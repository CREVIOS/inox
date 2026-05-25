// Generates a best-in-class Model Context Protocol server for the target API from the IR.
// Beyond Stainless/Speakeasy parity: three tool modes (typed | dynamic | code, auto-picked
// by API size), 2025-06-18 protocol, tool annotations derived from the HTTP verb, typed
// JSON Schemas straight from the IR, MCP resources, auth from config (bearer / api-key
// header|query / OAuth2 client-credentials), least-privilege permission flags, scope/tool
// filtering, and dual transports (stdio + streamable HTTP) — all zero-dependency. The
// generated server's own `--self-test` exercises every mode without touching the network.
import type { ApiIR, OperationIR, ResourceIR } from "./types.js";
import { snakeCase } from "./utils.js";
import { operationInputSchema } from "./jsonschema.js";

function resourceById(ir: ApiIR, id: string): ResourceIR | undefined {
  return ir.resources.find((resource) => resource.id === id);
}

function commandFor(ir: ApiIR, operation: OperationIR): string {
  const resource = resourceById(ir, operation.resource_id);
  return [...(resource?.path_segments ?? []), operation.name].join(".");
}

interface McpEndpointData {
  name: string;
  command: string;
  operationId: string;
  httpMethod: string;
  path: string;
  pathParams: string[];
  queryParams: string[];
  headerParams: string[];
  hasBody: boolean;
  multipart: boolean;
  summary: string;
  tags: string[];
  readOnly: boolean;
  idempotent: boolean;
  destructive: boolean;
  paginated: boolean;
  inputSchema: unknown;
}

function endpointData(ir: ApiIR): McpEndpointData[] {
  return ir.operations
    .filter((operation) => !operation.websocket)
    .map((operation) => {
      const command = commandFor(ir, operation);
      const method = operation.http_method.toUpperCase();
      return {
        name: command.replace(/[^a-zA-Z0-9_]/g, "_"),
        command,
        operationId: operation.id,
        httpMethod: method,
        path: operation.path,
        pathParams: operation.params.filter((param) => param.location === "path").map((param) => param.wire_name),
        queryParams: operation.params.filter((param) => param.location === "query").map((param) => param.wire_name),
        headerParams: operation.params.filter((param) => param.location === "header").map((param) => param.wire_name),
        hasBody: Boolean(operation.request),
        multipart: operation.request?.multipart ?? false,
        summary: operation.summary ?? "",
        tags: operation.tags ?? [],
        readOnly: method === "GET" || method === "HEAD",
        idempotent: ["GET", "HEAD", "PUT", "DELETE"].includes(method),
        destructive: method === "DELETE",
        paginated: Boolean(operation.pagination_id),
        inputSchema: operationInputSchema(ir, operation),
      };
    });
}

function authConfig(ir: ApiIR) {
  const prefix = ir.client.env_prefix;
  const auth = ir.client.auth ?? {};
  const hasApiKey = Boolean(auth.api_key?.header || auth.api_key?.query);
  const bearerEnv = auth.bearer
    ? auth.bearer.env ?? `${prefix}_API_KEY`
    : !hasApiKey && !ir.client.oauth2
      ? `${prefix}_API_KEY`
      : null;
  return {
    bearerEnv,
    apiKeyHeader: auth.api_key?.header ? { name: auth.api_key.header, env: auth.api_key.env ?? `${prefix}_API_KEY` } : null,
    apiKeyQuery: auth.api_key?.query ? { name: auth.api_key.query, env: auth.api_key.env ?? `${prefix}_API_KEY` } : null,
    oauth2: ir.client.oauth2
      ? {
          tokenUrl: ir.client.oauth2.token_url,
          clientIdEnv: ir.client.oauth2.client_id_env,
          clientSecretEnv: ir.client.oauth2.client_secret_env,
          authStyle: ir.client.oauth2.auth_style,
          scopes: ir.client.oauth2.scopes,
        }
      : null,
  };
}

function apiDocsMarkdown(ir: ApiIR, endpoints: McpEndpointData[]): string {
  const lines = [`# ${ir.api.name} — MCP tool reference`, ""];
  for (const endpoint of endpoints) {
    lines.push(`## ${endpoint.command}`);
    lines.push(`\`${endpoint.httpMethod} ${endpoint.path}\``);
    if (endpoint.summary) lines.push(endpoint.summary);
    const flags = [endpoint.readOnly ? "read-only" : "write", endpoint.paginated ? "paginated" : "", endpoint.tags.length ? `tags: ${endpoint.tags.join(", ")}` : ""].filter(Boolean);
    lines.push(`(${flags.join(" · ")})`);
    lines.push("");
  }
  return lines.join("\n");
}

export function renderMcpFiles(ir: ApiIR): Record<string, string> {
  const prefix = snakeCase(ir.api.package_prefix).replace(/_/g, "-");
  const pkgName = ir.mcp.package_name ?? `${prefix}-mcp`;
  const endpoints = endpointData(ir);
  const auth = authConfig(ir);
  const docs = apiDocsMarkdown(ir, endpoints);

  const pkg = {
    name: pkgName,
    version: ir.api.version ?? "0.1.0",
    private: true,
    type: "module",
    bin: { [pkgName]: "./dist/server.js" },
    scripts: { build: "tsc -p tsconfig.json", typecheck: "tsc -p tsconfig.json --noEmit", "self-test": "node dist/server.js --self-test" },
    devDependencies: { "@types/node": "^25.9.1", typescript: "^6.0.3" },
  };
  const tsconfig = {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      lib: ["ES2022", "DOM"],
      strict: true,
      noUncheckedIndexedAccess: true,
      outDir: "dist",
      rootDir: "src",
      types: ["node"],
      skipLibCheck: true,
    },
    include: ["src/**/*.ts"],
  };

  // The generated server uses string concatenation (no template literals) so this generator
  // template needs no backtick/`${}` escaping. JSON.stringify embeds IR-derived data.
  const server = `#!/usr/bin/env node
/*
 * Generated MCP server for ${ir.api.name}. Zero-dependency: newline-delimited JSON-RPC 2.0
 * over stdio plus a streamable-HTTP transport. Protocol revision 2025-06-18.
 *
 * Tool modes (default: ${ir.mcp.resolved_mode}; override with --tools):
 *   typed    one strongly-typed tool per endpoint (schemas from the API spec)
 *   dynamic  three meta-tools: list_api_endpoints, get_api_endpoint_schema, invoke_api_endpoint
 *   code     execute (constrained HTTP) + search_docs, for agents that write code
 *
 * Flags:
 *   --transport stdio|http        transport (default stdio)
 *   --port <n>                    HTTP port (default 3000)
 *   --tools typed|dynamic|code    tool mode
 *   --tool <name>                 (repeatable) mount only these tools
 *   --scope read|write|<tag>      (repeatable) filter tools by class or OpenAPI tag
 *   --allowed-methods <regex>     (repeatable) only allow commands matching these
 *   --blocked-methods <regex>     (repeatable) block commands matching these
 *   --allow-http-gets             permit GETs from the code/execute tool
 *   --oauth-client-id <id>        OAuth2 client id (else env)
 *   --oauth-client-secret <s>     OAuth2 client secret (else env)
 *   --self-test                   boot, validate every mode offline, exit
 */
import { createInterface } from "node:readline";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER = { name: ${JSON.stringify(`${ir.api.name} MCP`)}, version: ${JSON.stringify(ir.api.version ?? "0.1.0")} };

type ToolMode = "typed" | "dynamic" | "code";
const DEFAULT_MODE: ToolMode = ${JSON.stringify(ir.mcp.resolved_mode)};
const ENABLE_DOCS_TOOL = ${JSON.stringify(ir.mcp.enable_docs_tool)};
const ENABLE_CODE_TOOL = ${JSON.stringify(ir.mcp.enable_code_tool)};
const DEFAULT_PERMISSIONS = ${JSON.stringify(ir.mcp.permissions)};

interface Endpoint {
  name: string;
  command: string;
  operationId: string;
  httpMethod: string;
  path: string;
  pathParams: string[];
  queryParams: string[];
  headerParams: string[];
  hasBody: boolean;
  multipart: boolean;
  summary: string;
  tags: string[];
  readOnly: boolean;
  idempotent: boolean;
  destructive: boolean;
  paginated: boolean;
  inputSchema: Record<string, unknown>;
}

const endpoints: Endpoint[] = ${JSON.stringify(endpoints, null, 2)};
const API_DOCS: string = ${JSON.stringify(docs)};
const authConfig = ${JSON.stringify(auth, null, 2)} as {
  bearerEnv: string | null;
  apiKeyHeader: { name: string; env: string } | null;
  apiKeyQuery: { name: string; env: string } | null;
  oauth2: { tokenUrl: string; clientIdEnv: string; clientSecretEnv: string; authStyle: string; scopes: string[] } | null;
};
const baseUrl = process.env.${ir.client.env_prefix}_BASE_URL ?? ${JSON.stringify(ir.client.base_url)};

interface Flags {
  transport: "stdio" | "http";
  port: number;
  mode: ToolMode;
  tools: string[];
  scopes: string[];
  allowed: RegExp[];
  blocked: RegExp[];
  allowHttpGets: boolean;
  oauthClientId?: string;
  oauthClientSecret?: string;
  selfTest: boolean;
}

interface JsonRpcRequest { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown>; }
interface JsonRpcResponse { jsonrpc: "2.0"; id: string | number | null; result?: unknown; error?: { code: number; message: string }; }

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {
    transport: "stdio",
    port: 3000,
    mode: DEFAULT_MODE,
    tools: [],
    scopes: [],
    allowed: DEFAULT_PERMISSIONS.allowed_methods.map(function (re) { return new RegExp(re); }),
    blocked: DEFAULT_PERMISSIONS.blocked_methods.map(function (re) { return new RegExp(re); }),
    allowHttpGets: DEFAULT_PERMISSIONS.allow_http_gets,
    selfTest: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const next = function (): string { i += 1; return argv[i] ?? ""; };
    if (arg === "--transport") { const v = next(); flags.transport = v === "http" ? "http" : "stdio"; }
    else if (arg === "--port") { flags.port = Number(next()) || 3000; }
    else if (arg === "--tools" || arg === "--mode") { const v = next(); if (v === "typed" || v === "dynamic" || v === "code") flags.mode = v; }
    else if (arg === "--tool") { flags.tools.push(next()); }
    else if (arg === "--scope") { flags.scopes.push(next()); }
    else if (arg === "--allowed-methods") { flags.allowed.push(new RegExp(next())); }
    else if (arg === "--blocked-methods") { flags.blocked.push(new RegExp(next())); }
    else if (arg === "--allow-http-gets") { flags.allowHttpGets = true; }
    else if (arg === "--oauth-client-id") { flags.oauthClientId = next(); }
    else if (arg === "--oauth-client-secret") { flags.oauthClientSecret = next(); }
    else if (arg === "--self-test") { flags.selfTest = true; }
    else if (arg === "--transport=http") { flags.transport = "http"; }
    else if (arg.startsWith("--port=")) { flags.port = Number(arg.slice(7)) || 3000; }
  }
  return flags;
}

function permitted(command: string, flags: Flags): boolean {
  if (flags.blocked.some(function (re) { return re.test(command); })) return false;
  if (flags.allowed.length > 0 && !flags.allowed.some(function (re) { return re.test(command); })) return false;
  return true;
}

function inScope(endpoint: Endpoint, scope: string): boolean {
  if (scope === "read") return endpoint.readOnly;
  if (scope === "write") return !endpoint.readOnly;
  return endpoint.tags.indexOf(scope) >= 0;
}

function activeEndpoints(flags: Flags): Endpoint[] {
  return endpoints.filter(function (endpoint) {
    if (!permitted(endpoint.command, flags)) return false;
    if (flags.scopes.length > 0 && !flags.scopes.some(function (scope) { return inScope(endpoint, scope); })) return false;
    if (flags.tools.length > 0 && flags.tools.indexOf(endpoint.name) < 0) return false;
    return true;
  });
}

function annotationsFor(endpoint: Endpoint) {
  return { title: endpoint.command, readOnlyHint: endpoint.readOnly, destructiveHint: endpoint.destructive, idempotentHint: endpoint.idempotent, openWorldHint: true };
}

// ----- auth -----
let tokenCache: { value: string; expiresAt: number } | null = null;
async function oauthToken(flags: Flags): Promise<string | null> {
  const oauth = authConfig.oauth2;
  if (!oauth) return null;
  const id = flags.oauthClientId ?? process.env[oauth.clientIdEnv];
  const secret = flags.oauthClientSecret ?? process.env[oauth.clientSecretEnv];
  if (!id || !secret) return null;
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt > now + 5000) return tokenCache.value;
  const tokenUrl = oauth.tokenUrl.indexOf("http") === 0 ? oauth.tokenUrl : baseUrl + oauth.tokenUrl;
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  const params = new URLSearchParams({ grant_type: "client_credentials" });
  if (oauth.scopes.length > 0) params.set("scope", oauth.scopes.join(" "));
  if (oauth.authStyle === "basic") headers.authorization = "Basic " + Buffer.from(id + ":" + secret).toString("base64");
  else { params.set("client_id", id); params.set("client_secret", secret); }
  const response = await fetch(tokenUrl, { method: "POST", headers, body: params.toString() });
  const json = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) return null;
  tokenCache = { value: json.access_token, expiresAt: now + (json.expires_in ?? 3600) * 1000 };
  return tokenCache.value;
}

async function applyAuth(headers: Record<string, string>, url: URL, flags: Flags): Promise<void> {
  const token = await oauthToken(flags);
  if (token) { headers.authorization = "Bearer " + token; return; }
  if (authConfig.bearerEnv) { const key = process.env[authConfig.bearerEnv]; if (key) headers.authorization = "Bearer " + key; }
  if (authConfig.apiKeyHeader) { const key = process.env[authConfig.apiKeyHeader.env]; if (key) headers[authConfig.apiKeyHeader.name.toLowerCase()] = key; }
  if (authConfig.apiKeyQuery) { const key = process.env[authConfig.apiKeyQuery.env]; if (key) url.searchParams.set(authConfig.apiKeyQuery.name, key); }
}

async function callEndpoint(endpoint: Endpoint, args: Record<string, unknown>, flags: Flags): Promise<string> {
  if (!permitted(endpoint.command, flags)) return "Permission denied for " + endpoint.command;
  let path = endpoint.path;
  for (const param of endpoint.pathParams) {
    path = path.split("{" + param + "}").join(encodeURIComponent(String(args[param] ?? "")));
  }
  const url = new URL(baseUrl + path);
  for (const param of endpoint.queryParams) {
    if (args[param] !== undefined) url.searchParams.set(param, String(args[param]));
  }
  const headers: Record<string, string> = { accept: "application/json" };
  for (const param of endpoint.headerParams) {
    if (args[param] !== undefined) headers[param] = String(args[param]);
  }
  await applyAuth(headers, url, flags);
  let body: string | undefined;
  if (endpoint.hasBody && args.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(args.body);
  }
  const response = await fetch(url, { method: endpoint.httpMethod, headers, body });
  const text = await response.text();
  return response.ok ? text : "HTTP " + response.status + ": " + text;
}

// ----- raw execute (code mode) -----
async function rawExecute(args: Record<string, unknown>, flags: Flags): Promise<string> {
  const method = String(args.method ?? "GET").toUpperCase();
  const reqPath = String(args.path ?? "");
  const command = method + " " + reqPath;
  if (method === "GET" && !flags.allowHttpGets) return "GET requests require --allow-http-gets";
  if (!permitted(command, flags)) return "Permission denied for " + command;
  const url = new URL(baseUrl + reqPath);
  const query = (args.query ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(query)) url.searchParams.set(key, String(query[key]));
  const headers: Record<string, string> = { accept: "application/json" };
  await applyAuth(headers, url, flags);
  let body: string | undefined;
  if (args.body !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(args.body); }
  const response = await fetch(url, { method, headers, body });
  const text = await response.text();
  return response.ok ? text : "HTTP " + response.status + ": " + text;
}

function searchDocs(query: string): string {
  const lower = query.toLowerCase();
  const matches = endpoints.filter(function (endpoint) {
    return (endpoint.command + " " + endpoint.path + " " + endpoint.summary + " " + endpoint.tags.join(" ")).toLowerCase().indexOf(lower) >= 0;
  });
  if (matches.length === 0) return API_DOCS;
  return matches.map(function (endpoint) {
    return "## " + endpoint.command + "\\n" + endpoint.httpMethod + " " + endpoint.path + "\\n" + endpoint.summary;
  }).join("\\n\\n");
}

interface ToolDescriptor { name: string; title: string; description: string; inputSchema: Record<string, unknown>; annotations: Record<string, unknown>; }

function docsTool(): ToolDescriptor {
  return {
    name: "search_docs",
    title: "Search API docs",
    description: "Search " + SERVER.name + " endpoints and documentation by keyword.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "Search keyword" } }, required: ["query"] },
    annotations: { title: "Search API docs", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  };
}

function listTools(flags: Flags): ToolDescriptor[] {
  const active = activeEndpoints(flags);
  let tools: ToolDescriptor[] = [];
  if (flags.mode === "typed") {
    tools = active.map(function (endpoint): ToolDescriptor {
      return {
        name: endpoint.name,
        title: endpoint.command,
        description: (endpoint.summary || endpoint.command) + " (" + endpoint.httpMethod + " " + endpoint.path + ")" + (endpoint.paginated ? " [paginated]" : ""),
        inputSchema: endpoint.inputSchema,
        annotations: annotationsFor(endpoint),
      };
    });
    if (ENABLE_DOCS_TOOL) tools.push(docsTool());
  } else if (flags.mode === "dynamic") {
    tools = [
      {
        name: "list_api_endpoints",
        title: "List API endpoints",
        description: "List available " + SERVER.name + " endpoints, optionally filtered by search text or tag.",
        inputSchema: { type: "object", properties: { search: { type: "string" }, tag: { type: "string" } } },
        annotations: { title: "List API endpoints", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      {
        name: "get_api_endpoint_schema",
        title: "Get endpoint schema",
        description: "Get the full input schema for one endpoint by its command (resource.method).",
        inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
        annotations: { title: "Get endpoint schema", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      {
        name: "invoke_api_endpoint",
        title: "Invoke an endpoint",
        description: "Invoke an endpoint by command, passing its arguments object (see get_api_endpoint_schema).",
        inputSchema: { type: "object", properties: { command: { type: "string" }, arguments: { type: "object" } }, required: ["command"] },
        annotations: { title: "Invoke an endpoint", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
    ];
    if (ENABLE_DOCS_TOOL) tools.push(docsTool());
  } else {
    if (ENABLE_CODE_TOOL) {
      tools.push({
        name: "execute",
        title: "Execute an API request",
        description: "Execute an HTTP request against " + SERVER.name + ". GETs require --allow-http-gets. Subject to method allow/block lists.",
        inputSchema: {
          type: "object",
          properties: {
            method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
            path: { type: "string", description: "Request path, e.g. /v1/resource/{id}" },
            query: { type: "object" },
            body: { type: "object" },
          },
          required: ["method", "path"],
        },
        annotations: { title: "Execute an API request", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      });
    }
    if (ENABLE_DOCS_TOOL) tools.push(docsTool());
  }
  if (flags.tools.length > 0) tools = tools.filter(function (tool) { return flags.tools.indexOf(tool.name) >= 0; });
  return tools;
}

async function callTool(name: string, args: Record<string, unknown>, flags: Flags): Promise<{ text: string; isError?: boolean }> {
  if (name === "search_docs") return { text: searchDocs(String(args.query ?? "")) };
  if (name === "execute") return { text: await rawExecute(args, flags) };
  if (name === "list_api_endpoints") {
    const search = String(args.search ?? "").toLowerCase();
    const tag = String(args.tag ?? "");
    const rows = activeEndpoints(flags).filter(function (endpoint) {
      const matchSearch = !search || (endpoint.command + " " + endpoint.path + " " + endpoint.summary).toLowerCase().indexOf(search) >= 0;
      const matchTag = !tag || endpoint.tags.indexOf(tag) >= 0;
      return matchSearch && matchTag;
    }).map(function (endpoint) {
      return { command: endpoint.command, method: endpoint.httpMethod, path: endpoint.path, summary: endpoint.summary, read_only: endpoint.readOnly, paginated: endpoint.paginated, tags: endpoint.tags };
    });
    return { text: JSON.stringify({ count: rows.length, endpoints: rows }, null, 2) };
  }
  if (name === "get_api_endpoint_schema") {
    const command = String(args.command ?? "");
    const endpoint = endpoints.find(function (candidate) { return candidate.command === command || candidate.name === command; });
    if (!endpoint) return { text: "Unknown endpoint: " + command, isError: true };
    return { text: JSON.stringify({ command: endpoint.command, http: endpoint.httpMethod + " " + endpoint.path, input_schema: endpoint.inputSchema }, null, 2) };
  }
  if (name === "invoke_api_endpoint") {
    const command = String(args.command ?? "");
    const endpoint = endpoints.find(function (candidate) { return candidate.command === command || candidate.name === command; });
    if (!endpoint) return { text: "Unknown endpoint: " + command, isError: true };
    const inner = (args.arguments ?? {}) as Record<string, unknown>;
    return { text: await callEndpoint(endpoint, inner, flags) };
  }
  // typed mode: tool name == endpoint name
  const endpoint = endpoints.find(function (candidate) { return candidate.name === name; });
  if (!endpoint) return { text: "Unknown tool: " + name, isError: true };
  return { text: await callEndpoint(endpoint, args, flags) };
}

const RESOURCES = [
  { uri: "mcp://docs", name: "API reference", description: "Markdown reference for all endpoints.", mimeType: "text/markdown" },
  { uri: "mcp://endpoints", name: "Endpoint index", description: "JSON index of endpoints and metadata.", mimeType: "application/json" },
];

function readResource(uri: string): string | null {
  if (uri === "mcp://docs") return API_DOCS;
  if (uri === "mcp://endpoints") return JSON.stringify(endpoints.map(function (endpoint) { return { command: endpoint.command, method: endpoint.httpMethod, path: endpoint.path, summary: endpoint.summary, tags: endpoint.tags }; }), null, 2);
  return null;
}

async function handle(message: JsonRpcRequest, flags: Flags): Promise<JsonRpcResponse | null> {
  const id = (message.id ?? null) as string | number | null;
  const ok = function (result: unknown): JsonRpcResponse { return { jsonrpc: "2.0", id, result }; };
  const err = function (code: number, msg: string): JsonRpcResponse { return { jsonrpc: "2.0", id, error: { code, message: msg } }; };
  const method = message.method;
  if (method === "initialize") {
    return ok({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: { listChanged: false }, resources: { listChanged: false } }, serverInfo: SERVER });
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") return null;
  if (method === "ping") return ok({});
  if (method === "tools/list") return ok({ tools: listTools(flags) });
  if (method === "tools/call") {
    const params = message.params ?? {};
    const name = String(params.name ?? "");
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    try {
      const result = await callTool(name, args, flags);
      return ok({ content: [{ type: "text", text: result.text }], isError: result.isError === true });
    } catch (error) {
      return ok({ content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true });
    }
  }
  if (method === "resources/list") return ok({ resources: RESOURCES });
  if (method === "resources/read") {
    const uri = String((message.params ?? {}).uri ?? "");
    const text = readResource(uri);
    if (text === null) return err(-32602, "Unknown resource: " + uri);
    const mime = uri === "mcp://endpoints" ? "application/json" : "text/markdown";
    return ok({ contents: [{ uri, mimeType: mime, text }] });
  }
  if (id === null) return null;
  return err(-32601, "Unknown method: " + String(method));
}

function runStdio(flags: Flags): void {
  const reader = createInterface({ input: process.stdin });
  reader.on("line", function (line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: JsonRpcRequest;
    try { message = JSON.parse(trimmed) as JsonRpcRequest; } catch { return; }
    void handle(message, flags).then(function (response) {
      if (response) process.stdout.write(JSON.stringify(response) + "\\n");
    });
  });
  process.stderr.write("${ir.api.name} MCP server ready on stdio (mode " + flags.mode + ", " + listTools(flags).length + " tools)\\n");
}

function runHttp(flags: Flags): void {
  const httpServer = createServer(function (req: IncomingMessage, res: ServerResponse) {
    if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }); res.end("Method Not Allowed"); return; }
    let raw = "";
    req.on("data", function (chunk) { raw += chunk; });
    req.on("end", function () {
      let message: JsonRpcRequest;
      try { message = JSON.parse(raw) as JsonRpcRequest; } catch { res.writeHead(400); res.end("Invalid JSON"); return; }
      void handle(message, flags).then(function (response) {
        if (!response) { res.writeHead(202); res.end(); return; }
        const accept = String(req.headers.accept ?? "");
        if (accept.indexOf("text/event-stream") >= 0) {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          res.end("event: message\\ndata: " + JSON.stringify(response) + "\\n\\n");
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(response));
        }
      });
    });
  });
  httpServer.listen(flags.port, function () {
    process.stderr.write("${ir.api.name} MCP server on http://127.0.0.1:" + flags.port + "/ (streamable HTTP, mode " + flags.mode + ")\\n");
  });
}

async function selfTest(flags: Flags): Promise<void> {
  const fail = function (cond: boolean, msg: string): void { if (!cond) { throw new Error("mcp self-test: " + msg); } };
  const init = await handle({ jsonrpc: "2.0", id: 1, method: "initialize" }, flags);
  fail(((init?.result as { protocolVersion?: string })?.protocolVersion) === PROTOCOL_VERSION, "bad protocol");
  for (const mode of ["typed", "dynamic", "code"] as ToolMode[]) {
    const modeFlags: Flags = { ...flags, mode };
    const tools = listTools(modeFlags);
    fail(tools.length > 0, mode + " produced no tools");
    for (const tool of tools) {
      fail(typeof tool.inputSchema === "object", "tool " + tool.name + " missing inputSchema");
      fail(typeof (tool.annotations as { title?: string }).title === "string", "tool " + tool.name + " missing annotation title");
    }
    if (mode === "dynamic") {
      const list = await callTool("list_api_endpoints", {}, modeFlags);
      fail(!list.isError, "list_api_endpoints errored");
      const first = endpoints[0];
      if (first) {
        const schema = await callTool("get_api_endpoint_schema", { command: first.command }, modeFlags);
        fail(!schema.isError, "get_api_endpoint_schema errored");
      }
    }
  }
  const docs = await callTool("search_docs", { query: "" }, { ...flags, mode: "code" });
  fail(docs.text.length > 0, "search_docs empty");
  const resources = await handle({ jsonrpc: "2.0", id: 2, method: "resources/list" }, flags);
  fail((((resources?.result as { resources?: unknown[] })?.resources) ?? []).length === RESOURCES.length, "resources/list mismatch");
  process.stdout.write("mcp self-test passed: modes typed/dynamic/code, protocol " + PROTOCOL_VERSION + "\\n");
}

const flags = parseFlags(process.argv.slice(2));
if (flags.selfTest) {
  void selfTest(flags).catch(function (error) { process.stderr.write(String(error) + "\\n"); process.exit(1); });
} else if (flags.transport === "http") {
  runHttp(flags);
} else {
  runStdio(flags);
}
`;

  const stdioName = snakeCase(ir.api.package_prefix);
  const readme = `# ${ir.api.name} MCP Server

Generated Model Context Protocol server (protocol \`2025-06-18\`, zero dependencies).

## Tool modes

| Mode | Tools | When |
| --- | --- | --- |
| \`typed\` | one tool per endpoint, fully typed | small/medium APIs |
| \`dynamic\` | \`list_api_endpoints\`, \`get_api_endpoint_schema\`, \`invoke_api_endpoint\` | large APIs (token-efficient) |
| \`code\` | \`execute\` + \`search_docs\` | agents that write code |

Default mode: **${ir.mcp.resolved_mode}**. Override with \`--tools <mode>\`.

## Run (stdio, for Claude Desktop / Cursor / Claude Code)

\`\`\`json
{
  "mcpServers": {
    "${stdioName}": {
      "command": "node",
      "args": ["dist/server.js"],
      "env": { "${ir.client.env_prefix}_API_KEY": "your-api-key" }
    }
  }
}
\`\`\`

## Run (streamable HTTP, for remote/hosted)

\`\`\`sh
node dist/server.js --transport http --port 3000
\`\`\`

\`\`\`json
{ "mcpServers": { "${stdioName}": { "url": "http://localhost:3000/" } } }
\`\`\`

## Flags

\`\`\`text
--transport stdio|http        transport (default stdio)
--port <n>                    HTTP port (default 3000)
--tools typed|dynamic|code    tool mode
--tool <name>                 (repeatable) mount only these tools
--scope read|write|<tag>      (repeatable) filter tools by class or OpenAPI tag
--allowed-methods <regex>     (repeatable) only allow commands matching these
--blocked-methods <regex>     (repeatable) block commands matching these
--allow-http-gets             permit GETs from the code/execute tool
--oauth-client-id <id>        OAuth2 client id (else env)
--oauth-client-secret <s>     OAuth2 client secret (else env)
--self-test                   validate every mode offline, exit
\`\`\`

Least-privilege example (read-only, one resource):

\`\`\`sh
node dist/server.js --scope read --allowed-methods "customers\\..*" --blocked-methods ".*\\.delete"
\`\`\`
`;

  return {
    "package.json": JSON.stringify(pkg, null, 2),
    "tsconfig.json": JSON.stringify(tsconfig, null, 2),
    "src/server.ts": server,
    "README.md": readme,
  };
}
