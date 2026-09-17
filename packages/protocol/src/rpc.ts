import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { JsonRpcMessage } from "./types.ts";

type MethodHandler = (params: unknown) => unknown | Promise<unknown>;
type NotifyHandler = (params: unknown) => void;

export class RpcPeer {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly methods = new Map<string, MethodHandler>();
  private readonly notifies = new Map<string, NotifyHandler[]>();

  constructor(
    input: Readable,
    private readonly output: Writable,
  ) {
    const rl = createInterface({ input });
    rl.on("line", (line) => {
      void this.onLine(line);
    });
  }

  method(name: string, handler: MethodHandler): void {
    this.methods.set(name, handler);
  }

  onNotify(name: string, handler: NotifyHandler): void {
    const list = this.notifies.get(name) ?? [];
    list.push(handler);
    this.notifies.set(name, list);
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const p = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject });
    });
    this.write({ jsonrpc: "2.0", id, method, params });
    return p;
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(msg: JsonRpcMessage): void {
    this.output.write(`${JSON.stringify(msg)}\n`);
  }

  private async onLine(line: string): Promise<void> {
    if (!line.trim()) return;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    if ("method" in msg && msg.method) {
      const req = msg as { id?: number | string; method: string; params?: unknown };
      if (req.id !== undefined) {
        try {
          const handler = this.methods.get(req.method);
          if (!handler) throw new Error(`unknown method ${req.method}`);
          const result = await handler(req.params);
          this.write({ jsonrpc: "2.0", id: req.id, result: result ?? null });
        } catch (err) {
          this.write({
            jsonrpc: "2.0",
            id: req.id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          });
        }
      } else {
        for (const h of this.notifies.get(req.method) ?? []) h(req.params);
      }
      return;
    }
    const res = msg as { id?: number; result?: unknown; error?: { message: string } };
    if (typeof res.id === "number" && this.pending.has(res.id)) {
      const pending = this.pending.get(res.id)!;
      this.pending.delete(res.id);
      if (res.error) pending.reject(new Error(res.error.message));
      else pending.resolve(res.result);
    }
  }
}
