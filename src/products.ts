// Downstream products generated from the same IR: Markdown API docs, a standalone CLI,
// a Model Context Protocol (MCP) server, and a Terraform provider scaffold. These reuse
// the SDK IR so they stay in sync with the SDKs, mirroring Stainless's multi-output model.
import type { ApiIR, OperationIR, ResourceIR, TypeRefIR } from "./types.js";
import { pascalCase, snakeCase } from "./utils.js";
import { paginationShape } from "./generators/common.js";
import { operationInputSchema } from "./jsonschema.js";
import { snippetMarkdown } from "./codesamples.js";

interface RouteSpec {
  id: string;
  resource: string;
  method: string;
  httpMethod: string;
  path: string;
  pathParams: string[];
  queryParams: string[];
  hasBody: boolean;
  multipart: boolean;
  streaming: boolean;
  summary: string;
}

function resourceById(ir: ApiIR, id: string): ResourceIR | undefined {
  return ir.resources.find((resource) => resource.id === id);
}

function dottedAccessor(ir: ApiIR, operation: OperationIR): string {
  const resource = resourceById(ir, operation.resource_id);
  return (resource?.path_segments ?? []).join(".");
}

function routeSpecs(ir: ApiIR): RouteSpec[] {
  return ir.operations.map((operation) => ({
    id: operation.id,
    resource: dottedAccessor(ir, operation),
    method: operation.name,
    httpMethod: operation.http_method.toUpperCase(),
    path: operation.path,
    pathParams: operation.params.filter((param) => param.location === "path").map((param) => param.wire_name),
    queryParams: operation.params.filter((param) => param.location === "query").map((param) => param.wire_name),
    hasBody: Boolean(operation.request),
    multipart: operation.request?.multipart ?? false,
    streaming: Boolean(operation.streaming),
    summary: operation.summary ?? "",
  }));
}

function refToDocType(ir: ApiIR, ref: TypeRefIR | undefined): string {
  if (!ref) return "void";
  if (ref.kind === "ref") return ir.types.find((type) => type.id === ref.id)?.name ?? "unknown";
  if (ref.kind === "array") return `${refToDocType(ir, ref.items)}[]`;
  if (ref.kind === "map") return `map<string, ${refToDocType(ir, ref.values)}>`;
  if (ref.kind === "file") return "file";
  if (ref.kind === "primitive") return ref.name;
  return "unknown";
}

// ---------- Docs ----------

export function renderDocs(ir: ApiIR): string {
  const lines: string[] = [`# ${ir.api.name} API Reference`, ""];
  if (ir.api.description) lines.push(ir.api.description, "");
  lines.push(`Base URL: \`${ir.client.base_url}\``, "");

  for (const resource of ir.resources) {
    const operations = ir.operations.filter((operation) => operation.resource_id === resource.id);
    if (operations.length === 0) continue;
    lines.push(`## ${resource.path_segments.join(".")}`, "");
    for (const operation of operations) {
      lines.push(`### ${operation.name}`, "");
      lines.push(`\`${operation.http_method.toUpperCase()} ${operation.path}\``, "");
      if (operation.summary) lines.push(operation.summary, "");
      const params = operation.params;
      if (params.length > 0) {
        lines.push("| Parameter | In | Type | Required |", "| --- | --- | --- | --- |");
        for (const param of params) {
          lines.push(`| \`${param.wire_name}\` | ${param.location} | ${refToDocType(ir, param.type)} | ${param.required ? "yes" : "no"} |`);
        }
        lines.push("");
      }
      if (operation.request) {
        lines.push(`**Request body** (${operation.request.content_type}): \`${refToDocType(ir, operation.request.type)}\``, "");
      }
      const returns = operation.binary_response
        ? "binary"
        : operation.streaming
          ? `stream<${refToDocType(ir, { kind: "ref", id: operation.streaming.event_type_id })}>`
          : refToDocType(ir, operation.response);
      lines.push(`**Returns**: \`${returns}\``, "");
      if (operation.deprecated) {
        const reason = typeof operation.deprecated === "string" ? `: ${operation.deprecated}` : "";
        lines.push(`> **Deprecated**${reason}`, "");
      }
      lines.push(...snippetMarkdown(ir, operation));
    }
  }
  return lines.join("\n");
}

// ---------- API explorer (zero-dependency static HTML) ----------

export function renderApiExplorer(ir: ApiIR): string {
  const endpoints = ir.operations.map((operation) => ({
    command: [...(resourceById(ir, operation.resource_id)?.path_segments ?? []), operation.name].join("."),
    method: operation.http_method.toUpperCase(),
    path: operation.path,
    summary: operation.summary ?? "",
    hasBody: Boolean(operation.request),
    deprecated: Boolean(operation.deprecated),
  }));
  // Single self-contained file: a "try it" form that calls the live API from the browser.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${ir.api.name} — API Explorer</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 system-ui, sans-serif; margin: 0; display: grid; grid-template-columns: 320px 1fr; height: 100vh; }
  aside { border-right: 1px solid #8884; overflow: auto; padding: 12px; }
  main { padding: 20px; overflow: auto; }
  h1 { font-size: 16px; }
  .ep { padding: 6px 8px; border-radius: 6px; cursor: pointer; }
  .ep:hover { background: #8882; }
  .ep.dep { opacity: .55; text-decoration: line-through; }
  .m { font-weight: 700; font-size: 11px; margin-right: 6px; }
  .GET { color: #2a7; } .POST { color: #27a; } .PUT,.PATCH { color: #a82; } .DELETE { color: #c44; }
  input, textarea, select, button { font: inherit; padding: 6px 8px; border-radius: 6px; border: 1px solid #8886; background: transparent; color: inherit; }
  textarea { width: 100%; min-height: 120px; font-family: ui-monospace, monospace; }
  pre { background: #8881; padding: 12px; border-radius: 8px; overflow: auto; }
  label { display: block; margin: 10px 0 4px; font-weight: 600; }
  .row { display: flex; gap: 8px; align-items: center; }
</style>
</head>
<body>
<aside>
  <h1>${ir.api.name}</h1>
  <input id="filter" placeholder="Filter endpoints…" style="width:100%;margin-bottom:8px" />
  <div id="list"></div>
</aside>
<main>
  <div class="row"><strong id="title">Select an endpoint</strong></div>
  <label>Base URL</label>
  <input id="baseUrl" style="width:100%" value="${ir.client.base_url}" />
  <label>Authorization (Bearer token)</label>
  <input id="token" style="width:100%" placeholder="paste API key (sent as Authorization: Bearer …)" />
  <label>Path</label>
  <input id="path" style="width:100%" />
  <label>Request body (JSON)</label>
  <textarea id="body" placeholder="{ }"></textarea>
  <div class="row" style="margin-top:10px"><button id="send">Send request</button> <span id="status"></span></div>
  <label>Response</label>
  <pre id="out">—</pre>
</main>
<script>
const endpoints = ${JSON.stringify(endpoints)};
let current = null;
const list = document.getElementById("list");
function render(filter) {
  list.innerHTML = "";
  for (const ep of endpoints) {
    if (filter && !(ep.command + " " + ep.path + " " + ep.summary).toLowerCase().includes(filter.toLowerCase())) continue;
    const div = document.createElement("div");
    div.className = "ep" + (ep.deprecated ? " dep" : "");
    div.innerHTML = '<span class="m ' + ep.method + '">' + ep.method + '</span>' + ep.command;
    div.title = ep.summary;
    div.onclick = () => select(ep);
    list.appendChild(div);
  }
}
function select(ep) {
  current = ep;
  document.getElementById("title").textContent = ep.method + " " + ep.path;
  document.getElementById("path").value = ep.path;
  document.getElementById("body").style.display = ep.hasBody ? "block" : "none";
}
document.getElementById("filter").oninput = (e) => render(e.target.value);
document.getElementById("send").onclick = async () => {
  if (!current) return;
  const base = document.getElementById("baseUrl").value.replace(/\\/$/, "");
  const path = document.getElementById("path").value;
  const token = document.getElementById("token").value;
  const headers = { accept: "application/json" };
  if (token) headers.authorization = "Bearer " + token;
  let body;
  if (current.hasBody && document.getElementById("body").value.trim()) {
    headers["content-type"] = "application/json";
    body = document.getElementById("body").value;
  }
  const status = document.getElementById("status");
  status.textContent = "…";
  try {
    const res = await fetch(base + path, { method: current.method, headers, body });
    status.textContent = res.status + " " + res.statusText;
    const text = await res.text();
    try { document.getElementById("out").textContent = JSON.stringify(JSON.parse(text), null, 2); }
    catch { document.getElementById("out").textContent = text; }
  } catch (err) { status.textContent = "error"; document.getElementById("out").textContent = String(err); }
};
render("");
</script>
</body>
</html>`;
}

// ---------- CLI ----------

export function renderCliFiles(ir: ApiIR): Record<string, string> {
  const routes = routeSpecs(ir);
  const binName = snakeCase(ir.api.package_prefix).replace(/_/g, "-");
  const pkg = {
    name: `${binName}-cli`,
    version: ir.api.version ?? "0.1.0",
    private: true,
    type: "module",
    bin: { [binName]: "./dist/cli.js" },
    scripts: { build: "tsc -p tsconfig.json", typecheck: "tsc -p tsconfig.json --noEmit" },
    devDependencies: { "@types/node": "^25.9.1", typescript: "^6.0.3" },
  };
  const tsconfig = {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      lib: ["ES2022", "DOM"],
      strict: true,
      outDir: "dist",
      rootDir: "src",
      types: ["node"],
      skipLibCheck: true,
    },
    include: ["src/**/*.ts"],
  };

  const cli = `#!/usr/bin/env node
// Generated CLI for ${ir.api.name}. Usage: ${binName} <resource>.<method> [--param value] [--body '<json>']
interface Route {
  id: string;
  command: string;
  httpMethod: string;
  path: string;
  pathParams: string[];
  queryParams: string[];
  hasBody: boolean;
  summary: string;
}

const routes: Route[] = ${JSON.stringify(
    routes.map((route) => ({
      id: route.id,
      command: `${route.resource}.${route.method}`,
      httpMethod: route.httpMethod,
      path: route.path,
      pathParams: route.pathParams,
      queryParams: route.queryParams,
      hasBody: route.hasBody,
      summary: route.summary,
    })),
    null,
    2,
  )};

const baseUrl = process.env.${ir.client.env_prefix}_BASE_URL ?? ${JSON.stringify(ir.client.base_url)};
const apiKey = process.env.${ir.client.env_prefix}_API_KEY;

function usage(): void {
  console.error("Usage: ${binName} <command> [--param value] [--body '<json>']\\n\\nCommands:");
  for (const route of routes) {
    console.error(\`  \${route.command.padEnd(28)} \${route.httpMethod} \${route.path}\`);
  }
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = args[index + 1] ?? "";
      flags[key] = value;
      index += 1;
    }
  }
  return flags;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    usage();
    process.exit(command ? 0 : 1);
  }
  const route = routes.find((candidate) => candidate.command === command);
  if (!route) {
    console.error(\`Unknown command: \${command}\`);
    usage();
    process.exit(1);
  }
  const flags = parseFlags(rest);

  let path = route.path;
  for (const param of route.pathParams) {
    const value = flags[param];
    if (value === undefined) {
      console.error(\`Missing required path parameter --\${param}\`);
      process.exit(1);
    }
    path = path.replace(\`{\${param}}\`, encodeURIComponent(value));
  }

  const url = new URL(\`\${baseUrl}\${path}\`);
  for (const param of route.queryParams) {
    if (flags[param] !== undefined) url.searchParams.set(param, flags[param]);
  }

  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey) headers.authorization = \`Bearer \${apiKey}\`;
  let body: string | undefined;
  if (route.hasBody && flags.body) {
    headers["content-type"] = "application/json";
    body = flags.body;
  }

  const response = await fetch(url, { method: route.httpMethod, headers, body });
  const text = await response.text();
  if (!response.ok) {
    console.error(\`HTTP \${response.status}: \${text}\`);
    process.exit(1);
  }
  console.log(text);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
`;

  const readme = `# ${ir.api.name} CLI

Generated command-line interface.

\`\`\`sh
${binName} --help
${routes[0] ? `${binName} ${routes[0].resource}.${routes[0].method}` : ""}
\`\`\`
`;

  return {
    "package.json": JSON.stringify(pkg, null, 2),
    "tsconfig.json": JSON.stringify(tsconfig, null, 2),
    "src/cli.ts": cli,
    "README.md": readme,
  };
}

// ---------- MCP server ----------

export { renderMcpFiles } from "./mcpgen.js";

// ---------- Terraform provider scaffold ----------

export function renderTerraformFiles(ir: ApiIR): Record<string, string> {
  const providerName = snakeCase(ir.api.package_prefix).replace(/_/g, "");
  const files: Record<string, string> = {};
  const resourceTypes: string[] = [];

  for (const resource of ir.resources) {
    if (!resource.model_type_id) continue;
    const model = ir.types.find((type) => type.id === resource.model_type_id);
    if (!model || model.kind !== "object") continue;
    const operations = ir.operations.filter((operation) => operation.resource_id === resource.id);
    const hasCreate = operations.some((operation) => operation.http_method === "post");
    if (!hasCreate) continue;

    const tfName = `${providerName}_${snakeCase(resource.name)}`;
    resourceTypes.push(`&${pascalCase(resource.name)}Resource{}`);
    const attributes = model.fields
      .map((field) => {
        const tfType = terraformAttrType(field.type);
        const computed = field.read_only || field.name === "id";
        return `\t\t\t${JSON.stringify(field.wire_name)}: schema.${tfType}Attribute{\n\t\t\t\tOptional: ${computed ? "false" : "true"},\n\t\t\t\tComputed: ${computed ? "true" : "false"},\n\t\t\t},`;
      })
      .join("\n");

    files[`internal/provider/${snakeCase(resource.name)}_resource.go`] = `package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
)

// ${pascalCase(resource.name)}Resource manages a ${resource.name} (${tfName}).
type ${pascalCase(resource.name)}Resource struct{}

func (r *${pascalCase(resource.name)}Resource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_${snakeCase(resource.name)}"
}

func (r *${pascalCase(resource.name)}Resource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Attributes: map[string]schema.Attribute{
${attributes}
		},
	}
}

func (r *${pascalCase(resource.name)}Resource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
}

func (r *${pascalCase(resource.name)}Resource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
}

func (r *${pascalCase(resource.name)}Resource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
}

func (r *${pascalCase(resource.name)}Resource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
}
`;
  }

  files["internal/provider/provider.go"] = `package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/provider"
	"github.com/hashicorp/terraform-plugin-framework/provider/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource"
)

// ${pascalCase(providerName)}Provider is the generated Terraform provider for ${ir.api.name}.
type ${pascalCase(providerName)}Provider struct{}

func New() provider.Provider {
	return &${pascalCase(providerName)}Provider{}
}

func (p *${pascalCase(providerName)}Provider) Metadata(_ context.Context, _ provider.MetadataRequest, resp *provider.MetadataResponse) {
	resp.TypeName = ${JSON.stringify(providerName)}
}

func (p *${pascalCase(providerName)}Provider) Schema(_ context.Context, _ provider.SchemaRequest, resp *provider.SchemaResponse) {
	resp.Schema = schema.Schema{}
}

func (p *${pascalCase(providerName)}Provider) Configure(_ context.Context, _ provider.ConfigureRequest, _ *provider.ConfigureResponse) {
}

func (p *${pascalCase(providerName)}Provider) Resources(_ context.Context) []func() resource.Resource {
	return []func() resource.Resource{
${resourceTypes.map((type) => `\t\tfunc() resource.Resource { return ${type} },`).join("\n")}
	}
}

func (p *${pascalCase(providerName)}Provider) DataSources(_ context.Context) []func() datasource.DataSource {
	return nil
}
`;

  files["main.go"] = `package main

import (
	"context"
	"log"

	"github.com/hashicorp/terraform-plugin-framework/providerserver"

	"terraform-provider-${providerName}/internal/provider"
)

func main() {
	if err := providerserver.Serve(context.Background(), provider.New, providerserver.ServeOpts{
		Address: "registry.terraform.io/${ir.targets.go?.module_path?.split("/")[1] ?? ir.api.package_prefix}/${providerName}",
	}); err != nil {
		log.Fatal(err)
	}
}
`;

  files["go.mod"] = `module terraform-provider-${providerName}

go 1.23

require github.com/hashicorp/terraform-plugin-framework v1.11.0
`;

  files["README.md"] = `# ${ir.api.name} Terraform Provider (scaffold)

Generated provider scaffolding using terraform-plugin-framework. Run \`go mod download\`
then \`go build\` to compile against the framework. CRUD bodies are stubs to be wired to
the generated Go SDK.
`;

  return files;
}

// ---------- React / TanStack Query hooks ----------

/** A TypeScript subpackage of TanStack Query hooks over the generated SDK. */
export function renderReactFiles(ir: ApiIR): Record<string, string> {
  const clientName = ir.client.name;
  const sdkPkg = ir.targets.typescript?.package_name ?? `@${snakeCase(ir.api.package_prefix).replace(/_/g, "-")}/sdk`;
  const hooks: string[] = [];

  for (const operation of ir.operations) {
    const resource = resourceById(ir, operation.resource_id);
    if (!resource) continue;
    const accessor = resource.path_segments.join(".");
    const hookBase = `use${resource.path_segments.map((s) => pascalCase(s)).join("")}${pascalCase(operation.name)}`;
    const isQuery = operation.http_method === "get" && !operation.streaming;
    const shape = paginationShape(ir, operation);

    if (shape && isQuery) {
      hooks.push(`    ${hookBase}Infinite: (params?: any, options?: any) =>
      useInfiniteQuery({
        queryKey: ${JSON.stringify([`${accessor}.${operation.name}`])}.concat(params ? [params] : []),
        queryFn: ({ pageParam }: any) => client.${accessor}.${operation.name}({ ...params, ...(pageParam ?? {}) }),
        initialPageParam: {},
        getNextPageParam: () => undefined,
        ...options,
      }),`);
    }
    if (isQuery) {
      hooks.push(`    ${hookBase}: (params?: any, options?: any) =>
      useQuery({ queryKey: ${JSON.stringify([`${accessor}.${operation.name}`])}.concat(params ? [params] : []), queryFn: () => client.${accessor}.${operation.name}(params), ...options }),`);
    } else if (!operation.streaming) {
      hooks.push(`    ${hookBase}: (options?: any) =>
      useMutation({ mutationFn: (params: any) => client.${accessor}.${operation.name}(params), ...options }),`);
    }
  }

  const pkg = {
    name: `${sdkPkg.replace(/^@/, "").replace(/\//g, "-")}-react`,
    version: ir.api.version ?? "0.1.0",
    private: true,
    type: "module",
    peerDependencies: { react: ">=18", "@tanstack/react-query": ">=5", [sdkPkg]: "*" },
    scripts: { typecheck: "tsc -p tsconfig.json --noEmit" },
    devDependencies: { typescript: "^6.0.3" },
  };

  const tsconfig = {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
    },
    include: ["src/**/*.ts", "src/**/*.d.ts"],
  };

  // Verify-only ambient shims so the hooks typecheck offline; consumers install the real packages.
  const shims = `declare module "@tanstack/react-query" {
  export function useQuery(options: any): any;
  export function useMutation(options: any): any;
  export function useInfiniteQuery(options: any): any;
}
declare module ${JSON.stringify(sdkPkg)} {
  export default class ${clientName} {
    [key: string]: any;
    constructor(options?: any);
  }
}
`;

  const hooksFile = `import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import type ${clientName} from ${JSON.stringify(sdkPkg)};

/** Create typed TanStack Query hooks bound to a ${ir.api.name} client instance. */
export function createHooks(client: ${clientName}) {
  return {
${hooks.join("\n")}
  };
}
`;

  return {
    "package.json": JSON.stringify(pkg, null, 2),
    "tsconfig.json": JSON.stringify(tsconfig, null, 2),
    "src/_shims.d.ts": shims,
    "src/hooks.ts": hooksFile,
    "README.md": `# ${ir.api.name} React Hooks\n\nTanStack Query hooks. Install \`react\`, \`@tanstack/react-query\`, and \`${sdkPkg}\`.\n\n\`\`\`ts\nimport { createHooks } from "${pkg.name}";\nconst hooks = createHooks(client);\n\`\`\`\n`,
  };
}

// ---------- GitHub automation ----------

/** CI + auto-regeneration workflows for the SDK monorepo (clean-room GitHub App analogue). */
export function renderAutomationFiles(ir: ApiIR): Record<string, string> {
  const ci = `name: sdks
on:
  push:
    branches: [main]
  pull_request:
jobs:
  generate-and-verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - uses: actions/setup-go@v5
        with:
          go-version: "1.23"
      - run: npm ci
      - run: npx sdkgen lint
      - run: npx sdkgen generate --no-overlay
      - run: npx sdkgen verify
`;

  const regenerate = `name: regenerate
on:
  push:
    paths:
      - "openapi.yaml"
      - "sdkgen.yml"
permissions:
  contents: write
  pull-requests: write
jobs:
  regenerate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
      - run: npm ci
      - run: npx sdkgen generate
      - run: npx sdkgen release
      # Opens a release PR with the regenerated SDKs and changelog.
      - uses: peter-evans/create-pull-request@v6
        with:
          branch: sdkgen/release
          title: "release: regenerate ${ir.api.name} SDKs"
          commit-message: "chore: regenerate SDKs from spec"
          body-path: .sdkgen/release-notes.md
`;

  const provenance = `name: supply-chain
on:
  push:
    tags: ["v*"]
permissions:
  contents: read
  id-token: write
  attestations: write
jobs:
  attest:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # SLSA build provenance + SBOM attestation for every generated artifact.
      - uses: actions/attest-build-provenance@v1
        with:
          subject-path: "generated/**/dist/**"
`;

  return {
    ".github/workflows/sdks.yml": ci,
    ".github/workflows/regenerate.yml": regenerate,
    ".github/workflows/supply-chain.yml": provenance,
  };
}

function terraformAttrType(ref: TypeRefIR): string {
  if (ref.kind === "primitive") {
    if (ref.name === "integer" || ref.name === "number") return "Number";
    if (ref.name === "boolean") return "Bool";
    return "String";
  }
  if (ref.kind === "array") return "List";
  if (ref.kind === "map") return "Map";
  return "String";
}
