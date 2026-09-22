import type { Context } from "@harness/compose";
import type { LocalFs, Subprocess, ExecResult } from "./runtime-local.ts";
import type { TrajStore } from "./traj.ts";
import type { HarnessConfig } from "./config.ts";
import { JobHub, clampTimeout, formatJob } from "./jobs.ts";

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

type Handler = (args: Record<string, unknown>, signal?: AbortSignal) => Promise<string>;

export class ToolRouter {
  private readonly handlers = new Map<string, { schema: ToolSchema; run: Handler }>();
  /** Live bash stdout for the TUI. Set by the loop around a step. */
  onStdout?: (chunk: string) => void;

  constructor(readonly ctx: Context) {}

  register(schema: ToolSchema, run: Handler): void {
    this.handlers.set(schema.function.name, { schema, run });
  }

  schemas(): ToolSchema[] {
    return [...this.handlers.values()].map((h) => h.schema);
  }

  async execute(call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    const name = call.function.name;
    let args: Record<string, unknown> = {};
    try {
      args = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
    } catch {
      return { callId: call.id, name, ok: false, content: `invalid JSON arguments: ${call.function.arguments}` };
    }
    if (signal?.aborted) {
      return { callId: call.id, name, ok: false, content: "interrupted" };
    }
    const gated = await this.ctx.waterfall("tools/pre-execute", { name, args, deny: false as boolean });
    if (gated.deny) {
      return {
        callId: call.id,
        name,
        ok: false,
        content: `denied by policy/plugin: ${gated.reason ?? name}`,
      };
    }
    const handler = this.handlers.get(name);
    if (!handler) {
      return { callId: call.id, name, ok: false, content: `unknown tool: ${name}` };
    }
    try {
      const content = await handler.run(gated.args, signal);
      return { callId: call.id, name, ok: true, content };
    } catch (err) {
      if (signal?.aborted || isAbort(err)) {
        return { callId: call.id, name, ok: false, content: "interrupted" };
      }
      return { callId: call.id, name, ok: false, content: err instanceof Error ? err.message : String(err) };
    }
  }
}

export const READONLY_TOOLS = new Set(["read_file", "grep", "glob", "list_dir", "read_skill", "recall", "workspace_status", "wait"]);

export interface ToolView {
  name: string;
  label: string;
  path?: string;
  command?: string;
  pattern?: string;
  hits?: number;
}

export function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function hitCount(content: string): number {
  if (!content || /^\(no /.test(content)) return 0;
  return content.split("\n").filter((l) => l.trim()).length;
}

/** Human line for the TUI current-tool slot: command / path / grep hits. */
export function describeTool(name: string, args: Record<string, unknown>, extra?: { hits?: number }): ToolView {
  const file = args.path
    ? String(args.path)
    : args.patch
      ? firstPatchPathSafe(String(args.patch))
      : undefined;
  const command = args.command ? String(args.command) : undefined;
  const pattern = args.pattern
    ? String(args.pattern)
    : args.query
      ? String(args.query)
      : args.question
        ? String(args.question)
        : undefined;
  const language = args.language ? String(args.language) : undefined;
  const bits = [name];
  if (command && args.background) bits.push(`bg ${command.slice(0, 60)}`);
  else if (command) bits.push(command.slice(0, 80));
  else if (file) bits.push(file);
  else if (language) bits.push(language);
  else if (name === "todo_write") bits.push(todoSummary(args));
  else if (name === "wait") bits.push(String(args.job_id ?? "latest"));
  else if (name === "list_dir") bits.push(String(args.path ?? "."));
  else if (name === "move_file") bits.push(`${args.from ?? "?"} -> ${args.to ?? "?"}`);
  else if (pattern) bits.push(pattern);
  if (extra?.hits != null) bits.push(`${extra.hits} hits`);
  return { name, label: bits.join(" "), path: file, command, pattern, hits: extra?.hits };
}

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
    fn("list_dir", "List one directory in the AgentWorkspace. Prefer this over bash ls.", {
      type: "object",
      properties: { path: { type: "string", description: "Directory relative to the workspace. Omit for the root." } },
    }),
    async (args) => {
      const lines = await fs().listDir(String(args.path ?? "."));
      return lines.length ? lines.join("\n") : "(empty)";
    },
  );

  router.register(
    fn("move_file", "Rename or move a file inside the AgentWorkspace. Refuses to overwrite. Prefer this over bash mv.", {
      type: "object",
      properties: {
        from: { type: "string" },
        to: { type: "string" },
      },
      required: ["from", "to"],
    }),
    async (args) => {
      const from = String(args.from ?? "");
      const to = String(args.to ?? "");
      await fs().moveFile(from, to);
      return `moved ${from} -> ${to}`;
    },
  );

  router.register(
    fn("delete_file", "Delete a file in the AgentWorkspace. Prefer this over bash rm.", {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    }),
    async (args) => {
      const rel = String(args.path ?? "");
      if (!rel) throw new Error("delete_file requires path");
      await fs().removeFile(rel);
      return `deleted ${rel}`;
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
    fn("apply_patch", "Apply a multi-hunk patch to the AgentWorkspace. Prefer this over many str_replace calls. Use *** Begin Patch / *** Update File (or a unified diff).", {
      type: "object",
      properties: {
        patch: { type: "string" },
      },
      required: ["patch"],
    }),
    async (args) => {
      const { parsePatch, applyPatchOps } = await import("./patch.ts");
      const ops = parsePatch(String(args.patch ?? ""));
      return applyPatchOps(fs(), ops);
    },
  );

  router.register(
    fn("bash", "Run a shell command in the AgentWorkspace. cwd stays inside the worktree. Set background true for long jobs, then call wait. timeout_ms defaults to 30s (foreground) or 10min (background).", {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
        timeout_ms: { type: "integer" },
        background: { type: "boolean" },
      },
      required: ["command"],
    }),
    async (args, signal) => {
      if (args.background) {
        const jobs = jobsHub(ctx, sub());
        const job = jobs.start({
          command: String(args.command),
          cwd: args.cwd ? String(args.cwd) : undefined,
          timeoutMs: clampTimeout(args.timeout_ms, 600_000),
          signal,
          onStdout: router.onStdout,
        });
        await traj().append("tool", "job/started", { id: job.id, command: job.command });
        return `started ${job.id}\ncommand: ${job.command}\ncall wait with job_id ${job.id} to collect output.`;
      }
      const result = await sub().exec(String(args.command), {
        cwd: args.cwd ? String(args.cwd) : undefined,
        timeoutMs: clampTimeout(args.timeout_ms, 30_000),
        signal,
        onStdout: router.onStdout,
      });
      return formatExec(result, traj());
    },
  );

  router.register(
    fn("wait", "Wait for a background bash job started with background true. Pass job_id from that call, or omit to wait for the latest job.", {
      type: "object",
      properties: {
        job_id: { type: "string" },
        timeout_ms: { type: "integer" },
      },
    }),
    async (args, signal) => {
      const jobs = jobsHub(ctx, sub());
      const snap = await jobs.wait(args.job_id ? String(args.job_id) : undefined, clampTimeout(args.timeout_ms, 30_000), signal);
      return formatJob(snap);
    },
  );

  router.register(
    fn("read_skill", "Load a project skill's SKILL.md body by id. Catalog-only at start; body is on demand.", {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    }),
    async (args) => {
      const { readSkill } = await import("./skill.ts");
      return readSkill(ctx, String(args.id ?? ""));
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
      const { setPlan } = await import("./mode.ts");
      const result = await setPlan(
        ctx,
        args.steps as { id: string; title: string; status: "pending" | "done" | "skipped" }[],
        "model",
      );
      return `plan updated (${result.steps.length} steps)`;
    },
  );

  router.register(
    fn("todo_write", "Replace the in-thread todo list. todos is a JSON array of {id, content, status: pending|in_progress|done|cancelled}. Use this on multi-step tasks so progress stays visible.", {
      type: "object",
      properties: {
        todos: { type: "array" },
      },
      required: ["todos"],
    }),
    async (args) => {
      const { setTodos, formatTodos } = await import("./todo.ts");
      const result = await setTodos(ctx, args.todos as { id: string; content: string; status: "pending" | "in_progress" | "done" | "cancelled" }[], "model");
      return result.todos.length ? formatTodos(result.todos) : "(empty todo list)";
    },
  );

  router.register(
    fn("remember", "Save a lasting project fact into .harness/knowledge (test command, conventions). Survives new threads. Keep the body short.", {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
      },
      required: ["title", "body"],
    }),
    async (args) => {
      const { addKnowledge } = await import("./knowledge.ts");
      const workspace = ctx.get<{ userRoot: string }>("workspace");
      const note = await addKnowledge({
        userRoot: workspace.userRoot,
        title: String(args.title ?? ""),
        body: String(args.body ?? ""),
      });
      await traj().append("plugin", "knowledge/add", { id: note.id, title: note.title, source: "remember" });
      return `remembered ${note.id}: ${note.title}`;
    },
  );

  router.register(
    fn("recall", "Load the full body of a project knowledge note by id or title. Catalog in the prompt is titles only.", {
      type: "object",
      properties: {
        id: { type: "string" },
      },
      required: ["id"],
    }),
    async (args) => {
      const { getKnowledge } = await import("./knowledge.ts");
      const workspace = ctx.get<{ userRoot: string }>("workspace");
      const note = await getKnowledge(workspace.userRoot, String(args.id ?? ""));
      if (!note) throw new Error(`unknown knowledge note: ${args.id}`);
      return `# ${note.title}\n\n${note.body}`;
    },
  );

  router.register(
    fn("workspace_status", "Show agent worktree vs user tree: branch, dirty files, and files changed this thread.", {
      type: "object",
      properties: {},
    }),
    async () => {
      const workspace = ctx.get<{ status: () => Promise<{
        kind: string;
        branch: string;
        baseline: string;
        userDirty: string;
        agentDirty: string;
        files: string[];
        summary: string;
      }> }>("workspace");
      const st = await workspace.status();
      const lines = [
        `kind: ${st.kind}`,
        `branch: ${st.branch || "(none)"}`,
        `baseline: ${st.baseline}`,
        `changed: ${st.files.join(", ") || "(none)"}`,
        st.summary ? `diff: ${st.summary}` : "",
        st.agentDirty ? `agent dirty:\n${st.agentDirty}` : "agent tree: clean",
        st.userDirty ? `user dirty:\n${st.userDirty}` : "user tree: clean",
      ];
      return lines.filter(Boolean).join("\n");
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
    fn("fusion", "Run Lead + Sidekick sessions. Parent traj records only the brief and result; the two children do not share transcripts. Optional lead_model / sidekick_model pick different models for the two sessions.", {
      type: "object",
      properties: {
        task: { type: "string" },
        lead_model: { type: "string" },
        sidekick_model: { type: "string" },
      },
      required: ["task"],
    }),
    async (args) => {
      const { runFusion } = await import("./fusion.ts");
      const result = await runFusion(ctx, String(args.task), {
        leadModel: args.lead_model ? String(args.lead_model) : undefined,
        sidekickModel: args.sidekick_model ? String(args.sidekick_model) : undefined,
      });
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

  router.register(
    fn("web_search", "Search the public web. Disabled unless HARNESS_NET or --network.", {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    }),
    async (args) => {
      const { runWeb } = await import("./web.ts");
      const network = netOn(ctx);
      const result = await runWeb({ action: "search", query: String(args.query ?? ""), network });
      await traj().append("tool", "web_search", result);
      if (!result.ok) throw new Error(result.message);
      return result.message;
    },
  );

  router.register(
    fn("web_fetch", "Fetch a URL. Disabled unless HARNESS_NET or --network.", {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    }),
    async (args) => {
      const { runWeb } = await import("./web.ts");
      const network = netOn(ctx);
      const result = await runWeb({ action: "fetch", url: String(args.url ?? ""), network });
      await traj().append("tool", "web_fetch", result);
      if (!result.ok) throw new Error(result.message);
      return result.message;
    },
  );

  router.register(
    fn("ask_user", "Ask the human a question and wait for their answer. Not available unattended. options is an optional list of choices.", {
      type: "object",
      properties: {
        question: { type: "string" },
        options: { type: "array", items: { type: "string" } },
      },
      required: ["question"],
    }),
    async (args) => {
      if (!ctx.has("userAsk")) throw new Error("ask_user needs an interactive session");
      const ask = ctx.get<(req: { question: string; options?: string[] }) => Promise<string>>("userAsk");
      const options = Array.isArray(args.options) ? args.options.map((o) => String(o)) : undefined;
      const answer = await ask({ question: String(args.question ?? ""), options });
      await traj().append("user", "user/answer", { question: args.question, answer });
      if (!String(answer).trim()) throw new Error("user declined to answer");
      return `user: ${answer}`;
    },
  );

  router.register(
    fn("run_code", "Run a short JavaScript or Python snippet in the AgentWorkspace sandbox (no network). Use bash for project tests.", {
      type: "object",
      properties: {
        language: { type: "string", enum: ["javascript", "python", "js", "py"] },
        code: { type: "string" },
        timeout_ms: { type: "integer" },
      },
      required: ["language", "code"],
    }),
    async (args, signal) => {
      const { runSandboxedCode } = await import("./runcode.ts");
      return runSandboxedCode({
        language: String(args.language ?? ""),
        code: String(args.code ?? ""),
        fs: fs(),
        subprocess: sub(),
        signal,
        timeoutMs: args.timeout_ms !== undefined ? num(args.timeout_ms, 8_000) : undefined,
      });
    },
  );
}

function jobsHub(ctx: Context, subprocess: Subprocess): JobHub {
  if (ctx.has("jobs")) return ctx.get<JobHub>("jobs");
  const hub = new JobHub(subprocess);
  ctx.provide("jobs", hub);
  return hub;
}

function netOn(ctx: Context): boolean {
  try {
    return Boolean(ctx.get<HarnessConfig>("config").network);
  } catch {
    return false;
  }
}

function firstPatchPathSafe(patch: string): string | undefined {
  const m = patch.match(/\*\*\* (?:Add|Update|Delete) File:\s+(\S+)/) || patch.match(/^\+\+\+ [ab]\/(\S+)/m);
  return m?.[1];
}

function todoSummary(args: Record<string, unknown>): string {
  const list = Array.isArray(args.todos) ? args.todos : [];
  const pending = list.filter((t) => {
    const status = (t as { status?: string }).status;
    return status !== "done" && status !== "cancelled";
  }).length;
  return `${pending}/${list.length} open`;
}

function fn(name: string, description: string, parameters: Record<string, unknown>): ToolSchema {
  return { type: "function", function: { name, description, parameters } };
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function formatExec(result: ExecResult, traj: TrajStore): Promise<string> {
  const empty = !result.stdout && !result.stderr;
  const combined = `exit ${result.exitCode}\ncwd: ${result.cwd}\n--- stdout ---\n${result.stdout || (empty ? "(command produced no output)" : "")}\n--- stderr ---\n${result.stderr}`;
  if (combined.length < 8000) return combined;
  const file = await traj.writeArtifact(`${result.id}.txt`, combined);
  result.artifact = file;
  result.truncated = true;
  const tail = combined.slice(-1500);
  return `exit ${result.exitCode}\noutput truncated; full log: ${file}\n--- tail ---\n${tail}`;
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || /aborted|interrupted/i.test(err.message));
}
