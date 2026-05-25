import type { ApiIR, GenerationResult, TargetName } from "../types.js";
import { generateGo } from "./go.js";
import { generatePython } from "./python.js";
import { generateTypeScript } from "./typescript.js";
import { generateRuby } from "./ruby.js";
import { generateCsharp } from "./csharp.js";
import { generateJava } from "./java.js";

export async function generateTarget(ir: ApiIR, target: TargetName, outDir: string): Promise<GenerationResult> {
  if (target === "typescript") return generateTypeScript(ir, outDir);
  if (target === "python") return generatePython(ir, outDir);
  if (target === "go") return generateGo(ir, outDir);
  if (target === "ruby") return generateRuby(ir, outDir);
  if (target === "csharp") return generateCsharp(ir, outDir);
  if (target === "java") return generateJava(ir, outDir);
  throw new Error(`Unsupported target: ${target}`);
}

export async function generateTargets(ir: ApiIR, targets: TargetName[], outDir: string): Promise<GenerationResult[]> {
  const results: GenerationResult[] = [];
  for (const target of targets) {
    results.push(await generateTarget(ir, target, outDir));
  }
  return results;
}
