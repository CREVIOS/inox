// Custom-code patch replay: a clean-room version of Stainless's generated/integrated
// branch model. Generated output is written to a staging tree; this module merges it
// into the live output tree using a line-based three-way merge against the previous
// generation (the "base"). User edits to generated files survive regeneration, and
// real conflicts are surfaced with git-style markers instead of being clobbered.
import { mkdir, readFile, readdir, rm, writeFile, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

export interface OverlayReport {
  written: string[];
  merged: string[];
  conflicts: string[];
  deleted: string[];
  preserved: string[];
}

export async function applyOverlay(stagingRoot: string, outRoot: string, baseRoot: string): Promise<OverlayReport> {
  const report: OverlayReport = { written: [], merged: [], conflicts: [], deleted: [], preserved: [] };
  const stagingFiles = await listFiles(stagingRoot);
  const baseFiles = new Set(await listFiles(baseRoot));

  for (const rel of stagingFiles) {
    const stagingPath = join(stagingRoot, rel);
    const outPath = join(outRoot, rel);
    const basePath = join(baseRoot, rel);
    const next = await readFile(stagingPath, "utf8");
    const baseExists = baseFiles.has(rel);
    const ours = (await exists(outPath)) ? await readFile(outPath, "utf8") : undefined;

    if (ours === undefined) {
      // User deleted (or first generation): (re)create from generated output.
      await writeText(outPath, next);
      report.written.push(rel);
    } else if (!baseExists) {
      if (ours === next) {
        report.written.push(rel);
      } else {
        // A newly generated path collides with a user-authored file.
        const { merged, conflict } = merge3("", ours, next);
        await writeText(outPath, merged);
        (conflict ? report.conflicts : report.merged).push(rel);
      }
    } else {
      const base = await readFile(basePath, "utf8");
      if (ours === base) {
        if (ours !== next) await writeText(outPath, next);
        report.written.push(rel);
      } else if (ours === next) {
        report.merged.push(rel);
      } else {
        const { merged, conflict } = merge3(base, ours, next);
        await writeText(outPath, merged);
        (conflict ? report.conflicts : report.merged).push(rel);
      }
    }

    await writeText(basePath, next);
  }

  // Handle files the generator no longer emits.
  const stagingSet = new Set(stagingFiles);
  for (const rel of baseFiles) {
    if (stagingSet.has(rel)) continue;
    const outPath = join(outRoot, rel);
    const basePath = join(baseRoot, rel);
    const base = await readFile(basePath, "utf8");
    if (await exists(outPath)) {
      const ours = await readFile(outPath, "utf8");
      if (ours === base) {
        await rm(outPath, { force: true });
        report.deleted.push(rel);
      } else {
        report.preserved.push(rel);
      }
    }
    await rm(basePath, { force: true });
  }

  return report;
}

/** Line-based three-way merge (diff3). Returns merged text and whether it conflicted. */
export function merge3(baseText: string, oursText: string, theirsText: string): { merged: string; conflict: boolean } {
  const base = splitLines(baseText);
  const ours = splitLines(oursText);
  const theirs = splitLines(theirsText);

  const matchOurs = alignment(base, ours);
  const matchTheirs = alignment(base, theirs);

  const syncs: Array<{ bi: number; oi: number; ti: number }> = [];
  for (let bi = 0; bi < base.length; bi += 1) {
    if (matchOurs[bi] !== -1 && matchTheirs[bi] !== -1) {
      syncs.push({ bi, oi: matchOurs[bi]!, ti: matchTheirs[bi]! });
    }
  }
  syncs.push({ bi: base.length, oi: ours.length, ti: theirs.length });

  const out: string[] = [];
  let conflict = false;
  let lastBi = 0;
  let lastOi = 0;
  let lastTi = 0;
  for (const sync of syncs) {
    const baseSlice = base.slice(lastBi, sync.bi);
    const oursSlice = ours.slice(lastOi, sync.oi);
    const theirsSlice = theirs.slice(lastTi, sync.ti);

    if (equalLines(oursSlice, baseSlice)) {
      out.push(...theirsSlice);
    } else if (equalLines(theirsSlice, baseSlice)) {
      out.push(...oursSlice);
    } else if (equalLines(oursSlice, theirsSlice)) {
      out.push(...oursSlice);
    } else {
      conflict = true;
      out.push("<<<<<<< custom code", ...oursSlice, "=======", ...theirsSlice, ">>>>>>> generated");
    }

    if (sync.bi < base.length) out.push(base[sync.bi]!);
    lastBi = sync.bi + 1;
    lastOi = sync.oi + 1;
    lastTi = sync.ti + 1;
  }

  return { merged: out.join("\n"), conflict };
}

/** Returns matchBase[i] = index in `other` aligned to base line i (LCS), or -1. */
function alignment(base: string[], other: string[]): number[] {
  const n = base.length;
  const m = other.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = base[i] === other[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const match = new Array<number>(n).fill(-1);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (base[i] === other[j]) {
      match[i] = j;
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return match;
}

function equalLines(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((line, index) => line === b[index]);
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  return text.replace(/\n$/, "").split("\n");
}

async function listFiles(root: string): Promise<string[]> {
  if (!(await exists(root))) return [];
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const parent = (entry as { parentPath?: string; path?: string }).parentPath ?? (entry as { path?: string }).path ?? root;
    const abs = join(parent, entry.name);
    files.push(relative(root, abs).split(sep).join("/"));
  }
  return files;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}
