import { createServer, type IncomingMessage } from "node:http";

/** Injected by the local workbench HTTP host so buttons call ide/command over fetch. */
export const WORKBENCH_INJECT_JS = `window.harness = window.harness || {
  command: function(payload) {
    return fetch("/rpc/ide/command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload || {})
    }).then(function(r) { return r.json(); }).then(function(result) {
      var agent = document.getElementById("agent");
      if (agent && result && result.message) {
        var row = document.createElement("div");
        row.className = "result";
        row.textContent = (result.ok === false ? "fail " : "ok ") + result.message;
        agent.appendChild(row);
      }
      if (result && result.content != null && result.path && document.getElementById("editor")) {
        document.getElementById("editor").value = result.content;
      }
      return result;
    });
  }
};`;

export function attachWorkbenchHost(html: string, script = WORKBENCH_INJECT_JS): string {
  const tag = `<script>${script}</script>`;
  if (html.includes("</body>")) return html.replace("</body>", `${tag}</body>`);
  return html + tag;
}

export interface WorkbenchCommandPayload {
  cmd: string;
  text?: string;
  path?: string;
  content?: string;
}

export interface WorkbenchHost {
  url: string;
  port: number;
  close(): Promise<void>;
}

/** Loopback HTTP host for the self-owned workbench. Binds 127.0.0.1 only. */
export async function listenWorkbench(opts: {
  html: string;
  onCommand: (payload: WorkbenchCommandPayload) => Promise<unknown>;
  host?: string;
  port?: number;
}): Promise<WorkbenchHost> {
  const host = opts.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error("workbench host binds loopback only");
  }
  const html = attachWorkbenchHost(opts.html);
  const server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
    const url = req.url ?? "/";
    if (req.method === "GET" && (url === "/" || url.startsWith("/index.html"))) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
      return;
    }
    if (req.method === "POST" && url === "/rpc/ide/command") {
      let body: string;
      try {
        body = await readBody(req, 1_500_000);
      } catch (err) {
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, message: err instanceof Error ? err.message : String(err) }));
        return;
      }
      let payload: WorkbenchCommandPayload;
      try {
        payload = JSON.parse(body) as WorkbenchCommandPayload;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, message: "invalid json" }));
        return;
      }
      try {
        const result = await opts.onCommand(payload);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, message: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : (opts.port ?? 0);
  return {
    url: `http://${host}:${port}/`,
    port,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function readBody(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
