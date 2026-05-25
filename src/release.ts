// Release engineering: turn an IR diff into a SemVer recommendation, changelog, and
// release notes, and emit per-target publishing automation (GitHub Actions). Mirrors
// Stainless's release-PR flow (Conventional-Commit-style versioning into a changelog)
// without requiring a hosted service.
import type { ApiIR, TargetName } from "./types.js";
import { diffIR, type DiffResult } from "./diff.js";

export interface ReleasePlan {
  previousVersion: string;
  nextVersion: string;
  bump: DiffResult["recommended_bump"];
  diff: DiffResult;
  date: string;
}

export function planRelease(previous: ApiIR | undefined, current: ApiIR, today = new Date()): ReleasePlan {
  const currentVersion = current.api.version ?? "0.0.0";
  if (!previous) {
    return {
      previousVersion: "0.0.0",
      nextVersion: currentVersion === "0.0.0" ? "0.1.0" : currentVersion,
      bump: "minor",
      diff: { recommended_bump: "minor", changes: [] },
      date: isoDate(today),
    };
  }
  const diff = diffIR(previous, current);
  const previousVersion = previous.api.version ?? "0.0.0";
  return {
    previousVersion,
    nextVersion: bumpVersion(previousVersion, diff.recommended_bump),
    bump: diff.recommended_bump,
    diff,
    date: isoDate(today),
  };
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** SemVer bump with 0.x semantics: before 1.0, breaking changes bump the minor. */
export function bumpVersion(version: string, bump: DiffResult["recommended_bump"]): string {
  const clean = version.replace(/^v/, "").split("-")[0] ?? "0.0.0";
  const [major = 0, minor = 0, patch = 0] = clean.split(".").map((part) => Number.parseInt(part, 10) || 0);
  if (bump === "none") return `${major}.${minor}.${patch}`;
  if (major === 0) {
    if (bump === "major") return `0.${minor + 1}.0`;
    return `0.${minor}.${patch + 1}`;
  }
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

export function renderChangelogEntry(plan: ReleasePlan): string {
  const lines: string[] = [`## ${plan.nextVersion} (${plan.date})`, ""];
  if (plan.diff.changes.length === 0) {
    lines.push("- No API changes detected.", "");
    return lines.join("\n");
  }
  const groups: Array<[DiffResult["changes"][number]["level"], string]> = [
    ["major", "### Breaking changes"],
    ["minor", "### Features"],
    ["patch", "### Fixes"],
  ];
  for (const [level, heading] of groups) {
    const entries = plan.diff.changes.filter((change) => change.level === level);
    if (entries.length === 0) continue;
    lines.push(heading, "");
    for (const change of entries) lines.push(`- ${change.message}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function prependChangelog(existing: string, entry: string): string {
  const header = "# Changelog\n\n";
  const body = existing.startsWith("# Changelog") ? existing.slice(header.length) : existing;
  return `${header}${entry}\n${body}`.replace(/\n{3,}/g, "\n\n");
}

export function renderReleaseNotes(plan: ReleasePlan, apiName: string): string {
  return `# ${apiName} ${plan.nextVersion}

Recommended bump: **${plan.bump}** (from ${plan.previousVersion}).

${renderChangelogEntry(plan)}`;
}

/** GitHub Actions release workflow for a target (uses OIDC/trusted publishing where possible). */
export function renderReleaseWorkflow(target: TargetName, ir: ApiIR): string {
  if (target === "typescript") {
    return `name: release
on:
  push:
    tags: ["v*"]
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          registry-url: "https://registry.npmjs.org"
      - run: npm ci
      - run: npm run build
      - run: npm publish --provenance --access public
        env:
          NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}
`;
  }
  if (target === "python") {
    return `name: release
on:
  push:
    tags: ["v*"]
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - run: pip install build
      - run: python -m build
      # Trusted publishing via OIDC, no long-lived PyPI token required.
      - uses: pypa/gh-action-pypi-publish@release/v1
`;
  }
  if (target === "ruby") {
    return `name: release
on:
  push:
    tags: ["v*"]
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: ruby/setup-ruby@v1
        with:
          ruby-version: "3.3"
      - run: gem build *.gemspec
      # Trusted publishing to RubyGems via OIDC (no long-lived API key).
      - uses: rubygems/release-gem@v1
`;
  }
  if (target === "java") {
    return `name: release
on:
  push:
    tags: ["v*"]
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: "21"
      - run: mvn -B -ntp deploy
        env:
          MAVEN_GPG_PASSPHRASE: \${{ secrets.MAVEN_GPG_PASSPHRASE }}
`;
  }
  if (target === "csharp") {
    return `name: release
on:
  push:
    tags: ["v*"]
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-dotnet@v4
        with:
          dotnet-version: "8.0.x"
      - run: dotnet pack -c Release
      - run: dotnet nuget push "**/*.nupkg" --api-key \${{ secrets.NUGET_API_KEY }} --source https://api.nuget.org/v3/index.json
`;
  }
  return `name: release
on:
  push:
    tags: ["v*"]
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: "1.23"
      - run: go build ./...
      - run: go test ./...
      # Go modules are published to the module proxy automatically on tag push;
      # ${ir.targets.go?.module_path ?? "the module"} becomes available via go get once tagged.
`;
}
