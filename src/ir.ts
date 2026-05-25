import type {
  ApiIR,
  Diagnostic,
  FieldIR,
  HttpMethod,
  ObjectTypeIR,
  OpenApiDocument,
  OpenApiOperation,
  OpenApiParameter,
  OpenApiSchema,
  OAuth2IR,
  OperationIR,
  PaginationConfig,
  PaginationIR,
  ParamIR,
  ResourceConfig,
  ResourceIR,
  SdkConfig,
  StreamingConfig,
  StreamingIR,
  TargetName,
  WebsocketConfig,
  WebsocketIR,
  TypeIR,
  TypeRefIR,
  WebhookIR,
} from "./types.js";
import { isHttpMethod, resolveSchemaRef } from "./openapi.js";
import { camelCase, isRecord, pascalCase, pluralToSingular, sha256, snakeCase, stripJsonPath, uniqueBy } from "./utils.js";

export interface BuildIrInput {
  config: SdkConfig;
  configRaw: string;
  spec: OpenApiDocument;
  specRaw: string;
  diagnostics: Diagnostic[];
}

interface EndpointBinding {
  resourcePath: string[];
  methodName: string;
  paginationId?: string;
  streaming?: StreamingConfig;
  skip?: boolean | TargetName[];
  only?: TargetName[];
  methodType?: "http" | "websocket";
  websocket?: WebsocketConfig;
  deprecated?: boolean | string;
}

interface ConfiguredResource {
  path: string[];
  config: ResourceConfig;
}

export function buildIR(input: BuildIrInput): ApiIR {
  const builder = new IrBuilder(input);
  return builder.build();
}

class IrBuilder {
  private readonly config: SdkConfig;
  private readonly spec: OpenApiDocument;
  private readonly diagnostics: Diagnostic[];
  private readonly types = new Map<string, TypeIR>();
  private readonly endpointBindings = new Map<string, EndpointBinding>();
  private readonly resourceConfigs = new Map<string, ConfiguredResource>();
  private readonly allTargets: TargetName[];
  private readonly usedTypeNames = new Set<string>();
  private inlineTypeCount = 0;

  constructor(input: BuildIrInput) {
    this.config = input.config;
    this.spec = input.spec;
    this.diagnostics = [...input.diagnostics];
    this.allTargets = (Object.keys(input.config.targets ?? {}) as TargetName[]).filter((target) =>
      ["typescript", "python", "go", "ruby", "java", "csharp"].includes(target),
    );
    this.seedEndpointBindings();
  }

  build(): ApiIR {
    this.buildNamedTypes();
    const { resources, operations } = this.buildResourcesAndOperations();
    const envPrefix = (this.config.client?.env_prefix ?? snakeCase(this.config.project.name)).toUpperCase();
    const webhooks = this.buildWebhooks(envPrefix);
    this.addQualityDiagnostics(resources, operations);
    const firstServer = this.spec.servers?.find((server) => server.url)?.url;
    const client = this.config.client ?? {};
    const retry = client.retries ?? {};
    const auth = client.auth ?? {};

    return {
      ir_version: "2026-05-25.mvp1",
      source: {
        spec_hash: sha256(JSON.stringify(this.spec)),
        config_hash: sha256(JSON.stringify(this.config)),
        openapi_version: this.spec.openapi ?? "unknown",
        generated_at: new Date().toISOString(),
      },
      api: {
        name: this.config.project.display_name ?? this.spec.info?.title ?? this.config.project.name,
        package_prefix: this.config.project.name,
        version: this.spec.info?.version,
        description: this.spec.info?.description,
      },
      servers: [{ url: client.base_url?.default ?? firstServer ?? "https://api.example.com" }],
      client: {
        name: client.class_name ?? pascalCase(this.config.project.name),
        base_url: client.base_url?.default ?? firstServer ?? "https://api.example.com",
        env_prefix: envPrefix,
        auth,
        retry_policy: {
          max_retries: retry.max_retries ?? 2,
          retry_statuses: retry.retry_statuses ?? [408, 409, 429, 500, 502, 503, 504],
        },
        timeout_ms: (client.timeout?.seconds ?? 60) * 1000,
        idempotency_header: client.idempotency?.header,
        omit_stainless_headers: client.omit_stainless_headers ?? false,
        oauth2: this.buildOAuth2(envPrefix),
        environments: this.config.environments ?? {},
        default_environment: Object.keys(this.config.environments ?? {})[0],
      },
      targets: this.config.targets,
      resources,
      operations,
      types: [...this.types.values()],
      pagination: Object.entries(this.config.pagination ?? {}).map(([id, pagination]) =>
        paginationToIR(id, pagination),
      ),
      webhooks,
      mcp: this.buildMcp(operations.length),
      diagnostics: this.diagnostics,
    };
  }

  private buildMcp(operationCount: number): ApiIR["mcp"] {
    const mcp = this.config.mcp ?? {};
    const threshold = mcp.dynamic_threshold ?? 40;
    const defaultMode = mcp.tools ?? "auto";
    const resolved = defaultMode === "auto" ? (operationCount > threshold ? "dynamic" : "typed") : defaultMode;
    const permissions = mcp.permissions ?? {};
    return {
      default_mode: defaultMode,
      resolved_mode: resolved,
      dynamic_threshold: threshold,
      enable_docs_tool: mcp.enable_docs_tool ?? true,
      enable_code_tool: mcp.enable_code_tool ?? true,
      permissions: {
        allow_http_gets: permissions.allow_http_gets ?? false,
        allowed_methods: permissions.allowed_methods ?? [],
        blocked_methods: permissions.blocked_methods ?? [],
      },
      package_name: mcp.package_name,
    };
  }

  private seedEndpointBindings(): void {
    const walk = (resources: Record<string, ResourceConfig>, parentPath: string[]): void => {
      for (const [resourceName, resource] of Object.entries(resources)) {
        const path = [...parentPath, camelCase(resourceName)];
        this.resourceConfigs.set(resourceIdFromPath(path), { path, config: resource });
        for (const [methodName, method] of Object.entries(resource.methods ?? {})) {
          const endpoint = normalizeEndpoint(method.endpoint);
          this.endpointBindings.set(endpoint, {
            resourcePath: path,
            methodName,
            paginationId: method.pagination,
            streaming: method.streaming,
            skip: method.skip,
            only: method.only,
            methodType: method.type,
            websocket: method.websocket,
            deprecated: method.deprecated,
          });
        }
        if (resource.subresources) walk(resource.subresources, path);
      }
    };
    walk(this.config.resources ?? {}, []);

    for (const [endpoint, override] of Object.entries(this.config.overrides?.operations ?? {})) {
      const normalized = normalizeEndpoint(endpoint);
      const current = this.endpointBindings.get(normalized);
      const path = override.resource
        ? override.resource.split(".").map((segment) => camelCase(segment))
        : current?.resourcePath ?? [inferResourceNameFromPath(normalized.split(" ")[1] ?? "")];
      this.endpointBindings.set(normalized, {
        resourcePath: path,
        methodName: override.method_name ?? current?.methodName ?? inferMethodName(normalized.split(" ")[0] ?? "get", normalized.split(" ")[1] ?? ""),
        paginationId: current?.paginationId,
        streaming: current?.streaming,
        skip: current?.skip,
        only: current?.only,
      });
    }
  }

  private buildNamedTypes(): void {
    const schemas = this.spec.components?.schemas ?? {};
    const configuredRefs = new Set(Object.values(this.config.models ?? {}));

    // Reserve all named-type names first so inline types can't steal them.
    const planned: Array<{ id: string; typeName: string; schema: OpenApiSchema }> = [];
    for (const [schemaName, schema] of Object.entries(schemas)) {
      const ref = `#/components/schemas/${schemaName}`;
      const configuredName = findConfiguredModelName(this.config, ref);
      const typeName = configuredName ?? this.config.overrides?.types?.[schemaName]?.name ?? pascalCase(schemaName);
      const id = typeIdFromRef(ref);
      const shouldPromote = configuredRefs.size === 0 || configuredRefs.has(ref) || isPromotableSchema(schema);
      if (shouldPromote) {
        this.usedTypeNames.add(typeName);
        planned.push({ id, typeName, schema });
      }
    }

    for (const { id, typeName, schema } of planned) {
      this.types.set(id, this.schemaToNamedType(id, typeName, schema));
    }
  }

  /** Returns a globally-unique type name, suffixing on collision. */
  private uniqueTypeName(preferred: string): string {
    const base = preferred || "Value";
    let name = base;
    let suffix = 2;
    while (this.usedTypeNames.has(name)) {
      name = `${base}${suffix}`;
      suffix += 1;
    }
    this.usedTypeNames.add(name);
    return name;
  }

  private buildResourcesAndOperations(): { resources: ResourceIR[]; operations: OperationIR[] } {
    const operations: OperationIR[] = [];
    const resourceMap = new Map<string, ResourceIR>();
    const autoNamedOps = new Set<OperationIR>();

    for (const [path, pathItem] of Object.entries(this.spec.paths ?? {})) {
      if (!pathItem || typeof pathItem !== "object" || Array.isArray(pathItem)) continue;
      for (const [rawMethod, operationValue] of Object.entries(pathItem)) {
        const lowerMethod = rawMethod.toLowerCase();
        if (!isHttpMethod(lowerMethod) || !operationValue || typeof operationValue !== "object" || Array.isArray(operationValue)) {
          continue;
        }

        const operation = operationValue as OpenApiOperation;
        const endpoint = normalizeEndpoint(`${lowerMethod} ${path}`);
        const binding = this.endpointBindings.get(endpoint);
        const resourcePath = binding?.resourcePath ?? [camelCase(operation.tags?.[0] ?? inferResourceNameFromPath(path))];
        const resourceId = resourceIdFromPath(resourcePath);
        const methodName = binding?.methodName ?? inferMethodName(lowerMethod, path, operation.operationId);
        const resource = this.ensureResourceChain(resourceMap, resourcePath);

        const nameHint = `${pascalCase(resourcePath.at(-1) ?? "")}${pascalCase(methodName)}`;
        const op: OperationIR = {
          id: operation.operationId ?? `${lowerMethod}_${snakeCase(path)}`,
          resource_id: resourceId,
          name: camelCase(methodName),
          http_method: lowerMethod as HttpMethod,
          path,
          summary: operation.summary,
          params: this.buildParams(operation.parameters ?? [], path),
          request: this.buildRequestBody(operation, `${nameHint}Request`),
          response: this.buildResponse(operation, `${nameHint}Response`),
          pagination_id: binding?.paginationId,
          streaming: this.buildStreaming(binding?.streaming, nameHint),
          websocket: binding?.methodType === "websocket" ? this.buildWebsocket(binding.websocket) : undefined,
          tags: operation.tags && operation.tags.length > 0 ? operation.tags : undefined,
          deprecated: binding?.deprecated ?? (operation.deprecated ? true : undefined),
          binary_response: responseIsBinary(operation) || undefined,
          // WebSocket clients are currently generated for TypeScript only.
          targets: binding?.methodType === "websocket" ? ["typescript"] : this.resolveTargets(binding?.skip, binding?.only),
        };

        if (!op.pagination_id && op.name.startsWith("list")) {
          op.pagination_id = this.autoDetectPagination(op);
        }

        if (!binding?.methodName) autoNamedOps.add(op);
        operations.push(op);
        resource.operation_ids.push(op.id);
      }
    }

    // Specs without operationIds (e.g. DigitalOcean) infer the same method name for many
    // sibling endpoints. Auto-disambiguate inferred names from the path so generation
    // succeeds; explicitly-configured collisions still surface as a blocker diagnostic.
    const byResource = new Map<string, OperationIR[]>();
    for (const op of operations) {
      const list = byResource.get(op.resource_id) ?? [];
      list.push(op);
      byResource.set(op.resource_id, list);
    }
    for (const ops of byResource.values()) {
      const used = new Set<string>();
      for (const op of ops) {
        if (!used.has(op.name) || !autoNamedOps.has(op)) {
          used.add(op.name);
          continue;
        }
        op.name = this.disambiguateMethodName(op, used);
        used.add(op.name);
      }
    }

    for (const resource of resourceMap.values()) {
      resource.operation_ids = uniqueBy(resource.operation_ids, (id) => id);
      resource.subresource_ids = uniqueBy(resource.subresource_ids, (id) => id);
    }

    return { resources: [...resourceMap.values()], operations };
  }

  /** Materializes a resource and all of its ancestors, wiring parent/subresource links. */
  private ensureResourceChain(resourceMap: Map<string, ResourceIR>, resourcePath: string[]): ResourceIR {
    let parentId: string | undefined;
    let resource: ResourceIR | undefined;
    for (let depth = 1; depth <= resourcePath.length; depth += 1) {
      const path = resourcePath.slice(0, depth);
      const id = resourceIdFromPath(path);
      if (!resourceMap.has(id)) {
        const configured = this.resourceConfigs.get(id)?.config;
        const modelName = configured?.model;
        resourceMap.set(id, {
          id,
          name: path.at(-1) ?? id,
          class_name: path.map((segment) => pascalCase(segment)).join(""),
          path_segments: path,
          model_type_id: modelName ? typeIdFromName(modelName) : undefined,
          operation_ids: [],
          parent_id: parentId,
          subresource_ids: [],
          targets: this.resolveTargets(configured?.skip, configured?.only),
        });
        if (parentId) {
          resourceMap.get(parentId)?.subresource_ids.push(id);
        }
      }
      resource = resourceMap.get(id);
      parentId = id;
    }
    if (!resource) throw new Error(`Failed to build resource for ${resourcePath.join(".")}`);
    return resource;
  }

  /** Builds a unique method name for an auto-named operation by appending path segments. */
  private disambiguateMethodName(op: OperationIR, used: Set<string>): string {
    const segments = op.path.split("/").filter((segment) => segment && !segment.startsWith("{") && !/^v\d+$/i.test(segment));
    for (let take = 1; take <= segments.length; take += 1) {
      const suffix = segments.slice(-take).map((segment) => pascalCase(segment)).join("");
      const candidate = camelCase(`${op.name} ${suffix}`);
      if (candidate && !used.has(candidate)) return candidate;
    }
    let index = 2;
    let candidate = `${op.name}${index}`;
    while (used.has(candidate)) candidate = `${op.name}${(index += 1)}`;
    return candidate;
  }

  /** Stainless-style auto-pagination: a list_* method with no explicit scheme is matched
   *  to the first configured scheme whose request param and items field both fit. */
  private autoDetectPagination(op: OperationIR): string | undefined {
    if (!op.response || op.response.kind !== "ref") return undefined;
    const responseType = this.types.get(op.response.id);
    if (!responseType || responseType.kind !== "object") return undefined;
    const fieldNames = new Set(responseType.fields.flatMap((field) => [field.wire_name, field.name]));
    const paramNames = new Set(op.params.flatMap((param) => [param.wire_name, param.name]));
    for (const [id, raw] of Object.entries(this.config.pagination ?? {})) {
      const pagination = paginationToIR(id, raw);
      const itemsLeaf = pagination.items.split(".").at(-1);
      if (!itemsLeaf || !fieldNames.has(itemsLeaf)) continue;
      if (pagination.type === "cursor_url") {
        if (pagination.next_url && fieldNames.has(pagination.next_url)) return id;
        continue;
      }
      const requestParam =
        pagination.type === "cursor"
          ? leafName(pagination.request_cursor)
          : pagination.type === "offset"
            ? pagination.offset_param
            : pagination.type === "page_number"
              ? pagination.page_param
              : pagination.type === "cursor_id"
                ? pagination.cursor_id_param
                : undefined;
      if (requestParam && paramNames.has(requestParam)) return id;
    }
    return undefined;
  }

  private resolveTargets(skip?: boolean | TargetName[], only?: TargetName[]): TargetName[] | undefined {
    let targets = [...this.allTargets];
    if (only && only.length) targets = targets.filter((target) => only.includes(target));
    if (skip === true) targets = [];
    else if (Array.isArray(skip)) targets = targets.filter((target) => !skip.includes(target));
    return targets.length === this.allTargets.length ? undefined : targets;
  }

  private buildStreaming(config: StreamingConfig | undefined, nameHint: string): StreamingIR | undefined {
    if (!config) return undefined;
    const eventTypeId = typeIdFromName(config.event_model);
    if (!this.types.has(eventTypeId)) {
      this.diagnostics.push({
        severity: "blocker",
        code: "sdk.streaming.event_model.missing",
        message: `Streaming method references event model ${config.event_model}, which is not a generated type. Add it under models.`,
        location: nameHint,
      });
    }
    return {
      event_type_id: eventTypeId,
      param_discriminator: config.param_discriminator ?? undefined,
      protocol: config.protocol ?? "sse",
      done_sentinel: config.done_sentinel,
      always: config.param_discriminator === null || config.param_discriminator === undefined,
    };
  }

  private buildParams(parameters: OpenApiParameter[], path: string): ParamIR[] {
    // Parameters may be `$ref`s into components.parameters (common in real specs:
    // GitHub, Twilio, SendGrid, Plaid, Adyen, Asana). Resolve them before mapping.
    const params = parameters
      .map((param) => this.resolveParam(param))
      .filter((param): param is OpenApiParameter => Boolean(param?.name))
      .map((param) => this.paramToIR(param));
    const pathParamNames = [...path.matchAll(/\{([^}]+)\}/g)]
      .map((match) => match[1])
      .filter((name): name is string => Boolean(name));

    for (const name of pathParamNames) {
      if (!params.some((param) => param.wire_name === name && param.location === "path")) {
        params.push({
          name: camelCase(name),
          wire_name: name,
          location: "path",
          type: { kind: "primitive", name: "string" },
          required: true,
          nullable: false,
        });
        this.diagnostics.push({
          severity: "warning",
          code: "openapi.path_param.implicit",
          message: `Path parameter ${name} in ${path} was not declared; generated as string.`,
          location: path,
        });
      }
    }

    // Distinct wire names can collapse to one camelCase identifier (e.g. Twilio's range params
    // `StartTime<` and `StartTime>`). Keep wire_name exact; make the idiomatic name unique.
    const used = new Set<string>();
    for (const param of params) {
      let name = param.name || "param";
      if (used.has(name)) {
        let suffix = 2;
        while (used.has(`${name}${suffix}`)) suffix += 1;
        name = `${name}${suffix}`;
      }
      used.add(name);
      param.name = name;
    }

    return params;
  }

  private resolveParam(param: OpenApiParameter): OpenApiParameter | undefined {
    const ref = (param as { $ref?: string }).$ref;
    if (!ref) return param;
    return resolveSchemaRef(this.spec, ref) as OpenApiParameter | undefined;
  }

  private paramToIR(param: OpenApiParameter): ParamIR {
    const schema = param.schema ?? { type: "string" };
    return {
      name: camelCase(param.name),
      wire_name: param.name,
      location: param.in,
      type: this.schemaToTypeRef(schema, `${pascalCase(param.name)}Param`),
      required: param.required ?? param.in === "path",
      nullable: Boolean(schema.nullable),
      description: param.description,
    };
  }

  private buildRequestBody(operation: OpenApiOperation, nameHint: string) {
    const content = operation.requestBody?.content;
    if (!content || Object.keys(content).length === 0) return undefined;
    const keys = Object.keys(content);
    const multipartKey = keys.find((key) => key.startsWith("multipart/"));
    const jsonKey = keys.find((key) => key === "application/json" || key.endsWith("+json"));
    const formKey = keys.find((key) => key.startsWith("application/x-www-form-urlencoded"));
    const textKey = keys.find((key) => key.startsWith("text/"));
    // Selection priority for the typed surface: json > form-urlencoded > multipart > text > first.
    const selectedKey = jsonKey ?? formKey ?? multipartKey ?? textKey ?? keys[0] ?? "application/json";
    const schema = content[selectedKey]?.schema;
    if (!schema) return undefined;
    const isMultipart = selectedKey === multipartKey && !jsonKey && !formKey;
    const isForm = selectedKey === formKey && !jsonKey;
    const isText = selectedKey === textKey && !jsonKey && !formKey && !multipartKey;
    const contentType = isMultipart ? "multipart/form-data" : selectedKey;
    return {
      required: operation.requestBody?.required ?? false,
      content_type: contentType,
      type: this.schemaToTypeRef(schema, nameHint),
      multipart: contentType === "multipart/form-data" || (!isForm && !isText && schemaHasBinary(this.spec, schema)),
      form_urlencoded: isForm,
      text_plain: isText,
      content_types: keys,
    };
  }

  private buildResponse(operation: OpenApiOperation, nameHint: string): TypeRefIR | undefined {
    if (responseIsBinary(operation)) return undefined; // binary downloads return raw bytes, not a model
    const response = operation.responses?.["200"] ?? operation.responses?.["201"] ?? operation.responses?.["default"];
    const content = response?.content;
    const json = content?.["application/json"] ?? content?.[Object.keys(content ?? {})[0] ?? ""];
    if (!json?.schema) return undefined;
    return this.schemaToTypeRef(json.schema, nameHint);
  }

  private schemaToNamedType(id: string, name: string, schema: OpenApiSchema): TypeIR {
    if (schema.$ref) {
      return {
        kind: "alias",
        id,
        name,
        target: this.schemaToTypeRef(schema, `${name}Alias`),
        description: schema.description,
      };
    }

    if (schema.allOf?.length) {
      return this.schemaToNamedType(id, name, flattenAllOf(this.spec, schema));
    }

    if (schema.oneOf?.length || schema.anyOf?.length) {
      const variants = (schema.oneOf ?? schema.anyOf ?? []).map((variant, index) =>
        this.schemaToTypeRef(variant, `${name}Variant${index + 1}`),
      );
      return {
        kind: "union",
        id,
        name,
        variants,
        discriminator: schema.discriminator?.propertyName,
        unknown_variant: true,
        description: schema.description,
      };
    }

    if (schema.enum?.length) {
      const values = schema.enum.filter((value): value is string | number => typeof value === "string" || typeof value === "number");
      // An enum with no string/number members (e.g. boolean const `enum: [true]`) is not a
      // real enum; fall through to the scalar/object handling so we don't emit an empty set.
      if (values.length > 0) {
        return {
          kind: "enum",
          id,
          name,
          values,
          open: true,
          value_type: values.every((value) => typeof value === "number") ? "integer" : "string",
          description: schema.description,
        };
      }
    }

    if (schema.type === "object" || schema.properties || schema.additionalProperties) {
      return {
        kind: "object",
        id,
        name,
        fields: this.fieldsForObject(schema, name),
        extra_fields: schema.additionalProperties ? "preserve" : "ignore",
        description: schema.description,
      };
    }

    return {
      kind: "alias",
      id,
      name,
      target: this.schemaToTypeRef(schema, `${name}Value`),
      description: schema.description,
    };
  }

  private fieldsForObject(schema: OpenApiSchema, parentName: string): FieldIR[] {
    const required = new Set(schema.required ?? []);
    // Distinct wire names can collapse to the same camelCase identifier (e.g. `start_time` and
    // `startTime`, or GitHub's `+1`/`-1`). Keep wire_name exact (serde maps by it) but ensure the
    // idiomatic `name` is unique within the object so generated types don't get duplicate members.
    const used = new Set<string>();
    return Object.entries(schema.properties ?? {}).map(([fieldName, fieldSchema]) => {
      let name = camelCase(fieldName) || "field";
      if (used.has(name)) {
        let suffix = 2;
        while (used.has(`${name}${suffix}`)) suffix += 1;
        name = `${name}${suffix}`;
      }
      used.add(name);
      return {
        name,
        wire_name: fieldName,
        type: this.schemaToTypeRef(fieldSchema, `${parentName}${pascalCase(fieldName)}`),
        required: required.has(fieldName),
        nullable: Boolean(fieldSchema.nullable),
        read_only: Boolean(fieldSchema.readOnly),
        write_only: Boolean(fieldSchema.writeOnly),
        description: fieldSchema.description,
        default_value: fieldSchema.default,
        const_value: fieldSchema.const ?? (fieldSchema.enum?.length === 1 ? fieldSchema.enum[0] : undefined),
      };
    });
  }

  private schemaToTypeRef(schema: OpenApiSchema, nameHint: string): TypeRefIR {
    if (schema.$ref) {
      return { kind: "ref", id: typeIdFromRef(schema.$ref), nullable: Boolean(schema.nullable) };
    }

    if (schema.allOf?.length) {
      const id = this.ensureInlineType(flattenAllOf(this.spec, schema), nameHint);
      return { kind: "ref", id, nullable: Boolean(schema.nullable) };
    }

    if (schema.oneOf?.length || schema.anyOf?.length || schema.properties) {
      const id = this.ensureInlineType(schema, nameHint);
      return { kind: "ref", id, nullable: Boolean(schema.nullable) };
    }

    if (schema.enum?.length && schema.enum.some((value) => typeof value === "string" || typeof value === "number")) {
      const id = this.ensureInlineType(schema, nameHint);
      return { kind: "ref", id, nullable: Boolean(schema.nullable) };
    }

    const schemaType = Array.isArray(schema.type) ? schema.type.find((item) => item !== "null") : schema.type;

    if (schemaType === "array") {
      return {
        kind: "array",
        items: this.schemaToTypeRef(schema.items ?? { type: "unknown" }, `${nameHint}Item`),
        nullable: Boolean(schema.nullable),
      };
    }

    if (schemaType === "object" && schema.additionalProperties && typeof schema.additionalProperties === "object") {
      return {
        kind: "map",
        values: this.schemaToTypeRef(schema.additionalProperties, `${nameHint}Value`),
        nullable: Boolean(schema.nullable),
      };
    }

    if (schemaType === "integer") return { kind: "primitive", name: "integer", format: schema.format, nullable: Boolean(schema.nullable) };
    if (schemaType === "number") return { kind: "primitive", name: "number", format: schema.format, nullable: Boolean(schema.nullable) };
    if (schemaType === "boolean") return { kind: "primitive", name: "boolean", nullable: Boolean(schema.nullable) };
    if (schemaType === "string" && schema.format === "binary") return { kind: "file", nullable: Boolean(schema.nullable) };
    if (schemaType === "string") return { kind: "primitive", name: "string", format: schema.format, nullable: Boolean(schema.nullable) };

    return { kind: "primitive", name: "unknown", nullable: Boolean(schema.nullable) };
  }

  private ensureInlineType(schema: OpenApiSchema, nameHint: string): string {
    const id = `inline_${snakeCase(nameHint)}_${++this.inlineTypeCount}`;
    const name = this.uniqueTypeName(pascalCase(nameHint));
    this.types.set(id, this.schemaToNamedType(id, name, schema));
    return id;
  }

  private addQualityDiagnostics(resources: ResourceIR[], operations: OperationIR[]): void {
    const configuredBaseUrl = this.config.client?.base_url?.default ?? this.spec.servers?.find((server) => server.url)?.url;
    if (configuredBaseUrl?.startsWith("http://")) {
      this.diagnostics.push({
        severity: "warning",
        code: "sdk.security.insecure_base_url",
        message: `Base URL ${configuredBaseUrl} uses http://. Production SDKs should default to HTTPS.`,
        location: "client.base_url.default",
      });
    }

    if (!this.config.client?.auth && !this.spec.components?.securitySchemes && !this.config.client?.auth?.optional) {
      this.diagnostics.push({
        severity: "suggestion",
        code: "sdk.security.auth.missing",
        message: "No SDK auth configuration or OpenAPI security scheme was found. Configure auth before publishing production SDKs, or set auth.optional to allow unauthenticated requests.",
        location: "client.auth",
      });
    }

    for (const resource of resources) {
      const names = new Map<string, OperationIR[]>();
      for (const operation of operations.filter((item) => item.resource_id === resource.id)) {
        const existing = names.get(operation.name) ?? [];
        existing.push(operation);
        names.set(operation.name, existing);
      }
      for (const [name, duplicates] of names) {
        if (duplicates.length > 1) {
          this.diagnostics.push({
            severity: "blocker",
            code: "sdk.method_name.collision",
            message: `Resource ${resource.name} has ${duplicates.length} methods named ${name}. Add an override in sdkgen.yml.`,
            location: `resources.${resource.name}`,
          });
        }
      }
    }

    for (const operation of operations) {
      if (operation.pagination_id) {
        const pagination = this.config.pagination?.[operation.pagination_id];
        if (!pagination) {
          this.diagnostics.push({
            severity: "blocker",
            code: "sdk.pagination.missing",
            message: `Operation ${operation.name} references missing pagination scheme ${operation.pagination_id}.`,
            location: operation.path,
          });
        } else {
          const requestCursor = pagination.request_cursor?.split(".").at(-1);
          if (requestCursor && !operation.params.some((param) => param.wire_name === requestCursor || param.name === requestCursor)) {
            this.diagnostics.push({
              severity: "warning",
              code: "sdk.pagination.request_cursor.missing",
              message: `Pagination scheme ${operation.pagination_id} expects request cursor ${requestCursor}, but ${operation.name} has no matching parameter.`,
              location: operation.path,
            });
          }
        }
      }

      // TypeScript permits any keyword as a class member name, so only Python and Go
      // reserved words can actually break a generated method signature.
      for (const target of ["python", "go"] as const) {
        if (isReservedWord(target, operation.name)) {
          this.diagnostics.push({
            severity: "blocker",
            code: "sdk.name.reserved_word",
            message: `Method name ${operation.name} is reserved in ${target}. Add an operation override.`,
            location: operation.path,
            targets: [target],
          });
        }
      }
    }
  }

  private buildWebsocket(config: WebsocketConfig | undefined): WebsocketIR {
    return {
      client_event_type_id: config?.client_event_model ? typeIdFromName(config.client_event_model) : undefined,
      server_event_type_id: config?.server_event_model ? typeIdFromName(config.server_event_model) : undefined,
    };
  }

  private buildOAuth2(envPrefix: string): OAuth2IR | undefined {
    const configured = this.config.client?.auth?.oauth2;
    let tokenUrl = configured?.token_url;
    let scopes = configured?.scopes;

    if (!tokenUrl) {
      for (const scheme of Object.values(this.spec.components?.securitySchemes ?? {})) {
        if (!isRecord(scheme) || scheme.type !== "oauth2") continue;
        const flows = isRecord(scheme.flows) ? scheme.flows : {};
        const clientCredentials = isRecord(flows.clientCredentials) ? flows.clientCredentials : undefined;
        if (clientCredentials && typeof clientCredentials.tokenUrl === "string") {
          tokenUrl = clientCredentials.tokenUrl;
          scopes = scopes ?? (isRecord(clientCredentials.scopes) ? Object.keys(clientCredentials.scopes) : []);
          break;
        }
      }
    }

    if (!configured && !tokenUrl) return undefined;
    if (!tokenUrl) {
      this.diagnostics.push({
        severity: "blocker",
        code: "sdk.oauth2.token_url.missing",
        message: "OAuth2 is configured but no token URL was found in config or the OpenAPI clientCredentials flow.",
        location: "client.auth.oauth2",
      });
      return undefined;
    }

    return {
      token_url: tokenUrl,
      scopes: scopes ?? [],
      auth_style: configured?.auth_style ?? "post",
      client_id_env: configured?.client_id_env ?? `${envPrefix}_CLIENT_ID`,
      client_secret_env: configured?.client_secret_env ?? `${envPrefix}_CLIENT_SECRET`,
      authorization_url: configured?.authorization_url,
      device_authorization_url: configured?.device_authorization_url,
    };
  }

  private buildWebhooks(envPrefix: string): WebhookIR | undefined {
    const config = this.config.webhooks;
    if (!config) return undefined;

    const payloadTypeId = config.payload_type ? typeIdFromName(config.payload_type) : undefined;
    if (payloadTypeId && !this.types.has(payloadTypeId)) {
      this.diagnostics.push({
        severity: "blocker",
        code: "sdk.webhooks.payload_type.missing",
        message: `Webhook payload type ${config.payload_type} was not found in generated models.`,
        location: "webhooks.payload_type",
      });
    }

    return {
      signing_secret_env: config.signing_secret_env ?? `${envPrefix}_WEBHOOK_SECRET`,
      signature_header: config.signature_header ?? "Webhook-Signature",
      timestamp_header: config.timestamp_header ?? "Webhook-Timestamp",
      tolerance_seconds: config.tolerance_seconds ?? 300,
      payload_type_id: payloadTypeId,
    };
  }
}

function normalizeEndpoint(endpoint: string): string {
  const [method, ...pathParts] = endpoint.trim().split(/\s+/);
  return `${(method ?? "get").toLowerCase()} ${pathParts.join(" ")}`;
}

/** A success response is a binary download when its only content is a non-JSON binary media type. */
function responseIsBinary(operation: OpenApiOperation): boolean {
  const response = operation.responses?.["200"] ?? operation.responses?.["201"] ?? operation.responses?.["default"];
  const content = response?.content;
  if (!content) return false;
  const keys = Object.keys(content);
  if (keys.length === 0) return false;
  if (keys.some((key) => key.includes("json"))) return false;
  return keys.some((key) => {
    const lower = key.toLowerCase();
    if (lower.startsWith("application/octet-stream") || lower.startsWith("audio/") || lower.startsWith("image/") || lower.startsWith("video/") || lower === "application/pdf") {
      return true;
    }
    const schema = content[key]?.schema;
    return schema?.type === "string" && schema.format === "binary";
  });
}

function resourceIdFromPath(path: string[]): string {
  return path.map((segment) => snakeCase(segment)).join(".");
}

function leafName(path: string | undefined): string | undefined {
  if (!path) return undefined;
  return path.replace(/^\$\.?/, "").split(".").at(-1) || undefined;
}

function paginationToIR(id: string, pagination: PaginationConfig): PaginationIR {
  return {
    id,
    type: pagination.type,
    items: stripJsonPath(pagination.items) ?? "data",
    request_cursor: pagination.request_cursor,
    response_next_cursor: stripJsonPath(pagination.response_next_cursor),
    request_prev_cursor: pagination.request_prev_cursor,
    response_prev_cursor: stripJsonPath(pagination.response_prev_cursor),
    cursor_id_param: leafName(pagination.cursor_id_param),
    cursor_item_id: leafName(pagination.cursor_item_id),
    next_url: leafName(pagination.next_url),
    offset_param: leafName(pagination.offset_param),
    limit_param: leafName(pagination.limit_param),
    total_count: leafName(pagination.total_count),
    page_param: leafName(pagination.page_param),
    page_size_param: leafName(pagination.page_size_param),
    current_page: leafName(pagination.current_page),
    total_pages: leafName(pagination.total_pages),
  };
}

function schemaHasBinary(spec: OpenApiDocument, schema: OpenApiSchema | undefined, depth = 0): boolean {
  if (!schema || depth > 6) return false;
  const resolved = schema.$ref ? resolveSchemaRef(spec, schema.$ref) ?? schema : schema;
  const type = Array.isArray(resolved.type) ? resolved.type : [resolved.type];
  if (type.includes("string") && resolved.format === "binary") return true;
  for (const property of Object.values(resolved.properties ?? {})) {
    if (schemaHasBinary(spec, property, depth + 1)) return true;
  }
  if (schemaHasBinary(spec, resolved.items, depth + 1)) return true;
  return false;
}

function findConfiguredModelName(config: SdkConfig, ref: string): string | undefined {
  return Object.entries(config.models ?? {}).find(([, configuredRef]) => configuredRef === ref)?.[0];
}

function typeIdFromRef(ref: string): string {
  const name = ref.split("/").at(-1) ?? ref;
  return typeIdFromName(name);
}

function typeIdFromName(name: string): string {
  return snakeCase(name);
}

function inferResourceNameFromPath(path: string): string {
  const segment = path
    .split("/")
    .filter(Boolean)
    .find((part) => !part.startsWith("{") && !/^v\d+/.test(part));
  return camelCase(segment ?? "default");
}

function inferMethodName(method: string, path: string, operationId?: string): string {
  if (operationId) {
    return operationId.replace(/^(list|get|retrieve|create|update|delete|remove|new)([A-Z])/, (_match, verb: string, next: string) => {
      return `${verb}${next}`;
    });
  }
  const segments = path.split("/").filter(Boolean);
  const last = segments.at(-1) ?? "";
  const hasPathParamAtEnd = last.startsWith("{");
  if (method === "get" && !hasPathParamAtEnd) return "list";
  if (method === "get") return "retrieve";
  if (method === "post") return "create";
  if (method === "put" || method === "patch") return "update";
  if (method === "delete") return "delete";
  return camelCase(`${method}_${pluralToSingular(last)}`);
}

function isPromotableSchema(schema: OpenApiSchema): boolean {
  return Boolean(schema.properties || schema.enum || schema.oneOf || schema.anyOf || schema.allOf);
}

function flattenAllOf(spec: OpenApiDocument, schema: OpenApiSchema): OpenApiSchema {
  const merged: OpenApiSchema = {
    ...schema,
    allOf: undefined,
    type: "object",
    properties: {},
    required: [],
  };
  for (const part of schema.allOf ?? []) {
    const resolved = part.$ref ? resolveSchemaRef(spec, part.$ref) ?? part : part;
    const flattened = resolved.allOf?.length ? flattenAllOf(spec, resolved) : resolved;
    merged.properties = { ...(merged.properties ?? {}), ...(flattened.properties ?? {}) };
    merged.required = [...(merged.required ?? []), ...(flattened.required ?? [])];
  }
  merged.required = uniqueBy(merged.required ?? [], (value) => value);
  return merged;
}

function isReservedWord(target: "typescript" | "python" | "go", name: string): boolean {
  const words: Record<typeof target, Set<string>> = {
    typescript: new Set(["break", "case", "catch", "class", "const", "default", "delete", "do", "else", "enum", "export", "extends", "finally", "for", "function", "if", "import", "in", "instanceof", "new", "return", "super", "switch", "this", "throw", "try", "typeof", "var", "void", "while", "with", "yield"]),
    python: new Set(["False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield"]),
    go: new Set(["break", "default", "func", "interface", "select", "case", "defer", "go", "map", "struct", "chan", "else", "goto", "package", "switch", "const", "fallthrough", "if", "range", "type", "continue", "for", "import", "return", "var"]),
  };
  return words[target].has(name);
}
