import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Context, Loader } from "../src/index.ts";

test("provide / inject / isolate close does not drop parent services", async () => {
  const host = new Context("host");
  host.provide("llm", { id: "mock" });
  await host.inject(["llm"]);
  const child = host.isolate("th_1");
  child.provide("tools", { names: ["bash"] });
  assert.equal(child.get<{ id: string }>("llm").id, "mock");
  assert.deepEqual(child.get<{ names: string[] }>("tools").names, ["bash"]);
  await child.close();
  assert.equal(host.get<{ id: string }>("llm").id, "mock");
  await host.close();
});

test("effects dispose in reverse order", async () => {
  const ctx = new Context("host");
  const order: number[] = [];
  ctx.effect(() => () => {
    order.push(1);
  });
  ctx.effect(() => () => {
    order.push(2);
  });
  await ctx.close();
  assert.deepEqual(order, [2, 1]);
});

test("waterfall runs parent then child", async () => {
  const host = new Context("host");
  host.onWaterfall<{ n: number }>("tools/pre-execute", (p) => ({ n: p.n + 1 }));
  const iso = host.isolate("t");
  iso.onWaterfall<{ n: number }>("tools/pre-execute", (p) => ({ n: p.n * 2 }));
  const out = await iso.waterfall("tools/pre-execute", { n: 3 });
  assert.equal(out.n, 8);
  await host.close();
});

test("Loader refuses a half tree (missing inject)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "harness-loader-"));
  const profile = path.join(dir, "broken.yml");
  await writeFile(
    profile,
    `packages:\n  - id: needs-llm\n    plane: host\n    inject: [llm]\n`,
  );
  const loader = new Loader();
  loader.register("needs-llm", async () => undefined);
  const host = new Context("host");
  await assert.rejects(() => loader.mount(host, profile, "host"), /missing llm/);
  await host.close();
});

test("Loader refuses unknown packages", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "harness-loader-"));
  const profile = path.join(dir, "broken.yml");
  await writeFile(profile, `packages:\n  - id: not.registered\n    plane: host\n`);
  const loader = new Loader();
  const host = new Context("host");
  await assert.rejects(() => loader.mount(host, profile, "host"), /unknown package/);
  await host.close();
});
