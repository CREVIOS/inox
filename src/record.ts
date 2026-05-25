// Record/replay contract tests. `record` captures a cassette per operation — either offline
// from the spec-derived example responses, or live from a real base URL (read-only GETs) — and
// `replay` re-validates each recorded body against the current IR response type, surfacing
// contract drift (the API changed shape vs. what the SDK expects). Zero new dependencies.
import type { ApiIR, Diagnostic, OperationIR, TypeRefIR } from "./types.js";
import { exampleForRef } from "./mock.js";
import { typeById } from "./generators/common.js";

export interface Cassette {
  id: string;
  command: string;
  method: string;
  path: string;
  status: number;
  body: unknown;
  recorded_at: string;
  source: "spec" | "live";
}

function commandFor(ir: ApiIR, operation: OperationIR): string {
  const resource = ir.resources.find((candidate) => candidate.id === operation.resource_id);
  return [...(resource?.path_segments ?? []), operation.name].join(".");
}

/** Cassettes synthesized offline from the spec's example responses (deterministic). */
export function recordFromSpec(ir: ApiIR): Cassette[] {
  const now = new Date().toISOString();
  return ir.operations
    .filter((operation) => !operation.websocket && !operation.streaming)
    .map((operation) => ({
      id: operation.id,
      command: commandFor(ir, operation),
      method: operation.http_method.toUpperCase(),
      path: operation.path,
      status: operation.response ? 200 : 204,
      body: operation.response ? exampleForRef(ir, operation.response) : null,
      recorded_at: now,
      source: "spec" as const,
    }));
}

/** Cassettes captured live from a running API (read-only GETs without path params). */
export async function recordLive(ir: ApiIR, baseUrl: string, apiKey?: string): Promise<Cassette[]> {
  const now = new Date().toISOString();
  const cassettes: Cassette[] = [];
  for (const operation of ir.operations) {
    if (operation.http_method !== "get" || operation.websocket || operation.streaming) continue;
    if (operation.params.some((param) => param.location === "path")) continue; // skip parameterized paths
    const url = baseUrl.replace(/\/$/, "") + operation.path;
    const headers: Record<string, string> = { accept: "application/json" };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    try {
      const response = await fetch(url, { headers });
      const text = await response.text();
      cassettes.push({
        id: operation.id,
        command: commandFor(ir, operation),
        method: "GET",
        path: operation.path,
        status: response.status,
        body: text ? (JSON.parse(text) as unknown) : null,
        recorded_at: now,
        source: "live",
      });
    } catch {
      // unreachable endpoint; skip
    }
  }
  return cassettes;
}

/** Structural validation of a recorded value against an IR type ref; returns mismatch messages. */
function validateValue(ir: ApiIR, value: unknown, ref: TypeRefIR, path: string, depth = 0): string[] {
  if (depth > 8) return [];
  if (value === null || value === undefined) {
    return ref.nullable ? [] : [`${path}: expected ${describe(ir, ref)}, got null`];
  }
  switch (ref.kind) {
    case "primitive": {
      const okMap: Record<string, (v: unknown) => boolean> = {
        string: (v) => typeof v === "string",
        number: (v) => typeof v === "number",
        integer: (v) => typeof v === "number",
        boolean: (v) => typeof v === "boolean",
        unknown: () => true,
      };
      return okMap[ref.name]?.(value) ? [] : [`${path}: expected ${ref.name}, got ${typeof value}`];
    }
    case "array": {
      if (!Array.isArray(value)) return [`${path}: expected array, got ${typeof value}`];
      return value.flatMap((item, index) => validateValue(ir, item, ref.items, `${path}[${index}]`, depth + 1));
    }
    case "map":
      if (typeof value !== "object" || Array.isArray(value)) return [`${path}: expected object map, got ${typeof value}`];
      return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => validateValue(ir, item, ref.values, `${path}.${key}`, depth + 1));
    case "file":
      return [];
    case "ref": {
      const type = typeById(ir, ref.id);
      if (!type) return [];
      if (type.kind === "object") {
        if (typeof value !== "object" || Array.isArray(value)) return [`${path}: expected ${type.name}, got ${typeof value}`];
        const record = value as Record<string, unknown>;
        const issues: string[] = [];
        for (const field of type.fields) {
          if (field.required && !(field.wire_name in record)) {
            issues.push(`${path}.${field.wire_name}: required field missing`);
          } else if (field.wire_name in record) {
            issues.push(...validateValue(ir, record[field.wire_name], field.type, `${path}.${field.wire_name}`, depth + 1));
          }
        }
        return issues;
      }
      if (type.kind === "enum") {
        return type.values.map(String).includes(String(value)) ? [] : [`${path}: ${JSON.stringify(value)} not in enum ${type.name}`];
      }
      if (type.kind === "alias") return validateValue(ir, value, type.target, path, depth + 1);
      if (type.kind === "union") {
        // pass if the value validates against any variant
        const ok = type.variants.some((variant) => validateValue(ir, value, variant, path, depth + 1).length === 0);
        return ok ? [] : [`${path}: does not match any variant of ${type.name}`];
      }
      return [];
    }
    default:
      return [];
  }
}

function describe(ir: ApiIR, ref: TypeRefIR): string {
  if (ref.kind === "ref") return typeById(ir, ref.id)?.name ?? "value";
  if (ref.kind === "array") return "array";
  if (ref.kind === "primitive") return ref.name;
  return ref.kind;
}

/** Replays cassettes against the current IR, returning contract-drift diagnostics. */
export function replayContract(ir: ApiIR, cassettes: Cassette[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const cassette of cassettes) {
    const operation = ir.operations.find((candidate) => candidate.id === cassette.id);
    if (!operation) {
      diagnostics.push({ severity: "warning", code: "contract.operation.removed", message: `Cassette ${cassette.command} no longer maps to an operation.`, location: cassette.command });
      continue;
    }
    if (!operation.response || cassette.status >= 300) continue;
    const mismatches = validateValue(ir, cassette.body, operation.response, cassette.command);
    for (const mismatch of mismatches) {
      diagnostics.push({ severity: "warning", code: "contract.drift", message: mismatch, location: cassette.command });
    }
  }
  return diagnostics;
}
