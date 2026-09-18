export type ModeName = "ask" | "plan" | "agent";

export function parseMentions(prompt: string): string[] {
  const found: string[] = [];
  const re = /@((?:[\w.-]+\/)+[\w.-]+|[\w.-]+\.[A-Za-z][\w.-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt))) {
    const p = m[1]!;
    if (!found.includes(p)) found.push(p);
  }
  return found.slice(0, 4);
}

export function parsePastes(prompt: string): Array<{ kind: "diff" | "error"; content: string }> {
  const out: Array<{ kind: "diff" | "error"; content: string }> = [];
  const fence = /```(diff|patch)?[^\n]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(prompt))) {
    const lang = (m[1] ?? "").toLowerCase();
    const body = (m[2] ?? "").trim();
    if (!body) continue;
    if (lang === "diff" || lang === "patch" || /^(diff --git|\+\+\+ |--- |@@ )/m.test(body)) {
      out.push({ kind: "diff", content: body.slice(0, 24_000) });
    }
  }
  if (!out.some((p) => p.kind === "diff") && /^(diff --git |\*\*\* |Index: )/m.test(prompt)) {
    out.push({ kind: "diff", content: prompt.slice(0, 24_000) });
  }
  if (/\b(?:TypeError|ReferenceError|Error): |\bat \S+ \([^)]+:\d+:\d+\)/.test(prompt)) {
    const lines = prompt.split("\n").filter((l) => /Error:|^\s+at |FAIL |AssertionError/.test(l));
    const block = (lines.length ? lines.join("\n") : prompt).slice(0, 24_000);
    out.push({ kind: "error", content: block });
  }
  return out.slice(0, 4);
}

export async function loadAttachments(
  roots: string[],
  prompt: string,
): Promise<{ text: string; attachments: Array<{ path: string; content: string }> }> {
  const { existsSync } = await import("node:fs");
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const attachments: Array<{ path: string; content: string }> = [];
  for (const rel of parseMentions(prompt)) {
    if (rel.includes("..")) continue;
    let body = "";
    for (const root of roots) {
      const abs = path.join(root, rel);
      if (!existsSync(abs)) continue;
      body = await readFile(abs, "utf8");
      break;
    }
    if (!body) continue;
    attachments.push({ path: rel, content: body.slice(0, 24_000) });
  }
  const files = attachments.slice();
  for (const paste of parsePastes(prompt)) {
    attachments.push({ path: `paste:${paste.kind}`, content: paste.content });
  }
  if (!attachments.length) return { text: prompt, attachments: [] };
  if (!files.length) return { text: prompt, attachments };
  const block = files.map((a) => `### ${a.path}\n\`\`\`\n${a.content}\n\`\`\``).join("\n\n");
  return { text: `${prompt}\n\n## attachments\n${block}`, attachments };
}
