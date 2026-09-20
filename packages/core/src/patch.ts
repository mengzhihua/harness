import type { LocalFs } from "./runtime-local.ts";

export type PatchOp =
  | { kind: "add"; path: string; content: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; hunks: Array<{ before: string; after: string }> };

export function parsePatch(raw: string): PatchOp[] {
  const text = raw.replace(/\r\n/g, "\n").trim();
  if (!text) throw new Error("empty patch");
  if (text.includes("*** Begin Patch") || text.includes("*** Update File:") || text.includes("*** Add File:")) {
    return parseCodexPatch(text);
  }
  if (/^diff --git /m.test(text) || /^--- /m.test(text)) {
    return parseUnifiedPatch(text);
  }
  throw new Error("patch must be *** Begin Patch / *** Update File or a unified diff");
}

function parseCodexPatch(text: string): PatchOp[] {
  const body = text
    .replace(/^\*\*\* Begin Patch\s*\n?/, "")
    .replace(/\n?\*\*\* End Patch\s*$/, "");
  const chunks = body.split(/\n(?=\*\*\* (?:Add|Update|Delete) File:)/);
  const ops: PatchOp[] = [];
  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const add = trimmed.match(/^\*\*\* Add File:\s+(\S+)\n?([\s\S]*)$/);
    if (add) {
      ops.push({ kind: "add", path: add[1]!, content: plusLines(add[2] ?? "") });
      continue;
    }
    const del = trimmed.match(/^\*\*\* Delete File:\s+(\S+)/);
    if (del) {
      ops.push({ kind: "delete", path: del[1]! });
      continue;
    }
    const upd = trimmed.match(/^\*\*\* Update File:\s+(\S+)\n?([\s\S]*)$/);
    if (upd) {
      ops.push({ kind: "update", path: upd[1]!, hunks: parseCodexHunks(upd[2] ?? "") });
      continue;
    }
    throw new Error(`unrecognized patch header: ${trimmed.slice(0, 80)}`);
  }
  if (!ops.length) throw new Error("patch contained no file operations");
  return ops;
}

function plusLines(block: string): string {
  const lines = block.replace(/\n$/, "").split("\n");
  return lines.map((l) => (l.startsWith("+") ? l.slice(1) : l)).join("\n") + (block.endsWith("\n") || !block ? "\n" : "");
}

function parseCodexHunks(body: string): Array<{ before: string; after: string }> {
  const parts = body.split(/^@@.*$/m).map((p) => p.replace(/^\n/, "")).filter((p) => p.trim().length);
  const hunks = (parts.length ? parts : [body]).map(hunkPair);
  if (!hunks.length) throw new Error("update hunk is empty");
  return hunks;
}

function hunkPair(block: string): { before: string; after: string } {
  const lines = block.replace(/\n$/, "").split("\n").filter((l) => l.length > 0);
  const before: string[] = [];
  const after: string[] = [];
  for (const line of lines) {
    if (line.startsWith("***")) continue;
    const mark = line[0];
    const rest = mark === " " || mark === "+" || mark === "-" ? line.slice(1) : line;
    if (mark !== "+") before.push(rest);
    if (mark !== "-") after.push(rest);
  }
  return { before: before.join("\n"), after: after.join("\n") };
}

function parseUnifiedPatch(text: string): PatchOp[] {
  const ops: PatchOp[] = [];
  const files = text.split(/^diff --git .+\n/m);
  const chunks = files.length > 1 ? files.slice(1).map((c, i) => {
    const header = text.match(/^diff --git .+$/gm)?.[i] ?? "";
    return `${header}\n${c}`;
  }) : [text];
  for (const chunk of chunks) {
    const pathMatch = chunk.match(/^\+\+\+ [ab]\/(\S+)/m) || chunk.match(/^--- [ab]\/(\S+)/m);
    if (!pathMatch) continue;
    const filePath = pathMatch[1]!;
    if (/^deleted file/m.test(chunk) || /\/dev\/null/.test(chunk.split("\n").find((l) => l.startsWith("+++")) ?? "")) {
      ops.push({ kind: "delete", path: filePath === "dev/null" ? (chunk.match(/^--- [ab]\/(\S+)/m)?.[1] ?? filePath) : filePath });
      continue;
    }
    if (/^new file/m.test(chunk) || /\/dev\/null/.test(chunk.split("\n").find((l) => l.startsWith("---")) ?? "")) {
      const after = unifiedFileBody(chunk, "+");
      ops.push({ kind: "add", path: filePath, content: after.endsWith("\n") ? after : `${after}\n` });
      continue;
    }
    ops.push({ kind: "update", path: filePath, hunks: parseUnifiedHunks(chunk) });
  }
  if (!ops.length) throw new Error("unified diff contained no file operations");
  return ops;
}

function unifiedFileBody(chunk: string, mark: "+" | "-"): string {
  const lines: string[] = [];
  let inHunk = false;
  for (const line of chunk.split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("\\")) continue;
    if (line.startsWith(mark) || line.startsWith(" ")) lines.push(line.slice(1));
  }
  return lines.join("\n");
}

function parseUnifiedHunks(chunk: string): Array<{ before: string; after: string }> {
  const hunks: Array<{ before: string; after: string }> = [];
  const parts = chunk.split(/^@@.*$/m).slice(1);
  for (const part of parts) hunks.push(hunkPair(part));
  if (!hunks.length) throw new Error(`no hunks for ${chunk.slice(0, 60)}`);
  return hunks;
}

export async function applyPatchOps(fs: LocalFs, ops: PatchOp[]): Promise<string> {
  const notes: string[] = [];
  for (const op of ops) {
    if (op.kind === "add") {
      await fs.writeFile(op.path, op.content);
      notes.push(`added ${op.path}`);
      continue;
    }
    if (op.kind === "delete") {
      await fs.removeFile(op.path);
      notes.push(`deleted ${op.path}`);
      continue;
    }
    const raw = await fs.readRaw(op.path);
    let next = raw;
    for (const hunk of op.hunks) {
      next = applyOnce(next, hunk.before, hunk.after, op.path);
    }
    await fs.writeFile(op.path, next);
    notes.push(`updated ${op.path} (${op.hunks.length} hunk${op.hunks.length === 1 ? "" : "s"})`);
  }
  return notes.join("\n");
}

function applyOnce(source: string, before: string, after: string, file: string): string {
  const variants = [before, before.endsWith("\n") ? before.slice(0, -1) : `${before}\n`];
  for (const needle of variants) {
    const idx = source.indexOf(needle);
    if (idx < 0) continue;
    if (source.indexOf(needle, idx + 1) >= 0) {
      throw new Error(`hunk matched twice in ${file}; add more context`);
    }
    const replacement = needle.endsWith("\n") && !after.endsWith("\n") ? `${after}\n` : after;
    return source.slice(0, idx) + replacement + source.slice(idx + needle.length);
  }
  const idx = source.indexOf(before.slice(0, Math.min(24, before.length)));
  const near = idx >= 0 ? source.slice(Math.max(0, idx - 80), idx + 120) : source.slice(0, 200);
  throw new Error(`hunk not found in ${file}. nearby:\n${near}`);
}

export function firstPatchPath(raw: string): string | undefined {
  try {
    return parsePatch(raw)[0]?.path;
  } catch {
    const m = raw.match(/\*\*\* (?:Add|Update|Delete) File:\s+(\S+)/) || raw.match(/^\+\+\+ [ab]\/(\S+)/m);
    return m?.[1];
  }
}
