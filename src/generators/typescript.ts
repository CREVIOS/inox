import type {
  ApiIR,
  FieldIR,
  GenerationResult,
  ObjectTypeIR,
  OperationIR,
  ParamIR,
  ResourceIR,
  TypeIR,
  TypeRefIR,
} from "../types.js";
import { camelCase, indent, pascalCase, quote, snakeCase } from "../utils.js";
import { renderTsConformanceTest } from "../conformance.js";
import { renderReleaseWorkflow } from "../release.js";
import {
  childResources,
  createTargetWriter,
  emittedResources,
  operationTypeName,
  paginationShape,
  resourceFileSlug,
  streamEventType,
  targetOperationsForResource,
  topLevelResources,
  tsDoc,
  typeById,
} from "./common.js";

export async function generateTypeScript(ir: ApiIR, rootOutDir: string): Promise<GenerationResult> {
  const writer = createTargetWriter("typescript", rootOutDir);
  const packageName = ir.targets.typescript?.package_name ?? `@${snakeCase(ir.api.package_prefix).replace(/_/g, "-")}/sdk`;

  await writer.write(
    "package.json",
    JSON.stringify(
      {
        name: packageName,
        version: ir.api.version ?? "0.1.0",
        type: "module",
        main: "./dist/index.js",
        types: "./dist/index.d.ts",
        exports: {
          ".": {
            types: "./dist/index.d.ts",
            default: "./dist/index.js",
          },
        },
        scripts: {
          build: "tsc -p tsconfig.json",
          typecheck: "tsc -p tsconfig.json --noEmit",
          test: "npm run build --silent && node --test",
        },
        devDependencies: {
          "@types/node": "^25.9.1",
          typescript: "^6.0.3",
        },
      },
      null,
      2,
    ),
  );

  await writer.write(
    "tsconfig.json",
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          lib: ["ES2022", "DOM"],
          strict: true,
          declaration: true,
          outDir: "dist",
          rootDir: "src",
          types: ["node"],
          skipLibCheck: true,
        },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    ),
  );

  await writer.write("src/core.ts", renderTypeScriptCore());
  await writer.write("src/validation.ts", renderTypeScriptValidation(ir));
  await writer.write("src/otel.ts", renderTypeScriptOtel());
  await writer.write("src/index.ts", renderTypeScriptIndex(ir));
  await writer.write("src/client.ts", renderTypeScriptClient(ir));
  await writer.write("test/smoke.test.mjs", `import assert from "node:assert/strict";\n\nassert.equal(1 + 1, 2);\n`);
  await writer.write("test/endpoints.test.mjs", renderTsConformanceTest(ir));
  if (ir.webhooks) {
    await writer.write("src/webhooks.ts", renderTypeScriptWebhooks(ir));
    await writer.write("test/webhooks.test.mjs", renderTypeScriptWebhookTest(ir));
  }

  for (const type of ir.types) {
    await writer.write(`src/types/${snakeCase(type.name)}.ts`, renderTypeScriptType(ir, type));
  }

  for (const resource of emittedResources(ir, "typescript")) {
    await writer.write(`src/resources/${resourceFileSlug(resource)}.ts`, renderTypeScriptResource(ir, resource));
  }

  await writer.write(".github/workflows/release.yml", renderReleaseWorkflow("typescript", ir));
  await writer.write("README.md", renderTypeScriptReadme(ir));
  return writer.result();
}

function renderTypeScriptIndex(ir: ApiIR): string {
  const lines = [
    `export { ${ir.client.name} as default, ${ir.client.name} } from "./client.js";`,
    `export * from "./core.js";`,
    `export { ResponseValidationError } from "./validation.js";`,
    `export { createOtelHooks } from "./otel.js";`,
    `export type { OtelTracer, OtelSpan } from "./otel.js";`,
    ...(ir.webhooks ? [`export * from "./webhooks.js";`] : []),
    ...ir.types.map((type) => `export * from "./types/${snakeCase(type.name)}.js";`),
  ];
  return lines.join("\n");
}

function renderTypeScriptOtel(): string {
  return `// Optional OpenTelemetry instrumentation. Zero dependency: pass any tracer matching the
// minimal OtelTracer interface (e.g. \`trace.getTracer("name")\` from @opentelemetry/api).
// Emits one CLIENT span per HTTP attempt with stable HTTP semantic-convention attributes
// (https://opentelemetry.io/docs/specs/semconv/http/http-spans/). Wire via:
//   new Client({ hooks: createOtelHooks(trace.getTracer("acme")) })
import type { ClientHooks } from "./core.js";

export interface OtelSpan {
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus(status: { code: number; message?: string }): void;
  recordException?(error: unknown): void;
  end(): void;
}

export interface OtelTracer {
  startSpan(name: string, options?: { kind?: number }): OtelSpan;
}

const SPAN_KIND_CLIENT = 3; // SpanKind.CLIENT
const STATUS_ERROR = 2; // SpanStatusCode.ERROR

export function createOtelHooks(tracer: OtelTracer): ClientHooks {
  const spans = new Map<string, OtelSpan>();
  const key = (method: string, url: string, attempt: number): string => \`\${method} \${url} #\${attempt}\`;
  return {
    onRequest(info) {
      let host = "";
      let port: number | undefined;
      let full = info.url;
      try {
        const parsed = new URL(info.url);
        host = parsed.hostname;
        port = parsed.port ? Number(parsed.port) : undefined;
        full = parsed.href;
      } catch {
        // leave defaults when the URL is not absolute
      }
      const span = tracer.startSpan(info.method, { kind: SPAN_KIND_CLIENT });
      span.setAttribute("http.request.method", info.method);
      span.setAttribute("url.full", full);
      if (host) span.setAttribute("server.address", host);
      if (port !== undefined) span.setAttribute("server.port", port);
      if (info.attempt > 0) span.setAttribute("http.request.resend_count", info.attempt);
      spans.set(key(info.method, info.url, info.attempt), span);
    },
    onResponse(info) {
      const span = spans.get(key(info.method, info.url, info.attempt));
      if (!span) return;
      span.setAttribute("http.response.status_code", info.status);
      if (info.status >= 400) span.setStatus({ code: STATUS_ERROR });
      span.end();
      spans.delete(key(info.method, info.url, info.attempt));
    },
    onError(info) {
      const span = spans.get(key(info.method, info.url, info.attempt));
      if (!span) return;
      span.setAttribute("error.type", info.error instanceof Error ? info.error.name : "error");
      span.setStatus({ code: STATUS_ERROR, message: info.error instanceof Error ? info.error.message : String(info.error) });
      span.recordException?.(info.error);
      span.end();
      spans.delete(key(info.method, info.url, info.attempt));
    },
  };
}
`;
}

function renderTypeScriptValidation(ir: ApiIR): string {
  const refToJson = (ref: TypeRefIR): string => {
    if (ref.kind === "ref") return `{ k: "ref", id: ${quote(typeById(ir, ref.id)?.name ?? "unknown")}${ref.nullable ? ", nullable: true" : ""} }`;
    if (ref.kind === "array") return `{ k: "array", items: ${refToJson(ref.items)}${ref.nullable ? ", nullable: true" : ""} }`;
    if (ref.kind === "map") return `{ k: "map", values: ${refToJson(ref.values)}${ref.nullable ? ", nullable: true" : ""} }`;
    if (ref.kind === "file") return `{ k: "file"${ref.nullable ? ", nullable: true" : ""} }`;
    return `{ k: "prim", n: ${quote(ref.name)}${ref.nullable ? ", nullable: true" : ""} }`;
  };
  const schemas = ir.types
    .map((type) => {
      if (type.kind === "object") {
        const fields = type.fields
          .map((field) => `{ name: ${quote(field.wire_name)}, required: ${field.required}, ref: ${refToJson(field.type)} }`)
          .join(", ");
        return `  ${quote(type.name)}: { kind: "object", fields: [${fields}] },`;
      }
      if (type.kind === "enum") return `  ${quote(type.name)}: { kind: "enum" },`;
      if (type.kind === "alias") return `  ${quote(type.name)}: { kind: "alias", target: ${refToJson(type.target)} },`;
      return `  ${quote(type.name)}: { kind: "union" },`;
    })
    .join("\n");

  return `// Optional, dependency-free runtime response validation. Enable with
// \`new ${ir.client.name}({ validateResponses: true })\` to verify API responses match the
// generated types at runtime and fail fast on drift, instead of unsafely casting.

export class ResponseValidationError extends Error {
  readonly path: string;
  constructor(path: string, detail: string) {
    super(\`response validation failed at \${path}: \${detail}\`);
    this.path = path;
    this.name = "ResponseValidationError";
  }
}

type Ref =
  | { k: "prim"; n: string; nullable?: boolean }
  | { k: "ref"; id: string; nullable?: boolean }
  | { k: "array"; items: Ref; nullable?: boolean }
  | { k: "map"; values: Ref; nullable?: boolean }
  | { k: "file"; nullable?: boolean };

type Schema =
  | { kind: "object"; fields: { name: string; required: boolean; ref: Ref }[] }
  | { kind: "enum" }
  | { kind: "alias"; target: Ref }
  | { kind: "union" };

const SCHEMAS: Record<string, Schema> = {
${schemas}
};

export function validate(value: unknown, typeName: string): void {
  checkRef(value, { k: "ref", id: typeName }, "$");
}

function checkRef(value: unknown, ref: Ref, path: string): void {
  if (value === null || value === undefined) {
    if (ref.nullable) return;
    throw new ResponseValidationError(path, "unexpected null");
  }
  if (ref.k === "prim") {
    if ((ref.n === "integer" || ref.n === "number") && typeof value !== "number") throw new ResponseValidationError(path, "expected number");
    if (ref.n === "boolean" && typeof value !== "boolean") throw new ResponseValidationError(path, "expected boolean");
    if (ref.n === "string" && typeof value !== "string") throw new ResponseValidationError(path, "expected string");
    return;
  }
  if (ref.k === "file") return;
  if (ref.k === "array") {
    if (!Array.isArray(value)) throw new ResponseValidationError(path, "expected array");
    value.forEach((item, index) => checkRef(item, ref.items, \`\${path}[\${index}]\`));
    return;
  }
  if (ref.k === "map") {
    if (typeof value !== "object") throw new ResponseValidationError(path, "expected object");
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) checkRef(item, ref.values, \`\${path}.\${key}\`);
    return;
  }
  const schema = SCHEMAS[ref.id];
  if (!schema) return;
  if (schema.kind === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ResponseValidationError(path, \`expected object \${ref.id}\`);
    const obj = value as Record<string, unknown>;
    for (const field of schema.fields) {
      const present = field.name in obj && obj[field.name] !== undefined;
      if (!present) {
        if (field.required) throw new ResponseValidationError(\`\${path}.\${field.name}\`, "missing required field");
        continue;
      }
      checkRef(obj[field.name], field.ref, \`\${path}.\${field.name}\`);
    }
  } else if (schema.kind === "alias") {
    checkRef(value, schema.target, path);
  }
}
`;
}

function renderTypeScriptClient(ir: ApiIR): string {
  const basic = ir.client.auth?.basic;
  const basicUserEnv = basic?.username_env ?? `${ir.client.env_prefix}_USERNAME`;
  const basicPassEnv = basic?.password_env ?? `${ir.client.env_prefix}_PASSWORD`;
  const basicBlock = basic
    ? `
    const basicUser = options.username ?? process.env.${basicUserEnv};
    const basicPass = options.password ?? process.env.${basicPassEnv};
    const basicAuth = basicUser && basicPass ? "Basic " + Buffer.from(\`\${basicUser}:\${basicPass}\`).toString("base64") : undefined;`
    : "";
  const basicOption = basic ? "\n      basicAuth," : "";
  const resources = topLevelResources(ir, "typescript");
  const imports = resources.map(
    (resource) => `import { ${resource.class_name}Resource } from "./resources/${resourceFileSlug(resource)}.js";`,
  );
  const webhookImport = ir.webhooks ? `import { WebhookClient } from "./webhooks.js";` : "";
  const validationImport = `import { validate } from "./validation.js";`;
  const fields = [
    ...resources.map((resource) => `  readonly ${resource.name}: ${resource.class_name}Resource;`),
    ...(ir.webhooks ? [`  readonly webhooks: WebhookClient;`] : []),
  ];
  const initializers = [
    ...resources.map((resource) => `    this.${resource.name} = new ${resource.class_name}Resource(this._client);`),
    ...(ir.webhooks ? [`    this.webhooks = new WebhookClient({ secret: options.webhookSecret });`] : []),
  ];

  return `${imports.join("\n")}
${webhookImport}
${validationImport}
import { ApiClient, type ClientOptions } from "./core.js";

export class ${ir.client.name} {
  private readonly _client: ApiClient;
${fields.join("\n")}

  static readonly environments: Record<string, string> = ${JSON.stringify(ir.client.environments)};

  constructor(options: ClientOptions = {}) {
    const baseUrl = options.baseUrl ?? (options.environment ? ${ir.client.name}.environments[options.environment] : undefined) ?? ${quote(ir.client.default_environment ? ir.client.environments[ir.client.default_environment] ?? ir.client.base_url : ir.client.base_url)};${basicBlock}
    this._client = new ApiClient({
      baseUrl,
      apiKey: options.apiKey ?? process.env.${ir.client.env_prefix}_API_KEY,${basicOption}
      timeoutMs: options.timeoutMs ?? ${ir.client.timeout_ms},
      maxRetries: options.maxRetries ?? ${ir.client.retry_policy.max_retries},
      retryStatuses: options.retryStatuses ?? ${JSON.stringify(ir.client.retry_policy.retry_statuses)},
      packageVersion: ${quote(ir.api.version ?? "0.1.0")},
      omitStainlessHeaders: options.omitStainlessHeaders ?? ${JSON.stringify(ir.client.omit_stainless_headers)},
      idempotencyHeader: options.idempotencyHeader ?? ${JSON.stringify(ir.client.idempotency_header ?? null)},
      hooks: options.hooks,
      validateResponses: options.validateResponses ?? false,
      validate,${
        ir.client.oauth2
          ? `
      oauth2: {
        tokenUrl: ${quote(ir.client.oauth2.token_url)},
        scopes: ${JSON.stringify(ir.client.oauth2.scopes)},
        authStyle: ${quote(ir.client.oauth2.auth_style)},
        clientId: options.clientId ?? process.env.${ir.client.oauth2.client_id_env},
        clientSecret: options.clientSecret ?? process.env.${ir.client.oauth2.client_secret_env},
      },`
          : ""
      }
    });
${initializers.join("\n")}
  }
}
`;
}

function renderTypeScriptCore(): string {
  return `export interface ClientOptions {
  apiKey?: string;
  clientId?: string;
  clientSecret?: string;
  username?: string;
  password?: string;
  baseUrl?: string;
  environment?: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryStatuses?: number[];
  packageVersion?: string;
  omitStainlessHeaders?: boolean;
  idempotencyHeader?: string | null;
  webhookSecret?: string;
  hooks?: ClientHooks;
  validateResponses?: boolean;
}

export interface OAuth2Config {
  tokenUrl: string;
  scopes: string[];
  authStyle: "post" | "basic";
  clientId?: string;
  clientSecret?: string;
}

/** Observability hooks. Wire OpenTelemetry/metrics/logging here; default is no-op (zero deps). */
export interface RequestHookInfo {
  method: string;
  url: string;
  attempt: number;
}
export interface ResponseHookInfo extends RequestHookInfo {
  status: number;
  durationMs: number;
}
export interface ErrorHookInfo extends RequestHookInfo {
  error: unknown;
}
export interface ClientHooks {
  onRequest?: (info: RequestHookInfo) => void;
  onResponse?: (info: ResponseHookInfo) => void;
  onError?: (info: ErrorHookInfo) => void;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
  multipart?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRetries?: number;
  idempotencyKey?: string;
  responseType?: string;
  /** When true, the success response body is returned as raw bytes (binary download). */
  binary?: boolean;
}

export interface StreamOptions extends RequestOptions {
  sse?: boolean;
  doneSentinel?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    super(\`API request failed with status \${status}\`);
    this.status = status;
    this.body = body;
  }
}

/** Async-iterable wrapper over an SSE or JSONL response body. */
export class Stream<T> implements AsyncIterable<T> {
  constructor(
    private readonly body: ReadableStream<Uint8Array>,
    private readonly sse: boolean,
    private readonly doneSentinel?: string,
  ) {}

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    const decoder = new TextDecoder();
    let buffer = "";
    let dataLines: string[] = [];
    for await (const chunk of this.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);
        if (this.sse) {
          if (line === "") {
            const event = this.flush(dataLines);
            dataLines = [];
            if (event === DONE) return;
            if (event !== undefined) yield event as T;
            continue;
          }
          if (line.startsWith(":")) continue;
          if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
        } else if (line.trim() !== "") {
          if (this.doneSentinel !== undefined && line.trim() === this.doneSentinel) return;
          yield JSON.parse(line) as T;
        }
      }
    }
    if (this.sse) {
      const event = this.flush(dataLines);
      if (event !== undefined && event !== DONE) yield event as T;
    } else if (buffer.trim() !== "") {
      yield JSON.parse(buffer) as T;
    }
  }

  private flush(dataLines: string[]): T | typeof DONE | undefined {
    if (dataLines.length === 0) return undefined;
    const data = dataLines.join("\\n");
    if (this.doneSentinel !== undefined && data === this.doneSentinel) return DONE;
    return JSON.parse(data) as T;
  }

  private readonly listeners: { chunk: Array<(value: T) => void>; end: Array<() => void>; error: Array<(error: unknown) => void> } = { chunk: [], end: [], error: [] };
  private consuming = false;

  /** Event-emitter API over the stream. Use this OR async iteration, not both. Chainable. */
  on(event: "chunk", listener: (value: T) => void): this;
  on(event: "end", listener: () => void): this;
  on(event: "error", listener: (error: unknown) => void): this;
  on(event: "chunk" | "end" | "error", listener: (arg?: any) => void): this {
    (this.listeners[event] as Array<(arg?: any) => void>).push(listener);
    this.consume();
    return this;
  }

  private consume(): void {
    if (this.consuming) return;
    this.consuming = true;
    // Defer so all chained .on(...) listeners register before consumption begins.
    queueMicrotask(async () => {
      try {
        for await (const value of this) for (const cb of this.listeners.chunk) cb(value);
        for (const cb of this.listeners.end) cb();
      } catch (error) {
        if (this.listeners.error.length > 0) for (const cb of this.listeners.error) cb(error);
        else throw error;
      }
    });
  }
}

const DONE = Symbol("stream.done");

/** Typed bidirectional WebSocket connection. */
export class WebSocketConnection<ClientEvent, ServerEvent> {
  constructor(private readonly ws: WebSocket) {}

  onOpen(handler: () => void): this {
    this.ws.addEventListener("open", () => handler());
    return this;
  }

  onMessage(handler: (event: ServerEvent) => void): this {
    this.ws.addEventListener("message", (event: MessageEvent) => {
      const data = typeof event.data === "string" ? event.data : String(event.data);
      handler(JSON.parse(data) as ServerEvent);
    });
    return this;
  }

  onClose(handler: () => void): this {
    this.ws.addEventListener("close", () => handler());
    return this;
  }

  send(event: ClientEvent): void {
    this.ws.send(JSON.stringify(event));
  }

  close(): void {
    this.ws.close();
  }

  get socket(): WebSocket {
    return this.ws;
  }
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryStatuses: Set<number>;
  private readonly packageVersion: string;
  private readonly omitStainlessHeaders: boolean;
  private readonly idempotencyHeader?: string | null;
  private readonly oauth2?: OAuth2Config;
  private readonly basicAuth?: string;
  private readonly hooks?: ClientHooks;
  private readonly validateResponses: boolean;
  private readonly validate?: (value: unknown, typeName: string) => void;
  private cachedToken?: string;
  private tokenExpiresAt = 0;

  constructor(options: Required<Pick<ClientOptions, "baseUrl" | "timeoutMs" | "maxRetries" | "retryStatuses">> & Pick<ClientOptions, "apiKey" | "packageVersion" | "omitStainlessHeaders" | "idempotencyHeader" | "hooks"> & { oauth2?: OAuth2Config; basicAuth?: string; validateResponses?: boolean; validate?: (value: unknown, typeName: string) => void }) {
    this.baseUrl = options.baseUrl.replace(/\\/$/, "");
    this.apiKey = options.apiKey;
    this.basicAuth = options.basicAuth;
    this.timeoutMs = options.timeoutMs;
    this.maxRetries = options.maxRetries;
    this.retryStatuses = new Set(options.retryStatuses);
    this.packageVersion = options.packageVersion ?? "0.1.0";
    this.omitStainlessHeaders = options.omitStainlessHeaders ?? false;
    this.idempotencyHeader = options.idempotencyHeader;
    this.oauth2 = options.oauth2;
    this.hooks = options.hooks;
    this.validateResponses = options.validateResponses ?? false;
    this.validate = options.validate;
  }

  /** OAuth2 client-credentials: fetch, cache, and refresh the bearer token. */
  private async getAccessToken(force = false): Promise<string | undefined> {
    if (!this.oauth2?.clientId || !this.oauth2?.clientSecret) return undefined;
    if (!force && this.cachedToken && Date.now() < this.tokenExpiresAt) return this.cachedToken;
    const tokenUrl = this.oauth2.tokenUrl.startsWith("http") ? this.oauth2.tokenUrl : \`\${this.baseUrl}\${this.oauth2.tokenUrl}\`;
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
    const params = new URLSearchParams({ grant_type: "client_credentials" });
    if (this.oauth2.scopes.length) params.set("scope", this.oauth2.scopes.join(" "));
    if (this.oauth2.authStyle === "basic") {
      headers.authorization = "Basic " + Buffer.from(\`\${this.oauth2.clientId}:\${this.oauth2.clientSecret}\`).toString("base64");
    } else {
      params.set("client_id", this.oauth2.clientId);
      params.set("client_secret", this.oauth2.clientSecret);
    }
    const response = await fetch(tokenUrl, { method: "POST", headers, body: params.toString() });
    if (!response.ok) throw new ApiError(response.status, await response.text());
    const data = (await response.json()) as { access_token: string; expires_in?: number };
    this.cachedToken = data.access_token;
    this.tokenExpiresAt = Date.now() + ((data.expires_in ?? 3600) - 30) * 1000;
    return this.cachedToken;
  }

  private async resolveBearer(): Promise<string | undefined> {
    if (this.oauth2?.clientId && this.oauth2?.clientSecret) return this.getAccessToken();
    return this.apiKey;
  }

  private buildUrl(path: string, query: Record<string, unknown> | undefined): URL {
    const url = new URL(\`\${this.baseUrl}\${path}\`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, String(item));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    return url;
  }

  private buildHeaders(method: string, options: RequestOptions, attempt: number, streaming: boolean, bearer: string | undefined): { headers: Record<string, string>; body: BodyInit | undefined } {
    const headers: Record<string, string> = {
      accept: streaming ? "text/event-stream" : "application/json",
      ...options.headers,
    };
    if (!this.omitStainlessHeaders) {
      headers["x-stainless-lang"] = "typescript";
      headers["x-stainless-package-version"] = this.packageVersion;
      headers["x-stainless-runtime"] = "node";
      headers["x-stainless-runtime-version"] = process.version;
      headers["x-stainless-timeout"] = String((options.timeoutMs ?? this.timeoutMs) / 1000);
      headers["x-stainless-retry-count"] = String(attempt);
    }
    if (bearer) headers.authorization = \`Bearer \${bearer}\`;
    else if (this.basicAuth) headers.authorization = this.basicAuth;

    let body: BodyInit | undefined;
    if (options.multipart && options.body && typeof options.body === "object") {
      body = toFormData(options.body as Record<string, unknown>);
      // content-type (with boundary) is set by fetch for FormData bodies.
    } else if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    if (this.idempotencyHeader && method.toLowerCase() !== "get" && !hasHeader(headers, this.idempotencyHeader)) {
      headers[this.idempotencyHeader] = options.idempotencyKey ?? \`stainless-retry-\${randomId()}\`;
    }
    return { headers, body };
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    return (await this.requestRaw<T>(method, path, options)).data;
  }

  /** Like request(), but returns the parsed data alongside the raw Response. */
  async requestRaw<T>(method: string, path: string, options: RequestOptions = {}): Promise<{ data: T; response: Response }> {
    const url = this.buildUrl(path, options.query);
    let lastError: unknown;
    let bearer = await this.resolveBearer();
    let refreshed = false;
    const maxRetries = options.maxRetries ?? this.maxRetries;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const { headers, body } = this.buildHeaders(method, options, attempt, false, bearer);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? this.timeoutMs);
      const startedAt = Date.now();
      const hookInfo = { method: method.toUpperCase(), url: url.toString(), attempt };
      this.hooks?.onRequest?.(hookInfo);
      try {
        const response = await fetch(url, { method: method.toUpperCase(), headers, body, signal: options.signal ?? controller.signal });
        clearTimeout(timeout);
        this.hooks?.onResponse?.({ ...hookInfo, status: response.status, durationMs: Date.now() - startedAt });
        if (options.binary && response.ok) {
          return { data: new Uint8Array(await response.arrayBuffer()) as T, response };
        }
        const responseText = await response.text();
        const parsed = responseText ? JSON.parse(responseText) : undefined;
        if (response.ok) {
          if (this.validateResponses && options.responseType && parsed !== undefined && this.validate) {
            this.validate(parsed, options.responseType);
          }
          return { data: parsed as T, response };
        }
        if (response.status === 401 && this.oauth2?.clientId && !refreshed) {
          refreshed = true;
          bearer = await this.getAccessToken(true);
          continue;
        }
        if (attempt < maxRetries && shouldRetryResponse(response, this.retryStatuses)) {
          await sleep(backoffMs(attempt, response.headers.get("retry-after"), response.headers.get("retry-after-ms")));
          continue;
        }
        throw new ApiError(response.status, parsed);
      } catch (error) {
        clearTimeout(timeout);
        lastError = error;
        this.hooks?.onError?.({ ...hookInfo, error });
        if (error instanceof ApiError) throw error;
        if (attempt >= maxRetries) throw error;
        await sleep(backoffMs(attempt));
      }
    }
    throw lastError;
  }

  /** Issues a request and returns a typed event stream (SSE or JSONL). Streaming requests are not retried. */
  async stream<T>(method: string, path: string, options: StreamOptions = {}): Promise<Stream<T>> {
    const url = this.buildUrl(path, options.query);
    const bearer = await this.resolveBearer();
    const { headers, body } = this.buildHeaders(method, options, 0, true, bearer);
    const controller = new AbortController();
    const response = await fetch(url, { method: method.toUpperCase(), headers, body, signal: options.signal ?? controller.signal });
    if (!response.ok) {
      const text = await response.text();
      throw new ApiError(response.status, text ? safeJson(text) : undefined);
    }
    if (!response.body) throw new ApiError(response.status, "missing response stream body");
    return new Stream<T>(response.body, options.sse ?? true, options.doneSentinel);
  }

  /** Opens a typed WebSocket connection to the given path. */
  connectWebSocket<ClientEvent, ServerEvent>(path: string): WebSocketConnection<ClientEvent, ServerEvent> {
    const wsUrl = this.baseUrl.replace(/^http/, "ws") + path;
    return new WebSocketConnection<ClientEvent, ServerEvent>(new WebSocket(wsUrl));
  }

  /** Follows an absolute URL returned by cursor_url pagination. */
  async requestAbsolute<T>(absoluteUrl: string, options: RequestOptions = {}): Promise<T> {
    const path = absoluteUrl.startsWith(this.baseUrl) ? absoluteUrl.slice(this.baseUrl.length) : new URL(absoluteUrl).pathname + new URL(absoluteUrl).search;
    return this.request<T>("get", path, options);
  }

  /** Like requestAbsolute(), but returns the raw Response too (for Link-header pagination). */
  async requestAbsoluteRaw<T>(absoluteUrl: string, options: RequestOptions = {}): Promise<{ data: T; response: Response }> {
    const path = absoluteUrl.startsWith(this.baseUrl) ? absoluteUrl.slice(this.baseUrl.length) : new URL(absoluteUrl).pathname + new URL(absoluteUrl).search;
    return this.requestRaw<T>("get", path, options);
  }

  /** Parses an RFC 5988 Link header and returns the rel="next" URL, if present. */
  nextLink(response: Response): string | undefined {
    const value = response.headers.get("link");
    if (!value) return undefined;
    for (const part of value.split(",")) {
      const match = part.match(/<([^>]+)>\\s*;\\s*rel="?next"?/);
      if (match) return match[1];
    }
    return undefined;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toFormData(body: Record<string, unknown>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;
    if (value instanceof Blob) form.append(key, value);
    else if (value instanceof ArrayBuffer) form.append(key, new Blob([value]));
    else if (ArrayBuffer.isView(value)) form.append(key, new Blob([value as unknown as BlobPart]));
    else if (typeof value === "object") form.append(key, JSON.stringify(value));
    else form.append(key, String(value));
  }
  return form;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetryResponse(response: Response, retryStatuses: Set<number>): boolean {
  const shouldRetry = response.headers.get("x-should-retry")?.toLowerCase();
  if (shouldRetry === "true") return true;
  if (shouldRetry === "false") return false;
  return retryStatuses.has(response.status) || response.status >= 500;
}

function backoffMs(attempt: number, retryAfter?: string | null, retryAfterMs?: string | null): number {
  if (retryAfterMs) {
    const milliseconds = Number(retryAfterMs);
    if (Number.isFinite(milliseconds) && milliseconds >= 0 && milliseconds < 60_000) return milliseconds;
  }
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0 && seconds < 60) return seconds * 1000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) {
      const delay = date - Date.now();
      if (delay >= 0 && delay < 60_000) return delay;
    }
  }
  const base = Math.min(8000, 500 * 2 ** attempt);
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
}

function hasHeader(headers: Record<string, string>, headerName: string): boolean {
  const normalized = headerName.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === normalized);
}
`;
}

function renderTypeScriptWebhooks(ir: ApiIR): string {
  const webhook = ir.webhooks;
  if (!webhook) return "";
  const payloadType = webhook.payload_type_id ? typeById(ir, webhook.payload_type_id)?.name : undefined;
  const payloadImport = payloadType ? `import type { ${payloadType} } from "./types/${snakeCase(payloadType)}.js";\n` : "";
  const returnType = payloadType ?? "unknown";

  return `${payloadImport}import { createHmac, timingSafeEqual } from "node:crypto";

export type WebhookHeaders = Record<string, string | string[] | undefined> | { get(name: string): string | null };

export interface WebhookClientOptions {
  secret?: string;
  toleranceSeconds?: number;
}

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

export class WebhookClient {
  private readonly secret?: string;
  private readonly toleranceSeconds: number;

  constructor(options: WebhookClientOptions = {}) {
    this.secret = options.secret ?? process.env[${quote(webhook.signing_secret_env)}];
    this.toleranceSeconds = options.toleranceSeconds ?? ${webhook.tolerance_seconds};
  }

  unwrap(payload: string | Buffer, headers: WebhookHeaders): ${returnType} {
    this.verifySignature(payload, headers);
    return JSON.parse(payloadToString(payload)) as ${returnType};
  }

  verifySignature(payload: string | Buffer, headers: WebhookHeaders): true {
    if (!this.secret) {
      throw new WebhookVerificationError("Missing webhook signing secret");
    }

    const signatureHeader = getHeader(headers, ${quote(webhook.signature_header)});
    if (!signatureHeader) {
      throw new WebhookVerificationError("Missing webhook signature header");
    }

    const parsedHeader = parseSignatureHeader(signatureHeader);
    const timestamp = getHeader(headers, ${quote(webhook.timestamp_header)}) ?? parsedHeader.get("t");
    if (!timestamp) {
      throw new WebhookVerificationError("Missing webhook timestamp");
    }
    assertFreshTimestamp(timestamp, this.toleranceSeconds);

    const signature = parsedHeader.get("v1") ?? parsedHeader.get("sha256") ?? parsedHeader.get("signature") ?? parsedHeader.get("raw");
    if (!signature) {
      throw new WebhookVerificationError("Missing webhook signature value");
    }

    const signedPayload = \`\${timestamp}.\${payloadToString(payload)}\`;
    const expected = createHmac("sha256", this.secret).update(signedPayload).digest("hex");
    if (!secureCompareHex(expected, signature)) {
      throw new WebhookVerificationError("Webhook signature mismatch");
    }

    return true;
  }
}

function getHeader(headers: WebhookHeaders, name: string): string | undefined {
  if ("get" in headers && typeof headers.get === "function") {
    return headers.get(name) ?? headers.get(name.toLowerCase()) ?? undefined;
  }

  const normalized = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (key.toLowerCase() !== normalized || value === undefined) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

function parseSignatureHeader(value: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      if (trimmed) result.set("raw", trimmed);
      continue;
    }
    result.set(trimmed.slice(0, separator).trim().toLowerCase(), trimmed.slice(separator + 1).trim());
  }
  return result;
}

function assertFreshTimestamp(value: string, toleranceSeconds: number): void {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) {
    throw new WebhookVerificationError("Invalid webhook timestamp");
  }
  const age = Math.abs(Date.now() / 1000 - timestamp);
  if (age > toleranceSeconds) {
    throw new WebhookVerificationError("Webhook timestamp is outside the tolerance window");
  }
}

function payloadToString(payload: string | Buffer): string {
  return typeof payload === "string" ? payload : payload.toString("utf8");
}

function secureCompareHex(expected: string, actual: string): boolean {
  if (!/^[a-f0-9]+$/i.test(actual) || expected.length !== actual.length) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
}
`;
}

function renderTypeScriptType(ir: ApiIR, type: TypeIR): string {
  if (type.kind === "object") {
    return renderTypeScriptObject(ir, type);
  }
  if (type.kind === "enum") {
    const literals = type.values.map((value) => JSON.stringify(value)).join(" | ") || "never";
    const unknown = type.value_type === "integer" ? "number" : "(string & {})";
    return `${tsDoc(type.description)}export type ${type.name} = ${literals} | ${unknown};\n`;
  }
  if (type.kind === "union") {
    const imports = renderTypeImports(ir, type);
    const variants = type.variants.map((variant) => tsType(ir, variant)).join(" | ") || "unknown";
    return `${imports}${tsDoc(type.description)}export type ${type.name} = ${variants} | { [key: string]: unknown };\n`;
  }
  const aliasImports = renderTypeImports(ir, type);
  return `${aliasImports}${tsDoc(type.description)}export type ${type.name} = ${tsType(ir, type.target)};\n`;
}

/** Emits same-directory `import type` lines for any named types this type references. */
function renderTypeImports(ir: ApiIR, type: TypeIR): string {
  const lines = importsForType(ir, type)
    .filter((imported) => imported !== type.name)
    .map((imported) => `import type { ${imported} } from "./${snakeCase(imported)}.js";`);
  return lines.length ? `${lines.join("\n")}\n\n` : "";
}

function renderTypeScriptObject(ir: ApiIR, type: ObjectTypeIR): string {
  const imports = importsForType(ir, type)
    .filter((imported) => imported !== type.name)
    .map((imported) => `import type { ${imported} } from "./${snakeCase(imported)}.js";`);
  const fields = type.fields.map((field) => renderTypeScriptField(ir, field)).join("\n");
  const extra = type.extra_fields === "preserve" ? "\n  [key: string]: unknown;" : "";
  return `${imports.join("\n")}${imports.length ? "\n\n" : ""}${tsDoc(type.description)}export interface ${type.name} {
${fields}${extra}
}
`;
}

function renderTypeScriptField(ir: ApiIR, field: FieldIR): string {
  const optional = field.required ? "" : "?";
  const nullable = field.nullable ? " | null" : "";
  return `${tsDoc(field.description, "  ")}  ${field.name}${optional}: ${tsType(ir, field.type)}${nullable};`;
}

function renderTypeScriptResource(ir: ApiIR, resource: ResourceIR): string {
  const operations = targetOperationsForResource(ir, resource, "typescript");
  const children = childResources(ir, resource, "typescript");
  const typeImports = new Set<string>();
  for (const operation of operations) {
    collectOperationImports(ir, operation, typeImports);
  }
  const imports = [...typeImports].map((name) => `import type { ${name} } from "../types/${snakeCase(name)}.js";`);
  const childImports = children.map(
    (child) => `import { ${child.class_name}Resource } from "./${resourceFileSlug(child)}.js";`,
  );
  const localTypes = operations.map((operation) => renderOperationParamsType(ir, resource, operation)).filter(Boolean).join("\n\n");
  const methods = operations
    .flatMap((operation) => renderTypeScriptOperation(ir, resource, operation))
    .filter(Boolean)
    .join("\n\n");
  const childFields = children.map((child) => `  readonly ${child.name}: ${child.class_name}Resource;`).join("\n");
  const childInit = children.map((child) => `    this.${child.name} = new ${child.class_name}Resource(client);`).join("\n");
  const needsStream = operations.some((operation) => operation.streaming);
  const needsWs = operations.some((operation) => operation.websocket);
  const rawMethods = operations
    .filter((operation) => !operation.streaming && !operation.websocket)
    .map((operation) => renderTypeScriptRawMethod(ir, resource, operation))
    .filter(Boolean)
    .join("\n");
  const rawAccessor = rawMethods
    ? `\n  /** Same methods, returning { data, response } with the raw HTTP Response. */\n  get withRawResponse() {\n    return {\n${rawMethods}\n    };\n  }\n`
    : "";

  return `import type { ApiClient, RequestOptions${needsStream ? ", Stream" : ""}${needsWs ? ", WebSocketConnection" : ""} } from "../core.js";
${imports.join("\n")}
${childImports.join("\n")}

${localTypes}

export class ${resource.class_name}Resource {
${childFields}${childFields ? "\n" : ""}
  constructor(private readonly client: ApiClient) {
${childInit}
  }

${indent(methods, 2)}
${rawAccessor}
}
`;
}

function renderOperationParamsType(ir: ApiIR, resource: ResourceIR, operation: OperationIR): string {
  const queryParams = operation.params.filter((param) => param.location === "query");
  const pathParams = operation.params.filter((param) => param.location === "path");
  if (operation.request || queryParams.length > 0 || pathParams.length > 1) {
    const name = operationTypeName(resource, operation, "Params");
    const fields: string[] = [];
    for (const param of operation.params) {
      fields.push(renderParamField(ir, param));
    }
    if (operation.request) {
      fields.push(`  body${operation.request.required ? "" : "?"}: ${tsType(ir, operation.request.type)};`);
    }
    return `export interface ${name} {\n${fields.join("\n")}\n}`;
  }
  return "";
}

function renderParamField(ir: ApiIR, param: ParamIR): string {
  return `  ${param.name}${param.required ? "" : "?"}: ${tsType(ir, param.type)};`;
}

interface MethodPlan {
  args: string;
  pathExpr: string;
  query: string;
  bodyExpr: string;
  paramsName: string;
  hasParamsObject: boolean;
}

function planMethod(ir: ApiIR, resource: ResourceIR, operation: OperationIR): MethodPlan {
  const paramsName = operationTypeName(resource, operation, "Params");
  const pathParams = operation.params.filter((param) => param.location === "path");
  const queryParams = operation.params.filter((param) => param.location === "query");
  const hasParamsObject = Boolean(operation.request) || queryParams.length > 0 || pathParams.length > 1;
  const singlePathParam = pathParams.length === 1 && !hasParamsObject ? pathParams[0] : undefined;
  const args = singlePathParam
    ? `${singlePathParam.name}: ${tsType(ir, singlePathParam.type)}, options: RequestOptions = {}`
    : hasParamsObject
      ? `params: ${paramsName}${operation.request?.required || operation.params.some((param) => param.required) ? "" : " = {}"}, options: RequestOptions = {}`
      : "options: RequestOptions = {}";
  const query = queryParams.length
    ? `{
${queryParams.map((param) => `      ${quote(param.wire_name)}: params.${param.name},`).join("\n")}
    }`
    : "undefined";
  return {
    args,
    pathExpr: renderTsPath(operation.path, pathParams, singlePathParam),
    query,
    bodyExpr: operation.request ? "params.body" : "undefined",
    paramsName,
    hasParamsObject,
  };
}

function tsDeprecation(operation: OperationIR): string {
  if (!operation.deprecated) return "";
  const reason = typeof operation.deprecated === "string" ? ` ${operation.deprecated}` : "";
  return `/** @deprecated${reason} */\n`;
}

function renderTypeScriptOperation(ir: ApiIR, resource: ResourceIR, operation: OperationIR): string[] {
  const methods: string[] = [];
  if (operation.websocket) {
    return [renderTypeScriptWebsocketMethod(ir, operation)];
  }
  if (operation.streaming) {
    if (!operation.streaming.always) methods.push(renderTypeScriptMethod(ir, resource, operation, "non-stream"));
    methods.push(renderTypeScriptStreamingMethod(ir, resource, operation));
  } else {
    methods.push(renderTypeScriptMethod(ir, resource, operation, "plain"));
  }
  const pager = renderTypeScriptPaginationMethod(ir, resource, operation);
  if (pager) methods.push(pager);
  return methods.map((method, index) => (index === 0 ? `${tsDeprecation(operation)}${method}` : method));
}

function renderTypeScriptMethod(ir: ApiIR, resource: ResourceIR, operation: OperationIR, mode: "plain" | "non-stream"): string {
  const response = operation.binary_response ? "Uint8Array" : operation.response ? tsType(ir, operation.response) : "unknown";
  const plan = planMethod(ir, resource, operation);
  const multipart = operation.request?.multipart ? "\n    multipart: true," : "";
  const binary = operation.binary_response ? "\n    binary: true," : "";
  const responseTypeName = operation.response?.kind === "ref" ? typeById(ir, operation.response.id)?.name : undefined;
  const responseTypeLine = !operation.binary_response && responseTypeName ? `\n    responseType: ${quote(responseTypeName)},` : "";
  const discriminator = mode === "non-stream" && operation.streaming?.param_discriminator;
  const bodyExpr = discriminator && operation.request
    ? `{ ...params.body, ${quote(discriminator)}: false }`
    : plan.bodyExpr;
  return `async ${operation.name}(${plan.args}): Promise<${response}> {
  return this.client.request<${response}>(${quote(operation.http_method)}, ${plan.pathExpr}, {
    ...options,
    query: ${plan.query},
    body: ${bodyExpr},${multipart}${binary}${responseTypeLine}
  });
}`;
}

function renderTypeScriptWebsocketMethod(ir: ApiIR, operation: OperationIR): string {
  const ws = operation.websocket;
  const clientType = ws?.client_event_type_id ? typeById(ir, ws.client_event_type_id)?.name ?? "unknown" : "unknown";
  const serverType = ws?.server_event_type_id ? typeById(ir, ws.server_event_type_id)?.name ?? "unknown" : "unknown";
  return `${operation.name}(): WebSocketConnection<${clientType}, ${serverType}> {
  return this.client.connectWebSocket<${clientType}, ${serverType}>(${quote(operation.path)});
}`;
}

function renderTypeScriptRawMethod(ir: ApiIR, resource: ResourceIR, operation: OperationIR): string {
  const response = operation.response ? tsType(ir, operation.response) : "unknown";
  const plan = planMethod(ir, resource, operation);
  const multipart = operation.request?.multipart ? " multipart: true," : "";
  const responseTypeName = operation.response?.kind === "ref" ? typeById(ir, operation.response.id)?.name : undefined;
  const responseTypeLine = responseTypeName ? ` responseType: ${quote(responseTypeName)},` : "";
  return `      ${operation.name}: (${plan.args}): Promise<{ data: ${response}; response: globalThis.Response }> =>
        this.client.requestRaw<${response}>(${quote(operation.http_method)}, ${plan.pathExpr}, { ...options, query: ${plan.query}, body: ${plan.bodyExpr},${multipart}${responseTypeLine} }),`;
}

function renderTypeScriptStreamingMethod(ir: ApiIR, resource: ResourceIR, operation: OperationIR): string {
  const streaming = operation.streaming;
  if (!streaming) return "";
  const eventType = streamEventType(ir, operation);
  const eventName = eventType?.name ?? "unknown";
  const plan = planMethod(ir, resource, operation);
  const methodName = streaming.always ? operation.name : `${operation.name}Streaming`;
  const discriminator = streaming.param_discriminator;
  const bodyExpr = discriminator && operation.request
    ? `{ ...params.body, ${quote(discriminator)}: true }`
    : plan.bodyExpr;
  const sse = streaming.protocol === "sse";
  const done = streaming.done_sentinel ? `\n    doneSentinel: ${quote(streaming.done_sentinel)},` : "";
  return `async ${methodName}(${plan.args}): Promise<Stream<${eventName}>> {
  return this.client.stream<${eventName}>(${quote(operation.http_method)}, ${plan.pathExpr}, {
    ...options,
    query: ${plan.query},
    body: ${bodyExpr},
    sse: ${sse},${done}
  });
}`;
}

function renderTypeScriptPaginationMethod(ir: ApiIR, resource: ResourceIR, operation: OperationIR): string {
  const shape = paginationShape(ir, operation);
  if (!shape) return "";
  const itemType = tsType(ir, shape.itemType);
  const itemsField = shape.itemsField.name;
  const paramsName = operationTypeName(resource, operation, "Params");
  const hasParams = operation.params.length > 0 || Boolean(operation.request);
  const paramsArg = hasParams ? `params: ${paramsName} = {} as ${paramsName}` : "params: Record<string, never> = {}";
  const list = `this.${operation.name}(${hasParams ? "pageParams" : ""}${hasParams ? ", options" : "options"})`;

  // RFC 5988 Link-header pagination: the next-page URL is in the response's `Link` header
  // (rel="next"), so this pager drives requestRaw directly to inspect headers per page.
  if (shape.kind === "link_header") {
    const plan = planMethod(ir, resource, operation);
    const responseType = operation.response ? tsType(ir, operation.response) : "unknown";
    return `async *${operation.name}AutoPaging(${plan.args}): AsyncIterable<${itemType}> {
  let result = await this.client.requestRaw<${responseType}>(${quote(operation.http_method)}, ${plan.pathExpr}, { ...options, query: ${plan.query} });
  while (true) {
    const items = ((result.data as unknown as Record<string, unknown>)[${quote(itemsField)}] ?? []) as ${itemType}[];
    for (const item of items) yield item;
    const next = this.client.nextLink(result.response);
    if (!next) return;
    result = await this.client.requestAbsoluteRaw<${responseType}>(next, options);
  }
}`;
  }

  const advance = renderTsPagerAdvance(shape, itemsField);
  return `async *${operation.name}AutoPaging(${paramsArg}, options: RequestOptions = {}): AsyncIterable<${itemType}> {
  let pageParams: ${hasParams ? paramsName : "Record<string, never>"} = { ...params };
  let page = await ${list};
  while (true) {
    const items = (page.${itemsField} ?? []) as ${itemType}[];
    for (const item of items) yield item;
${indent(advance, 4)}
    page = await ${hasParams ? `this.${operation.name}(pageParams, options)` : `this.${operation.name}(options)`};
  }
}`;
}

function renderTsPagerAdvance(shape: ReturnType<typeof paginationShape>, itemsField: string): string {
  if (!shape) return "return;";
  switch (shape.kind) {
    case "cursor": {
      if (!shape.nextCursorField || !shape.requestCursorParam) return "return;";
      return `const next = page.${shape.nextCursorField.name};
if (!next) return;
pageParams = { ...pageParams, ${shape.requestCursorParam}: next };`;
    }
    case "cursor_id": {
      if (!shape.cursorIdParam || !shape.cursorItemIdField) return "return;";
      return `if (items.length === 0) return;
const last = items[items.length - 1] as Record<string, unknown>;
const nextId = last[${quote(shape.cursorItemIdField.wire_name)}];
if (nextId === undefined || nextId === null) return;
pageParams = { ...pageParams, ${shape.cursorIdParam}: nextId } as typeof pageParams;`;
    }
    case "cursor_url": {
      if (!shape.nextUrlField) return "return;";
      return `const nextUrl = page.${shape.nextUrlField.name};
if (!nextUrl) return;
for await (const item of (async function* (client) {
  let url: string | null | undefined = nextUrl;
  while (url) {
    const p: any = await client.requestAbsolute(url, options);
    for (const it of (p.${itemsField} ?? [])) yield it;
    url = p.${shape.nextUrlField.name};
  }
})(this.client)) yield item as never;
return;`;
    }
    case "offset": {
      if (!shape.offsetParam) return "return;";
      const total = shape.totalCountField ? `\nif (page.${shape.totalCountField.name} !== undefined && nextOffset >= Number(page.${shape.totalCountField.name})) return;` : "";
      return `if (items.length === 0) return;
const nextOffset = Number((pageParams as any).${shape.offsetParam} ?? 0) + items.length;${total}
pageParams = { ...pageParams, ${shape.offsetParam}: nextOffset } as typeof pageParams;`;
    }
    case "page_number": {
      if (!shape.pageParam) return "return;";
      const current = shape.currentPageField
        ? `Number(page.${shape.currentPageField.name} ?? (pageParams as any).${shape.pageParam} ?? 1)`
        : `Number((pageParams as any).${shape.pageParam} ?? 1)`;
      const total = shape.totalPagesField ? `\nif (page.${shape.totalPagesField.name} !== undefined && currentPage >= Number(page.${shape.totalPagesField.name})) return;` : "";
      return `if (items.length === 0) return;
const currentPage = ${current};${total}
pageParams = { ...pageParams, ${shape.pageParam}: currentPage + 1 } as typeof pageParams;`;
    }
    default:
      return "return;";
  }
}

function renderTsPath(path: string, pathParams: ParamIR[], singlePathParam: ParamIR | undefined): string {
  if (pathParams.length === 0) return quote(path);
  if (singlePathParam) {
    return "`" + path.replace(`{${singlePathParam.wire_name}}`, `\${encodeURIComponent(String(${singlePathParam.name}))}`) + "`";
  }
  return "`" + path.replace(/\{([^}]+)\}/g, (_match, name: string) => `\${encodeURIComponent(String(params.${camelCase(name)}))}`) + "`";
}

function renderTypeScriptReadme(ir: ApiIR): string {
  const resources = topLevelResources(ir, "typescript");
  const firstResource = resources[0];
  const firstOperation = firstResource ? targetOperationsForResource(ir, firstResource, "typescript")[0] : undefined;
  const example = firstResource && firstOperation ? `await client.${firstResource.name}.${firstOperation.name}();` : "// call your API";
  const packageName = ir.targets.typescript?.package_name ?? snakeCase(ir.api.package_prefix);
  return `# ${ir.api.name} TypeScript SDK

\`\`\`ts
import ${ir.client.name} from "${packageName}";

const client = new ${ir.client.name}({ apiKey: process.env.${ir.client.env_prefix}_API_KEY });
${example}
\`\`\`
`;
}

function renderTypeScriptWebhookTest(ir: ApiIR): string {
  const webhook = ir.webhooks;
  if (!webhook) return "";
  return `import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import ${ir.client.name} from "../dist/index.js";

test("webhooks unwrap signed payloads", () => {
  const secret = "whsec_test_secret";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const payload = JSON.stringify({
    id: "evt_test",
    type: "customer.created",
    created: Number(timestamp),
    data: { customer_id: "cus_test" },
  });
  const signature = createHmac("sha256", secret).update(timestamp + "." + payload).digest("hex");
  const client = new ${ir.client.name}({ webhookSecret: secret });

  const event = client.webhooks.unwrap(payload, {
    ${quote(webhook.timestamp_header)}: timestamp,
    ${quote(webhook.signature_header)}: "v1=" + signature,
  });

  assert.equal((event).id, "evt_test");
  assert.throws(() => client.webhooks.unwrap(payload, {
    ${quote(webhook.timestamp_header)}: timestamp,
    ${quote(webhook.signature_header)}: "v1=bad",
  }), /signature mismatch|signature value/);
});
`;
}

function tsType(ir: ApiIR, ref: TypeRefIR): string {
  let value: string;
  if (ref.kind === "ref") {
    value = typeById(ir, ref.id)?.name ?? "unknown";
  } else if (ref.kind === "array") {
    value = `${tsType(ir, ref.items)}[]`;
  } else if (ref.kind === "map") {
    // Index signature, not Record<>: a mapped-type alias that references itself
    // (e.g. `type ErrorDetails = Record<string, ErrorDetails>`) trips TS2456; an index
    // signature permits the same recursion.
    value = `{ [key: string]: ${tsType(ir, ref.values)} }`;
  } else if (ref.kind === "file") {
    value = "Blob | File | ArrayBuffer | Uint8Array";
  } else if (ref.name === "integer" || ref.name === "number") {
    value = "number";
  } else if (ref.name === "boolean") {
    value = "boolean";
  } else if (ref.name === "string") {
    value = "string";
  } else {
    value = "unknown";
  }
  return ref.nullable ? `${value} | null` : value;
}

function importsForType(ir: ApiIR, type: TypeIR): string[] {
  const imports = new Set<string>();
  if (type.kind === "object") {
    for (const field of type.fields) collectTypeImports(ir, field.type, imports);
  } else if (type.kind === "union") {
    for (const variant of type.variants) collectTypeImports(ir, variant, imports);
  } else if (type.kind === "alias") {
    collectTypeImports(ir, type.target, imports);
  }
  return [...imports];
}

function collectOperationImports(ir: ApiIR, operation: OperationIR, imports: Set<string>): void {
  for (const param of operation.params) collectTypeImports(ir, param.type, imports);
  if (operation.request) collectTypeImports(ir, operation.request.type, imports);
  if (operation.response) collectTypeImports(ir, operation.response, imports);
  const shape = paginationShape(ir, operation);
  if (shape) collectTypeImports(ir, shape.itemType, imports);
  const eventType = streamEventType(ir, operation);
  if (eventType) imports.add(eventType.name);
  if (operation.websocket?.client_event_type_id) {
    const t = typeById(ir, operation.websocket.client_event_type_id);
    if (t) imports.add(t.name);
  }
  if (operation.websocket?.server_event_type_id) {
    const t = typeById(ir, operation.websocket.server_event_type_id);
    if (t) imports.add(t.name);
  }
}

function collectTypeImports(ir: ApiIR, ref: TypeRefIR, imports: Set<string>): void {
  if (ref.kind === "ref") {
    const type = typeById(ir, ref.id);
    if (type) imports.add(type.name);
  } else if (ref.kind === "array") {
    collectTypeImports(ir, ref.items, imports);
  } else if (ref.kind === "map") {
    collectTypeImports(ir, ref.values, imports);
  }
}
