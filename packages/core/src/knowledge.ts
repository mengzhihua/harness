import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface KnowledgeNote {
  id: string;
  title: string;
  body: string;
}

export function knowledgeDir(userRoot: string): string {
  return path.join(path.resolve(userRoot), ".harness", "knowledge");
}

export async function loadKnowledge(userRoot: string): Promise<KnowledgeNote[]> {
  const dir = knowledgeDir(userRoot);
  if (!existsSync(dir)) return [];
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const notes: KnowledgeNote[] = [];
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const id = name.replace(/\.md$/, "");
    const raw = await readFile(path.join(dir, name), "utf8");
    const title = titleOf(raw, id);
    notes.push({ id, title, body: raw });
  }
  return notes;
}

export function knowledgeCatalog(notes: KnowledgeNote[]): string {
  if (!notes.length) return "";
  return notes
    .map((n) => {
      const first = n.body.split("\n").find((l) => l.trim() && !l.startsWith("#")) ?? "";
      return `- ${n.title}: ${first.trim().slice(0, 160)}`;
    })
    .join("\n");
}

export async function addKnowledge(opts: {
  userRoot: string;
  title: string;
  body: string;
}): Promise<KnowledgeNote> {
  const dir = knowledgeDir(opts.userRoot);
  await mkdir(dir, { recursive: true });
  const id = slug(opts.title);
  const body = `# ${opts.title}\n\n${opts.body.trim()}\n`;
  await writeFile(path.join(dir, `${id}.md`), body);
  return { id, title: opts.title, body };
}

export async function getKnowledge(userRoot: string, idOrTitle: string): Promise<KnowledgeNote | undefined> {
  const notes = await loadKnowledge(userRoot);
  const key = idOrTitle.trim().toLowerCase();
  const want = slug(idOrTitle);
  return notes.find((n) => n.id === idOrTitle || n.id === want || n.title.toLowerCase() === key);
}

function titleOf(raw: string, fallback: string): string {
  const h = /^#\s+(.+)$/m.exec(raw);
  return h?.[1]?.trim() || fallback;
}

function slug(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^\w]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return s || `note_${Date.now().toString(36)}`;
}
