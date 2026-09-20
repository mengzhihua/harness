import { tuiCopy, type Lang } from "./i18n.ts";

export interface TuiState {
  mode: string;
  model: string;
  language: Lang;
  threadId?: string;
  agentRoot?: string;
  plugins: number;
  tokens: number;
  cacheHit: number;
  stream: string;
  items: string[];
  tool?: string;
  diff?: string;
  plan?: string;
  approval?: { id: string; name: string; reason: string; command?: string; cwd?: string };
  pending: string[];
  input: string;
  status: string;
}

export function emptyTuiState(opts?: Partial<TuiState>): TuiState {
  return {
    mode: opts?.mode ?? "agent",
    model: opts?.model ?? "mock",
    language: opts?.language ?? "en",
    threadId: opts?.threadId,
    agentRoot: opts?.agentRoot,
    plugins: opts?.plugins ?? 0,
    tokens: opts?.tokens ?? 0,
    cacheHit: opts?.cacheHit ?? 0,
    stream: opts?.stream ?? "",
    items: opts?.items ?? [],
    tool: opts?.tool,
    diff: opts?.diff,
    plan: opts?.plan,
    approval: opts?.approval,
    pending: opts?.pending ?? [],
    input: opts?.input ?? "",
    status: opts?.status ?? "ready",
  };
}

/** Self-drawn first viewport: stream + current tool + status + input. No Ink. */
export function renderFrame(state: TuiState): string {
  const width = 72;
  const copy = tuiCopy(state.language);
  const line = "─".repeat(width);
  const wt = state.agentRoot ? shortPath(state.agentRoot, 28) : "";
  const queuedN = state.pending.length ? `queued=${state.pending.length} · ` : "";
  const status = ` ${state.mode} · ${state.model} · ${state.language} · plugins=${state.plugins} · tok=${state.tokens} cache=${state.cacheHit} · ${queuedN}${state.status} `;
  const thread = state.threadId ? `thread ${state.threadId}${wt ? `  ${wt}` : ""}` : "no thread";
  const live = state.stream
    ? state.stream
        .split("\n")
        .filter(Boolean)
        .slice(-2)
        .map((s) => ` ${s.slice(0, width - 1)}`)
    : [];
  const items = [
    ...(state.items.length ? state.items.slice(-8) : live.length ? [] : [copy.waiting]).map((s) =>
      ` ${s.slice(0, width - 1)}`,
    ),
    ...live,
  ];
  const tool = state.tool ? [` ${copy.tool} ${state.tool}`.slice(0, width)] : [];
  const approval = state.approval
    ? [
        ` ${copy.approval} ${state.approval.id}`,
        ` ${state.approval.command || state.approval.name}`,
        ...(state.approval.cwd ? [` cwd ${shortPath(state.approval.cwd, width - 6)}`] : []),
        ` ${copy.why}: ${state.approval.reason}`,
        ` ${copy.thisTurn}  ${copy.thisThread}  ${copy.always}  ${copy.deny}`,
      ]
    : [];
  const diff = state.diff ? [` ${copy.diff}`, ` ${state.diff.split("\n")[0]?.slice(0, width - 2) ?? ""}`] : [];
  const plan = state.plan ? [` ${copy.plan} ${state.plan.slice(0, width - 6)}`] : [];
  const queued = state.pending.length
    ? [
        ` ${copy.queued} (${state.pending.length})`,
        ...state.pending.slice(-3).map((t, i) => {
          const n = state.pending.length > 3 ? state.pending.length - 3 + i + 1 : i + 1;
          return `  ${n}. ${t}`.slice(0, width);
        }),
      ]
    : [];
  return [
    `┌${line}┐`,
    `│${pad(` harness  ${thread}`, width)}│`,
    `│${pad(status, width)}│`,
    `├${line}┤`,
    ...items.map((s) => `│${pad(s, width)}│`),
    ...(tool.length ? tool.map((s) => `│${pad(s, width)}│`) : []),
    ...(diff.length ? [`├${line}┤`, ...diff.map((s) => `│${pad(s, width)}│`)] : []),
    ...(plan.length ? plan.map((s) => `│${pad(s, width)}│`) : []),
    ...(approval.length ? [`├${line}┤`, ...approval.map((s) => `│${pad(s, width)}│`)] : []),
    `├${line}┤`,
    ...(queued.length ? queued.map((s) => `│${pad(s, width)}│`) : []),
    `│${pad(` > ${state.input}`, width)}│`,
    `└${line}┘`,
  ].join("\n");
}

function shortPath(p: string, max: number): string {
  if (p.length <= max) return p;
  return `…${p.slice(-max + 1)}`;
}

function pad(text: string, width: number): string {
  const raw = text.length > width ? text.slice(0, width) : text;
  return raw + " ".repeat(Math.max(0, width - raw.length));
}

export function applyEvent(state: TuiState, method: string, params: unknown): TuiState {
  const next = { ...state, items: state.items.slice() };
  if (method === "item/started") {
    const p = params as { type?: string; label?: string; name?: string; path?: string; command?: string; pattern?: string };
    if (p.type === "tool") {
      next.tool = p.label || [p.name, p.command || p.path || p.pattern].filter(Boolean).join(" ");
      next.status = "running";
    }
  } else if (method === "item/completed") {
    const p = params as { type?: string; label?: string; hits?: number; name?: string; ok?: boolean; error?: string };
    if (p.type === "tool") {
      next.tool = p.label || (p.hits != null ? `${p.name} ${p.hits} hits` : next.tool);
      if (p.ok === false && p.error) next.items.push(String(p.error).slice(0, 70));
    }
  } else if (method === "item/delta") {
    const p = params as { text?: string; append?: boolean };
    const text = p.text ?? "";
    if (p.append) {
      next.stream = (next.stream + text).slice(-800);
    } else if (text) {
      next.stream = "";
      next.items.push(text);
    }
    next.status = "running";
  } else if (method === "done_report") {
    const d = params as {
      changed_files?: string[];
      apply_ready?: boolean;
      checks?: unknown[];
      interrupted?: boolean;
    };
    next.items.push(`done files=${(d.changed_files ?? []).join(",") || "-"} apply_ready=${d.apply_ready}`);
    next.diff = (d.changed_files ?? []).join(", ");
    const needsCheck = !d.interrupted && !d.apply_ready && (d.changed_files ?? []).length > 0 && !(d.checks ?? []).length;
    next.status = needsCheck ? "needs-check" : d.interrupted ? "interrupted" : "ready";
    next.stream = "";
    next.tool = undefined;
  } else if (method === "approval/request") {
    const p = params as { id: string; name: string; reason: string; command?: string; cwd?: string; args?: { command?: string } };
    next.approval = {
      id: p.id,
      name: p.name,
      reason: p.reason,
      command: p.command || (p.args?.command ? String(p.args.command) : p.name),
      cwd: p.cwd,
    };
    next.status = "approval";
  } else if (method === "diff/updated") {
    next.diff = String((params as { summary?: string }).summary ?? "");
  } else if (method === "plan/updated") {
    next.plan = JSON.stringify((params as { steps?: unknown }).steps ?? params);
  } else if (method === "llm/usage") {
    const p = params as { prompt_tokens?: number; completion_tokens?: number; cached_tokens?: number };
    next.tokens += (p.prompt_tokens ?? 0) + (p.completion_tokens ?? 0);
    next.cacheHit = p.cached_tokens ?? 0;
  } else if (method === "plugin/event") {
    const p = params as {
      type?: string;
      mode?: string;
      key?: string;
      value?: string;
      cmd?: string;
      message?: string;
      config?: { language?: string };
    };
    if (p.type === "mode/change" && p.mode) next.mode = p.mode;
    if (p.type === "config/change" && p.key === "language") {
      next.language = p.config?.language === "zh" || p.value === "zh" ? "zh" : "en";
    }
    if (p.type === "ide/command") {
      next.items.push(`${p.cmd ?? "ide"} ${p.message ?? ""}`.trim());
    }
  } else if (method === "item/rewind") {
    const p = params as { type?: string; payload?: { cmd?: string; message?: string } };
    if (p.type === "ide/command") {
      next.items.push(`${p.payload?.cmd ?? "ide"} ${p.payload?.message ?? ""}`.trim());
    }
  } else if (method === "inbox/updated") {
    const p = params as { queued?: string[]; items?: string[] };
    next.pending = Array.isArray(p.queued) ? p.queued.slice() : Array.isArray(p.items) ? p.items.slice() : next.pending;
  } else if (method === "turn/interrupted") {
    next.status = "interrupted";
    next.tool = undefined;
  }
  return next;
}
