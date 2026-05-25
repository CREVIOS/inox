// Software Bill of Materials (CycloneDX 1.5) per generated SDK. Because the generated
// runtimes have zero third-party runtime dependencies, the component list is empty — the
// smallest possible supply-chain attack surface, which we surface explicitly. Pairs with
// the SLSA build-provenance attestation wired into the generated supply-chain workflow.
import type { ApiIR, TargetName } from "./types.js";
import { sha256, snakeCase } from "./utils.js";

interface CycloneDxBom {
  bomFormat: "CycloneDX";
  specVersion: "1.5";
  serialNumber: string;
  version: number;
  metadata: {
    timestamp: string;
    tools: Array<{ vendor: string; name: string }>;
    component: { type: "library"; "bom-ref": string; name: string; version: string; purl?: string };
  };
  components: unknown[];
}

function packageName(ir: ApiIR, target: TargetName): string {
  if (target === "typescript") return ir.targets.typescript?.package_name ?? `@${snakeCase(ir.api.package_prefix)}/sdk`;
  if (target === "python") return snakeCase(ir.targets.python?.package_name ?? ir.api.package_prefix.replace(/-api$/, ""));
  if (target === "ruby") return snakeCase(ir.targets.ruby?.gem_name ?? ir.targets.ruby?.package_name ?? ir.api.package_prefix.replace(/-api$/, ""));
  if (target === "java") return `${ir.targets.java?.maven_group ?? "com.example"}:${ir.targets.java?.maven_artifact ?? snakeCase(ir.api.package_prefix)}`;
  if (target === "csharp") return ir.targets.csharp?.namespace ?? `${ir.api.package_prefix}.Sdk`;
  return ir.targets.go?.module_path ?? `github.com/generated/${snakeCase(ir.api.package_prefix)}`;
}

function purl(ir: ApiIR, target: TargetName, name: string, version: string): string {
  if (target === "typescript") return `pkg:npm/${name}@${version}`;
  if (target === "python") return `pkg:pypi/${name}@${version}`;
  if (target === "ruby") return `pkg:gem/${name}@${version}`;
  if (target === "java") return `pkg:maven/${name.replace(":", "/")}@${version}`;
  if (target === "csharp") return `pkg:nuget/${name}@${version}`;
  return `pkg:golang/${name}@v${version}`;
}

export function renderSbom(ir: ApiIR, target: TargetName, timestamp = new Date().toISOString()): CycloneDxBom {
  const name = packageName(ir, target);
  const version = ir.api.version ?? "0.1.0";
  // Deterministic serial number derived from package identity + version (reproducible builds).
  const serial = sha256(`${target}:${name}:${version}`).slice(0, 32);
  const uuid = `${serial.slice(0, 8)}-${serial.slice(8, 12)}-${serial.slice(12, 16)}-${serial.slice(16, 20)}-${serial.slice(20, 32)}`;
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: `urn:uuid:${uuid}`,
    version: 1,
    metadata: {
      timestamp,
      tools: [{ vendor: "sdkgen", name: "sdkgen" }],
      component: {
        type: "library",
        "bom-ref": name,
        name,
        version,
        purl: purl(ir, target, name, version),
      },
    },
    // Zero third-party runtime dependencies by design.
    components: [],
  };
}
