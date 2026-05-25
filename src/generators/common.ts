import { join } from "node:path";
import type { ApiIR, FieldIR, GenerationResult, OperationIR, PaginationKind, ResourceIR, TargetName, TypeIR, TypeRefIR } from "../types.js";
import { camelCase, pascalCase, quote, snakeCase, writeTextFile } from "../utils.js";

export interface GeneratorContext {
  ir: ApiIR;
  rootOutDir: string;
}

export interface TargetWriter {
  target: TargetName;
  outDir: string;
  files: string[];
  write(relativePath: string, contents: string): Promise<void>;
  result(): GenerationResult;
}

export function createTargetWriter(target: TargetName, rootOutDir: string): TargetWriter {
  const outDir = join(rootOutDir, target);
  const files: string[] = [];
  return {
    target,
    outDir,
    files,
    async write(relativePath: string, contents: string) {
      await writeTextFile(outDir, relativePath, contents.endsWith("\n") ? contents : `${contents}\n`);
      files.push(relativePath);
    },
    result() {
      return { target, outDir, files };
    },
  };
}

export function typeById(ir: ApiIR, id: string): TypeIR | undefined {
  return ir.types.find((type) => type.id === id);
}

/** Authorization-header scheme prefix incl. trailing space ("Bearer " by default; "" sends bare token). */
export function bearerHeaderPrefix(ir: ApiIR): string {
  const prefix = ir.client.auth?.bearer?.prefix;
  if (prefix === undefined) return "Bearer ";
  return prefix === "" ? "" : `${prefix} `;
}

export function operationsForResource(ir: ApiIR, resource: ResourceIR): OperationIR[] {
  const ids = new Set(resource.operation_ids);
  return ir.operations.filter((operation) => ids.has(operation.id));
}

function resourceById(ir: ApiIR, id: string | undefined): ResourceIR | undefined {
  return id ? ir.resources.find((resource) => resource.id === id) : undefined;
}

export function resourceAppliesToTarget(ir: ApiIR, resource: ResourceIR, target: TargetName): boolean {
  let current: ResourceIR | undefined = resource;
  while (current) {
    if (current.targets && !current.targets.includes(target)) return false;
    current = resourceById(ir, current.parent_id);
  }
  return true;
}

export function operationAppliesToTarget(ir: ApiIR, operation: OperationIR, target: TargetName): boolean {
  if (operation.targets && !operation.targets.includes(target)) return false;
  const resource = resourceById(ir, operation.resource_id);
  return resource ? resourceAppliesToTarget(ir, resource, target) : true;
}

export function targetOperationsForResource(ir: ApiIR, resource: ResourceIR, target: TargetName): OperationIR[] {
  return operationsForResource(ir, resource).filter((operation) => operationAppliesToTarget(ir, operation, target));
}

export function childResources(ir: ApiIR, resource: ResourceIR, target: TargetName): ResourceIR[] {
  return resource.subresource_ids
    .map((id) => resourceById(ir, id))
    .filter((child): child is ResourceIR => Boolean(child))
    .filter((child) => resourceAppliesToTarget(ir, child, target) && resourceHasContent(ir, child, target));
}

/** A resource is emitted for a target only if it (or a descendant) has at least one method. */
export function resourceHasContent(ir: ApiIR, resource: ResourceIR, target: TargetName): boolean {
  if (targetOperationsForResource(ir, resource, target).length > 0) return true;
  return resource.subresource_ids
    .map((id) => resourceById(ir, id))
    .filter((child): child is ResourceIR => Boolean(child))
    .some((child) => resourceAppliesToTarget(ir, child, target) && resourceHasContent(ir, child, target));
}

export function topLevelResources(ir: ApiIR, target: TargetName): ResourceIR[] {
  return ir.resources
    .filter((resource) => !resource.parent_id)
    .filter((resource) => resourceAppliesToTarget(ir, resource, target) && resourceHasContent(ir, resource, target));
}

export function emittedResources(ir: ApiIR, target: TargetName): ResourceIR[] {
  return ir.resources.filter((resource) => resourceAppliesToTarget(ir, resource, target) && resourceHasContent(ir, resource, target));
}

/** Stable, collision-free file slug for a (possibly nested) resource. */
export function resourceFileSlug(resource: ResourceIR): string {
  return resource.path_segments.map((segment) => snakeCase(segment)).join("_");
}

export function streamEventType(ir: ApiIR, operation: OperationIR): TypeIR | undefined {
  return operation.streaming ? typeById(ir, operation.streaming.event_type_id) : undefined;
}

export function operationTypeName(resource: ResourceIR, operation: OperationIR, suffix: string): string {
  return `${resource.class_name}${pascalCase(operation.name)}${suffix}`;
}

export function modelFileName(type: TypeIR): string {
  return `${snakeCase(type.name)}.${type.kind === "object" || type.kind === "enum" || type.kind === "union" || type.kind === "alias" ? "ts" : "txt"}`;
}

export function tsDoc(description: string | undefined, indent = ""): string {
  if (!description) return "";
  // Escape `*/` so a description containing it (e.g. a glob like `release/*/*`) can't
  // terminate the JSDoc block comment early.
  const safe = description.replace(/\*\//g, "*\\/");
  const lines = safe.split("\n").map((line) => `${indent} * ${line}`);
  return `${indent}/**\n${lines.join("\n")}\n${indent} */\n`;
}

export function jsonString(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function pathTemplateForTs(path: string): string {
  return quote(path).replace(/\{([^}]+)\}/g, (_match, name: string) => `\${encodeURIComponent(String(${camelCase(name)}))}`);
}

export function pathTemplateForPython(path: string): string {
  return path.replace(/\{([^}]+)\}/g, (_match, name: string) => `{${snakeCase(name)}}`);
}

export function pathTemplateForGo(path: string): string {
  return path.replace(/\{([^}]+)\}/g, (_match, name: string) => `" + url.PathEscape(fmt.Sprint(params.${pascalCase(name)})) + "`);
}

export function primitiveFallback(ref: TypeRefIR): string {
  if (ref.kind === "primitive") return ref.name;
  return "unknown";
}

export interface PaginationShape {
  kind: PaginationKind;
  itemsField: FieldIR;
  itemType: TypeRefIR;
  /** cursor */
  nextCursorField?: FieldIR;
  requestCursorParam?: string;
  /** cursor (bidirectional / backward) */
  prevCursorField?: FieldIR;
  requestPrevCursorParam?: string;
  /** cursor_id */
  cursorIdParam?: string;
  cursorItemIdField?: FieldIR;
  /** cursor_url */
  nextUrlField?: FieldIR;
  /** offset */
  offsetParam?: string;
  limitParam?: string;
  totalCountField?: FieldIR;
  /** page_number */
  pageParam?: string;
  pageSizeParam?: string;
  currentPageField?: FieldIR;
  totalPagesField?: FieldIR;
}

function fieldByName(fields: FieldIR[], name: string | undefined): FieldIR | undefined {
  if (!name) return undefined;
  return fields.find((field) => field.wire_name === name || field.name === name);
}

function paramName(operation: OperationIR, name: string | undefined): string | undefined {
  if (!name) return undefined;
  return operation.params.find((param) => param.wire_name === name || param.name === name)?.name;
}

export function paginationShape(ir: ApiIR, operation: OperationIR): PaginationShape | undefined {
  if (!operation.pagination_id || !operation.response) return undefined;
  const pagination = ir.pagination.find((item) => item.id === operation.pagination_id);
  if (!pagination) return undefined;
  const responseType = operation.response.kind === "ref" ? typeById(ir, operation.response.id) : undefined;
  if (!responseType || responseType.kind !== "object") return undefined;

  const itemsFieldName = pagination.items.split(".").at(-1) ?? pagination.items;
  const itemsField = fieldByName(responseType.fields, itemsFieldName);
  if (!itemsField || itemsField.type.kind !== "array") return undefined;

  const itemType = itemsField.type.items;
  const itemObject = itemType.kind === "ref" ? typeById(ir, itemType.id) : undefined;
  const itemFields = itemObject?.kind === "object" ? itemObject.fields : [];

  return {
    kind: pagination.type,
    itemsField,
    itemType,
    nextCursorField: fieldByName(responseType.fields, pagination.response_next_cursor?.split(".").at(-1)),
    requestCursorParam: paramName(operation, pagination.request_cursor?.split(".").at(-1)),
    prevCursorField: fieldByName(responseType.fields, pagination.response_prev_cursor?.split(".").at(-1)),
    requestPrevCursorParam: paramName(operation, pagination.request_prev_cursor?.split(".").at(-1)),
    cursorIdParam: paramName(operation, pagination.cursor_id_param),
    cursorItemIdField: fieldByName(itemFields, pagination.cursor_item_id ?? "id"),
    nextUrlField: fieldByName(responseType.fields, pagination.next_url),
    offsetParam: paramName(operation, pagination.offset_param),
    limitParam: paramName(operation, pagination.limit_param),
    totalCountField: fieldByName(responseType.fields, pagination.total_count),
    pageParam: paramName(operation, pagination.page_param),
    pageSizeParam: paramName(operation, pagination.page_size_param),
    currentPageField: fieldByName(responseType.fields, pagination.current_page),
    totalPagesField: fieldByName(responseType.fields, pagination.total_pages),
  };
}
