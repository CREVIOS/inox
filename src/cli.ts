#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { hasBlockingDiagnostics, readConfig, resolveSpecPath, writeSampleFiles, enabledTargets } from "./config.js";
import { diffIR } from "./diff.js";
import { buildIR } from "./ir.js";
import { generateMockServer } from "./mock.js";
import { readOpenApiSpec } from "./openapi.js";
import { applyOverlay } from "./overlay.js";
import { planRelease, prependChangelog, renderChangelogEntry, renderReleaseNotes } from "./release.js";
import { renderApiExplorer, renderAutomationFiles, renderCliFiles, renderDocs, renderMcpFiles, renderReactFiles, renderTerraformFiles } from "./products.js";
import { codeSamples, decorateOpenApi } from "./codesamples.js";
import type { ApiIR, Diagnostic, TargetName } from "./types.js";
import { generateTargets } from "./generators/index.js";
import { verifyTargets } from "./verify.js";
import { writeTextFile } from "./utils.js";
import { createStudioServer, studioSelfTest } from "./studio.js";
import { governanceDiagnostics } from "./governance.js";
import { renderSbom } from "./sbom.js";
import { renderConnectFiles } from "./connectgen.js";
import { mcpSelfTest, runMcpServer } from "./mcpserver.js";
import { applyConfiguredOverlays } from "./transforms.js";
import { recordFromSpec, recordLive, replayContract, type Cassette } from "./record.js";

interface CliOptions {
  config: string;
  out: string;
  target: TargetName | "all";
  force: boolean;
  pretty: boolean;
  overlay: boolean;
  selfTest: boolean;
  port: number;
  governance: boolean;
  strictGovernance: boolean;
  gate: boolean;
  against?: string;
  baseUrl?: string;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? "help";
  const options = parseOptions(args.slice(1));

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "init") {
    await writeSampleFiles(options.force);
    console.log("Wrote sdkgen.yml and openapi.yaml");
    return;
  }

  if (command === "mcp") {
    const serverOptions = { config: options.config, out: options.out };
    if (options.selfTest) {
      await mcpSelfTest(serverOptions);
      return;
    }
    runMcpServer(serverOptions);
    return;
  }

  if (!["lint", "ir", "generate", "mock", "verify", "diff", "release", "products", "studio", "sbom", "record", "replay"].includes(command)) {
    throw new Error(`Unknown command: ${command}`);
  }

  const { loadedConfig, loadedSpec, ir } = await loadProject(options.config);
  const diagnostics = [...loadedConfig.diagnostics, ...loadedSpec.diagnostics, ...ir.diagnostics];
  if (options.governance) {
    diagnostics.push(...governanceDiagnostics(loadedSpec.spec, ir, { strict: options.strictGovernance }));
  }

  if (command === "lint") {
    printDiagnostics(diagnostics);
    if (hasBlockingDiagnostics(diagnostics)) process.exitCode = 1;
    return;
  }

  if (hasBlockingDiagnostics(diagnostics)) {
    printDiagnostics(diagnostics);
    throw new Error("Cannot continue with blocking diagnostics.");
  }

  if (command === "ir") {
    const outPath = await writeIrSnapshot(ir, options.out === "generated" ? ".sdkgen/ir.json" : options.out, options.pretty);
    console.log(`Wrote ${outPath}`);
    return;
  }

  if (command === "generate") {
    const targets = enabledTargets(loadedConfig.config, options.target);
    if (targets.length === 0) {
      throw new Error(`No enabled targets matched ${options.target}. Check sdkgen.yml targets.`);
    }
    const outRoot = resolve(options.out);

    const writeSboms = async (): Promise<void> => {
      for (const target of targets) {
        await writeTextFile(outRoot, `${target}/sbom.cdx.json`, `${JSON.stringify(renderSbom(ir, target), null, 2)}\n`);
      }
    };

    if (!options.overlay) {
      const results = await generateTargets(ir, targets, outRoot);
      const mock = await generateMockServer(ir, outRoot);
      await writeSboms();
      await writeIrSnapshot(ir, ".sdkgen/ir.json", true);
      for (const result of results) {
        console.log(`Generated ${result.target} SDK at ${result.outDir} (${result.files.length} files)`);
      }
      console.log(`Generated mock server at ${mock.outDir} (${mock.files.length} files)`);
      return;
    }

    // Generate into a clean staging tree, then three-way merge into the output
    // so any custom code on top of generated files survives regeneration.
    const staging = await mkdtemp(join(tmpdir(), "sdkgen-stage-"));
    try {
      const results = await generateTargets(ir, targets, staging);
      await generateMockServer(ir, staging);
      const report = await applyOverlay(staging, outRoot, resolve(".sdkgen/base"));
      await writeSboms();
      await writeIrSnapshot(ir, ".sdkgen/ir.json", true);
      for (const result of results) {
        console.log(`Generated ${result.target} SDK (${result.files.length} files)`);
      }
      console.log(
        `Overlay: ${report.written.length} written, ${report.merged.length} merged, ${report.deleted.length} deleted, ${report.preserved.length} preserved, ${report.conflicts.length} conflicts`,
      );
      for (const conflict of report.conflicts) console.log(`  CONFLICT ${conflict}`);
      for (const preserved of report.preserved) console.log(`  PRESERVED (no longer generated) ${preserved}`);
      if (report.conflicts.length > 0) process.exitCode = 1;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    return;
  }

  if (command === "mock") {
    const result = await generateMockServer(ir, resolve(options.out));
    await writeIrSnapshot(ir, ".sdkgen/ir.json", true);
    console.log(`Generated mock server at ${result.outDir} (${result.files.length} files)`);
    return;
  }

  if (command === "verify") {
    const targets = enabledTargets(loadedConfig.config, options.target);
    const results = await verifyTargets(resolve(options.out), targets);
    for (const result of results) {
      console.log(`${result.ok ? "PASS" : "FAIL"} ${result.target}: ${result.commands.join(" && ")}`);
      if (result.error) console.log(result.error);
    }
    if (results.some((result) => !result.ok)) process.exitCode = 1;
    return;
  }

  if (command === "sbom") {
    const targets = enabledTargets(loadedConfig.config, options.target);
    const outRoot = resolve(options.out);
    for (const target of targets) {
      const bom = renderSbom(ir, target);
      await writeTextFile(outRoot, `${target}/sbom.cdx.json`, `${JSON.stringify(bom, null, 2)}\n`);
      console.log(`Wrote ${target}/sbom.cdx.json (CycloneDX 1.5, ${bom.components.length} third-party components)`);
    }
    return;
  }

  if (command === "studio") {
    let previous: ApiIR | undefined;
    try {
      previous = JSON.parse(await readFile(resolve(".sdkgen/released.json"), "utf8")) as ApiIR;
    } catch {
      previous = undefined;
    }
    const studioData = { ir, diagnostics, previous };
    if (options.selfTest) {
      await studioSelfTest(studioData);
      return;
    }
    const server = createStudioServer(studioData);
    server.listen(options.port, "127.0.0.1", () => {
      console.log(`sdkgen Studio running at http://127.0.0.1:${options.port}`);
    });
    return;
  }

  if (command === "products") {
    const outRoot = resolve(options.out);
    await writeTextFile(outRoot, "docs/api.md", ensureTrailingNewline(renderDocs(ir)));
    await writeTextFile(outRoot, "docs/code-samples.json", `${JSON.stringify(codeSamples(ir), null, 2)}\n`);
    await writeTextFile(outRoot, "docs/openapi.x-codesamples.json", `${JSON.stringify(decorateOpenApi(loadedSpec.spec, ir), null, 2)}\n`);
    await writeTextFile(outRoot, "docs/explorer.html", ensureTrailingNewline(renderApiExplorer(ir)));
    let fileCount = 4;
    for (const [name, contents] of Object.entries(renderCliFiles(ir))) {
      await writeTextFile(outRoot, `cli/${name}`, ensureTrailingNewline(contents));
      fileCount += 1;
    }
    for (const [name, contents] of Object.entries(renderMcpFiles(ir))) {
      await writeTextFile(outRoot, `mcp/${name}`, ensureTrailingNewline(contents));
      fileCount += 1;
    }
    for (const [name, contents] of Object.entries(renderTerraformFiles(ir))) {
      await writeTextFile(outRoot, `terraform/${name}`, ensureTrailingNewline(contents));
      fileCount += 1;
    }
    for (const [name, contents] of Object.entries(renderAutomationFiles(ir))) {
      await writeTextFile(outRoot, `automation/${name}`, ensureTrailingNewline(contents));
      fileCount += 1;
    }
    if (enabledTargets(loadedConfig.config, "all").includes("typescript")) {
      for (const [name, contents] of Object.entries(renderReactFiles(ir))) {
        await writeTextFile(outRoot, `react/${name}`, ensureTrailingNewline(contents));
        fileCount += 1;
      }
      for (const [name, contents] of Object.entries(renderConnectFiles(ir))) {
        await writeTextFile(outRoot, `connect/${name}`, ensureTrailingNewline(contents));
        fileCount += 1;
      }
    }
    console.log(`Generated docs, CLI, MCP server, Terraform provider, Connect client, and CI automation (${fileCount} files) under ${outRoot}`);
    return;
  }

  if (command === "release") {
    const releasedPath = resolve(".sdkgen/released.json");
    let previous: ApiIR | undefined;
    try {
      previous = JSON.parse(await readFile(releasedPath, "utf8")) as ApiIR;
    } catch {
      previous = undefined;
    }
    const plan = planRelease(previous, ir);
    console.log(`Recommended bump: ${plan.bump}`);
    console.log(`Version: ${plan.previousVersion} -> ${plan.nextVersion}`);
    for (const change of plan.diff.changes) {
      console.log(`  [${change.level}] ${change.code}: ${change.message}`);
    }

    let changelog = "";
    try {
      changelog = await readFile(resolve("CHANGELOG.md"), "utf8");
    } catch {
      changelog = "";
    }
    await writeFile(resolve("CHANGELOG.md"), prependChangelog(changelog, renderChangelogEntry(plan)));
    await mkdir(resolve(".sdkgen"), { recursive: true });
    await writeFile(resolve(".sdkgen/release-notes.md"), renderReleaseNotes(plan, ir.api.name));
    await writeFile(releasedPath, `${JSON.stringify(ir, null, 2)}\n`);
    console.log("Wrote CHANGELOG.md and .sdkgen/release-notes.md; updated .sdkgen/released.json");
    return;
  }

  if (command === "diff") {
    if (!options.against) {
      throw new Error("diff requires --against <previous-ir.json>");
    }
    const previous = JSON.parse(await readFile(resolve(options.against), "utf8")) as ApiIR;
    const result = diffIR(previous, ir);
    console.log(`Recommended bump: ${result.recommended_bump}`);
    if (result.changes.length === 0) {
      console.log("No IR changes.");
    } else {
      for (const change of result.changes) {
        console.log(`[${change.level}] ${change.code}: ${change.message}`);
      }
    }
    if (options.gate && result.recommended_bump === "major") {
      console.error("Breaking change detected (major bump required). Failing the gate.");
      process.exitCode = 1;
    }
    return;
  }

  if (command === "record") {
    const cassettesPath = resolve(".sdkgen/cassettes.json");
    const cassettes = options.baseUrl
      ? await recordLive(ir, options.baseUrl, process.env[`${ir.client.env_prefix}_API_KEY`])
      : recordFromSpec(ir);
    await mkdir(resolve(".sdkgen"), { recursive: true });
    await writeFile(cassettesPath, `${JSON.stringify(cassettes, null, 2)}\n`);
    console.log(`Recorded ${cassettes.length} cassette(s) (${options.baseUrl ? `live from ${options.baseUrl}` : "from spec examples"}) to ${cassettesPath}`);
    return;
  }

  if (command === "replay") {
    let cassettes: Cassette[];
    try {
      cassettes = JSON.parse(await readFile(resolve(".sdkgen/cassettes.json"), "utf8")) as Cassette[];
    } catch {
      throw new Error("No cassettes found; run `sdkgen record` first.");
    }
    const drift = replayContract(ir, cassettes);
    if (drift.length === 0) {
      console.log(`Replayed ${cassettes.length} cassette(s): contract holds, no drift.`);
    } else {
      printDiagnostics(drift);
      console.error(`Contract drift in ${drift.length} place(s).`);
      if (options.gate) process.exitCode = 1;
    }
    return;
  }
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

async function writeIrSnapshot(ir: ApiIR, path: string, pretty: boolean): Promise<string> {
  const outPath = resolve(path);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(ir, null, pretty ? 2 : 0)}\n`);
  return outPath;
}

async function loadProject(configPath: string) {
  const loadedConfig = await readConfig(configPath);
  const specPath = resolveSpecPath(loadedConfig.config, loadedConfig.path);
  const loadedSpec = await readOpenApiSpec(specPath);
  const overlayDiagnostics = await applyConfiguredOverlays(loadedSpec.spec, loadedConfig.config, loadedConfig.path);
  const ir = buildIR({
    config: loadedConfig.config,
    configRaw: loadedConfig.raw,
    spec: loadedSpec.spec,
    specRaw: loadedSpec.raw,
    diagnostics: [...loadedConfig.diagnostics, ...loadedSpec.diagnostics, ...overlayDiagnostics],
  });
  return { loadedConfig, loadedSpec, ir };
}

function parseOptions(args: string[]): CliOptions {
  const options: CliOptions = {
    config: "sdkgen.yml",
    out: "generated",
    target: "all",
    force: false,
    pretty: true,
    overlay: true,
    selfTest: false,
    port: 4100,
    governance: false,
    strictGovernance: false,
    gate: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--config" || arg === "-c") {
      options.config = requiredValue(args, ++index, arg);
    } else if (arg === "--out" || arg === "-o") {
      options.out = requiredValue(args, ++index, arg);
    } else if (arg === "--target" || arg === "-t") {
      const value = requiredValue(args, ++index, arg);
      if (!isTargetOption(value)) throw new Error(`Unsupported target ${value}`);
      options.target = value;
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--no-overlay") {
      options.overlay = false;
    } else if (arg === "--self-test") {
      options.selfTest = true;
    } else if (arg === "--port") {
      options.port = Number(requiredValue(args, ++index, arg));
    } else if (arg === "--governance") {
      options.governance = true;
    } else if (arg === "--strict-governance") {
      options.governance = true;
      options.strictGovernance = true;
    } else if (arg === "--gate") {
      options.gate = true;
    } else if (arg === "--compact") {
      options.pretty = false;
    } else if (arg === "--against") {
      options.against = requiredValue(args, ++index, arg);
    } else if (arg === "--base-url") {
      options.baseUrl = requiredValue(args, ++index, arg);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function isTargetOption(value: string): value is TargetName | "all" {
  return ["all", "typescript", "python", "go", "ruby", "java", "csharp"].includes(value);
}

function printDiagnostics(diagnostics: Diagnostic[]): void {
  if (diagnostics.length === 0) {
    console.log("No diagnostics.");
    return;
  }
  const seen = new Set<string>();
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.severity}:${diagnostic.code}:${diagnostic.location ?? ""}:${diagnostic.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const location = diagnostic.location ? ` ${diagnostic.location}` : "";
    console.log(`[${diagnostic.severity}] ${diagnostic.code}${location}: ${diagnostic.message}`);
  }
}

function printHelp(): void {
  console.log(`inox — one spec, every SDK

Commands:
  init                 Write sample sdkgen.yml and openapi.yaml
  lint                 Validate config/spec and show diagnostics
  ir                   Write canonical IR JSON
  generate             Generate SDK source trees
  mock                 Generate a spec-derived local mock server
  verify               Run target verification checks against generated SDKs
  diff                 Compare current IR against a previous IR snapshot
  release              Plan a SemVer release, write CHANGELOG.md and release notes
  products             Generate docs, CLI, MCP server, Terraform provider, CI automation
  studio               Serve the offline Studio web UI over the IR (--port, --self-test)
  mcp                  Run the generator itself as an MCP server over stdio (--self-test)
  record               Record contract cassettes (spec examples, or live via --base-url)
  replay               Replay cassettes against the IR to detect contract drift (--gate)
  sbom                 Write a CycloneDX SBOM per target (zero-dependency runtime)

Options:
  -c, --config <path>  Config path, default sdkgen.yml
  -o, --out <path>     Output path, default generated
  -t, --target <name>  all, typescript, python, or go
  --against <path>     Previous IR snapshot for diff
  --gate               Fail (exit 1) on a breaking change during diff
  --governance         Run policy-as-code governance rules during lint
  --strict-governance  Escalate governance findings to blockers
  --force              Overwrite sample files during init
  --no-overlay         Overwrite output without three-way custom-code merge
  --port <n>           Studio port (default 4100)
  --self-test          Studio: boot, hit every route, exit
  --compact            Write compact JSON for ir
`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
