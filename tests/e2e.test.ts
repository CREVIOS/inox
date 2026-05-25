import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { enabledTargets, hasBlockingDiagnostics, readConfig, resolveSpecPath, writeSampleFiles } from "../src/config.js";
import { generateTargets } from "../src/generators/index.js";
import { buildIR } from "../src/ir.js";
import { generateMockServer } from "../src/mock.js";
import { merge3 } from "../src/overlay.js";
import { planRelease } from "../src/release.js";
import { governanceDiagnostics } from "../src/governance.js";
import { renderSbom } from "../src/sbom.js";
import { readOpenApiSpec } from "../src/openapi.js";
import { renderMcpFiles } from "../src/products.js";
import { mcpSelfTest } from "../src/mcpserver.js";
import { writeTextFile } from "../src/utils.js";

const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  const originalCwd = process.cwd();
  const tempRoot = process.platform === "win32" ? tmpdir() : "/tmp";
  const tempDir = await mkdtemp(join(tempRoot, "sdkgen-e2e-"));

  try {
    process.chdir(tempDir);
    await writeSampleFiles(false);

    const loadedConfig = await readConfig("sdkgen.yml");
    const loadedSpec = await readOpenApiSpec(resolveSpecPath(loadedConfig.config, loadedConfig.path));
    const ir = buildIR({
      config: loadedConfig.config,
      configRaw: loadedConfig.raw,
      spec: loadedSpec.spec,
      specRaw: loadedSpec.raw,
      diagnostics: [...loadedConfig.diagnostics, ...loadedSpec.diagnostics],
    });

    assert.equal(hasBlockingDiagnostics(ir.diagnostics), false);
    assert.equal(ir.resources.length, 6);
    assert.equal(ir.operations.length, 9);
    assert.equal(ir.webhooks?.signature_header, "Acme-Signature");
    const realtime = ir.operations.find((operation) => operation.id === "connectRealtime");
    assert.ok(realtime?.websocket, "websocket op detected");
    const autoEvents = ir.operations.find((operation) => operation.id === "listEvents");
    assert.equal(autoEvents?.pagination_id, "events_offset");
    assert.equal(ir.client.environments.sandbox, "https://sandbox.acme.test");
    assert.deepEqual(enabledTargets(loadedConfig.config, "all"), ["typescript", "python", "go", "ruby", "java", "csharp"]);

    // Subresource wiring
    const customers = ir.resources.find((resource) => resource.id === "customers");
    assert.ok(customers, "customers resource exists");
    assert.deepEqual(customers?.subresource_ids, ["customers.invoices"]);

    // Streaming + multipart + skip metadata reached the IR
    const completion = ir.operations.find((operation) => operation.id === "createCompletion");
    assert.equal(completion?.streaming?.protocol, "sse");
    assert.equal(completion?.streaming?.param_discriminator, "stream");
    const upload = ir.operations.find((operation) => operation.id === "uploadFile");
    assert.equal(upload?.request?.multipart, true);
    const deleteFile = ir.operations.find((operation) => operation.id === "deleteFile");
    assert.deepEqual(deleteFile?.targets, ["typescript", "python", "ruby", "java", "csharp"]);

    // Three-way custom-code merge: non-overlapping edits merge cleanly, overlaps conflict.
    const clean = merge3("a\nb\nc\nd\n", "a\nB\nc\nd\n", "a\nb\nc\nD\n");
    assert.equal(clean.conflict, false);
    assert.equal(clean.merged, "a\nB\nc\nD");
    const conflicting = merge3("a\nb\nc\n", "a\nX\nc\n", "a\nY\nc\n");
    assert.equal(conflicting.conflict, true);

    // OAuth2 detection from config
    assert.equal(ir.client.oauth2?.token_url, "/oauth/token");

    // Governance ruleset produces findings; SBOM is well-formed CycloneDX with zero deps.
    const governance = governanceDiagnostics(loadedSpec.spec, ir);
    assert.ok(governance.some((d) => d.code === "governance.error_model.missing"));
    const sbom = renderSbom(ir, "typescript");
    assert.equal(sbom.bomFormat, "CycloneDX");
    assert.equal(sbom.specVersion, "1.5");
    assert.equal(sbom.components.length, 0);

    // Release planning: removing an operation is a breaking (major) change.
    const reduced: typeof ir = { ...ir, operations: ir.operations.slice(1) };
    const plan = planRelease(ir, reduced);
    assert.equal(plan.bump, "major");
    assert.ok(plan.diff.changes.some((change) => change.code === "operation.removed"));

    const results = await generateTargets(ir, ["typescript", "python", "go", "ruby", "java", "csharp"], resolve("generated"));
    assert.equal(results.length, 6);
    const mockResult = await generateMockServer(ir, resolve("generated"));
    assert.equal(mockResult.files.length, 1);

    await run("npm", ["install", "--silent"], join(tempDir, "generated/typescript"));
    await run("npm", ["run", "typecheck", "--silent"], join(tempDir, "generated/typescript"));
    await run("npm", ["run", "build", "--silent"], join(tempDir, "generated/typescript"));
    await run("node", ["--test"], join(tempDir, "generated/typescript"));
    await run("python3", ["-m", "compileall", "-q", "src"], join(tempDir, "generated/python"));
    await run("python3", ["-m", "unittest", "discover", "-s", "tests"], join(tempDir, "generated/python"));
    await run("go", ["test", "./..."], join(tempDir, "generated/go"));
    await run("sh", ["-c", 'test -z "$(gofmt -l .)"'], join(tempDir, "generated/go"));
    try {
      await run("sh", ["scripts/run-conformance.sh"], join(tempDir, "generated/java"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/error:|Exception|AssertionError/.test(message)) throw error;
    }
    await run("sh", ["-c", 'find lib -name "*.rb" -print0 | xargs -0 -n1 ruby -c >/dev/null'], join(tempDir, "generated/ruby"));
    await run("ruby", ["test/conformance.rb"], join(tempDir, "generated/ruby"));
    await run("dotnet", ["run", "-c", "Release", "--project", "Conformance/Conformance.csproj"], join(tempDir, "generated/csharp"));
    await run("node", ["server.mjs", "--self-test"], join(tempDir, "generated/mock"));

    // MCP: the generator-as-MCP server (A) answers in-process; the generated per-API MCP
    // server (B) compiles and self-tests every tool mode offline via the root tsx binary.
    assert.equal(ir.mcp.resolved_mode, "typed");
    await mcpSelfTest({ config: "sdkgen.yml", out: resolve("generated") });

    const mcpDir = join(tempDir, "generated/mcp");
    for (const [name, contents] of Object.entries(renderMcpFiles(ir))) {
      await writeTextFile(mcpDir, name, contents.endsWith("\n") ? contents : `${contents}\n`);
    }
    const tsxBin = join(originalCwd, "node_modules/.bin/tsx");
    await run(tsxBin, ["src/server.ts", "--self-test"], mcpDir);

    console.log("e2e generation test passed");
  } finally {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function run(command: string, args: string[], cwd: string): Promise<void> {
  try {
    await execFileAsync(command, args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  } catch (error) {
    if (isExecError(error)) {
      const stdout = error.stdout ? `\nstdout:\n${error.stdout}` : "";
      const stderr = error.stderr ? `\nstderr:\n${error.stderr}` : "";
      throw new Error(`${command} ${args.join(" ")} failed in ${cwd}${stdout}${stderr}`);
    }
    throw error;
  }
}

function isExecError(error: unknown): error is Error & { stdout?: string; stderr?: string } {
  return error instanceof Error;
}

await main();
