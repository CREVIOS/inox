// Converts the canonical IR into JSON Schema (draft 2020-12 compatible). Shared by the
// generator-as-MCP server (`get_endpoint_schema`) and the generated per-API MCP server's
// typed tool mode, so a tool's `inputSchema` is derived from the same source of truth as
// the SDKs. Self-referential types are bounded with a visited set + depth guard.
import type { ApiIR, EnumTypeIR, ObjectTypeIR, OperationIR, TypeIR, TypeRefIR, UnionTypeIR } from "./types.js";

export interface JsonSchema {
  type?: string | string[];
  description?: string;
  format?: string;
  enum?: Array<string | number | boolean | null>;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  additionalProperties?: boolean | JsonSchema;
  anyOf?: JsonSchema[];
  title?: string;
  nullable?: boolean;
  default?: unknown;
}

const MAX_DEPTH = 6;

function typeById(ir: ApiIR, id: string): TypeIR | undefined {
  return ir.types.find((type) => type.id === id);
}

function primitiveSchema(ref: Extract<TypeRefIR, { kind: "primitive" }>): JsonSchema {
  const base: JsonSchema = {};
  switch (ref.name) {
    case "string":
      base.type = "string";
      break;
    case "integer":
      base.type = "integer";
      break;
    case "number":
      base.type = "number";
      break;
    case "boolean":
      base.type = "boolean";
      break;
    default:
      // `unknown` => unconstrained.
      break;
  }
  if (ref.format) base.format = ref.format;
  return base;
}

function withNullable(schema: JsonSchema, nullable: boolean | undefined): JsonSchema {
  if (!nullable || schema.type === undefined) return schema;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.includes("null")) schema.type = [...types, "null"];
  return schema;
}

function objectSchema(ir: ApiIR, type: ObjectTypeIR, visited: Set<string>, depth: number): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const field of type.fields) {
    if (field.write_only) continue; // tool inputs/outputs describe the readable shape
    const child = typeRefToJsonSchema(ir, field.type, visited, depth + 1);
    if (field.description) child.description = field.description;
    properties[field.wire_name] = withNullable(child, field.nullable);
    if (field.required) required.push(field.wire_name);
  }
  const schema: JsonSchema = { type: "object", title: type.name, properties };
  if (required.length > 0) schema.required = required;
  if (type.extra_fields === "reject") schema.additionalProperties = false;
  if (type.description) schema.description = type.description;
  return schema;
}

function enumSchema(type: EnumTypeIR): JsonSchema {
  const schema: JsonSchema = {
    type: type.value_type === "integer" ? "integer" : "string",
    enum: [...type.values],
    title: type.name,
  };
  if (type.description) schema.description = type.description;
  return schema;
}

function unionSchema(ir: ApiIR, type: UnionTypeIR, visited: Set<string>, depth: number): JsonSchema {
  const schema: JsonSchema = {
    title: type.name,
    anyOf: type.variants.map((variant) => typeRefToJsonSchema(ir, variant, visited, depth + 1)),
  };
  if (type.description) schema.description = type.description;
  return schema;
}

export function typeRefToJsonSchema(ir: ApiIR, ref: TypeRefIR, visited = new Set<string>(), depth = 0): JsonSchema {
  if (depth > MAX_DEPTH) return {};
  switch (ref.kind) {
    case "primitive":
      return withNullable(primitiveSchema(ref), ref.nullable);
    case "array":
      return withNullable({ type: "array", items: typeRefToJsonSchema(ir, ref.items, visited, depth + 1) }, ref.nullable);
    case "map":
      return withNullable(
        { type: "object", additionalProperties: typeRefToJsonSchema(ir, ref.values, visited, depth + 1) },
        ref.nullable,
      );
    case "file":
      return withNullable({ type: "string", format: "binary" }, ref.nullable);
    case "ref": {
      const type = typeById(ir, ref.id);
      if (!type) return {};
      if (visited.has(ref.id)) return { type: "object", title: type.name }; // break cycles
      const nextVisited = new Set(visited).add(ref.id);
      let schema: JsonSchema;
      if (type.kind === "object") schema = objectSchema(ir, type, nextVisited, depth);
      else if (type.kind === "enum") schema = enumSchema(type);
      else if (type.kind === "union") schema = unionSchema(ir, type, nextVisited, depth);
      else schema = typeRefToJsonSchema(ir, type.target, nextVisited, depth + 1);
      return withNullable(schema, ref.nullable);
    }
    default:
      return {};
  }
}

/**
 * Tool `inputSchema` for an operation: path + query + header params as top-level
 * properties, and the request body nested under `body`. Required params drive `required`.
 */
export function operationInputSchema(ir: ApiIR, operation: OperationIR): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const param of operation.params) {
    if (param.location === "cookie") continue;
    const child = typeRefToJsonSchema(ir, param.type);
    child.description = param.description ?? `${param.location} parameter`;
    properties[param.wire_name] = withNullable(child, param.nullable);
    if (param.required) required.push(param.wire_name);
  }
  if (operation.request) {
    const bodySchema = operation.request.multipart
      ? { type: "object", description: "multipart/form-data fields" }
      : typeRefToJsonSchema(ir, operation.request.type);
    bodySchema.description = bodySchema.description ?? "JSON request body";
    properties.body = bodySchema;
    if (operation.request.required) required.push("body");
  }
  const schema: JsonSchema = { type: "object", properties };
  if (required.length > 0) schema.required = required;
  return schema;
}
