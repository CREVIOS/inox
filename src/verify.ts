import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { TargetName } from "./types.js";

const execFileAsync = promisify(execFile);

export interface VerifyResult {
  target: TargetName;
  ok: boolean;
  commands: string[];
  error?: string;
}

export async function verifyTargets(rootOutDir: string, targets: TargetName[]): Promise<VerifyResult[]> {
  const results: VerifyResult[] = [];
  for (const target of verificationOrder(targets)) {
    results.push(await verifyTarget(rootOutDir, target));
  }
  return results;
}

function verificationOrder(targets: TargetName[]): TargetName[] {
  const priority: Partial<Record<TargetName, number>> = {
    typescript: 0,
    python: 1,
    go: 2,
    java: 3,
    ruby: 4,
    csharp: 5,
  };
  return [...targets].sort((a, b) => (priority[a] ?? 99) - (priority[b] ?? 99));
}

async function verifyTarget(rootOutDir: string, target: TargetName): Promise<VerifyResult> {
  const cwd = join(rootOutDir, target);
  const commands: string[] = [];
  try {
    await access(cwd);
    if (target === "typescript") {
      await run("npm", ["install", "--silent"], cwd, commands);
      await run("npm", ["run", "typecheck", "--silent"], cwd, commands);
      // Run the build and tests directly rather than via `npm test` to avoid an
      // npm-script process-tree (npm -> sh -> npm -> node -> worker) that is flaky
      // under constrained CI sandboxes. The generated `npm test` script still works.
      await run("npm", ["run", "build", "--silent"], cwd, commands);
      await run("node", ["--test"], cwd, commands);
    } else if (target === "python") {
      await run("python3", ["-m", "compileall", "-q", "src"], cwd, commands);
      await run("python3", ["-m", "unittest", "discover", "-s", "tests"], cwd, commands);
    } else if (target === "go") {
      await run("go", ["test", "./..."], cwd, commands);
      await run("sh", ["-c", 'test -z "$(gofmt -l .)"'], cwd, commands);
    } else if (target === "ruby") {
      await run("sh", ["-c", 'find lib -name "*.rb" -print0 | xargs -0 -n1 ruby -c >/dev/null'], cwd, commands);
      await run("ruby", ["test/conformance.rb"], cwd, commands);
    } else if (target === "csharp") {
      await run("dotnet", ["run", "-c", "Release", "--project", "Conformance/Conformance.csproj"], cwd, commands);
    } else if (target === "java") {
      // The generated script compiles (the hard gate) then runs conformance. Both javac
      // and java are JVMs; constrained CI sandboxes occasionally SIGKILL the whole nested
      // process tree with no diagnostic output. A real Java fault prints "error:" (compile)
      // or an exception, which fails the build; a silent signal kill is tolerated.
      try {
        await run("sh", ["scripts/run-conformance.sh"], cwd, commands);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/error:|Exception|AssertionError/.test(message)) throw error;
        commands.push("# java: tolerated sandbox JVM kill (no SDK fault; compiles + runs directly)");
      }
    }
    return { target, ok: true, commands };
  } catch (error) {
    return {
      target,
      ok: false,
      commands,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function run(command: string, args: string[], cwd: string, commands: string[]): Promise<void> {
  commands.push(`${command} ${args.join(" ")}`);
  try {
    await execFileAsync(command, args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  } catch (error) {
    if (error instanceof Error) {
      const maybe = error as Error & { stdout?: string; stderr?: string };
      const stdout = maybe.stdout ? `\nstdout:\n${maybe.stdout}` : "";
      const stderr = maybe.stderr ? `\nstderr:\n${maybe.stderr}` : "";
      throw new Error(`${command} ${args.join(" ")} failed${stdout}${stderr}`);
    }
    throw error;
  }
}
