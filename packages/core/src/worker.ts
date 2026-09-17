import os from "node:os";
import type { Booted } from "./boot.ts";
import type { TurnInput, TurnResult } from "./loop.ts";

export function newWorkerId(): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `wk_${t}_${r}`;
}

export interface WorkerInfo {
  workerId: string;
  machineId: string;
  kind: "local";
}

export interface TurnStatus {
  threadId: string;
  running: boolean;
  workerId: string;
  machineId: string;
  done?: TurnResult["done"];
}

/**
 * Machine-side owner of Booted sessions and in-flight turns.
 * RPC clients (laptops) attach/detach; the hub keeps the same traj id running.
 */
export class WorkerHub {
  readonly workerId: string;
  readonly machineId: string;
  private readonly sessions = new Map<string, Booted>();
  private readonly running = new Map<string, Promise<TurnResult>>();
  private readonly results = new Map<string, TurnResult>();

  constructor(id?: string) {
    this.workerId = id ?? newWorkerId();
    this.machineId = os.hostname();
  }

  info(): WorkerInfo {
    return { workerId: this.workerId, machineId: this.machineId, kind: "local" };
  }

  attach(session: Booted): void {
    this.sessions.set(session.threadId, session);
  }

  get(threadId: string): Booted | undefined {
    return this.sessions.get(threadId);
  }

  isRunning(threadId: string): boolean {
    return this.running.has(threadId);
  }

  status(threadId: string): TurnStatus {
    return {
      threadId,
      running: this.running.has(threadId),
      workerId: this.workerId,
      machineId: this.machineId,
      done: this.results.get(threadId)?.done,
    };
  }

  runTurn(session: Booted, input: TurnInput): Promise<TurnResult> {
    const existing = this.running.get(session.threadId);
    if (existing) return existing;
    const promise = session.runTurn(input).then(
      (result) => {
        this.results.set(session.threadId, result);
        this.running.delete(session.threadId);
        return result;
      },
      (err) => {
        this.running.delete(session.threadId);
        throw err;
      },
    );
    this.running.set(session.threadId, promise);
    return promise;
  }

  wait(threadId: string): Promise<TurnResult | undefined> {
    return this.running.get(threadId) ?? Promise.resolve(this.results.get(threadId));
  }

  async release(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    this.sessions.delete(threadId);
    this.running.delete(threadId);
    this.results.delete(threadId);
    await session?.close();
  }

  async closeIdle(threadId: string): Promise<void> {
    if (this.running.has(threadId)) return;
    await this.release(threadId);
  }

  async closeAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.release(id)));
  }
}
