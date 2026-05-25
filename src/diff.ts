import type { ApiIR } from "./types.js";

export interface DiffChange {
  level: "patch" | "minor" | "major";
  code: string;
  message: string;
}

export interface DiffResult {
  recommended_bump: "none" | "patch" | "minor" | "major";
  changes: DiffChange[];
}

const bumpRank = { none: 0, patch: 1, minor: 2, major: 3 } as const;

export function diffIR(previous: ApiIR, current: ApiIR): DiffResult {
  const changes: DiffChange[] = [];
  const previousOps = new Map(previous.operations.map((operation) => [operation.id, operation]));
  const currentOps = new Map(current.operations.map((operation) => [operation.id, operation]));
  const previousTypes = new Map(previous.types.map((type) => [type.id, type]));
  const currentTypes = new Map(current.types.map((type) => [type.id, type]));

  for (const [id, operation] of currentOps) {
    if (!previousOps.has(id)) {
      changes.push({ level: "minor", code: "operation.added", message: `Added ${operation.http_method.toUpperCase()} ${operation.path} (${operation.name})` });
    }
  }

  for (const [id, operation] of previousOps) {
    if (!currentOps.has(id)) {
      changes.push({ level: "major", code: "operation.removed", message: `Removed ${operation.http_method.toUpperCase()} ${operation.path} (${operation.name})` });
      continue;
    }
    const currentOperation = currentOps.get(id);
    if (!currentOperation) continue;
    if (operation.name !== currentOperation.name) {
      changes.push({ level: "major", code: "operation.renamed", message: `Renamed operation ${id}: ${operation.name} -> ${currentOperation.name}` });
    }
    if (operation.path !== currentOperation.path || operation.http_method !== currentOperation.http_method) {
      changes.push({ level: "major", code: "operation.endpoint.changed", message: `Changed endpoint for ${id}` });
    }
  }

  for (const [id, type] of currentTypes) {
    if (!previousTypes.has(id)) {
      changes.push({ level: "minor", code: "type.added", message: `Added type ${type.name}` });
    }
  }

  for (const [id, type] of previousTypes) {
    const currentType = currentTypes.get(id);
    if (!currentType) {
      changes.push({ level: "major", code: "type.removed", message: `Removed type ${type.name}` });
      continue;
    }
    if (type.kind === "object" && currentType.kind === "object") {
      const previousFields = new Map(type.fields.map((field) => [field.wire_name, field]));
      const currentFields = new Map(currentType.fields.map((field) => [field.wire_name, field]));
      for (const [fieldName, field] of currentFields) {
        if (!previousFields.has(fieldName)) {
          changes.push({
            level: field.required ? "major" : "minor",
            code: "field.added",
            message: `Added ${field.required ? "required" : "optional"} field ${currentType.name}.${field.name}`,
          });
        }
      }
      for (const [fieldName, field] of previousFields) {
        if (!currentFields.has(fieldName)) {
          changes.push({ level: "major", code: "field.removed", message: `Removed field ${type.name}.${field.name}` });
        }
      }
    }
    if (type.kind === "enum" && currentType.kind === "enum") {
      const previousValues = new Set(type.values.map(String));
      for (const value of currentType.values) {
        if (!previousValues.has(String(value))) {
          changes.push({
            level: currentType.open ? "patch" : "major",
            code: "enum.value.added",
            message: `Added enum value ${currentType.name}.${String(value)}`,
          });
        }
      }
    }
  }

  return {
    recommended_bump: recommendedBump(changes),
    changes,
  };
}

function recommendedBump(changes: DiffChange[]): DiffResult["recommended_bump"] {
  let recommended: DiffResult["recommended_bump"] = "none";
  for (const change of changes) {
    if (bumpRank[change.level] > bumpRank[recommended]) recommended = change.level;
  }
  return recommended;
}
