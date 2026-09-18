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
  if (!attachments.length) return { text: prompt, attachments: [] };
  const block = attachments.map((a) => `### ${a.path}\n\`\`\`\n${a.content}\n\`\`\``).join("\n\n");
  return { text: `${prompt}\n\n## attachments\n${block}`, attachments };
}
