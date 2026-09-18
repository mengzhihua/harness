export interface TuiState {
  mode: string;
  model: string;
  threadId?: string;
  agentRoot?: string;
  plugins: number;
  items: string[];
  diff?: string;
  plan?: string;
  approval?: { id: string; name: string; reason: string };
  input: string;
  status: string;
}

export function emptyTuiState(opts?: Partial<TuiState>): TuiState {
  return {
    mode: opts?.mode ?? "agent",
    model: opts?.model ?? "mock",
    threadId: opts?.threadId,
    agentRoot: opts?.agentRoot,
    plugins: opts?.plugins ?? 0,
    items: opts?.items ?? [],
    diff: opts?.diff,
    plan: opts?.plan,
    approval: opts?.approval,
    input: opts?.input ?? "",
    status: opts?.status ?? "ready",
  };
}

/** Self-drawn first viewport: stream + current tool + status + input. No Ink. */
export function renderFrame(state: TuiState): string {
  const width = 72;
  const line = "─".repeat(width);
  const status = ` ${state.mode} · ${state.model} · plugins=${state.plugins} · ${state.status} `;
  const thread = state.threadId ? `thread ${state.threadId}` : "no thread";
  const items = (state.items.length ? state.items.slice(-8) : ["(waiting for a turn)"]).map((s) => ` ${s.slice(0, width - 1)}`);
  const approval = state.approval
    ? [` APPROVAL ${state.approval.id}`, ` ${state.approval.name}: ${state.approval.reason}`, " [y] allow  [n] deny  [s] allow_session"]
    : [];
  const diff = state.diff ? [` diff`, ` ${state.diff.split("\n")[0]?.slice(0, width - 2) ?? ""}`] : [];
  const plan = state.plan ? [` plan ${state.plan.slice(0, width - 6)}`] : [];
  return [
    `┌${line}┐`,
    `│${pad(` harness  ${thread}`, width)}│`,
    `│${pad(status, width)}│`,
    `├${line}┤`,
    ...items.map((s) => `│${pad(s, width)}│`),
    ...(diff.length ? [`├${line}┤`, ...diff.map((s) => `│${pad(s, width)}│`)] : []),
    ...(plan.length ? plan.map((s) => `│${pad(s, width)}│`) : []),
    ...(approval.length ? [`├${line}┤`, ...approval.map((s) => `│${pad(s, width)}│`)] : []),
    `├${line}┤`,
    `│${pad(` > ${state.input}`, width)}│`,
    `└${line}┘`,
  ].join("\n");
}

function pad(text: string, width: number): string {
  const raw = text.length > width ? text.slice(0, width) : text;
  return raw + " ".repeat(Math.max(0, width - raw.length));
}

export function applyEvent(state: TuiState, method: string, params: unknown): TuiState {
  const next = { ...state, items: state.items.slice() };
  if (method === "item/delta") {
    const text = (params as { text?: string }).text ?? "";
    if (text) next.items.push(text);
    next.status = "running";
  } else if (method === "done_report") {
    const d = params as { changed_files?: string[]; apply_ready?: boolean };
    next.items.push(`done files=${(d.changed_files ?? []).join(",") || "-"} apply_ready=${d.apply_ready}`);
    next.status = "ready";
    next.diff = (d.changed_files ?? []).join(", ");
  } else if (method === "approval/request") {
    const p = params as { id: string; name: string; reason: string };
    next.approval = { id: p.id, name: p.name, reason: p.reason };
    next.status = "approval";
  } else if (method === "diff/updated") {
    next.diff = String((params as { summary?: string }).summary ?? "");
  } else if (method === "plan/updated") {
    next.plan = JSON.stringify((params as { steps?: unknown }).steps ?? params);
  } else if (method === "turn/interrupted") {
    next.status = "interrupted";
  }
  return next;
}
