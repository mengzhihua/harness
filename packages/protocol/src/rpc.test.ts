import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { RpcPeer, PROTOCOL_VERSION } from "./index.ts";

test("RpcPeer request / response / notify", async () => {
  const a = new PassThrough();
  const b = new PassThrough();
  const server = new RpcPeer(a, b);
  const client = new RpcPeer(b, a);
  server.method("ping", (params) => ({ pong: (params as { n: number }).n, v: PROTOCOL_VERSION }));
  const seen: unknown[] = [];
  client.onNotify("tick", (p) => seen.push(p));
  const out = await client.request<{ pong: number }>("ping", { n: 7 });
  assert.equal(out.pong, 7);
  server.notify("tick", { ok: true });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(seen, [{ ok: true }]);
});
