// Offline Studio: a dependency-free local web app + JSON API over the IR, diagnostics,
// and release plan. A clean-room analogue of Stainless's hosted Studio for inspecting a
// build before publishing. Runs entirely in-process via node:http.
import { createServer, type Server } from "node:http";
import type { ApiIR, Diagnostic, TargetName } from "./types.js";
import { planRelease, type ReleasePlan } from "./release.js";
import { diffIR, type DiffResult } from "./diff.js";

/** Per-target install commands plus a templated early-access (branch build) install URL. */
function installTargets(ir: ApiIR, branch = "next"): Array<{ target: string; install: string; branch_install: string }> {
  const out: Array<{ target: string; install: string; branch_install: string }> = [];
  const slug = ir.api.package_prefix.replace(/[^a-zA-Z0-9]+/g, "-");
  const url = (target: string) => `https://builds.sdkgen.local/${slug}/${branch}/${target}`;
  const targets = Object.keys(ir.targets) as TargetName[];
  for (const target of targets) {
    const cfg = ir.targets[target] ?? {};
    if (target === "typescript") out.push({ target, install: `npm install ${cfg.package_name ?? slug}`, branch_install: `npm install "${url("typescript")}.tgz"` });
    else if (target === "python") out.push({ target, install: `pip install ${cfg.project_name ?? cfg.package_name ?? slug}`, branch_install: `pip install "${url("python")}.whl"` });
    else if (target === "go") out.push({ target, install: `go get ${cfg.module_path ?? slug}`, branch_install: `go get ${cfg.module_path ?? slug}@${branch}` });
    else if (target === "ruby") out.push({ target, install: `gem install ${cfg.gem_name ?? slug}`, branch_install: `gem install ${cfg.gem_name ?? slug} --source ${url("ruby")}` });
    else if (target === "java") out.push({ target, install: `implementation("${cfg.maven_group ?? "com." + slug}:${cfg.maven_artifact ?? slug}")`, branch_install: url("java") });
    else if (target === "csharp") out.push({ target, install: `dotnet add package ${cfg.namespace ?? slug}`, branch_install: `dotnet add package ${cfg.namespace ?? slug} --source ${url("csharp")}` });
  }
  return out;
}

export interface StudioData {
  ir: ApiIR;
  diagnostics: Diagnostic[];
  previous?: ApiIR;
}

export function createStudioServer(data: StudioData): Server {
  const release: ReleasePlan = planRelease(data.previous, data.ir);
  const diff: DiffResult = data.previous ? diffIR(data.previous, data.ir) : { recommended_bump: "minor", changes: [] };
  const install = installTargets(data.ir);
  const summary = {
    api: data.ir.api.name,
    version: data.ir.api.version,
    resources: data.ir.resources.length,
    operations: data.ir.operations.length,
    types: data.ir.types.length,
    diagnostics: data.diagnostics.length,
    recommended_bump: release.bump,
    next_version: release.nextVersion,
  };

  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const json = (status: number, body: unknown): void => {
      response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
      response.end(JSON.stringify(body));
    };

    if (url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", connection: "close" });
      response.end(renderStudioHtml(data.ir));
      return;
    }
    if (url.pathname === "/api/summary") return json(200, summary);
    if (url.pathname === "/api/ir") return json(200, data.ir);
    if (url.pathname === "/api/diagnostics") return json(200, data.diagnostics);
    if (url.pathname === "/api/release") return json(200, release);
    if (url.pathname === "/api/diff") return json(200, diff);
    if (url.pathname === "/api/install") return json(200, install);
    json(404, { error: "not found", path: url.pathname });
  });
}

export async function studioSelfTest(data: StudioData): Promise<void> {
  const server = createStudioServer(data);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const base = `http://127.0.0.1:${port}`;
    const home = await fetch(`${base}/`);
    if (!home.ok || !(await home.text()).includes("<!doctype html>")) throw new Error("studio home failed");
    for (const path of ["/api/summary", "/api/ir", "/api/diagnostics", "/api/release", "/api/diff", "/api/install"]) {
      const res = await fetch(`${base}${path}`);
      if (!res.ok) throw new Error(`studio ${path} returned ${res.status}`);
      await res.json();
    }
    console.log("studio self-test passed");
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export function renderStudioHtml(ir: ApiIR): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(ir.api.name)} · sdkgen Studio</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; margin: 0; background: #0b0d12; color: #e6e9ef; }
  header { padding: 20px 28px; border-bottom: 1px solid #232838; background: #11141c; }
  header h1 { margin: 0; font-size: 18px; }
  header .meta { color: #8b93a7; font-size: 12px; margin-top: 4px; }
  main { padding: 24px 28px; display: grid; gap: 24px; max-width: 1100px; }
  .cards { display: flex; flex-wrap: wrap; gap: 12px; }
  .card { background: #11141c; border: 1px solid #232838; border-radius: 10px; padding: 14px 16px; min-width: 120px; }
  .card .n { font-size: 22px; font-weight: 600; }
  .card .l { color: #8b93a7; font-size: 12px; }
  section h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .04em; color: #8b93a7; }
  .resource { border: 1px solid #232838; border-radius: 10px; margin-bottom: 10px; background: #11141c; }
  .resource > summary { padding: 12px 16px; cursor: pointer; font-weight: 600; }
  .op { padding: 8px 16px; border-top: 1px solid #1b1f2b; display: flex; gap: 10px; align-items: baseline; }
  .verb { font-family: ui-monospace, monospace; font-size: 11px; padding: 2px 6px; border-radius: 5px; background: #1f2a44; color: #9ec1ff; }
  .path { font-family: ui-monospace, monospace; color: #b6bdce; }
  .tag { font-size: 11px; color: #6ee7b7; margin-left: auto; }
  .diag { padding: 8px 12px; border-radius: 8px; margin-bottom: 6px; border: 1px solid #232838; background: #11141c; }
  .sev-blocker, .sev-error { border-color: #7f1d1d; }
  .sev-warning { border-color: #78510f; }
  code { font-family: ui-monospace, monospace; }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(ir.api.name)} <span style="color:#8b93a7;font-weight:400">· sdkgen Studio</span></h1>
  <div class="meta">version ${escapeHtml(ir.api.version ?? "0.0.0")} · base URL <code>${escapeHtml(ir.client.base_url)}</code></div>
</header>
<main>
  <div class="cards" id="cards"></div>
  <section><h2>Resources &amp; methods</h2><div id="resources"></div></section>
  <section><h2>Install</h2><div id="install"></div></section>
  <section><h2>IR diff vs last release</h2><div id="diff"></div></section>
  <section><h2>Diagnostics</h2><div id="diagnostics"></div></section>
</main>
<script type="module">
const [summary, ir, diagnostics, install, diff] = await Promise.all([
  fetch("/api/summary").then((r) => r.json()),
  fetch("/api/ir").then((r) => r.json()),
  fetch("/api/diagnostics").then((r) => r.json()),
  fetch("/api/install").then((r) => r.json()),
  fetch("/api/diff").then((r) => r.json()),
]);

const cards = document.getElementById("cards");
const stats = [
  ["resources", summary.resources], ["operations", summary.operations], ["types", summary.types],
  ["diagnostics", summary.diagnostics], ["next version", summary.next_version], ["bump", summary.recommended_bump],
];
cards.innerHTML = stats.map(([l, n]) => '<div class="card"><div class="n">' + n + '</div><div class="l">' + l + '</div></div>').join("");

const byResource = new Map();
for (const op of ir.operations) {
  if (!byResource.has(op.resource_id)) byResource.set(op.resource_id, []);
  byResource.get(op.resource_id).push(op);
}
const resources = document.getElementById("resources");
resources.innerHTML = ir.resources.map((res) => {
  const ops = (byResource.get(res.id) || []).map((op) => {
    const tags = [];
    if (op.pagination_id) tags.push("paginated");
    if (op.streaming) tags.push("streaming");
    if (op.request && op.request.multipart) tags.push("multipart");
    return '<div class="op"><span class="verb">' + op.http_method.toUpperCase() + '</span>'
      + '<span>' + res.path_segments.join(".") + "." + op.name + '</span>'
      + '<span class="path">' + op.path + '</span>'
      + '<span class="tag">' + tags.join(" · ") + '</span></div>';
  }).join("");
  return '<details class="resource"><summary>' + res.path_segments.join(".") + ' (' + (byResource.get(res.id) || []).length + ')</summary>' + ops + '</details>';
}).join("");

const diag = document.getElementById("diagnostics");
diag.innerHTML = diagnostics.length === 0 ? '<div class="diag">No diagnostics.</div>'
  : diagnostics.map((d) => '<div class="diag sev-' + d.severity + '"><strong>' + d.severity + '</strong> <code>' + d.code + '</code> — ' + d.message + '</div>').join("");

const installEl = document.getElementById("install");
installEl.innerHTML = install.map((t) => '<div class="resource" style="padding:12px 16px"><strong>' + t.target + '</strong>'
  + '<div class="path" style="margin-top:6px">' + t.install + '</div>'
  + '<div class="l" style="color:#6ee7b7;margin-top:4px">early access: <code>' + t.branch_install + '</code></div></div>').join("");

const diffEl = document.getElementById("diff");
diffEl.innerHTML = '<div class="card" style="margin-bottom:10px"><div class="n">' + diff.recommended_bump + '</div><div class="l">recommended bump</div></div>'
  + (diff.changes.length === 0 ? '<div class="diag">No IR changes.</div>'
    : diff.changes.map((c) => '<div class="diag sev-' + (c.level === "major" ? "error" : c.level === "minor" ? "warning" : "") + '"><strong>' + c.level + '</strong> <code>' + c.code + '</code> — ' + c.message + '</div>').join(""));
</script>
</body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] ?? char);
}
