import assert from "node:assert/strict";
import { createEmbeddedPair } from "./app-server.ts";
import { listenAppHttp } from "./http-rpc.ts";
import { PROTOCOL_VERSION } from "@harness/protocol";
import { test } from "node:test";

test("listenAppHttp serves health and JSON-RPC doctor", async () => {
  const http = await listenAppHttp({ host: "127.0.0.1", port: 0 });
  try {
    const health = await fetch(new URL("/health", http.url));
    const body = (await health.json()) as { ok: boolean; protocol: string; rpc: string };
    assert.equal(body.ok, true);
    assert.equal(body.protocol, PROTOCOL_VERSION);
    assert.equal(body.rpc, "/rpc");
    const rpc = await fetch(new URL("/rpc", http.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "runtime/doctor", params: {} }),
    });
    const result = (await rpc.json()) as { result?: { ok: boolean; protocol: string } };
    assert.equal(result.result?.ok, true);
    assert.equal(result.result?.protocol, PROTOCOL_VERSION);
  } finally {
    await http.close();
  }
});

test("createEmbeddedPair still speaks stdio JSON-RPC", async () => {
  const pair = createEmbeddedPair();
  assert.ok(pair.server);
  assert.ok(pair.toServer);
});
