import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function titleCase(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1).toLowerCase())
    .join("");
}

export function camelCase(input: string): string {
  const pascal = pascalCase(input);
  return pascal.slice(0, 1).toLowerCase() + pascal.slice(1);
}

export function pascalCase(input: string): string {
  const value = titleCase(input);
  if (value.length === 0) return "Value";
  // Identifiers can't begin with a digit in any target language (spec names like
  // `1-clicks` or fields like `401a`); prefix so the result is always a valid identifier.
  return /^[0-9]/.test(value) ? `_${value}` : value;
}

export function snakeCase(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

export function kebabCase(input: string): string {
  return snakeCase(input).replace(/_/g, "-");
}

export function lowerFirst(input: string): string {
  return input.slice(0, 1).toLowerCase() + input.slice(1);
}

export function pluralToSingular(input: string): string {
  if (input.endsWith("ies")) return `${input.slice(0, -3)}y`;
  if (input.endsWith("ses")) return input.slice(0, -2);
  if (input.endsWith("s") && input.length > 1) return input.slice(0, -1);
  return input;
}

export function stripJsonPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  return path.replace(/^\$\./, "").replace(/^\$/, "");
}

export function quote(value: string): string {
  return JSON.stringify(value);
}

export function indent(input: string, spaces = 2): string {
  const prefix = " ".repeat(spaces);
  return input
    .split("\n")
    .map((line) => (line.length > 0 ? `${prefix}${line}` : line))
    .join("\n");
}

export async function writeTextFile(root: string, relativePath: string, contents: string): Promise<string> {
  const fullPath = join(root, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, contents);
  return fullPath;
}

export function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const id = key(item);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(item);
  }
  return out;
}

export function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
