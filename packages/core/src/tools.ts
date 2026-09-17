import type { Context } from "@harness/compose";
import type { LocalFs, Subprocess, ExecResult } from "./runtime-local.ts";
import type { TrajStore } from "./traj.ts";

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolResult {
  callId: string;
  name: string;
  ok: boolean;
  content: string;
}

type Handler = (args: Record<string, unknown>) => Promise<string>;

export class ToolRouter {
  private readonly handlers = new Map<string, { schema: ToolSchema; run: Handler }>();

  constructor(readonly ctx: Context) {}

  register(schema: ToolSchema, run: Handler): void {
    this.handlers.set(schema.function.name, { schema, run });
  }

  schemas(): ToolSchema[] {
    return [...this.handlers.values()].map((h) => h.schema);
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    const name = call.function.name;
    let args: Record<string, unknown> = {};
    try {
      args = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
    } catch {
      return { callId: call.id, name, ok: false, content: `invalid JSON arguments: ${call.function.arguments}` };
    }
    const gated = await this.ctx.waterfall("tools/pre-execute", { name, args, deny: false as boolean });
    if (gated.deny) {
      return { callId: call.id, name, ok: false, content: `denied by policy/plugin: ${name}` };
    }
    const handler = this.handlers.get(name);
    if (!handler) {
      return { callId: call.id, name, ok: false, content: `unknown tool: ${name}` };
    }
    try {
      const content = await handler.run(gated.args);
      return { callId: call.id, name, ok: true, content };
    } catch (err) {
      return { callId: call.id, name, ok: false, content: err instanceof Error ? err.message : String(err) };
    }
  }
}

export const READONLY_TOOLS = new Set(["read_file", "grep", "glob"]);

export function registerAci(router: ToolRouter, kind: "full" | "minimal"): void {
  const ctx = router.ctx;
  const fs = () => ctx.get<LocalFs>("fs");
  const sub = () => ctx.get<Subprocess>("subprocess");
  const traj = () => ctx.get<TrajStore>("traj");

  router.register(
    fn("read_file", "Read a file from the AgentWorkspace with line numbers.", {
      type: "object",
      properties: {
        path: { type: "string" },
        start: { type: "integer" },
        end: { type: "integer" },
      },
      required: ["path"],
    }),
    async (args) => {
      const slice = await fs().readFile(String(args.path), {
        start: num(args.start, 1),
        end: args.end !== undefined ? num(args.end, 0) : undefined,
      });
      return slice.content || "(empty)";
    },
  );

  router.register(
    fn("str_replace", "Replace an exact string in a file. Fails if the string is missing or not unique.", {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
      },
      required: ["path", "old_string", "new_string"],
    }),
    async (args) => {
      const rel = String(args.path);
      const oldStr = String(args.old_string);
      const newStr = String(args.new_string);
      const raw = await fs().readRaw(rel);
      const count = raw.split(oldStr).length - 1;
      if (count === 0) {
        const idx = raw.indexOf(oldStr.slice(0, Math.min(12, oldStr.length)));
        const near = idx >= 0 ? raw.slice(Math.max(0, idx - 80), idx + 80) : raw.slice(0, 200);
        throw new Error(`old_string not found in ${rel}. nearby:\n${near}`);
      }
      if (count > 1) throw new Error(`old_string found ${count} times in ${rel}; make it unique`);
      await fs().writeFile(rel, raw.replace(oldStr, newStr));
      return `updated ${rel} (1 replacement)`;
    },
  );

  router.register(
    fn("write_file", "Write a whole file in the AgentWorkspace. Prefer str_replace for small edits.", {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    }),
    async (args) => {
      await fs().writeFile(String(args.path), String(args.content));
      return `wrote ${args.path}`;
    },
  );

  router.register(
    fn("bash", "Run a shell command in the AgentWorkspace. cwd stays inside the worktree.", {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
      },
      required: ["command"],
    }),
    async (args) => {
      const result = await sub().exec(String(args.command), { cwd: args.cwd ? String(args.cwd) : undefined });
      return formatExec(result, traj());
    },
  );

  if (kind === "minimal") return;

  router.register(
    fn("grep", "Search file contents. Returns file:line + a short snippet.", {
      type: "object",
      properties: {
        pattern: { type: "string" },
        glob: { type: "string" },
      },
      required: ["pattern"],
    }),
    async (args) => {
      const hits = await fs().grep(String(args.pattern), args.glob ? String(args.glob) : "**/*.{js,ts,mjs,cjs,json,md}");
      return hits.length ? hits.join("\n") : "(no matches)";
    },
  );

  router.register(
    fn("glob", "List files matching a glob under AgentWorkspace.", {
      type: "object",
      properties: {
        pattern: { type: "string" },
      },
      required: ["pattern"],
    }),
    async (args) => {
      const hits = await fs().glob(String(args.pattern));
      return hits.length ? hits.join("\n") : "(no files)";
    },
  );

  router.register(
    fn("update_plan", "Replace the structured plan. steps is a JSON array of {id, title, status}.", {
      type: "object",
      properties: {
        steps: { type: "array" },
      },
      required: ["steps"],
    }),
    async (args) => {
      const steps = args.steps;
      ctx.provide("plan", steps);
      await traj().append("assistant", "plan/updated", { steps });
      return `plan updated (${Array.isArray(steps) ? steps.length : 0} steps)`;
    },
  );

  router.register(
    fn("delegate", "Run a bounded child agent on the same AgentWorkspace. Returns a summary only; child tool noise stays on the child trajectory.", {
      type: "object",
      properties: {
        task: { type: "string" },
        title: { type: "string" },
      },
      required: ["task"],
    }),
    async (args) => {
      const { runDelegate } = await import("./delegate.ts");
      const result = await runDelegate(ctx, String(args.task), args.title ? String(args.title) : undefined);
      return `child ${result.childId}\napply_ready: ${result.apply_ready}\nchanged: ${result.changed_files.join(", ") || "(none)"}\n${result.summary}`;
    },
  );

  router.register(
    fn("fusion", "Run Lead + Sidekick sessions. Parent traj records only the brief and result; the two children do not share transcripts.", {
      type: "object",
      properties: {
        task: { type: "string" },
      },
      required: ["task"],
    }),
    async (args) => {
      const { runFusion } = await import("./fusion.ts");
      const result = await runFusion(ctx, String(args.task));
      return `fusion lead=${result.leadId} sidekick=${result.sidekickId}\napply_ready: ${result.apply_ready}\nchanged: ${result.changed_files.join(", ") || "(none)"}\n--- brief ---\n${result.brief}\n--- result ---\n${result.summary}`;
    },
  );

  router.register(
    fn("browser", "Drive a browser sub-agent (navigate/snapshot/click/type). Disabled unless HARNESS_BROWSER is set.", {
      type: "object",
      properties: {
        action: { type: "string", enum: ["navigate", "snapshot", "click", "type"] },
        url: { type: "string" },
        ref: { type: "string" },
        text: { type: "string" },
      },
      required: ["action"],
    }),
    async (args) => {
      const { runBrowser } = await import("./browser.ts");
      const result = await runBrowser({
        action: args.action as "navigate" | "snapshot" | "click" | "type",
        url: args.url ? String(args.url) : undefined,
        ref: args.ref ? String(args.ref) : undefined,
        text: args.text ? String(args.text) : undefined,
      });
      await traj().append("tool", "browser", result);
      if (!result.ok) throw new Error(result.message);
      return result.snapshot ?? result.message;
    },
  );
}

function fn(name: string, description: string, parameters: Record<string, unknown>): ToolSchema {
  return { type: "function", function: { name, description, parameters } };
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function formatExec(result: ExecResult, traj: TrajStore): Promise<string> {
  const combined = `exit ${result.exitCode}\ncwd: ${result.cwd}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`;
  if (combined.length < 8000) return combined;
  const file = await traj.writeArtifact(`${result.id}.txt`, combined);
  const tail = combined.slice(-1500);
  return `exit ${result.exitCode}\noutput truncated; full log: ${file}\n--- tail ---\n${tail}`;
}
