import assert from "node:assert/strict";
import { test } from "node:test";
import { Context } from "@harness/compose";
import { ApplicationContext, autowired, springContext } from "./index.ts";

test("ApplicationContext creates singleton beans and autowires inject", async () => {
  const ctx = new Context("host");
  ctx.provide("config", { model: "mock" });
  const app = new ApplicationContext(ctx);
  let built = 0;
  app.bean({
    id: "llm",
    inject: ["config"],
    factory: (c) => {
      built += 1;
      return { model: autowired<{ model: string }>(c, "config").model };
    },
  });
  await app.refresh();
  assert.equal(built, 1);
  assert.equal((await app.getBean<{ model: string }>("llm")).model, "mock");
  assert.equal((await app.getBean<{ model: string }>("llm")).model, "mock");
  assert.equal(built, 1);
  await app.close();
  await ctx.close();
});

test("circular bean inject fails before runtime", async () => {
  const ctx = new Context("host");
  const app = new ApplicationContext(ctx);
  app.bean({
    id: "a",
    inject: ["b"],
    factory: () => ({ id: "a" }),
  });
  app.bean({
    id: "b",
    inject: ["a"],
    factory: () => ({ id: "b" }),
  });
  await assert.rejects(() => app.refresh(), /circular bean dependency: a -> b -> a/);
  await ctx.close();
});

test("springContext hangs on Cordis isolate and disposes", async () => {
  const host = new Context("host");
  const iso = host.isolate("th_1");
  const app = springContext(iso);
  let destroyed = false;
  app.bean({
    id: "shell",
    factory: () => ({ kind: "local" }),
    destroy: () => {
      destroyed = true;
    },
  });
  await app.refresh();
  assert.equal(iso.get<{ kind: string }>("shell").kind, "local");
  await iso.close();
  assert.equal(destroyed, true);
  await host.close();
});
