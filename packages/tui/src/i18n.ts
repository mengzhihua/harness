export type Lang = "en" | "zh";

export function normalizeLang(value?: string): Lang {
  if (!value) return "en";
  const v = value.trim().toLowerCase();
  if (v.startsWith("zh") || v === "cn" || v === "chinese" || v === "中文") return "zh";
  return "en";
}

const EN = {
  approval: "APPROVAL",
  why: "why",
  thisTurn: "[y] this turn",
  thisThread: "[s] this thread",
  always: "[a] always",
  deny: "[n] deny",
  tool: "tool",
  plan: "plan",
  diff: "diff",
  waiting: "(waiting for a turn)",
} as const;

const ZH = {
  approval: "审批",
  why: "原因",
  thisTurn: "[y] 本次",
  thisThread: "[s] 本线程",
  always: "[a] 永久",
  deny: "[n] 拒绝",
  tool: "工具",
  plan: "计划",
  diff: "差异",
  waiting: "(等待一轮)",
} as const;

export type TuiCopy = typeof EN;

export function tuiCopy(lang: Lang): TuiCopy {
  return lang === "zh" ? ZH : EN;
}
