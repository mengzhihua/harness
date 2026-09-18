import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export class McpClient {
  private id = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly child: ChildProcess;
  tools: McpTool[] = [];

  private constructor(child: ChildProcess) {
    this.child = child;
    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (line) => this.onLine(line));
  }

  static async start(opts: {
    command: string;
    args?: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  }): Promise<McpClient> {
    const child = spawn(opts.command, opts.args ?? [], {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: opts.env ?? { ...process.env },
    });
    child.stderr?.resume();
    child.unref();
    child.stdin?.unref();
    child.stdout?.unref();
    child.stderr?.unref();
    const client = new McpClient(child);
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "harness", version: "0.1.0" },
    });
    client.write({ jsonrpc: "2.0", method: "notifications/initialized" });
    const listed = (await client.request("tools/list", {})) as { tools?: McpTool[] };
    client.tools = listed.tools ?? [];
    return client;
  }

  async call(name: string, args: Record<string, unknown>): Promise<string> {
    const result = (await this.request("tools/call", { name, arguments: args })) as {
      content?: Array<{ type: string; text?: string }>;
    };
    return (result.content ?? []).map((c) => c.text ?? "").join("\n") || JSON.stringify(result);
  }

  close(): void {
    try {
      this.child.stdin?.end();
    } catch {
      /* ignore */
    }
    this.child.kill("SIGKILL");
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.id++;
    const p = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`mcp timeout on ${method}`));
        }
      }, 8000);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
    this.write({ jsonrpc: "2.0", id, method, params });
    return p;
  }

  private write(msg: unknown): void {
    this.child.stdin?.write(`${JSON.stringify(msg)}\n`);
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let msg: { id?: number; result?: unknown; error?: { message: string } };
    try {
      msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string } };
    } catch {
      return;
    }
    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      const pending = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message));
      else pending.resolve(msg.result);
    }
  }
}
