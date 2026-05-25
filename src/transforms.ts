// OpenAPI Overlay 1.0.0 support (https://spec.openapis.org/overlay/v1.0.0.html): apply a list
// of overlay documents to the spec before IR build, so teams can patch a vendor spec without
// forking it. Each overlay action has a `target` JSONPath and either `update` (deep-merged
// into every matched node) or `remove: true`. Implements a practical JSONPath subset:
// `$`, `.name`, `['name']`/`["name"]`, `[n]`, and the `*`/`[*]` wildcard.
import { readFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Diagnostic, OpenApiDocument, SdkConfig } from "./types.js";

export interface OverlayDocument {
  overlay?: string;
  info?: { title?: string; version?: string };
  actions?: OverlayAction[];
}

export interface OverlayAction {
  target?: string;
  description?: string;
  update?: unknown;
  remove?: boolean;
}

interface Match {
  parent: unknown;
  key: string | number | null; // null => the root document
  value: unknown;
}

function tokenize(path: string): Array<string | "*"> {
  const tokens: Array<string | "*"> = [];
  let rest = path.trim();
  if (rest.startsWith("$")) rest = rest.slice(1);
  const pattern = /^(?:\.(\*)|\.([A-Za-z0-9_$-]+)|\['([^']*)'\]|\["([^"]*)"\]|\[(\d+)\]|\[(\*)\])/;
  while (rest.length > 0) {
    const match = pattern.exec(rest);
    if (!match) break;
    if (match[1] || match[6]) tokens.push("*");
    else tokens.push((match[2] ?? match[3] ?? match[4] ?? match[5]) as string);
    rest = rest.slice(match[0].length);
  }
  return tokens;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolve(root: unknown, path: string): Match[] {
  let matches: Match[] = [{ parent: null, key: null, value: root }];
  for (const token of tokenize(path)) {
    const next: Match[] = [];
    for (const match of matches) {
      const value = match.value;
      if (token === "*") {
        if (Array.isArray(value)) value.forEach((item, index) => next.push({ parent: value, key: index, value: item }));
        else if (isObject(value)) for (const key of Object.keys(value)) next.push({ parent: value, key, value: value[key] });
      } else if (Array.isArray(value) && /^\d+$/.test(token)) {
        const index = Number(token);
        if (index < value.length) next.push({ parent: value, key: index, value: value[index] });
      } else if (isObject(value) && token in value) {
        next.push({ parent: value, key: token, value: value[token] });
      }
    }
    matches = next;
  }
  return matches;
}

function deepMerge(target: unknown, patch: unknown): unknown {
  if (!isObject(target) || !isObject(patch)) return patch;
  for (const [key, value] of Object.entries(patch)) {
    target[key] = deepMerge((target as Record<string, unknown>)[key], value);
  }
  return target;
}

/** Applies one overlay document to `spec` in place; returns how many nodes changed + diagnostics. */
export function applyOverlay(spec: OpenApiDocument, overlay: OverlayDocument, source = "overlay"): { applied: number; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  let applied = 0;
  if (overlay.overlay && !overlay.overlay.startsWith("1.")) {
    diagnostics.push({ severity: "warning", code: "overlay.version.unsupported", message: `Overlay version ${overlay.overlay} may not be supported (expected 1.x).`, location: source });
  }
  for (const action of overlay.actions ?? []) {
    if (!action.target) {
      diagnostics.push({ severity: "warning", code: "overlay.action.no_target", message: "Overlay action missing target; skipped.", location: source });
      continue;
    }
    const matches = resolve(spec, action.target);
    if (matches.length === 0) {
      diagnostics.push({ severity: "info", code: "overlay.target.unmatched", message: `Overlay target matched nothing: ${action.target}`, location: source });
      continue;
    }
    for (const match of matches) {
      if (action.remove) {
        if (match.parent === null) continue; // cannot remove the root
        if (Array.isArray(match.parent) && typeof match.key === "number") match.parent.splice(match.key, 1);
        else if (isObject(match.parent) && typeof match.key === "string") delete match.parent[match.key];
        applied += 1;
      } else if (action.update !== undefined) {
        if (match.parent === null) deepMerge(spec, action.update);
        else if (isObject(match.parent) && typeof match.key === "string") match.parent[match.key] = deepMerge(match.value, action.update);
        else if (Array.isArray(match.parent) && typeof match.key === "number") match.parent[match.key] = deepMerge(match.value, action.update);
        applied += 1;
      }
    }
  }
  return { applied, diagnostics };
}

/** Reads and applies every overlay listed in `config.spec.overlays` (paths relative to the config). */
export async function applyConfiguredOverlays(spec: OpenApiDocument, config: SdkConfig, configPath: string): Promise<Diagnostic[]> {
  const overlays = config.spec.overlays ?? [];
  const diagnostics: Diagnostic[] = [];
  for (const relativePath of overlays) {
    const overlayPath = resolvePath(dirname(resolvePath(configPath)), relativePath);
    let raw: string;
    try {
      raw = await readFile(overlayPath, "utf8");
    } catch {
      diagnostics.push({ severity: "error", code: "overlay.file.missing", message: `Overlay file not found: ${relativePath}`, location: relativePath });
      continue;
    }
    const doc = parseYaml(raw) as OverlayDocument;
    const { applied, diagnostics: overlayDiagnostics } = applyOverlay(spec, doc, relativePath);
    diagnostics.push(...overlayDiagnostics);
    diagnostics.push({ severity: "info", code: "overlay.applied", message: `Applied overlay ${relativePath} (${applied} change(s))`, location: relativePath });
  }
  return diagnostics;
}
