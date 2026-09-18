import { Context } from "@harness/compose";

export type BeanScope = "singleton" | "isolate";

export interface BeanDefinition<T = unknown> {
  id: string;
  scope?: BeanScope;
  inject?: string[];
  factory: (ctx: Context) => T | Promise<T>;
  destroy?: (bean: T) => void | Promise<void>;
}

/**
 * Spring-style container on top of Cordis Context.
 * Does not vendor Java Spring; exposes Bean / inject / refresh / destroy.
 */
export class ApplicationContext {
  private readonly defs = new Map<string, BeanDefinition>();
  private readonly singletons = new Map<string, unknown>();
  private readonly destroying: Array<() => void | Promise<void>> = [];
  private readonly creating = new Set<string>();
  private closed = false;

  constructor(readonly ctx: Context) {}

  bean<T>(def: BeanDefinition<T>): this {
    this.ensureOpen();
    this.defs.set(def.id, def as BeanDefinition);
    return this;
  }

  containsBean(id: string): boolean {
    return this.defs.has(id) || this.singletons.has(id) || this.ctx.has(id);
  }

  async refresh(): Promise<void> {
    this.ensureOpen();
    for (const [id, def] of this.defs) {
      if ((def.scope ?? "singleton") === "singleton") await this.getBean(id);
    }
  }

  async getBean<T>(id: string): Promise<T> {
    this.ensureOpen();
    if (this.singletons.has(id)) return this.singletons.get(id) as T;
    if (this.ctx.has(id) && !this.defs.has(id)) return this.ctx.get<T>(id);
    return this.create(id);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const dispose of [...this.destroying].reverse()) await dispose();
    this.singletons.clear();
  }

  private async create<T>(id: string): Promise<T> {
    const def = this.defs.get(id);
    if (!def) throw new Error(`no bean ${id}`);
    if (this.creating.has(id)) {
      throw new Error(`circular bean dependency: ${[...this.creating, id].join(" -> ")}`);
    }
    this.creating.add(id);
    try {
      for (const dep of def.inject ?? []) {
        if (this.defs.has(dep)) await this.getBean(dep);
      }
      if (def.inject?.length) await this.ctx.inject(def.inject);
      const bean = (await def.factory(this.ctx)) as T;
      this.ctx.provide(def.id, bean);
      if ((def.scope ?? "singleton") === "singleton") this.singletons.set(id, bean);
      if (def.destroy) {
        this.destroying.push(() => def.destroy!(bean));
        this.ctx.effect(() => () => {
          void def.destroy!(bean);
        });
      }
      return bean;
    } finally {
      this.creating.delete(id);
    }
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("ApplicationContext is closed");
  }
}

export function autowired<T>(ctx: Context, name: string): T {
  return ctx.get<T>(name);
}

export function springContext(ctx: Context): ApplicationContext {
  if (ctx.has("spring")) return ctx.get<ApplicationContext>("spring");
  const app = new ApplicationContext(ctx);
  ctx.provide("spring", app);
  ctx.effect(() => () => {
    void app.close();
  });
  return app;
}
