import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createInterface } from "node:readline";
import { PROTOCOL_VERSION } from "@harness/protocol";
import { createEmbeddedPair } from "./app-server.ts";

export interface AppHttpServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

/** HTTP JSON-RPC front for App Server. Used by `harness serve --http` and native/server packs. */
export async function listenAppHttp(opts?: { host?: string; port?: number }): Promise<AppHttpServer> {
  const host = opts?.host ?? "0.0.0.0";
  const { toServer, toClient } = createEmbeddedPair();
  const pending = new Map<string | number, (msg: unknown) => void>();
  const rl = createInterface({ input: toClient });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line) as { id?: string | number };
      if (msg.id === undefined) return;
      const wait = pending.get(msg.id);
      if (!wait) return;
      pending.delete(msg.id);
      wait(msg);
    } catch {
      /* ignore truncated lines */
    }
  });

  let nextId = 1;
  const server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathOnly = (req.url ?? "/").split("?")[0] ?? "/";
    if (req.method === "GET" && (pathOnly === "/" || pathOnly === "/health" || pathOnly === "/actuator/health")) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true, status: "UP", name: "harness", protocol: PROTOCOL_VERSION, rpc: "/rpc" }));
      return;
    }
    if (req.method === "POST" && pathOnly === "/rpc") {
      let body: string;
      try {
        body = await readBody(req, 1_500_000);
      } catch (err) {
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { message: err instanceof Error ? err.message : String(err) } }));
        return;
      }
      let msg: { jsonrpc?: string; id?: string | number; method?: string; params?: unknown };
      try {
        msg = JSON.parse(body) as typeof msg;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { message: "invalid json" } }));
        return;
      }
      if (msg.id === undefined) msg.id = nextId++;
      try {
        const result = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(msg.id!);
            reject(new Error("rpc timeout"));
          }, 120_000);
          pending.set(msg.id!, (value) => {
            clearTimeout(timer);
            resolve(value);
          });
          toServer.write(`${JSON.stringify(msg)}\n`);
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(504, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { message: err instanceof Error ? err.message : String(err) } }));
      }
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts?.port ?? 0, host, () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : (opts?.port ?? 0);
  const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  return {
    url: `http://${displayHost}:${port}/`,
    port,
    close: () =>
      new Promise((resolve, reject) => {
        rl.close();
        server.closeAllConnections?.();
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
