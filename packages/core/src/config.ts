export type Mode = "ask" | "plan" | "agent";
export type ExecProvider = "local" | "docker";

export interface HarnessConfig {
  userRoot: string;
  harnessHome: string;
  profile: string;
  profilePath: string;
  model: string;
  mode: Mode;
  inPlace: boolean;
  openaiBaseUrl: string;
  openaiApiKey?: string;
  yolo: boolean;
  maxSteps: number;
  exec: ExecProvider;
  dockerImage: string;
  network: boolean;
  delegateDepth: number;
}

export function newThreadId(): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `th_${t}_${r}`;
}

export function threadDir(home: string, threadId: string): string {
  return `${home.replace(/\/$/, "")}/threads/${threadId}`;
}

export function worktreeDir(home: string, threadId: string): string {
  return `${home.replace(/\/$/, "")}/worktrees/${threadId}`;
}
