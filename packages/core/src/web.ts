export interface WebRequest {
  action: "search" | "fetch";
  query?: string;
  url?: string;
}

/** Frozen web tool contract. No live HTTP unless HARNESS_NET is set. */
export function webActionRequest(opts: WebRequest): { method: "web/act"; params: WebRequest } {
  if (opts.action === "search" && !opts.query) throw new Error("search requires query");
  if (opts.action === "fetch" && !opts.url) throw new Error("fetch requires url");
  return { method: "web/act", params: { ...opts } };
}

export async function runWeb(opts: WebRequest): Promise<{ ok: boolean; message: string }> {
  const req = webActionRequest(opts);
  if (!process.env.HARNESS_NET) {
    return {
      ok: false,
      message: `web unavailable: set HARNESS_NET to enable ${req.method} ${req.params.action}`,
    };
  }
  return { ok: true, message: `(web stub) ${req.params.action} ${req.params.query ?? req.params.url ?? ""}`.trim() };
}
