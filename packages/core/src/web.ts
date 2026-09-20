import { isIP } from "node:net";

export interface WebRequest {
  action: "search" | "fetch";
  query?: string;
  url?: string;
  network?: boolean;
}

export interface WebDeps {
  fetch?: typeof fetch;
}

const MAX_BYTES = 200_000;
const TIMEOUT_MS = 15_000;

/** Frozen web tool contract. No live HTTP unless HARNESS_NET or --network. */
export function webActionRequest(opts: WebRequest): { method: "web/act"; params: WebRequest } {
  if (opts.action === "search" && !opts.query) throw new Error("search requires query");
  if (opts.action === "fetch" && !opts.url) throw new Error("fetch requires url");
  return { method: "web/act", params: { ...opts } };
}

export function networkEnabled(flag?: boolean): boolean {
  if (flag) return true;
  const env = process.env.HARNESS_NET;
  return Boolean(env && env !== "0" && env.toLowerCase() !== "false");
}

export function assertPublicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid url: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`only http/https urls are allowed (${url.protocol})`);
  }
  const host = url.hostname.toLowerCase();
  if (host === "169.254.169.254" || host.endsWith(".169.254.169.254")) {
    throw new Error("blocked metadata url");
  }
  const ip = isIP(host) ? host : "";
  if (ip && isMetadataIp(ip)) throw new Error("blocked metadata url");
  return url;
}

function isMetadataIp(ip: string): boolean {
  if (ip === "169.254.169.254") return true;
  const parts = ip.split(".").map(Number);
  return parts.length === 4 && parts[0] === 169 && parts[1] === 254;
}

export async function runWeb(opts: WebRequest, deps: WebDeps = {}): Promise<{ ok: boolean; message: string }> {
  const req = webActionRequest(opts);
  if (!networkEnabled(opts.network)) {
    return {
      ok: false,
      message: `web unavailable: set HARNESS_NET or --network to enable ${req.method} ${req.params.action}`,
    };
  }
  const fetchFn = deps.fetch ?? globalThis.fetch;
  try {
    if (opts.action === "search") return await searchWeb(String(opts.query), fetchFn);
    return await fetchWeb(String(opts.url), fetchFn);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

async function searchWeb(query: string, fetchFn: typeof fetch): Promise<{ ok: boolean; message: string }> {
  const template = process.env.HARNESS_SEARCH_URL;
  const target = template
    ? template.replaceAll("{q}", encodeURIComponent(query))
    : `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const url = assertPublicHttpUrl(target);
  const text = await readBody(fetchFn, url);
  const hits = parseSearchHits(text).slice(0, 5);
  if (!hits.length) return { ok: true, message: `(no search hits) ${query}` };
  return { ok: true, message: hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}`).join("\n") };
}

async function fetchWeb(raw: string, fetchFn: typeof fetch): Promise<{ ok: boolean; message: string }> {
  const url = assertPublicHttpUrl(raw);
  const text = await readBody(fetchFn, url);
  return { ok: true, message: clipText(toReadable(text, url)) };
}

async function readBody(fetchFn: typeof fetch, url: URL): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetchFn(url, { redirect: "follow", signal: ac.signal, headers: { "user-agent": "harness-web/0.31" } });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url.origin}${url.pathname}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const sliced = buf.subarray(0, MAX_BYTES);
    return sliced.toString("utf8");
  } finally {
    clearTimeout(timer);
  }
}

function parseSearchHits(html: string): Array<{ title: string; url: string }> {
  const hits: Array<{ title: string; url: string }> = [];
  const re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const url = decodeHref(m[1] ?? "");
    const title = stripTags(m[2] ?? "").trim();
    if (url && title) hits.push({ title, url });
  }
  if (hits.length) return hits;
  const generic = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = generic.exec(html))) {
    const url = m[1] ?? "";
    const title = stripTags(m[2] ?? "").trim();
    if (url && title && !url.includes("duckduckgo.com")) hits.push({ title, url });
    if (hits.length >= 8) break;
  }
  return hits;
}

function decodeHref(href: string): string {
  try {
    const u = new URL(href, "https://html.duckduckgo.com/");
    const uddg = u.searchParams.get("uddg");
    return uddg || href;
  } catch {
    return href;
  }
}

function toReadable(body: string, url: URL): string {
  const looksHtml = /<html|<body|<p[\s>]|<div[\s>]/i.test(body.slice(0, 2000));
  const text = looksHtml ? stripTags(body) : body;
  return `${url.origin}${url.pathname}\n${text}`;
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function clipText(text: string): string {
  if (text.length <= 8_000) return text;
  return `${text.slice(0, 8_000)}\n…(truncated)`;
}
