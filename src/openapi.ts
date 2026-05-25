import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { parseDocument } from "yaml";
import type { Diagnostic, OpenApiDocument, OpenApiSchema } from "./types.js";
import { isRecord } from "./utils.js";

export interface LoadedSpec {
  spec: OpenApiDocument;
  diagnostics: Diagnostic[];
  raw: string;
}

export async function readOpenApiSpec(path: string): Promise<LoadedSpec> {
  const raw = await readFile(path, "utf8");
  const diagnostics: Diagnostic[] = [];
  let parsed: unknown;

  if (extname(path).toLowerCase() === ".json") {
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      diagnostics.push({
        severity: "error",
        code: "openapi.json.invalid",
        message: error instanceof Error ? error.message : String(error),
        location: path,
      });
      parsed = {};
    }
  } else {
    const doc = parseDocument(raw);
    for (const error of doc.errors) {
      diagnostics.push({
        severity: "error",
        code: "openapi.yaml.invalid",
        message: error.message,
        location: path,
      });
    }
    parsed = doc.toJS();
  }

  if (!isRecord(parsed)) {
    diagnostics.push({
      severity: "error",
      code: "openapi.document.invalid",
      message: "OpenAPI document must be an object.",
      location: path,
    });
    parsed = {};
  }

  const spec = parsed as OpenApiDocument;
  diagnostics.push(...validateOpenApiDocument(spec, path));
  return { spec, diagnostics, raw };
}

export function validateOpenApiDocument(spec: OpenApiDocument, path: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  if (!spec.openapi) {
    diagnostics.push({
      severity: "error",
      code: "openapi.version.missing",
      message: "`openapi` version is required.",
      location: `${path}:openapi`,
    });
  }

  if (!spec.paths || Object.keys(spec.paths).length === 0) {
    diagnostics.push({
      severity: "error",
      code: "openapi.paths.missing",
      message: "`paths` must include at least one operation.",
      location: `${path}:paths`,
    });
  }

  for (const [route, pathItem] of Object.entries(spec.paths ?? {})) {
    if (!isRecord(pathItem)) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!isHttpMethod(method) || !isRecord(operation)) continue;
      if (!("operationId" in operation)) {
        diagnostics.push({
          severity: "warning",
          code: "openapi.operation_id.missing",
          message: `${method.toUpperCase()} ${route} is missing operationId; a method name will be inferred.`,
          location: `${path}:paths.${route}.${method}`,
        });
      }
    }
  }

  return diagnostics;
}

export function isHttpMethod(method: string): method is "get" | "post" | "put" | "patch" | "delete" | "head" | "options" {
  return ["get", "post", "put", "patch", "delete", "head", "options"].includes(method.toLowerCase());
}

export function resolveSchemaRef(spec: OpenApiDocument, ref: string): OpenApiSchema | undefined {
  if (!ref.startsWith("#/")) return undefined;
  const parts = ref
    .slice(2)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: unknown = spec;
  for (const part of parts) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return isRecord(current) ? (current as OpenApiSchema) : undefined;
}
