import assert from "node:assert/strict";
import { test } from "node:test";
import { attachWorkbenchHost, listenWorkbench, WORKBENCH_INJECT_JS } from "./host.ts";
import { renderWorkbench } from "./workbench.ts";

test("attachWorkbenchHost injects window.harness fetch bridge", () => {
  const html = attachWorkbenchHost("<html><body>hi</body></html>");
  assert.match(html, /window\.harness/);
  assert.match(html, /\/rpc\/ide\/command/);
  assert.match(html, /EventSource\("\/events"\)/);
  assert.match(WORKBENCH_INJECT_JS, /fetch\("\/rpc\/ide\/command"/);
  assert.match(WORKBENCH_INJECT_JS, /new EventSource\("\/events"\)/);
});

test("listenWorkbench serves HTML and POSTs ide/command on loopback", async () => {
  const view = renderWorkbench({ threadId: "th_host", title: "Harness IDE" });
  const seen: Array<{ cmd?: string; path?: string; content?: string }> = [];
  const host = await listenWorkbench({
    html: view.html,
    onCommand: async (payload) => {
      seen.push(payload);
      return { ok: true, cmd: payload.cmd, message: `saved ${payload.path}`, path: payload.path };
    },
  });
  try {
    assert.match(host.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const page = await fetch(host.url);
    const body = await page.text();
    assert.match(body, /window\.harness/);
    assert.match(body, /\/rpc\/ide\/command/);
    assert.match(body, /EventSource\("\/events"\)/);
    assert.match(body, /data-cmd="save"/);
    const posted = await fetch(new URL("/rpc/ide/command", host.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cmd: "save", path: "src/auth.js", content: "export const ok = 1;\n" }),
    });
    const result = (await posted.json()) as { ok: boolean; message: string };
    assert.equal(result.ok, true);
    assert.match(result.message, /saved src\/auth\.js/);
    assert.equal(seen[0]?.cmd, "save");
    assert.equal(seen[0]?.path, "src/auth.js");
    const unknown = await fetch(new URL("/nope", host.url));
    assert.equal(unknown.status, 404);
  } finally {
    await host.close();
  }
});

test("listenWorkbench streams SSE events and serves runtime/doctor", async () => {
  const host = await listenWorkbench({
    html: "<html><body>live</body></html>",
    onCommand: async () => ({ ok: true }),
    onDoctor: async () => ({ ok: true, protocol: "0.27.0", checks: [] }),
  });
  const es = new EventSource(new URL("/events", host.url).href);
  try {
    await new Promise<void>((resolve, reject) => {
      es.addEventListener("open", () => resolve());
      es.addEventListener("error", () => reject(new Error("sse error")));
      setTimeout(() => reject(new Error("sse open timeout")), 4000);
    });
    const got = new Promise<string>((resolve, reject) => {
      es.addEventListener("item/delta", (ev) => resolve((ev as MessageEvent).data));
      setTimeout(() => reject(new Error("sse event timeout")), 4000);
    });
    host.push({ method: "item/delta", params: { text: "workbench live" } });
    assert.match(await got, /workbench live/);
    const doctor = await fetch(new URL("/rpc/runtime/doctor", host.url));
    assert.equal(doctor.status, 200);
    const body = (await doctor.json()) as { ok: boolean; protocol: string };
    assert.equal(body.ok, true);
    assert.equal(body.protocol, "0.27.0");
  } finally {
    es.close();
    await host.close();
  }
});

test("listenWorkbench refuses non-loopback binds", async () => {
  await assert.rejects(
    listenWorkbench({
      html: "<html></html>",
      host: "0.0.0.0",
      onCommand: async () => ({}),
    }),
    /loopback/,
  );
});
