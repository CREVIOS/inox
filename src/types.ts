export type TargetName = "typescript" | "python" | "go" | "ruby" | "java" | "csharp";

export interface SdkConfig {
  sdkgen: number;
  organization?: {
    name?: string;
  };
  project: {
    name: string;
    display_name?: string;
  };
  spec: {
    path: string;
    /** OpenAPI Overlay documents (overlay 1.0.0) applied to the spec before IR build. */
    overlays?: string[];
  };
  targets: Partial<Record<TargetName, TargetConfig>>;
  client?: {
    class_name?: string;
    env_prefix?: string;
    base_url?: {
      default?: string;
    };
    auth?: AuthConfig;
    retries?: {
      max_retries?: number;
      retry_statuses?: number[];
    };
    timeout?: {
      seconds?: number;
    };
    idempotency?: {
      header?: string;
    };
    omit_stainless_headers?: boolean;
  };
  webhooks?: WebhookConfig;
  /** Generated MCP server options. */
  mcp?: McpConfig;
  /** Named base URLs (e.g. production, sandbox). The first entry is the default. */
  environments?: Record<string, string>;
  resources?: Record<string, ResourceConfig>;
  models?: Record<string, string>;
  pagination?: Record<string, PaginationConfig>;
  overrides?: {
    operations?: Record<string, OperationOverride>;
    types?: Record<string, TypeOverride>;
  };
}

export interface McpConfig {
  /** Tool exposure: one typed tool per endpoint, dynamic meta-tools, code-execution, or auto by size. */
  tools?: "typed" | "dynamic" | "code" | "auto";
  /** Endpoint count above which `auto` resolves to `dynamic` (default 40). */
  dynamic_threshold?: number;
  /** Include a documentation-search tool (default true). */
  enable_docs_tool?: boolean;
  /** Include the code-execution tool in code mode (default true). */
  enable_code_tool?: boolean;
  /** Default permission flags baked into the generated server (overridable via CLI flags). */
  permissions?: {
    allow_http_gets?: boolean;
    allowed_methods?: string[];
    blocked_methods?: string[];
  };
  /** Generated MCP package name; defaults to `<prefix>-mcp`. */
  package_name?: string;
}

export interface McpIR {
  /** Configured default; `auto` is resolved into `resolved_mode` at build time. */
  default_mode: "typed" | "dynamic" | "code" | "auto";
  resolved_mode: "typed" | "dynamic" | "code";
  dynamic_threshold: number;
  enable_docs_tool: boolean;
  enable_code_tool: boolean;
  permissions: { allow_http_gets: boolean; allowed_methods: string[]; blocked_methods: string[] };
  package_name?: string;
}

export interface WebhookConfig {
  signing_secret_env?: string;
  signature_header?: string;
  timestamp_header?: string;
  tolerance_seconds?: number;
  payload_type?: string;
}

export interface TargetConfig {
  package_name?: string;
  project_name?: string;
  module_path?: string;
  edition?: string;
  repo?: string;
  /** Ruby gem name. */
  gem_name?: string;
  /** Java/Kotlin/C# root namespace (reverse domain), e.g. com.acme.api. */
  namespace?: string;
  reverse_domain?: string;
  /** Maven group:artifact for Java. */
  maven_group?: string;
  maven_artifact?: string;
}

export interface AuthConfig {
  bearer?: {
    env?: string;
    security_scheme?: string;
  };
  basic?: {
    username_env?: string;
    password_env?: string;
    security_scheme?: string;
  };
  api_key?: {
    env?: string;
    security_scheme?: string;
    header?: string;
    query?: string;
  };
  oauth2?: {
    token_url?: string;
    scopes?: string[];
    /** how client credentials are presented to the token endpoint. */
    auth_style?: "post" | "basic";
    client_id_env?: string;
    client_secret_env?: string;
    security_scheme?: string;
  };
}

export interface OAuth2IR {
  token_url: string;
  scopes: string[];
  auth_style: "post" | "basic";
  client_id_env: string;
  client_secret_env: string;
}

export interface ResourceConfig {
  model?: string;
  methods?: Record<string, ResourceMethodConfig>;
  subresources?: Record<string, ResourceConfig>;
  skip?: boolean | TargetName[];
  only?: TargetName[];
}

export interface ResourceMethodConfig {
  endpoint: string;
  pagination?: string;
  streaming?: StreamingConfig;
  skip?: boolean | TargetName[];
  only?: TargetName[];
  /** Method kind; `websocket` generates a typed bidirectional client. */
  type?: "http" | "websocket";
  websocket?: WebsocketConfig;
  /** Mark the method deprecated; string is the reason/replacement shown in generated docs. */
  deprecated?: boolean | string;
}

export interface WebsocketConfig {
  /** Model the client sends to the server. */
  client_event_model?: string;
  /** Model the server sends to the client. */
  server_event_model?: string;
}

export interface StreamingConfig {
  /** Per-event model name (must resolve to a configured/generated model). */
  event_model: string;
  /** Request param that toggles streaming; omit/null for always-streaming endpoints. */
  param_discriminator?: string | null;
  /** Wire framing: server-sent events (default) or newline-delimited JSON. */
  protocol?: "sse" | "jsonl";
  /** SSE `data:` value that terminates the stream, e.g. "[DONE]". */
  done_sentinel?: string;
}

export interface PaginationConfig {
  type: "cursor" | "cursor_id" | "cursor_url" | "offset" | "page_number" | "link_header";
  items: string;
  /** cursor: request param carrying the cursor, response field with the next cursor. */
  request_cursor?: string;
  response_next_cursor?: string;
  /** cursor (bidirectional): backward request param + response field with the previous cursor. */
  request_prev_cursor?: string;
  response_prev_cursor?: string;
  /** cursor_id: request param + the item property used as the next cursor. */
  cursor_id_param?: string;
  cursor_item_id?: string;
  /** cursor_url: response field (or `header:Link`) carrying the absolute next URL. */
  next_url?: string;
  /** offset: request offset/limit params + response total-count field. */
  offset_param?: string;
  limit_param?: string;
  total_count?: string;
  /** page_number: request page/size params + response current/total page fields. */
  page_param?: string;
  page_size_param?: string;
  current_page?: string;
  total_pages?: string;
}

export interface OperationOverride {
  method_name?: string;
  resource?: string;
}

export interface TypeOverride {
  name?: string;
}

export interface Diagnostic {
  severity: "error" | "blocker" | "warning" | "suggestion" | "info";
  code: string;
  message: string;
  location?: string;
  targets?: TargetName[];
}

export interface OpenApiDocument {
  openapi?: string;
  info?: {
    title?: string;
    version?: string;
    description?: string;
  };
  servers?: Array<{ url?: string }>;
  paths?: Record<string, Record<string, OpenApiOperation | unknown>>;
  components?: {
    schemas?: Record<string, OpenApiSchema>;
    securitySchemes?: Record<string, unknown>;
  };
}

export interface OpenApiOperation {
  operationId?: string;
  tags?: string[];
  summary?: string;
  description?: string;
  deprecated?: boolean;
  parameters?: OpenApiParameter[];
  requestBody?: OpenApiRequestBody;
  responses?: Record<string, OpenApiResponse>;
}

export interface OpenApiParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required?: boolean;
  schema?: OpenApiSchema;
  description?: string;
}

export interface OpenApiRequestBody {
  required?: boolean;
  content?: Record<string, { schema?: OpenApiSchema; examples?: unknown }>;
}

export interface OpenApiResponse {
  description?: string;
  headers?: Record<string, OpenApiParameter>;
  content?: Record<string, { schema?: OpenApiSchema; examples?: unknown }>;
}

export interface OpenApiSchema {
  $ref?: string;
  type?: string | string[];
  format?: string;
  title?: string;
  description?: string;
  enum?: Array<string | number | boolean | null>;
  properties?: Record<string, OpenApiSchema>;
  required?: string[];
  items?: OpenApiSchema;
  additionalProperties?: boolean | OpenApiSchema;
  oneOf?: OpenApiSchema[];
  anyOf?: OpenApiSchema[];
  allOf?: OpenApiSchema[];
  nullable?: boolean;
  readOnly?: boolean;
  writeOnly?: boolean;
  discriminator?: { propertyName?: string; mapping?: Record<string, string> };
  default?: unknown;
  const?: string | number | boolean | null;
}

export interface ApiIR {
  ir_version: string;
  source: {
    spec_hash: string;
    config_hash: string;
    openapi_version: string;
    generated_at: string;
  };
  api: {
    name: string;
    package_prefix: string;
    version?: string;
    description?: string;
  };
  servers: Array<{ url: string }>;
  client: ClientIR;
  targets: Partial<Record<TargetName, TargetConfig>>;
  resources: ResourceIR[];
  operations: OperationIR[];
  types: TypeIR[];
  pagination: PaginationIR[];
  webhooks?: WebhookIR;
  mcp: McpIR;
  diagnostics: Diagnostic[];
}

export interface ClientIR {
  name: string;
  base_url: string;
  env_prefix: string;
  auth: AuthConfig;
  retry_policy: {
    max_retries: number;
    retry_statuses: number[];
  };
  timeout_ms: number;
  idempotency_header?: string;
  omit_stainless_headers: boolean;
  oauth2?: OAuth2IR;
  environments: Record<string, string>;
  default_environment?: string;
}

export interface ResourceIR {
  id: string;
  name: string;
  class_name: string;
  path_segments: string[];
  model_type_id?: string;
  operation_ids: string[];
  /** id of the parent resource when this is a subresource. */
  parent_id?: string;
  /** ids of nested subresources. */
  subresource_ids: string[];
  /** targets this resource is generated for; undefined => all. */
  targets?: TargetName[];
}

export interface OperationIR {
  id: string;
  resource_id: string;
  name: string;
  http_method: HttpMethod;
  path: string;
  summary?: string;
  params: ParamIR[];
  request?: RequestBodyIR;
  response?: TypeRefIR;
  pagination_id?: string;
  streaming?: StreamingIR;
  websocket?: WebsocketIR;
  /** OpenAPI operation tags; drive MCP `--scope` tag filtering. */
  tags?: string[];
  /** Deprecation marker: true, or a string reason/replacement for generated docs. */
  deprecated?: boolean | string;
  /** True when the success response is a binary stream (octet-stream/audio/image/pdf). */
  binary_response?: boolean;
  /** targets this method is generated for; undefined => all. */
  targets?: TargetName[];
}

export interface WebsocketIR {
  client_event_type_id?: string;
  server_event_type_id?: string;
}

export interface StreamingIR {
  event_type_id: string;
  param_discriminator?: string;
  protocol: "sse" | "jsonl";
  done_sentinel?: string;
  /** true when the endpoint is always streaming (no discriminator param). */
  always: boolean;
}

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete" | "head" | "options";

export interface ParamIR {
  name: string;
  wire_name: string;
  location: "path" | "query" | "header" | "cookie";
  type: TypeRefIR;
  required: boolean;
  nullable: boolean;
  description?: string;
}

export interface RequestBodyIR {
  required: boolean;
  content_type: string;
  type: TypeRefIR;
  /** true when content_type is multipart/form-data (file upload). */
  multipart: boolean;
  /** true when content_type is application/x-www-form-urlencoded (e.g. Stripe). */
  form_urlencoded?: boolean;
  /** true when content_type is text/plain (raw string body). */
  text_plain?: boolean;
  /** All request content types the endpoint accepts (multi-content endpoints list more than one). */
  content_types?: string[];
}

export type PaginationKind = "cursor" | "cursor_id" | "cursor_url" | "offset" | "page_number" | "link_header";

export interface PaginationIR {
  id: string;
  type: PaginationKind;
  items: string;
  request_cursor?: string;
  response_next_cursor?: string;
  request_prev_cursor?: string;
  response_prev_cursor?: string;
  cursor_id_param?: string;
  cursor_item_id?: string;
  next_url?: string;
  offset_param?: string;
  limit_param?: string;
  total_count?: string;
  page_param?: string;
  page_size_param?: string;
  current_page?: string;
  total_pages?: string;
}

export interface WebhookIR {
  signing_secret_env: string;
  signature_header: string;
  timestamp_header: string;
  tolerance_seconds: number;
  payload_type_id?: string;
}

export type TypeIR = ObjectTypeIR | EnumTypeIR | UnionTypeIR | AliasTypeIR;

export interface ObjectTypeIR {
  kind: "object";
  id: string;
  name: string;
  fields: FieldIR[];
  extra_fields: "preserve" | "ignore" | "reject";
  description?: string;
}

export interface FieldIR {
  name: string;
  wire_name: string;
  type: TypeRefIR;
  required: boolean;
  nullable: boolean;
  read_only: boolean;
  write_only: boolean;
  description?: string;
  /** Schema default value, if declared. */
  default_value?: unknown;
  /** Fixed const value (single-valued schema), if declared. */
  const_value?: string | number | boolean | null;
}

export interface EnumTypeIR {
  kind: "enum";
  id: string;
  name: string;
  values: Array<string | number>;
  open: boolean;
  value_type: "string" | "integer";
  description?: string;
}

export interface UnionTypeIR {
  kind: "union";
  id: string;
  name: string;
  variants: TypeRefIR[];
  discriminator?: string;
  unknown_variant: boolean;
  description?: string;
}

export interface AliasTypeIR {
  kind: "alias";
  id: string;
  name: string;
  target: TypeRefIR;
  description?: string;
}

export type TypeRefIR =
  | { kind: "primitive"; name: "string" | "number" | "integer" | "boolean" | "unknown"; format?: string; nullable?: boolean }
  | { kind: "array"; items: TypeRefIR; nullable?: boolean }
  | { kind: "map"; values: TypeRefIR; nullable?: boolean }
  | { kind: "ref"; id: string; nullable?: boolean }
  | { kind: "file"; nullable?: boolean };

export interface GenerationResult {
  target: TargetName;
  outDir: string;
  files: string[];
}
