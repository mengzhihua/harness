import assert from "node:assert/strict";
import { test } from "node:test";
import { browserActionRequest, runBrowser } from "./browser.ts";
import { extractBrief } from "./fusion.ts";

test("browserActionRequest freezes navigate/click payloads", () => {
  assert.deepEqual(browserActionRequest({ action: "navigate", url: "https://example.com" }).params, {
    action: "navigate",
    url: "https://example.com",
  });
  assert.equal(browserActionRequest({ action: "click", ref: "e12" }).method, "browser/act");
  assert.throws(() => browserActionRequest({ action: "navigate" }), /url/);
});

test("runBrowser fails closed without HARNESS_BROWSER", async () => {
  const prev = process.env.HARNESS_BROWSER;
  delete process.env.HARNESS_BROWSER;
  try {
    const out = await runBrowser({ action: "snapshot" });
    assert.equal(out.ok, false);
    assert.match(out.message, /HARNESS_BROWSER/);
  } finally {
    if (prev !== undefined) process.env.HARNESS_BROWSER = prev;
  }
});

test("extractBrief keeps only the BRIEF block", () => {
  assert.match(extractBrief("noise\nBRIEF:\ngoal: fix\n"), /^BRIEF:/);
});
