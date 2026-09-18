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
  scoreTrajectory,
  searchCatalog,
  installCatalogPlugin,
  openInIde,
  ideStatus,
  setPluginEnabled,
  runProjectCommand,
  setThreadMode,
  setPlan,
  skipPlanStep,
  detectCheckCommand,
  loadUserConfig,
  setUserConfig,
  type Subprocess,
  type Booted,
  type ProcFn,
  type GateRequest,
  type PlanStep,
  Policy,
} from "@harness/core";

export class AppServer {
  readonly peer: RpcPeer;
  readonly hub: WorkerHub;
  private init?: InitializeParams;
  private session?: Booted;
  private inbox: string[] = [];
  private abort?: AbortController;
  private readonly githubProc?: ProcFn;
  private readonly pendingApprovals = new Map<
    string,
    (d: "allow" | "deny" | "allow_session" | "allow_always") => void
  >();
  private approvalSeq = 0;

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
    this.peer.method("thread/mode", (p) => this.threadMode(p as { mode: "ask" | "plan" | "agent" }));
    this.peer.method("plan/set", (p) => this.planSet(p as { steps: PlanStep[] }));
    this.peer.method("plan/skip", (p) => this.planSkip(p as { id: string }));
    this.peer.method("turn/start", (p) => this.turnStart(p as { prompt: string; detach?: boolean }));
    this.peer.method("turn/steer", (p) => this.turnSteer(p as { text: string }));
    this.peer.method("turn/interrupt", () => this.turnInterrupt());
    this.peer.method("turn/status", (p) => this.turnStatus(p as { threadId?: string }));
    this.peer.method("workspace/undo", () => this.undo());
    this.peer.method("workspace/apply", () => this.apply());
    this.peer.method("workspace/check", () => this.runCheck());
    this.peer.method("workspace/pr", (p) => this.openPr(p as { title?: string; body?: string; base?: string }));
    this.peer.method("workspace/ci", () => this.attachCi());
    this.peer.method("fusion/run", (p) => this.fusionRun(p as { task: string; leadModel?: string; sidekickModel?: string }));
    this.peer.method("knowledge/list", () => this.knowledgeList());
    this.peer.method("knowledge/add", (p) => this.knowledgeAdd(p as { title: string; body: string }));
    this.peer.method("plugin/list", () => this.pluginList());
    this.peer.method("plugin/add", (p) => this.pluginAdd(p as { source: string }));
    this.peer.method("plugin/enable", (p) => this.pluginEnable(p as { id: string; enabled?: boolean }));
    this.peer.method("plugin/disable", (p) => this.pluginEnable({ id: (p as { id: string }).id, enabled: false }));
    this.peer.method("plugin/command", (p) => this.pluginCommand(p as { id: string }));
    this.peer.method("approval/respond", (p) => this.approvalRespond(p as { id: string; decision: string }));
    this.peer.method("config/get", () => this.configGet());
    this.peer.method("config/set", (p) => this.configSet(p as { key: string; value: string }));
    this.peer.method("traj/show", (p) => this.trajShow(p as { source?: string }));
    this.peer.method("traj/export", (p) => this.trajExport(p as { path: string }));
    this.peer.method("traj/replay", (p) => this.trajReplay(p as { mode?: "dry" | "live" }));
    this.peer.method("traj/diff", (p) => this.trajDiff(p as { otherThreadId: string }));
    this.peer.method("traj/baseline", (p) => this.trajBaseline(p as { op: string; name?: string }));
    this.peer.method("eval/score", (p) => this.evalScore((p as { task?: string; traj?: string }) ?? {}));
    this.peer.method("plugin/search", (p) => this.pluginSearch(p as { query?: string }));
    this.peer.method("plugin/install", (p) => this.pluginInstall(p as { id: string }));
    this.peer.method("ide/open", (p) => this.ideOpen(p as { path: string; line?: number }));
    this.peer.method("ide/status", () => this.ideInfo());
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
      language: this.init.language,
      leadModel: this.init.leadModel,
      sidekickModel: this.init.sidekickModel,
      workerId: this.hub.workerId,
      machineId: this.hub.machineId,
      threadId,
      approver: this.makeApprover(),
    };
  }

  private makeApprover() {
    return (req: GateRequest, reason: string) => {
      const id = `ap_${++this.approvalSeq}`;
      this.safeNotify("approval/request", {
        id,
        name: req.name,
        args: req.args,
        reason,
        command:
          req.name === "bash"
            ? String(req.args.command ?? "")
            : `${req.name} ${JSON.stringify(req.args).slice(0, 180)}`,
        cwd: this.session?.workspace.agentRoot,
      });
      return new Promise<"allow" | "deny" | "allow_session" | "allow_always">((resolve) => {
        this.pendingApprovals.set(id, resolve);
      });
    };
  }

  private bindApprover(session: Booted): void {
    try {
      const policy = session.thread.get<Policy>("policy");
      policy.approver = this.makeApprover();
    } catch {
      /* policy not mounted */
    }
  }

  private approvalRespond(params: { id: string; decision: string }) {
    const resolve = this.pendingApprovals.get(params.id);
    if (!resolve) throw new Error(`unknown approval ${params.id}`);
    this.pendingApprovals.delete(params.id);
    if (
      params.decision !== "allow" &&
      params.decision !== "deny" &&
      params.decision !== "allow_session" &&
      params.decision !== "allow_always"
    ) {
      throw new Error("decision must be allow | deny | allow_session | allow_always");
    }
    resolve(params.decision);
    return { ok: true, id: params.id, decision: params.decision };
  }

  private async configGet() {
    return loadUserConfig(this.home());
  }

  private async configSet(params: { key: string; value: string }) {
    const cfg = await setUserConfig(this.home(), params.key, params.value);
    if (this.session) {
      if (params.key === "yolo" && cfg.yolo !== undefined) {
        this.session.config.yolo = cfg.yolo;
        try {
          this.session.thread.get<Policy>("policy").setYolo(cfg.yolo);
        } catch {
          /* policy not mounted */
        }
      }
      if (params.key === "mode" && cfg.mode) {
        await setThreadMode(this.session.thread, cfg.mode);
      }
      if (params.key === "model" && cfg.model) this.session.config.model = cfg.model;
      if (params.key === "network" && cfg.network !== undefined) this.session.config.network = cfg.network;
      if (params.key === "language" && cfg.language) this.session.config.language = cfg.language;
      if (params.key === "lead_model" || params.key === "leadModel") this.session.config.leadModel = cfg.leadModel;
      if (params.key === "sidekick_model" || params.key === "sidekickModel") {
        this.session.config.sidekickModel = cfg.sidekickModel;
      }
    }
    this.safeNotify("plugin/event", { type: "config/change", key: params.key, value: params.value, config: cfg });
    return cfg;
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
      this.bindApprover(existing);
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

  private async threadMode(params: { mode: "ask" | "plan" | "agent" }) {
    if (!this.session) throw new Error("no thread");
    const result = await setThreadMode(this.session.thread, params.mode);
    if (this.init) this.init.mode = result.mode;
    this.safeNotify("plugin/event", { type: "mode/change", mode: result.mode });
    return result;
  }

  private async planSet(params: { steps: PlanStep[] }) {
    if (!this.session) throw new Error("no thread");
    const result = await setPlan(this.session.thread, params.steps ?? []);
    this.safeNotify("plan/updated", { steps: result.steps });
    return result;
  }

  private async planSkip(params: { id: string }) {
    if (!this.session) throw new Error("no thread");
    const result = await skipPlanStep(this.session.thread, params.id);
    this.safeNotify("plan/updated", { steps: result.steps });
    return result;
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
      onNotify: (method, params) => {
        this.safeNotify(method, params);
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

  private async runCheck() {
    if (!this.session) throw new Error("no thread");
    const cmd = (await detectCheckCommand(this.session.workspace.agentRoot)) ?? "node --test";
    const sub = this.session.thread.get<Subprocess>("subprocess");
    const result = await sub.exec(cmd);
    const summary = `exit ${result.exitCode}\n${(result.stdout || result.stderr).slice(0, 800)}`;
    await this.session.traj.append("system", "workspace/check", {
      cmd,
      exit_code: result.exitCode,
      summary: summary.slice(0, 400),
    });
    this.safeNotify("item/delta", { text: `check ${cmd} exit ${result.exitCode}` });
    return { cmd, exit_code: result.exitCode, summary };
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

  private async fusionRun(params: { task: string; leadModel?: string; sidekickModel?: string }) {
    if (!this.session) throw new Error("no thread");
    const result = await runFusion(this.session.thread, params.task, {
      leadModel: params.leadModel,
      sidekickModel: params.sidekickModel,
    });
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

  private async evalScore(params: { task?: string; traj?: string } = {}) {
    if (!this.session) throw new Error("no thread");
    const events = await this.session.traj.events();
    const score = scoreTrajectory({
      header: this.session.traj.header,
      events,
      task: params.task,
      threadId: this.session.threadId,
      traj: params.traj,
    });
    if (score.dry_replay_ok && events.some((e) => e.type === "turn/start")) {
      try {
        const replay = await dryReplay(this.session.traj);
        score.dry_replay_ok = replay.messages.some((m) => m.role === "user");
      } catch {
        score.dry_replay_ok = false;
      }
    }
    return score;
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

  private async pluginSearch(params: { query?: string }) {
    return { plugins: await searchCatalog(params.query) };
  }

  private async pluginInstall(params: { id: string }) {
    if (!this.init) throw new Error("call initialize first");
    const result = await installCatalogPlugin({ userRoot: this.init.cwd, id: params.id });
    this.safeNotify("plugin/event", { type: "install", id: result.id, dir: result.dir });
    return result;
  }

  private async ideOpen(params: { path: string; line?: number }) {
    const cwd = this.session?.workspace.agentRoot ?? this.init?.cwd;
    const result = await openInIde({ path: params.path, line: params.line, cwd });
    if (this.session) await this.session.traj.append("system", "ide/open", result);
    return result;
  }

  private async ideInfo() {
    return ideStatus(this.session?.workspace.agentRoot);
  }

  private async pluginEnable(params: { id: string; enabled?: boolean }) {
    if (!this.session) throw new Error("no thread");
    const result = await setPluginEnabled(this.session.thread, params.id, params.enabled !== false);
    this.safeNotify("plugin/event", { type: "plugin/change", id: result.id, enabled: result.enabled });
    return result;
  }

  private async pluginCommand(params: { id: string }) {
    if (!this.session) throw new Error("no thread");
    return runProjectCommand(this.session.thread, params.id);
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
          ["turn/start", "steer", "step", "tool_result", "done_report", "checkpoint/created", "delegate", "fusion", "pr/opened", "ci/log", "verify_nudge", "check_nudge", "compact", "plugin/change", "attachment", "mode/change", "plan/updated", "turn/interrupted", "skill/read", "diff/updated", "workspace/check"].includes(e.type),
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
