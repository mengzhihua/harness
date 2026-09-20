import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addPlugin } from "./project-plugins.ts";
import { packageRoot } from "./paths.ts";

export interface CatalogPlugin {
  id: string;
  kind: string;
  description: string;
  source: string;
  origin?: "local" | "remote";
  permissions?: Record<string, unknown>;
}

export function defaultCatalogDir(): string {
  return path.join(packageRoot(), "catalog");
}

export async function listCatalog(catalogDir = defaultCatalogDir()): Promise<CatalogPlugin[]> {
  return readCatalogFile(path.join(catalogDir, "plugins.json"), catalogDir, "local");
}

export async function fetchRemoteCatalog(url = process.env.HARNESS_STORE_URL): Promise<CatalogPlugin[]> {
  if (!url) return [];
  const raw = await readStoreBody(url);
  const parsed = JSON.parse(raw) as { plugins?: Array<Omit<CatalogPlugin, "origin">> };
  const base = url.startsWith("http") ? url : path.dirname(url.startsWith("file:") ? fileURLToPath(url) : url);
  return (parsed.plugins ?? []).map((p) => ({
    ...p,
    origin: "remote" as const,
    source: resolveRemoteSource(p.source, base),
  }));
}

export async function searchCatalog(
  query?: string,
  catalogDir = defaultCatalogDir(),
  storeUrl = process.env.HARNESS_STORE_URL,
): Promise<CatalogPlugin[]> {
  const remote = await fetchRemoteCatalog(storeUrl).catch(() => [] as CatalogPlugin[]);
  const local = await listCatalog(catalogDir);
  const byId = new Map<string, CatalogPlugin>();
  for (const p of remote) byId.set(p.id, p);
  for (const p of local) byId.set(p.id, p);
  const all = [...byId.values()];
  if (!query) return all;
  const q = query.toLowerCase();
  return all.filter(
    (p) =>
      p.id.toLowerCase().includes(q) ||
      p.kind.toLowerCase().includes(q) ||
      p.description.toLowerCase().includes(q) ||
      (p.origin ?? "") === q,
  );
}

export async function installCatalogPlugin(opts: {
  userRoot: string;
  id: string;
  catalogDir?: string;
  storeUrl?: string;
}): Promise<{ id: string; dir: string; kind?: string }> {
  const found = (await searchCatalog(undefined, opts.catalogDir, opts.storeUrl ?? process.env.HARNESS_STORE_URL)).find(
    (p) => p.id === opts.id,
  );
  if (!found) throw new Error(`unknown catalog plugin ${opts.id}`);
  return addPlugin({ userRoot: opts.userRoot, source: found.source, origin: found.origin });
}

async function readCatalogFile(file: string, catalogDir: string, origin: "local" | "remote"): Promise<CatalogPlugin[]> {
  if (!existsSync(file)) return [];
  const raw = JSON.parse(await readFile(file, "utf8")) as { plugins?: CatalogPlugin[] };
  return (raw.plugins ?? []).map((p) => ({
    ...p,
    origin,
    source: path.isAbsolute(p.source) ? p.source : path.resolve(catalogDir, p.source),
  }));
}

async function readStoreBody(url: string): Promise<string> {
  if (url.startsWith("http://") || url.startsWith("https://")) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`store ${url} ${res.status}`);
    return res.text();
  }
  const file = url.startsWith("file:") ? fileURLToPath(url) : url;
  return readFile(file, "utf8");
}

function resolveRemoteSource(source: string, base: string): string {
  if (/^(git@|ssh:\/\/|git:\/\/|https?:\/\/|file:)/.test(source) || path.isAbsolute(source)) return source;
  if (base.startsWith("http://") || base.startsWith("https://")) {
    try {
      return new URL(source, base.endsWith("/") ? base : `${base}/`).href;
    } catch {
      return source;
    }
  }
  return path.resolve(base, source);
}
