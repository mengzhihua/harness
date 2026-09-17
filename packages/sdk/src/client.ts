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
    return this.peer.request<{ threadId: string }>("thread/resume", { threadId });
  }

  threadList(query?: string) {
    return this.peer.request<{ threads: ThreadSummary[] }>("thread/list", { query });
  }

  threadFork(threadId?: string, at?: string) {
    return this.peer.request<{ threadId: string; parentThreadId: string }>("thread/fork", { threadId, at });
  }

  turnStart(prompt: string) {
    return this.peer.request("turn/start", { prompt });
  }

  turnSteer(text: string) {
    return this.peer.request("turn/steer", { text });
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

  pluginList() {
    return this.peer.request<{ packages: Array<{ id: string; plane: string; version: string }> }>("plugin/list", {});
  }

  pluginAdd(source: string) {
    return this.peer.request<{ id: string; dir: string; kind?: string }>("plugin/add", { source });
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

  itemsList() {
    return this.peer.request<{ items: unknown[] }>("thread/items/list", {});
  }

  shutdown() {
    return this.peer.request("shutdown", {});
  }
}
