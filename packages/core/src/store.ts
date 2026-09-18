import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addPlugin } from "./project-plugins.ts";

export interface CatalogPlugin {
  id: string;
  kind: string;
  description: string;
  source: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));

export function defaultCatalogDir(): string {
  return path.resolve(here, "../../../catalog");
}

export async function listCatalog(catalogDir = defaultCatalogDir()): Promise<CatalogPlugin[]> {
  const file = path.join(catalogDir, "plugins.json");
  if (!existsSync(file)) return [];
  const raw = JSON.parse(await readFile(file, "utf8")) as { plugins?: CatalogPlugin[] };
  return (raw.plugins ?? []).map((p) => ({
    ...p,
    source: path.isAbsolute(p.source) ? p.source : path.resolve(catalogDir, p.source),
  }));
}

export async function searchCatalog(query?: string, catalogDir = defaultCatalogDir()): Promise<CatalogPlugin[]> {
  const all = await listCatalog(catalogDir);
  if (!query) return all;
  const q = query.toLowerCase();
  return all.filter(
    (p) => p.id.toLowerCase().includes(q) || p.kind.toLowerCase().includes(q) || p.description.toLowerCase().includes(q),
  );
}

export async function installCatalogPlugin(opts: {
  userRoot: string;
  id: string;
  catalogDir?: string;
}): Promise<{ id: string; dir: string; kind?: string }> {
  const found = (await listCatalog(opts.catalogDir)).find((p) => p.id === opts.id);
  if (!found) throw new Error(`unknown catalog plugin ${opts.id}`);
  return addPlugin({ userRoot: opts.userRoot, source: found.source });
}
