export type BrowserAction = "navigate" | "snapshot" | "click" | "type";

export interface BrowserRequest {
  action: BrowserAction;
  url?: string;
  ref?: string;
  text?: string;
}

/** Frozen browser-subagent action payload. No live Chrome unless HARNESS_BROWSER is set. */
export function browserActionRequest(opts: BrowserRequest): { method: "browser/act"; params: BrowserRequest } {
  if (!opts.action) throw new Error("browser action required");
  if (opts.action === "navigate" && !opts.url) throw new Error("navigate requires url");
  if ((opts.action === "click" || opts.action === "type") && !opts.ref) throw new Error(`${opts.action} requires ref`);
  return { method: "browser/act", params: { ...opts } };
}

export async function runBrowser(opts: BrowserRequest): Promise<{
  ok: boolean;
  snapshot?: string;
  message: string;
}> {
  const req = browserActionRequest(opts);
  if (!process.env.HARNESS_BROWSER) {
    return {
      ok: false,
      message: `browser unavailable: set HARNESS_BROWSER to enable ${req.method} ${req.params.action}`,
    };
  }
  return {
    ok: true,
    snapshot: `(browser stub) ${req.params.action} ${req.params.url ?? req.params.ref ?? ""}`.trim(),
    message: "browser stub",
  };
}
