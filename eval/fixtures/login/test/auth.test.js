import assert from "node:assert/strict";
import { test } from "node:test";
import { login } from "../src/auth.js";

test("admin can log in with the documented password", () => {
  assert.equal(login("admin", "password").ok, true);
});
