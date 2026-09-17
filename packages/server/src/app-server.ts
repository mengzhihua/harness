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
  type Booted,
} from "@harness/core";

export class AppServer {
  readonly peer: RpcPeer;
  private init?: InitializeParams;
  private session?: Booted;
  private inbox: string[] = [];
  private abort?: AbortController;

  constructor(input: Readable, output: Writable) {
    this.peer = new RpcPeer(input, output);
    this.peer.method("initialize", (p) => this.initialize(p as InitializeParams));
    this.peer.method("thread/start", (p) => this.threadStart(p as { title?: string }));
    this.peer.method("thread/resume", (p) => this.threadResume(p as { threadId: string }));
    this.peer.method("thread/list", (p) => this.threadList(p as { query?: string }));
    this.peer.method("thread/fork", (p) => this.threadFork(p as { threadId?: string; at?: string }));
    this.peer.method("turn/start", (p) => this.turnStart(p as { prompt: string }));
    this.peer.method("turn/steer", (p) => this.turnSteer(p as { text: string }));
    this.peer.method("turn/interrupt", () => this.turnInterrupt());
    this.peer.method("workspace/undo", () => this.undo());
    this.peer.method("workspace/apply", () => this.apply());
    this.peer.method("plugin/list", () => this.pluginList());
    this.peer.method("plugin/add", (p) => this.pluginAdd(p as { source: string }));
    this.peer.method("traj/show", (p) => this.trajShow(p as { source?: string }));
    this.peer.method("traj/export", (p) => this.trajExport(p as { path: string }));
    this.peer.method("traj/replay", (p) => this.trajReplay(p as { mode?: "dry" | "live" }));
    this.peer.method("traj/diff", (p) => this.trajDiff(p as { otherThreadId: string }));
    this.peer.method("thread/items/list", () => this.itemsList());
    this.peer.method("shutdown", () => this.shutdown());
  }

  private home(): string {
    if (!this.init) throw new Error("call initialize first");
    return this.init.harnessHome ?? `${process.env.HOME ?? "."}/.harness`;
  }

  private async initialize(params: InitializeParams) {
    this.init = params;
    return { protocolVersion: PROTOCOL_VERSION, serverName: "harness" };
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
      threadId,
    };
  }

  private async threadStart(params: { title?: string }) {
    await this.session?.close();
    this.session = await boot(this.bootOpts());
    if (params.title) await this.session.traj.updateHeader({ title: params.title });
    this.inbox = [];
    return { threadId: this.session.threadId, agentRoot: this.session.workspace.agentRoot };
  }

  private async threadResume(params: { threadId: string }) {
    await this.session?.close();
    this.session = await boot(this.bootOpts(params.threadId));
    this.inbox = [];
    return { threadId: this.session.threadId, agentRoot: this.session.workspace.agentRoot };
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

  private async turnStart(params: { prompt: string }) {
    if (!this.session) throw new Error("no thread");
    this.abort = new AbortController();
    const inbox = this.inbox;
    if (!this.session.traj.header?.title) {
      await this.session.traj.updateHeader({ title: params.prompt.slice(0, 80) });
    }
    this.peer.notify("item/started", { type: "user", text: params.prompt });
    try {
      const result = await this.session.runTurn({
        prompt: params.prompt,
        inbox,
        signal: this.abort.signal,
        onEvent: (line) => {
          this.peer.notify("item/delta", { text: line });
        },
      });
      this.peer.notify("done_report", result.done);
      this.peer.notify(result.done.interrupted ? "turn/interrupted" : "turn/completed", result.done);
      return result.done;
    } finally {
      this.abort = undefined;
    }
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
    this.peer.notify("checkpoint/created", { id, kind: "rewind" });
    return { id };
  }

  private async apply() {
    if (!this.session) throw new Error("no thread");
    return this.session.apply();
  }

  private pluginList() {
    if (!this.session) throw new Error("no thread");
    return { packages: this.session.plugins() };
  }

  private async pluginAdd(params: { source: string }) {
    if (!this.init) throw new Error("call initialize first");
    const result = await addPlugin({ userRoot: this.init.cwd, source: params.source });
    this.peer.notify("plugin/event", { type: "add", id: result.id, dir: result.dir });
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
    await this.session?.close();
    this.session = undefined;
    return { ok: true };
  }

  private async itemsList() {
    if (!this.session) throw new Error("no thread");
    const events = await this.session.traj.events();
    return {
      items: events
        .filter((e) =>
          ["turn/start", "steer", "step", "tool_result", "done_report", "checkpoint/created"].includes(e.type),
        )
        .map((e) => ({ type: e.type, source: e.source, ts: e.ts, payload: e.payload })),
    };
  }
}

export function createEmbeddedPair(): { toServer: PassThrough; toClient: PassThrough; server: AppServer } {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const server = new AppServer(toServer, toClient);
  return { toServer, toClient, server };
}
