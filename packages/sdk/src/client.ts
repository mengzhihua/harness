import type { Readable, Writable } from "node:stream";
import { RpcPeer, PROTOCOL_VERSION, type InitializeParams, type ThreadSummary } from "@harness/protocol";

export type NotifyHandler = (method: string, params: unknown) => void;

export class HarnessClient {
  readonly peer: RpcPeer;
  private readonly listeners = new Set<NotifyHandler>();

  constructor(input: Readable, output: Writable) {
    this.peer = new RpcPeer(input, output);
    for (const name of [
      "item/started",
      "item/delta",
      "item/completed",
      "done_report",
      "diff/updated",
      "plan/updated",
      "checkpoint/created",
      "plugin/event",
      "turn/completed",
      "turn/interrupted",
      "approval/request",
      "llm/usage",
      "inbox/updated",
      "item/rewind",
      "item/rewind_end",
    ]) {
      this.peer.onNotify(name, (params) => {
        for (const l of this.listeners) l(name, params);
      });
    }
  }

  onEvent(handler: NotifyHandler): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  initialize(params: InitializeParams) {
    return this.peer.request("initialize", { ...params, protocolVersion: PROTOCOL_VERSION });
  }

  threadStart(title?: string) {
    return this.peer.request<{ threadId: string; agentRoot: string }>("thread/start", { title });
  }

  threadResume(threadId: string) {
    return this.peer.request<{ threadId: string; agentRoot?: string }>("thread/resume", { threadId });
  }

  threadList(query?: string) {
    return this.peer.request<{ threads: ThreadSummary[] }>("thread/list", { query });
  }

  threadFork(threadId?: string, at?: string) {
    return this.peer.request<{ threadId: string; parentThreadId: string }>("thread/fork", { threadId, at });
  }

  threadMode(mode: "ask" | "plan" | "agent") {
    return this.peer.request<{ mode: string; threadId: string }>("thread/mode", { mode });
  }

  planSet(steps: Array<{ id: string; title: string; status: "pending" | "done" | "skipped" }>) {
    return this.peer.request<{ steps: unknown[] }>("plan/set", { steps });
  }

  planSkip(id: string) {
    return this.peer.request<{ steps: unknown[] }>("plan/skip", { id });
  }

  turnStart(prompt: string, opts?: { detach?: boolean }) {
    return this.peer.request("turn/start", { prompt, detach: opts?.detach });
  }

  turnStatus(threadId?: string) {
    return this.peer.request<{
      threadId: string;
      running: boolean;
      workerId: string;
      machineId: string;
      done?: unknown;
    }>("turn/status", { threadId });
  }

  turnSteer(text: string) {
    return this.peer.request<{ queued: number; items: string[] }>("turn/steer", { text });
  }

  turnInbox() {
    return this.peer.request<{ queued: string[] }>("turn/inbox", {});
  }

  turnInboxClear() {
    return this.peer.request<{ queued: string[] }>("turn/inbox/clear", {});
  }

  turnInterrupt() {
    return this.peer.request("turn/interrupt", {});
  }

  undo() {
    return this.peer.request<{ id: string }>("workspace/undo", {});
  }

  apply() {
    return this.peer.request<{ ok: boolean; message: string }>("workspace/apply", {});
  }

  runCheck() {
    return this.peer.request<{ cmd: string; exit_code: number; summary: string }>("workspace/check", {});
  }

  pluginList() {
    return this.peer.request<{
      packages: Array<{
        id: string;
        plane: string;
        version: string;
        enabled?: boolean;
        origin?: string;
        kind?: string;
        permissions?: { network: boolean; secrets: boolean; subprocess: boolean; fs: string };
      }>;
    }>("plugin/list", {});
  }

  pluginAdd(source: string) {
    return this.peer.request<{ id: string; dir: string; kind?: string }>("plugin/add", { source });
  }

  pluginEnable(id: string) {
    return this.peer.request<{ id: string; enabled: boolean }>("plugin/enable", { id, enabled: true });
  }

  pluginDisable(id: string) {
    return this.peer.request<{ id: string; enabled: boolean }>("plugin/disable", { id });
  }

  pluginCommand(id: string) {
    return this.peer.request<{ ok: boolean; output: string }>("plugin/command", { id });
  }

  approvalRespond(id: string, decision: "allow" | "deny" | "allow_session" | "allow_always") {
    return this.peer.request<{ ok: boolean }>("approval/respond", { id, decision });
  }

  configGet() {
    return this.peer.request<{
      model?: string;
      mode?: string;
      profile?: string;
      network?: boolean;
      yolo?: boolean;
      allow?: string[];
      language?: string;
      leadModel?: string;
      sidekickModel?: string;
    }>("config/get", {});
  }

  configSet(key: string, value: string) {
    return this.peer.request<{
      model?: string;
      mode?: string;
      profile?: string;
      network?: boolean;
      yolo?: boolean;
      allow?: string[];
      language?: string;
      leadModel?: string;
      sidekickModel?: string;
    }>("config/set", { key, value });
  }

  trajShow(source?: string) {
    return this.peer.request<{ header: unknown; events: unknown[] }>("traj/show", { source });
  }

  trajExport(path: string) {
    return this.peer.request<{ path: string }>("traj/export", { path });
  }

  trajReplay(mode: "dry" | "live" = "dry") {
    return this.peer.request("traj/replay", { mode });
  }

  trajDiff(otherThreadId: string) {
    return this.peer.request("traj/diff", { otherThreadId });
  }

  itemsList(since?: number) {
    return this.peer.request<{ items: unknown[] }>("thread/items/list", { since });
  }

  threadSubscribe(since?: number) {
    return this.peer.request<{ seq: number; count: number; running: boolean }>("thread/subscribe", { since });
  }

  workerInfo() {
    return this.peer.request<{ workerId: string; machineId: string; kind: string }>("worker/info", {});
  }

  openPr(opts?: { title?: string; body?: string; base?: string }) {
    return this.peer.request<{ ok: boolean; url?: string; message: string }>("workspace/pr", opts ?? {});
  }

  attachCi() {
    return this.peer.request<{ ok: boolean; artifact?: string; message: string }>("workspace/ci", {});
  }

  fusionRun(task: string, opts?: { leadModel?: string; sidekickModel?: string }) {
    return this.peer.request<{
      leadId: string;
      sidekickId: string;
      brief: string;
      summary: string;
      apply_ready: boolean;
      changed_files: string[];
      leadModel?: string;
      sidekickModel?: string;
    }>("fusion/run", { task, leadModel: opts?.leadModel, sidekickModel: opts?.sidekickModel });
  }

  pluginSearch(query?: string, store?: string) {
    return this.peer.request<{
      plugins: Array<{
        id: string;
        kind: string;
        description: string;
        source: string;
        origin?: string;
        permissions?: { network?: boolean; secrets?: boolean; subprocess?: boolean; fs?: string };
      }>;
    }>("plugin/search", { query, store });
  }

  pluginInstall(id: string, store?: string) {
    return this.peer.request<{ id: string; dir: string; kind?: string }>("plugin/install", { id, store });
  }

  ideOpen(path: string, line?: number) {
    return this.peer.request<{ ok: boolean; editor: string; command: string; message: string }>("ide/open", { path, line });
  }

  ideStatus() {
    return this.peer.request<{
      editor?: string;
      worktree?: string;
      bridge: string;
      fork?: string;
      workbench?: boolean;
      commands?: string[];
    }>("ide/status", {});
  }

  ideWorkbench() {
    return this.peer.request<{
      fork: string;
      workbench: boolean;
      commands: string[];
      files: string[];
      contents: Record<string, string>;
      html: string;
    }>("ide/workbench", {});
  }

  ideFile(path: string) {
    return this.peer.request<{ ok: boolean; path: string; content: string }>("ide/file", { path });
  }

  ideCommand(cmd: string, opts?: { text?: string; path?: string }) {
    return this.peer.request<{
      ok: boolean;
      cmd: string;
      message: string;
      queued?: number;
      items?: string[];
      path?: string;
      content?: string;
      id?: string;
    }>("ide/command", { cmd, text: opts?.text, path: opts?.path });
  }

  knowledgeList() {
    return this.peer.request<{ notes: Array<{ id: string; title: string; body: string }> }>("knowledge/list", {});
  }

  knowledgeAdd(title: string, body: string) {
    return this.peer.request<{ id: string; title: string }>("knowledge/add", { title, body });
  }

  trajBaseline(op: "save" | "list" | "check", name?: string) {
    return this.peer.request("traj/baseline", { op, name });
  }

  evalScore(opts?: { task?: string; traj?: string }) {
    return this.peer.request<{
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
      plugin_permission: number;
      project_plugins: string[];
      plugin_tools: string[];
      plugin_lock: string[];
      steered: boolean;
      ide_commands: number;
      dry_replay_ok: boolean;
      integrity_mismatch: number;
    }>("eval/score", opts ?? {});
  }

  shutdown() {
    return this.peer.request("shutdown", {});
  }
}
