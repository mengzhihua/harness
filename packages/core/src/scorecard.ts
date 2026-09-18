import { readdir } from "node:fs/promises";
import path from "node:path";
import type { TrajEvent, TrajHeader } from "./traj.ts";

const BUILTIN_TOOLS = new Set([
  "read_file",
  "read_skill",
  "grep",
  "glob",
  "str_replace",
  "write_file",
  "bash",
  "update_plan",
  "delegate",
  "fusion",
  "browser",
  "web_search",
  "web_fetch",
  "ask_user",
]);

const DEFAULT_PROTECTED = ["USER_WIP.md"];

export interface TaskScore {
  task: string;
  threadId: string;
  traj?: string;
  apply_ready: boolean;
  interrupted: boolean;
  changed_files: string[];
  unrelated_files: string[];
  checks: Array<{ cmd: string; exit_code: number }>;
  claimed_done_but_check_fail: number;
  residual_risks: string[];
  approvals: { deny: number; allow_always: number; audit: number; total: number };
  first_tool_ms: number | null;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  cache_hit_rate: number;
  plugin_errors: number;
  project_plugins: string[];
  plugin_tools: string[];
  plugin_lock: string[];
  steered: boolean;
  dry_replay_ok: boolean;
  integrity_mismatch: number;
}

export interface SuiteTotals {
  tasks: number;
  apply_ready: number;
  interrupted: number;
  claimed_done_but_check_fail: number;
  plugin_errors: number;
  unrelated_files: number;
  approvals: number;
  denials: number;
  steered: number;
  dry_replay_ok: number;
  integrity_mismatch: number;
  first_tool_ms_avg: number | null;
  cache_hit_rate: number;
  project_plugins_seen: number;
}

export interface SuiteScorecard {
  generatedAt: string;
  tasks: TaskScore[];
  totals: SuiteTotals;
}

export async function listEvalTasks(dir: string): Promise<Array<{ name: string; path: string }>> {
  const abs = path.resolve(dir);
  const names = await readdir(abs);
  return names
    .filter((n) => n.endsWith(".md"))
    .sort()
    .map((n) => ({ name: n.replace(/\.md$/i, ""), path: path.join(abs, n) }));
}

export function scoreTrajectory(opts: {
  header?: TrajHeader;
  events: TrajEvent[];
  task?: string;
  threadId?: string;
  traj?: string;
  protectedFiles?: string[];
}): TaskScore {
  const events = opts.events;
  const done = [...events].reverse().find((e) => e.type === "done_report");
  const payload = (done?.payload ?? {}) as {
    changed_files?: string[];
    checks?: Array<{ cmd?: string; exit_code?: number }>;
    residual_risks?: string[];
    apply_ready?: boolean;
    interrupted?: boolean;
  };
  const changed = payload.changed_files ?? [];
  const checks = (payload.checks ?? []).map((c) => ({
    cmd: c.cmd ?? "",
    exit_code: c.exit_code ?? -1,
  }));
  const protectedFiles = opts.protectedFiles ?? DEFAULT_PROTECTED;
  const unrelated_files = changed.filter((f) =>
    protectedFiles.some((p) => f === p || f.endsWith(`/${p}`) || path.basename(f) === p),
  );
  const lastCheck = checks.at(-1);
  const apply_ready = !!payload.apply_ready;
  const claimed_done_but_check_fail = apply_ready && (!lastCheck || lastCheck.exit_code !== 0) ? 1 : 0;

  const turnStart = events.find((e) => e.type === "turn/start");
  const firstTool = events.find((e) => {
    if (e.type !== "step") return false;
    return ((e.payload as { tool_calls?: unknown[] }).tool_calls ?? []).length > 0;
  });
  let first_tool_ms: number | null = null;
  if (turnStart && firstTool) {
    const ms = Date.parse(firstTool.ts) - Date.parse(turnStart.ts);
    if (Number.isFinite(ms) && ms >= 0) first_tool_ms = ms;
  }

  let prompt_tokens = 0;
  let completion_tokens = 0;
  let cached_tokens = 0;
  for (const e of events) {
    if (e.type !== "llm/usage") continue;
    const u = e.payload as { prompt_tokens?: number; completion_tokens?: number; cached_tokens?: number };
    prompt_tokens += u.prompt_tokens ?? 0;
    completion_tokens += u.completion_tokens ?? 0;
    cached_tokens += u.cached_tokens ?? 0;
  }

  const deny = events.filter((e) => e.source === "policy" && e.type === "deny").length;
  const allow_always = events.filter((e) => e.type === "allow_always").length;
  const audit = events.filter((e) => e.source === "policy" && e.type === "audit").length;

  const plugin_errors = events.filter((e) => e.type === "plugin/error").length;
  const packages =
    opts.header?.plugin_lock?.packages ??
    ((events.find((e) => e.type === "plugin_lock")?.payload as { packages?: TrajHeader["plugin_lock"]["packages"] } | undefined)
      ?.packages ?? []);
  const project_plugins = packages.filter((p) => !p.id.startsWith("@harness/")).map((p) => p.id);
  const plugin_tools = [
    ...new Set(
      events
        .filter((e) => e.type === "tool_result")
        .map((e) => String((e.payload as { name?: string }).name ?? ""))
        .filter((n) => n && !BUILTIN_TOOLS.has(n)),
    ),
  ];
  const integrity_mismatch = events.filter((e) => e.type === "integrity/mismatch").length;

  return {
    task: opts.task ?? opts.header?.title ?? opts.threadId ?? "",
    threadId: opts.threadId ?? opts.header?.threadId ?? "",
    traj: opts.traj,
    apply_ready,
    interrupted: !!payload.interrupted,
    changed_files: changed,
    unrelated_files,
    checks,
    claimed_done_but_check_fail,
    residual_risks: payload.residual_risks ?? [],
    approvals: { deny, allow_always, audit, total: deny + allow_always + audit },
    first_tool_ms,
    prompt_tokens,
    completion_tokens,
    cached_tokens,
    cache_hit_rate: prompt_tokens ? cached_tokens / prompt_tokens : 0,
    plugin_errors,
    project_plugins,
    plugin_tools,
    plugin_lock: packages.map((p) => `${p.id}@${p.version}`),
    steered: events.some((e) => e.type === "steer"),
    dry_replay_ok: integrity_mismatch === 0,
    integrity_mismatch,
  };
}

export function summarizeScorecard(tasks: TaskScore[], generatedAt = new Date().toISOString()): SuiteScorecard {
  const firsts = tasks.map((t) => t.first_tool_ms).filter((n): n is number => n != null);
  const prompt = tasks.reduce((n, t) => n + t.prompt_tokens, 0);
  const cached = tasks.reduce((n, t) => n + t.cached_tokens, 0);
  return {
    generatedAt,
    tasks,
    totals: {
      tasks: tasks.length,
      apply_ready: tasks.filter((t) => t.apply_ready).length,
      interrupted: tasks.filter((t) => t.interrupted).length,
      claimed_done_but_check_fail: tasks.reduce((n, t) => n + t.claimed_done_but_check_fail, 0),
      plugin_errors: tasks.reduce((n, t) => n + t.plugin_errors, 0),
      unrelated_files: tasks.reduce((n, t) => n + t.unrelated_files.length, 0),
      approvals: tasks.reduce((n, t) => n + t.approvals.total, 0),
      denials: tasks.reduce((n, t) => n + t.approvals.deny, 0),
      steered: tasks.filter((t) => t.steered).length,
      dry_replay_ok: tasks.filter((t) => t.dry_replay_ok).length,
      integrity_mismatch: tasks.reduce((n, t) => n + t.integrity_mismatch, 0),
      first_tool_ms_avg: firsts.length ? Math.round(firsts.reduce((a, b) => a + b, 0) / firsts.length) : null,
      cache_hit_rate: prompt ? cached / prompt : 0,
      project_plugins_seen: tasks.filter((t) => t.project_plugins.length > 0).length,
    },
  };
}

export function formatScorecard(card: SuiteScorecard): string {
  const t = card.totals;
  const lines = [
    `Harness scorecard  ${t.tasks} task${t.tasks === 1 ? "" : "s"}`,
    `  apply_ready ${t.apply_ready}/${t.tasks}  claimed_done_check_fail ${t.claimed_done_but_check_fail}  plugin_errors ${t.plugin_errors}  unrelated ${t.unrelated_files}`,
    `  approvals ${t.approvals} (deny ${t.denials})  steer ${t.steered}  dry_replay ${t.dry_replay_ok}/${t.tasks}  integrity ${t.integrity_mismatch}`,
    `  first_tool_ms avg ${t.first_tool_ms_avg ?? "-"}  cache_hit ${t.cache_hit_rate.toFixed(2)}  project_plugins ${t.project_plugins_seen}/${t.tasks}`,
  ];
  const width = Math.max(12, ...card.tasks.map((s) => s.task.length), 4);
  lines.push(`${"task".padEnd(width)}  ready  files            checks  first_ms  plugins`);
  for (const s of card.tasks) {
    const files = s.changed_files.join(",") || "-";
    const checks = `${s.checks.filter((c) => c.exit_code === 0).length}/${s.checks.length}`;
    const plugins = s.project_plugins.slice(0, 2).join(",") || "-";
    lines.push(
      `${s.task.padEnd(width)}  ${s.apply_ready ? "yes" : "no  "}  ${files.slice(0, 16).padEnd(16)}  ${checks.padEnd(6)}  ${String(s.first_tool_ms ?? "-").padEnd(8)}  ${plugins}`,
    );
  }
  return lines.join("\n");
}

export function scorecardFailed(card: SuiteScorecard): boolean {
  const t = card.totals;
  return t.claimed_done_but_check_fail > 0 || t.plugin_errors > 0 || t.unrelated_files > 0 || t.integrity_mismatch > 0;
}
