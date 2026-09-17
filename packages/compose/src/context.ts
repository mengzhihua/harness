import type { PluginLock, WaterfallHandler } from "./types.ts";

export class Context {
  readonly name: string;
  readonly parent: Context | null;
  private readonly services = new Map<string, unknown>();
  private readonly children = new Set<Context>();
  private readonly disposers: Array<() => void | Promise<void>> = [];
  private readonly waterfalls = new Map<string, WaterfallHandler<unknown>[]>();
  private closed = false;

  constructor(name = "host", parent: Context | null = null) {
    this.name = name;
    this.parent = parent;
    parent?.children.add(this);
  }

  isolate(threadId: string): Context {
    this.ensureOpen();
    return new Context(threadId, this);
  }

  provide<T>(name: string, value: T): this {
    this.ensureOpen();
    this.services.set(name, value);
    return this;
  }

  get<T>(name: string): T {
    if (this.services.has(name)) return this.services.get(name) as T;
    if (this.parent) return this.parent.get<T>(name);
    throw new Error(`service not provided: ${name}`);
  }

  has(name: string): boolean {
    return this.services.has(name) || (this.parent?.has(name) ?? false);
  }

  /** Own services only; used by Loader to merge plugin_lock. */
  own<T>(name: string): T | undefined {
    return this.services.get(name) as T | undefined;
  }

  async inject(names: string[]): Promise<void> {
    const missing = names.filter((n) => !this.has(n));
    if (missing.length) {
      throw new Error(`incomplete composition on ${this.name}: missing ${missing.join(", ")}`);
    }
  }

  effect(register: () => () => void | Promise<void>): void {
    this.ensureOpen();
    const dispose = register();
    this.disposers.push(dispose);
  }

  onWaterfall<T>(event: string, handler: WaterfallHandler<T>): void {
    this.effect(() => {
      const list = this.waterfalls.get(event) ?? [];
      list.push(handler as WaterfallHandler<unknown>);
      this.waterfalls.set(event, list);
      return () => {
        const cur = this.waterfalls.get(event);
        if (!cur) return;
        this.waterfalls.set(
          event,
          cur.filter((h) => h !== handler),
        );
      };
    });
  }

  async waterfall<T>(event: string, payload: T): Promise<T> {
    const handlers = this.collectWaterfalls(event);
    let acc: T = payload;
    for (const handler of handlers) {
      acc = (await handler(acc)) as T;
    }
    return acc;
  }

  pluginLock(): PluginLock {
    const packages = [
      ...(this.parent?.pluginLock().packages ?? []),
      ...(this.own<PluginLock>("plugin_lock")?.packages ?? []),
    ];
    return { packages };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const kids = [...this.children];
    for (const child of kids) await child.close();
    for (const dispose of [...this.disposers].reverse()) {
      await dispose();
    }
    this.parent?.children.delete(this);
  }

  private collectWaterfalls(event: string): WaterfallHandler<unknown>[] {
    const parent = this.parent?.collectWaterfalls(event) ?? [];
    return [...parent, ...(this.waterfalls.get(event) ?? [])];
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error(`context ${this.name} is closed`);
  }
}
