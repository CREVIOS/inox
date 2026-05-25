// Vendor-format code samples for docs platforms (ReadMe/Mintlify/Redocly/`x-codeSamples`).
// Generates an idiomatic call snippet per language for every operation, straight from the IR,
// plus a helper that decorates an OpenAPI document with `x-codeSamples` arrays so a docs
// vendor renders language tabs. Additive: no generator or runtime changes.
import type { ApiIR, OperationIR, ResourceIR, TargetName, OpenApiDocument } from "./types.js";
import { pascalCase, snakeCase } from "./utils.js";

const LANG_LABEL: Record<TargetName, string> = {
  typescript: "TypeScript",
  python: "Python",
  go: "Go",
  ruby: "Ruby",
  java: "Java",
  csharp: "C#",
};

const LANG_FENCE: Record<TargetName, string> = {
  typescript: "ts",
  python: "python",
  go: "go",
  ruby: "ruby",
  java: "java",
  csharp: "csharp",
};

function resourceById(ir: ApiIR, id: string): ResourceIR | undefined {
  return ir.resources.find((resource) => resource.id === id);
}

function segments(ir: ApiIR, operation: OperationIR): string[] {
  return resourceById(ir, operation.resource_id)?.path_segments ?? [];
}

function pathArgs(operation: OperationIR): string[] {
  return operation.params.filter((param) => param.location === "path").map((param) => param.name);
}

function clientName(ir: ApiIR): string {
  return ir.client.name;
}

/** One idiomatic call snippet per language for a single operation. */
export function operationSnippet(ir: ApiIR, operation: OperationIR, target: TargetName): string {
  const segs = segments(ir, operation);
  const paths = pathArgs(operation);
  const hasBody = Boolean(operation.request);
  const name = operation.name;
  const cls = clientName(ir);
  const accessorDot = (caseFn: (s: string) => string): string => segs.map(caseFn).join(".");

  switch (target) {
    case "typescript": {
      const args = [...paths.map((p) => `${p}: "${p}_value"`), ...(hasBody ? ["body: { /* ... */ }"] : [])];
      const argStr = args.length ? `{ ${args.join(", ")} }` : "";
      return [
        `import { ${cls} } from "${ir.targets.typescript?.package_name ?? ir.api.package_prefix}";`,
        ``,
        `const client = new ${cls}();`,
        `const result = await client.${accessorDot((s) => s)}.${name}(${argStr});`,
        `console.log(result);`,
      ].join("\n");
    }
    case "python": {
      const args = [...paths.map((p) => `${snakeCase(p)}="${p}_value"`), ...(hasBody ? ["body={}"] : [])];
      return [
        `from ${snakeCase(ir.targets.python?.package_name ?? ir.api.package_prefix)} import ${cls}`,
        ``,
        `client = ${cls}()`,
        `result = client.${accessorDot(snakeCase)}.${snakeCase(name)}(${args.join(", ")})`,
        `print(result)`,
      ].join("\n");
    }
    case "go": {
      const paramsType = `${pascalCase(segs.at(-1) ?? "")}${pascalCase(name)}Params`;
      const argStr = paths.length || hasBody ? `, ${paramsType}{}` : "";
      return [
        `client := ${snakeCase(ir.api.package_prefix).replace(/_/g, "")}.NewClient()`,
        `result, err := client.${accessorDot(pascalCase)}.${pascalCase(name)}(context.TODO()${argStr})`,
      ].join("\n");
    }
    case "ruby": {
      const args = [...paths.map((p) => `${snakeCase(p)}: "${p}_value"`), ...(hasBody ? ["body: {}"] : [])];
      return [
        `client = ${cls}::Client.new`,
        `result = client.${accessorDot(snakeCase)}.${snakeCase(name)}(${args.join(", ")})`,
      ].join("\n");
    }
    case "java": {
      const accessor = segs.map((s) => `${s}()`).join(".");
      const args = [...paths.map((p) => `"${p}_value"`), ...(hasBody ? ["body"] : [])];
      return [
        `${cls}Client client = new ${cls}Client();`,
        `Object result = client.${accessor}.${name}(${args.join(", ")});`,
      ].join("\n");
    }
    case "csharp": {
      const args = [...paths.map((p) => `"${p}_value"`), ...(hasBody ? ["body"] : [])];
      return [
        `var client = new ${cls}();`,
        `var result = await client.${accessorDot(pascalCase)}.${pascalCase(name)}Async(${args.join(", ")});`,
      ].join("\n");
    }
    default:
      return "";
  }
}

export interface OperationSamples {
  command: string;
  http: string;
  samples: Partial<Record<TargetName, string>>;
}

const ALL_TARGETS: TargetName[] = ["typescript", "python", "go", "ruby", "java", "csharp"];

/** Code samples for every operation, keyed by operationId; restricted to enabled targets. */
export function codeSamples(ir: ApiIR): Record<string, OperationSamples> {
  const enabled = ALL_TARGETS.filter((target) => Boolean(ir.targets[target]));
  const out: Record<string, OperationSamples> = {};
  for (const operation of ir.operations) {
    const samples: Partial<Record<TargetName, string>> = {};
    for (const target of enabled) {
      if (operation.targets && !operation.targets.includes(target)) continue;
      samples[target] = operationSnippet(ir, operation, target);
    }
    out[operation.id] = {
      command: [...segments(ir, operation), operation.name].join("."),
      http: `${operation.http_method.toUpperCase()} ${operation.path}`,
      samples,
    };
  }
  return out;
}

/** Returns a deep clone of `spec` with `x-codeSamples` added to every documented operation. */
export function decorateOpenApi(spec: OpenApiDocument, ir: ApiIR): OpenApiDocument {
  const clone = JSON.parse(JSON.stringify(spec)) as OpenApiDocument;
  const byPathMethod = new Map<string, OperationSamples>();
  for (const operation of ir.operations) {
    byPathMethod.set(`${operation.http_method} ${operation.path}`, {
      command: [...segments(ir, operation), operation.name].join("."),
      http: `${operation.http_method.toUpperCase()} ${operation.path}`,
      samples: codeSamples(ir)[operation.id]?.samples ?? {},
    });
  }
  for (const [path, item] of Object.entries(clone.paths ?? {})) {
    if (!item || typeof item !== "object") continue;
    for (const [method, op] of Object.entries(item as Record<string, unknown>)) {
      const entry = byPathMethod.get(`${method.toLowerCase()} ${path}`);
      if (!entry || !op || typeof op !== "object") continue;
      const samples = Object.entries(entry.samples).map(([target, source]) => ({
        lang: LANG_FENCE[target as TargetName],
        label: LANG_LABEL[target as TargetName],
        source,
      }));
      (op as Record<string, unknown>)["x-codeSamples"] = samples;
    }
  }
  return clone;
}

/** Markdown block of language-tabbed snippets for one operation (used by renderDocs). */
export function snippetMarkdown(ir: ApiIR, operation: OperationIR): string[] {
  const enabled = ALL_TARGETS.filter((target) => Boolean(ir.targets[target]) && (!operation.targets || operation.targets.includes(target)));
  const lines: string[] = [];
  for (const target of enabled) {
    lines.push("```" + LANG_FENCE[target], operationSnippet(ir, operation, target), "```");
  }
  lines.push("");
  return lines;
}
