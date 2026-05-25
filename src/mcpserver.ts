// Exposes the SDK generator itself over the Model Context Protocol so an agent
// (Claude Code, Cursor, Claude Desktop) can lint a spec, inspect the IR, list/inspect
// endpoints, diff for SemVer, plan a release, run governance, and generate SDKs — all
// locally and air-gapped. Zero dependency: newline-delimited JSON-RPC 2.0 over stdio,
// protocol revision 2025-06-18. `mcpSelfTest` drives every read-only tool in-process so
// `sdkgen verify`/the e2e suite proves the server boots and answers.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { enabledTargets, hasBlockingDiagnostics, readConfig, resolveSpecPath } from "./config.js";
import { diffIR } from "./diff.js";
import { buildIR } from "./ir.js";
import { generateMockServer } from "./mock.js";
import { readOpenApiSpec } from "./openapi.js";
import { generateTargets } from "./generators/index.js";
import { planRelease, renderChangelogEntry } from "./release.js";
import { governanceDiagnostics } from "./governance.js";
import { renderDocs } from "./products.js";
import { operationInputSchema, typeRefToJsonSchema } from "./jsonschema.js";
import type { ApiIR, Diagnostic, OperationIR, TargetName } from "./types.js";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "sdkgen", title: "SDK Generator", version: "0.2.0" };

export interface McpServerOptions {
  config: string;
  out: string;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

interface ToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
  run(args: Record<string, unknown>, options: McpServerOptions): Promise<string>;
}

function readOnly(title: string, openWorld = false): ToolAnnotations {
  return { title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: openWorld };
}

function configProp(): Record<string, unknown> {
  return { config: { type: "string", description: "Path to sdkgen.yml (default: the server's configured path)." } };
}

async function loadProject(configPath: string): Promise<{ ir: ApiIR; diagnostics: Diagnostic[]; specRaw: string; configRaw: string }> {
  const loadedConfig = await readConfig(configPath);
  const specPath = resolveSpecPath(loadedConfig.config, loadedConfig.path);
  const loadedSpec = await readOpenApiSpec(specPath);
  const ir = buildIR({
    config: loadedConfig.config,
    configRaw: loadedConfig.raw,
    spec: loadedSpec.spec,
    specRaw: loadedSpec.raw,
    diagnostics: [...loadedConfig.diagnostics, ...loadedSpec.diagnostics],
  });
  return {
    ir,
    diagnostics: [...loadedConfig.diagnostics, ...loadedSpec.diagnostics, ...ir.diagnostics],
    specRaw: loadedSpec.raw,
    configRaw: loadedConfig.raw,
  };
}

function resolveConfig(args: Record<string, unknown>, options: McpServerOptions): string {
  return typeof args.config === "string" && args.config ? args.config : options.config;
}

function commandFor(ir: ApiIR, operation: OperationIR): string {
  const resource = ir.resources.find((candidate) => candidate.id === operation.resource_id);
  return [...(resource?.path_segments ?? []), operation.name].join(".");
}

function endpointSummary(ir: ApiIR, operation: OperationIR) {
  return {
    command: commandFor(ir, operation),
    operation_id: operation.id,
    http: `${operation.http_method.toUpperCase()} ${operation.path}`,
    summary: operation.summary ?? "",
    paginated: Boolean(operation.pagination_id),
    streaming: Boolean(operation.streaming),
  };
}

export const MCP_TOOLS: ToolDef[] = [
  {
    name: "lint_spec",
    title: "Lint spec & config",
    description: "Validate the OpenAPI spec and sdkgen.yml; returns diagnostics (optionally including governance rules).",
    inputSchema: { type: "object", properties: { ...configProp(), governance: { type: "boolean" }, strict: { type: "boolean" } } },
    annotations: readOnly("Lint spec & config"),
    async run(args, options) {
      const configPath = resolveConfig(args, options);
      const { ir, diagnostics } = await loadProject(configPath);
      const all = [...diagnostics];
      if (args.governance) {
        const loadedSpec = await readOpenApiSpec(resolveSpecPath((await readConfig(configPath)).config, resolve(configPath)));
        all.push(...governanceDiagnostics(loadedSpec.spec, ir, { strict: Boolean(args.strict) }));
      }
      const blocking = hasBlockingDiagnostics(all);
      return JSON.stringify({ blocking, count: all.length, diagnostics: all }, null, 2);
    },
  },
  {
    name: "build_ir",
    title: "Build canonical IR",
    description: "Build and return the canonical intermediate representation (resources, operations, types, pagination) as JSON.",
    inputSchema: { type: "object", properties: { ...configProp(), summary: { type: "boolean", description: "Return counts only." } } },
    annotations: readOnly("Build canonical IR"),
    async run(args, options) {
      const { ir } = await loadProject(resolveConfig(args, options));
      if (args.summary) {
        return JSON.stringify(
          {
            api: ir.api,
            resources: ir.resources.length,
            operations: ir.operations.length,
            types: ir.types.length,
            pagination: ir.pagination.length,
            targets: Object.keys(ir.targets),
          },
          null,
          2,
        );
      }
      return JSON.stringify(ir, null, 2);
    },
  },
  {
    name: "list_endpoints",
    title: "List endpoints",
    description: "List API operations as agent commands (resource.method), optionally filtered by a keyword.",
    inputSchema: { type: "object", properties: { ...configProp(), query: { type: "string", description: "Case-insensitive filter over command/path/summary." } } },
    annotations: readOnly("List endpoints"),
    async run(args, options) {
      const { ir } = await loadProject(resolveConfig(args, options));
      const query = String(args.query ?? "").toLowerCase();
      const rows = ir.operations
        .map((operation) => endpointSummary(ir, operation))
        .filter((row) => !query || `${row.command} ${row.http} ${row.summary}`.toLowerCase().includes(query));
      return JSON.stringify({ count: rows.length, endpoints: rows }, null, 2);
    },
  },
  {
    name: "get_endpoint_schema",
    title: "Get endpoint schema",
    description: "Return the full JSON Schema (params, request body, response) for one endpoint by its command or operationId.",
    inputSchema: {
      type: "object",
      properties: { ...configProp(), command: { type: "string", description: "Endpoint command (resource.method) or operationId." } },
      required: ["command"],
    },
    annotations: readOnly("Get endpoint schema"),
    async run(args, options) {
      const { ir } = await loadProject(resolveConfig(args, options));
      const target = String(args.command ?? "");
      const operation = ir.operations.find((candidate) => commandFor(ir, candidate) === target || candidate.id === target);
      if (!operation) return `Unknown endpoint: ${target}`;
      return JSON.stringify(
        {
          ...endpointSummary(ir, operation),
          input_schema: operationInputSchema(ir, operation),
          response_schema: operation.response ? typeRefToJsonSchema(ir, operation.response) : { type: "null" },
        },
        null,
        2,
      );
    },
  },
  {
    name: "diff_ir",
    title: "Diff against released IR",
    description: "Classify IR changes (major/minor/patch) against a previous IR snapshot for SemVer; defaults to .sdkgen/released.json.",
    inputSchema: { type: "object", properties: { ...configProp(), against: { type: "string", description: "Path to a previous IR JSON snapshot." } } },
    annotations: readOnly("Diff against released IR"),
    async run(args, options) {
      const { ir } = await loadProject(resolveConfig(args, options));
      const againstPath = typeof args.against === "string" && args.against ? args.against : ".sdkgen/released.json";
      let previous: ApiIR | undefined;
      try {
        previous = JSON.parse(await readFile(resolve(againstPath), "utf8")) as ApiIR;
      } catch {
        return JSON.stringify({ recommended_bump: "minor", note: `No baseline at ${againstPath}; treating all as additive.`, changes: [] }, null, 2);
      }
      return JSON.stringify(diffIR(previous, ir), null, 2);
    },
  },
  {
    name: "plan_release",
    title: "Plan a release",
    description: "Recommend a SemVer bump and render the changelog entry from the IR diff against the last released IR.",
    inputSchema: { type: "object", properties: { ...configProp() } },
    annotations: readOnly("Plan a release"),
    async run(args, options) {
      const { ir } = await loadProject(resolveConfig(args, options));
      let previous: ApiIR | undefined;
      try {
        previous = JSON.parse(await readFile(resolve(".sdkgen/released.json"), "utf8")) as ApiIR;
      } catch {
        previous = undefined;
      }
      const plan = planRelease(previous, ir);
      return JSON.stringify(
        { bump: plan.bump, previous_version: plan.previousVersion, next_version: plan.nextVersion, changelog: renderChangelogEntry(plan), changes: plan.diff.changes },
        null,
        2,
      );
    },
  },
  {
    name: "governance_check",
    title: "Run governance ruleset",
    description: "Run the policy-as-code governance ruleset (operationId/descriptions/security/error-model/casing) and return findings.",
    inputSchema: { type: "object", properties: { ...configProp(), strict: { type: "boolean", description: "Escalate findings to blockers." } } },
    annotations: readOnly("Run governance ruleset"),
    async run(args, options) {
      const configPath = resolveConfig(args, options);
      const { ir } = await loadProject(configPath);
      const loadedSpec = await readOpenApiSpec(resolveSpecPath((await readConfig(configPath)).config, resolve(configPath)));
      const findings = governanceDiagnostics(loadedSpec.spec, ir, { strict: Boolean(args.strict) });
      return JSON.stringify({ count: findings.length, findings }, null, 2);
    },
  },
  {
    name: "generate_sdk",
    title: "Generate SDKs",
    description: "Generate SDK source trees (and the mock server) into the output directory. Writes files; safe to re-run.",
    inputSchema: {
      type: "object",
      properties: {
        ...configProp(),
        out: { type: "string", description: "Output directory (default: the server's configured output)." },
        target: { type: "string", description: "all | typescript | python | go | ruby | java | csharp" },
      },
    },
    annotations: { title: "Generate SDKs", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async run(args, options) {
      const configPath = resolveConfig(args, options);
      const loadedConfig = await readConfig(configPath);
      const { ir, diagnostics } = await loadProject(configPath);
      if (hasBlockingDiagnostics(diagnostics)) {
        return JSON.stringify({ ok: false, error: "Blocking diagnostics; fix with lint_spec first.", diagnostics: diagnostics.filter((d) => d.severity === "error" || d.severity === "blocker") }, null, 2);
      }
      const requested = typeof args.target === "string" ? args.target : "all";
      const targets = enabledTargets(loadedConfig.config, (requested as TargetName | "all"));
      if (targets.length === 0) return JSON.stringify({ ok: false, error: `No enabled targets matched ${requested}.` }, null, 2);
      const outRoot = resolve(typeof args.out === "string" && args.out ? args.out : options.out);
      const results = await generateTargets(ir, targets, outRoot);
      const mock = await generateMockServer(ir, outRoot);
      return JSON.stringify(
        { ok: true, out: outRoot, targets: results.map((result) => ({ target: result.target, files: result.files.length })), mock_files: mock.files.length },
        null,
        2,
      );
    },
  },
];

interface ResourceDef {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  read(options: McpServerOptions): Promise<string>;
}

const MCP_RESOURCES: ResourceDef[] = [
  {
    uri: "sdkgen://config",
    name: "sdkgen.yml",
    description: "The generator configuration.",
    mimeType: "application/yaml",
    read: async (options) => (await loadProject(options.config)).configRaw,
  },
  {
    uri: "sdkgen://openapi",
    name: "OpenAPI spec",
    description: "The source OpenAPI document.",
    mimeType: "text/plain",
    read: async (options) => (await loadProject(options.config)).specRaw,
  },
  {
    uri: "sdkgen://ir",
    name: "Canonical IR",
    description: "The canonical IR JSON.",
    mimeType: "application/json",
    read: async (options) => JSON.stringify((await loadProject(options.config)).ir, null, 2),
  },
  {
    uri: "sdkgen://docs",
    name: "API reference",
    description: "Markdown API reference rendered from the IR.",
    mimeType: "text/markdown",
    read: async (options) => renderDocs((await loadProject(options.config)).ir),
  },
];

export async function handleMcp(request: JsonRpcRequest, options: McpServerOptions): Promise<JsonRpcResponse | undefined> {
  const id = (request.id ?? null) as string | number | null;
  const respond = (result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string): JsonRpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });

  switch (request.method) {
    case "initialize":
      return respond({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: "Drive the local SDK generator: lint_spec, build_ir, list_endpoints, get_endpoint_schema, diff_ir, plan_release, governance_check, generate_sdk.",
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return undefined; // notifications take no response
    case "ping":
      return respond({});
    case "tools/list":
      return respond({
        tools: MCP_TOOLS.map((tool) => ({ name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations })),
      });
    case "tools/call": {
      const name = String(request.params?.name ?? "");
      const tool = MCP_TOOLS.find((candidate) => candidate.name === name);
      if (!tool) return fail(-32602, `Unknown tool: ${name}`);
      const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        const text = await tool.run(args, options);
        return respond({ content: [{ type: "text", text }] });
      } catch (error) {
        return respond({ content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true });
      }
    }
    case "resources/list":
      return respond({ resources: MCP_RESOURCES.map(({ uri, name, description, mimeType }) => ({ uri, name, description, mimeType })) });
    case "resources/read": {
      const uri = String(request.params?.uri ?? "");
      const resource = MCP_RESOURCES.find((candidate) => candidate.uri === uri);
      if (!resource) return fail(-32602, `Unknown resource: ${uri}`);
      try {
        const text = await resource.read(options);
        return respond({ contents: [{ uri, mimeType: resource.mimeType, text }] });
      } catch (error) {
        return fail(-32603, error instanceof Error ? error.message : String(error));
      }
    }
    default:
      if (id === null) return undefined;
      return fail(-32601, `Unknown method: ${String(request.method)}`);
  }
}

export function runMcpServer(options: McpServerOptions): void {
  const reader = createInterface({ input: process.stdin });
  const write = (message: JsonRpcResponse): void => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };
  reader.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      return;
    }
    void handleMcp(request, options).then((response) => {
      if (response) write(response);
    });
  });
  process.stderr.write(`sdkgen MCP server ready (protocol ${PROTOCOL_VERSION}, ${MCP_TOOLS.length} tools, ${MCP_RESOURCES.length} resources)\n`);
}

/** Boots the server in-process, exercises initialize + every read-only tool + resources, exits non-zero on any failure. */
export async function mcpSelfTest(options: McpServerOptions): Promise<void> {
  const expect = (condition: boolean, message: string): void => {
    if (!condition) throw new Error(`mcp self-test: ${message}`);
  };
  const call = async (method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse | undefined> =>
    handleMcp({ jsonrpc: "2.0", id: 1, method, params }, options);

  const init = await call("initialize");
  expect((init?.result as { protocolVersion?: string })?.protocolVersion === PROTOCOL_VERSION, "initialize protocol mismatch");

  const toolsList = (await call("tools/list"))?.result as { tools: Array<{ name: string; annotations: ToolAnnotations; inputSchema: unknown }> };
  expect(toolsList.tools.length === MCP_TOOLS.length, "tools/list count mismatch");
  for (const tool of toolsList.tools) {
    expect(Boolean(tool.annotations?.title), `tool ${tool.name} missing annotations.title`);
    expect(typeof tool.inputSchema === "object", `tool ${tool.name} missing inputSchema`);
  }

  for (const tool of MCP_TOOLS.filter((candidate) => candidate.annotations.readOnlyHint)) {
    const args: Record<string, unknown> = { summary: true };
    if (tool.name === "get_endpoint_schema") {
      const listText = ((await call("tools/call", { name: "list_endpoints", arguments: {} }))?.result as { content?: Array<{ text: string }> })?.content?.[0]?.text ?? "{}";
      const listed = JSON.parse(listText) as { endpoints?: Array<{ command: string }> };
      args.command = listed.endpoints?.[0]?.command ?? "";
    }
    const result = (await call("tools/call", { name: tool.name, arguments: args }))?.result as { content?: Array<{ type: string; text: string }>; isError?: boolean } | undefined;
    expect(result?.isError !== true, `tool ${tool.name} returned an error: ${result?.content?.[0]?.text}`);
    expect(result?.content?.[0]?.type === "text", `tool ${tool.name} returned no text content`);
  }

  const resources = (await call("resources/list"))?.result as { resources: Array<{ uri: string }> };
  expect(resources.resources.length === MCP_RESOURCES.length, "resources/list count mismatch");
  for (const resource of resources.resources) {
    const read = (await call("resources/read", { uri: resource.uri }))?.result as { contents: Array<{ text: string }> } | undefined;
    expect(Boolean(read?.contents?.[0]?.text), `resource ${resource.uri} read empty`);
  }

  // generate_sdk writes files: verify it runs into a throwaway directory.
  const stage = await mkdtemp(join(tmpdir(), "sdkgen-mcp-st-"));
  try {
    const gen = (await call("tools/call", { name: "generate_sdk", arguments: { out: stage, target: "typescript" } }))?.result as { content?: Array<{ text: string }> } | undefined;
    const genText = gen?.content?.[0]?.text ?? "{}";
    const parsed = JSON.parse(genText) as { ok?: boolean };
    expect(parsed.ok === true, "generate_sdk did not report ok");
  } finally {
    await rm(stage, { recursive: true, force: true });
  }

  process.stdout.write(`mcp self-test passed: ${MCP_TOOLS.length} tools, ${MCP_RESOURCES.length} resources, protocol ${PROTOCOL_VERSION}\n`);
}
