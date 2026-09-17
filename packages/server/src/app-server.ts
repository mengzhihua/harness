import type { Readable, Writable } from "node:stream";
import { PassThrough } from "node:stream";
import { RpcPeer, PROTOCOL_VERSION, type InitializeParams } from "@harness/protocol";
import {
  boot,
  dryReplay,
  liveReplay,
  exportTraj,
  forkThread,
  diffTrajectories,
  listThreadSummaries,
  TrajStore,
  threadDir,
  addPlugin,
  WorkerHub,
  createPullRequest,
  attachCiLogs,
  runFusion,
  addKnowledge,
  loadKnowledge,
  saveBaseline,
  listBaselines,
  checkBaseline,
  type Booted,
  type ProcFn,
} from "@harness/core";

export class AppServer {
  readonly peer: RpcPeer;
  readonly hub: WorkerHub;
  private init?: InitializeParams;
  private session?: Booted;
  private inbox: string[] = [];
  private abort?: AbortController;
  private readonly githubProc?: ProcFn;

  constructor(input: Readable, output: Writable, hub?: WorkerHub, githubProc?: ProcFn) {
    this.hub = hub ?? new WorkerHub();
    this.githubProc = githubProc;
    output.on("error", () => undefined);
    this.peer = new RpcPeer(input, output);
    this.peer.method("initialize", (p) => this.initialize(p as InitializeParams));
    this.peer.method("worker/info", () => this.hub.info());
    this.peer.method("thread/start", (p) => this.threadStart(p as { title?: string }));
    this.peer.method("thread/resume", (p) => this.threadResume(p as { threadId: string }));
    this.peer.method("thread/list", (p) => this.threadList(p as { query?: string }));
    this.peer.method("thread/fork", (p) => this.threadFork(p as { threadId?: string; at?: string }));
    this.peer.method("turn/start", (p) => this.turnStart(p as { prompt: string; detach?: boolean }));
    this.peer.method("turn/steer", (p) => this.turnSteer(p as { text: string }));
    this.peer.method("turn/interrupt", () => this.turnInterrupt());
    this.peer.method("turn/status", (p) => this.turnStatus(p as { threadId?: string }));
    this.peer.method("workspace/undo", () => this.undo());
    this.peer.method("workspace/apply", () => this.apply());
    this.peer.method("workspace/pr", (p) => this.openPr(p as { title?: string; body?: string; base?: string }));
    this.peer.method("workspace/ci", () => this.attachCi());
    this.peer.method("fusion/run", (p) => this.fusionRun(p as { task: string }));
    this.peer.method("knowledge/list", () => this.knowledgeList());
    this.peer.method("knowledge/add", (p) => this.knowledgeAdd(p as { title: string; body: string }));
    this.peer.method("plugin/list", () => this.pluginList());
    this.peer.method("plugin/add", (p) => this.pluginAdd(p as { source: string }));
    this.peer.method("traj/show", (p) => this.trajShow(p as { source?: string }));
    this.peer.method("traj/export", (p) => this.trajExport(p as { path: string }));
    this.peer.method("traj/replay", (p) => this.trajReplay(p as { mode?: "dry" | "live" }));
    this.peer.method("traj/diff", (p) => this.trajDiff(p as { otherThreadId: string }));
    this.peer.method("traj/baseline", (p) => this.trajBaseline(p as { op: string; name?: string }));
    this.peer.method("thread/items/list", (p) => this.itemsList((p as { since?: number }) ?? {}));
    this.peer.method("thread/subscribe", (p) => this.threadSubscribe((p as { since?: number }) ?? {}));
    this.peer.method("shutdown", () => this.shutdown());
  }

  private home(): string {
    if (!this.init) throw new Error("call initialize first");
    return this.init.harnessHome ?? `${process.env.HOME ?? "."}/.harness`;
  }

  private async initialize(params: InitializeParams) {
    this.init = params;
    return { protocolVersion: PROTOCOL_VERSION, serverName: "harness", worker: this.hub.info() };
  }

  private bootOpts(threadId?: string) {
    if (!this.init) throw new Error("call initialize first");
    return {
      userRoot: this.init.cwd,
      harnessHome: this.init.harnessHome,
      model: this.init.model,
      mode: this.init.mode,
      profile: this.init.profile,
      inPlace: this.init.inPlace,
      yolo: this.init.yolo,
      exec: this.init.exec,
      dockerImage: this.init.dockerImage,
      network: this.init.network,
      unattended: this.init.unattended ?? this.init.cloud,
      workerId: this.hub.workerId,
      machineId: this.hub.machineId,
      threadId,
    };
  }

  private async threadStart(params: { title?: string }) {
    const prev = this.session;
    if (prev && !this.hub.isRunning(prev.threadId)) {
      await this.hub.closeIdle(prev.threadId);
    }
    const session = await boot(this.bootOpts());
    this.hub.attach(session);
    this.session = session;
    if (params.title) await this.session.traj.updateHeader({ title: params.title });
    this.inbox = [];
    return {
      threadId: this.session.threadId,
      agentRoot: this.session.workspace.agentRoot,
      workerId: this.hub.workerId,
    };
  }

  private async threadResume(params: { threadId: string }) {
    const existing = this.hub.get(params.threadId);
    if (existing) {
      this.session = existing;
      this.inbox = [];
      return {
        threadId: existing.threadId,
        agentRoot: existing.workspace.agentRoot,
        workerId: this.hub.workerId,
      };
    }
    const session = await boot(this.bootOpts(params.threadId));
    this.hub.attach(session);
    this.session = session;
    this.inbox = [];
    return {
      threadId: this.session.threadId,
      agentRoot: this.session.workspace.agentRoot,
      workerId: this.hub.workerId,
    };
  }

  private async threadList(params: { query?: string }) {
    return { threads: await listThreadSummaries(this.home(), params.query) };
  }

  private async threadFork(params: { threadId?: string; at?: string }) {
    const sourceId = params.threadId || this.session?.threadId;
    if (!sourceId) throw new Error("no thread");
    return forkThread({
      harnessHome: this.home(),
      sourceId,
      at: params.at,
      userRoot: this.init?.cwd,
    });
  }

  private async turnStart(params: { prompt: string; detach?: boolean }) {
    if (!this.session) throw new Error("no thread");
    this.abort = new AbortController();
    const inbox = this.inbox;
    if (!this.session.traj.header?.title) {
      await this.session.traj.updateHeader({ title: params.prompt.slice(0, 80) });
    }
    this.safeNotify("item/started", { type: "user", text: params.prompt });
    const input = {
      prompt: params.prompt,
      inbox,
      signal: this.abort.signal,
      onEvent: (line: string) => {
        this.safeNotify("item/delta", { text: line });
      },
    };
    if (params.detach) {
      const threadId = this.session.threadId;
      void this.hub.runTurn(this.session, input).then(
        (result) => {
          this.safeNotify("done_report", result.done);
          this.safeNotify(result.done.interrupted ? "turn/interrupted" : "turn/completed", result.done);
        },
        (err) => {
          this.safeNotify("turn/interrupted", { message: err instanceof Error ? err.message : String(err) });
        },
      );
      return { threadId, running: true, workerId: this.hub.workerId };
    }
    try {
      const result = await this.hub.runTurn(this.session, input);
      this.safeNotify("done_report", result.done);
      this.safeNotify(result.done.interrupted ? "turn/interrupted" : "turn/completed", result.done);
      return result.done;
    } finally {
      this.abort = undefined;
    }
  }

  private turnStatus(params: { threadId?: string }) {
    const id = params.threadId || this.session?.threadId;
    if (!id) throw new Error("no thread");
    return this.hub.status(id);
  }

  private turnSteer(params: { text: string }) {
    this.inbox.push(params.text);
    return { queued: this.inbox.length };
  }

  private turnInterrupt() {
    this.abort?.abort();
    return { ok: true };
  }

  private async undo() {
    if (!this.session) throw new Error("no thread");
    const id = await this.session.undo();
    this.safeNotify("checkpoint/created", { id, kind: "rewind" });
    return { id };
  }

  private async apply() {
    if (!this.session) throw new Error("no thread");
    return this.session.apply();
  }

  private async openPr(params: { title?: string; body?: string; base?: string }) {
    if (!this.session) throw new Error("no thread");
    const events = await this.session.traj.events();
    const done = [...events].reverse().find((e) => e.type === "done_report");
    const report = done?.payload as { message?: string; changed_files?: string[] } | undefined;
    const title = params.title ?? this.session.traj.header?.title ?? "harness changes";
    const body =
      params.body ??
      `Done Report from ${this.session.threadId}\n\n${report?.message ?? ""}\n\nchanged: ${(report?.changed_files ?? []).join(", ") || "(none)"}`;
    const result = await createPullRequest({
      cwd: this.session.workspace.agentRoot,
      title,
      body,
      base: params.base,
      proc: this.githubProc,
    });
    await this.session.traj.append("system", "pr/opened", result);
    return result;
  }

  private async attachCi() {
    if (!this.session) throw new Error("no thread");
    return attachCiLogs({
      cwd: this.session.workspace.agentRoot,
      traj: this.session.traj,
      proc: this.githubProc,
    });
  }

  private async fusionRun(params: { task: string }) {
    if (!this.session) throw new Error("no thread");
    const result = await runFusion(this.session.thread, params.task);
    this.safeNotify("done_report", {
      changed_files: result.changed_files,
      apply_ready: result.apply_ready,
      message: result.summary,
    });
    return result;
  }

  private async knowledgeList() {
    if (!this.init) throw new Error("call initialize first");
    return { notes: await loadKnowledge(this.init.cwd) };
  }

  private async knowledgeAdd(params: { title: string; body: string }) {
    if (!this.init) throw new Error("call initialize first");
    const note = await addKnowledge({ userRoot: this.init.cwd, title: params.title, body: params.body });
    this.safeNotify("plugin/event", { type: "knowledge/add", id: note.id });
    return note;
  }

  private async trajBaseline(params: { op: string; name?: string }) {
    const home = this.home();
    if (params.op === "list") return { baselines: await listBaselines(home) };
    const threadId = this.session?.threadId;
    if (!threadId) throw new Error("no thread");
    if (!params.name) throw new Error("baseline name required");
    if (params.op === "save") return saveBaseline({ harnessHome: home, threadId, name: params.name });
    if (params.op === "check") return checkBaseline({ harnessHome: home, threadId, name: params.name });
    throw new Error(`unknown baseline op ${params.op}`);
  }

  private pluginList() {
    if (!this.session) throw new Error("no thread");
    return { packages: this.session.plugins() };
  }

  private async pluginAdd(params: { source: string }) {
    if (!this.init) throw new Error("call initialize first");
    const result = await addPlugin({ userRoot: this.init.cwd, source: params.source });
    this.safeNotify("plugin/event", { type: "add", id: result.id, dir: result.dir });
    return result;
  }

  private async trajShow(params: { source?: string }) {
    if (!this.session) throw new Error("no thread");
    const events = await this.session.traj.events();
    return {
      header: this.session.traj.header,
      events: params.source ? events.filter((e) => e.source === params.source) : events,
    };
  }

  private async trajExport(params: { path: string }) {
    if (!this.session) throw new Error("no thread");
    return { path: await exportTraj(this.session.traj.dir, params.path) };
  }

  private async trajReplay(params: { mode?: "dry" | "live" }) {
    if (!this.session) throw new Error("no thread");
    if ((params.mode ?? "dry") === "live") {
      return liveReplay(this.session.traj, {
        userRoot: this.session.config.userRoot,
        harnessHome: this.session.config.harnessHome,
        model: this.session.config.model,
      });
    }
    return dryReplay(this.session.traj);
  }

  private async trajDiff(params: { otherThreadId: string }) {
    if (!this.session) throw new Error("no thread");
    const other = new TrajStore(threadDir(this.home(), params.otherThreadId));
    return diffTrajectories(await this.session.traj.events(), await other.events());
  }

  private async shutdown() {
    const id = this.session?.threadId;
    this.session = undefined;
    this.abort = undefined;
    if (id && !this.hub.isRunning(id)) {
      await this.hub.closeIdle(id);
    }
    return { ok: true };
  }

  private async itemsList(params: { since?: number } = {}) {
    if (!this.session) throw new Error("no thread");
    const events = await this.session.traj.eventsSince(params.since ?? 0);
    return {
      items: events
        .filter((e) =>
          ["turn/start", "steer", "step", "tool_result", "done_report", "checkpoint/created", "delegate", "fusion", "pr/opened", "ci/log"].includes(e.type),
        )
        .map((e) => ({ type: e.type, source: e.source, ts: e.ts, seq: e.seq, payload: e.payload })),
    };
  }

  private async threadSubscribe(params: { since?: number }) {
    if (!this.session) throw new Error("no thread");
    const events = await this.session.traj.eventsSince(params.since ?? 0);
    for (const e of events) {
      this.safeNotify("item/rewind", { seq: e.seq, type: e.type, source: e.source, payload: e.payload });
    }
    const last = events.at(-1)?.seq ?? params.since ?? 0;
    this.safeNotify("item/rewind_end", {
      seq: last,
      running: this.hub.isRunning(this.session.threadId),
      threadId: this.session.threadId,
    });
    return { seq: last, count: events.length, running: this.hub.isRunning(this.session.threadId) };
  }

  private safeNotify(method: string, params: unknown): void {
    try {
      this.peer.notify(method, params);
    } catch {
      /* client disconnected; turn keeps running on the worker */
    }
  }
}

export function createEmbeddedPair(hub?: WorkerHub, githubProc?: ProcFn): {
  toServer: PassThrough;
  toClient: PassThrough;
  server: AppServer;
} {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const server = new AppServer(toServer, toClient, hub, githubProc);
  return { toServer, toClient, server };
}
