import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "@harness/protocol";
import { formatReleaseNotes } from "../../scripts/release-gate.mjs";
import {
  NATIVE_TARGETS,
  buildNative,
  isFatMachO,
  isMachoArm64,
  isMachoX64,
  requireAppleSiliconZip,
  thinMachO,
  writeFatMachO,
} from "../../scripts/build-native.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

test("protocol version is 0.32 for P32", () => {
  assert.equal(PROTOCOL_VERSION, "0.32.0");
});

test("native targets always include Apple Silicon darwin-arm64", () => {
  const arm = NATIVE_TARGETS.find((t) => t.id === "darwin-arm64");
  assert.ok(arm, "darwin-arm64 target");
  assert.equal(arm.os, "darwin");
  assert.equal(arm.arch, "arm64");
  assert.equal(arm.macho, true);
});

test("requireAppleSiliconZip fails when the ARM Mac zip is missing or not arm64", () => {
  assert.throws(
    () => requireAppleSiliconZip([]),
    /Apple Silicon macOS zip \(harness-macos-arm64-\*\.zip\) was not produced/,
  );

  const tmp = mkdtempSync(path.join(os.tmpdir(), "harness-p32-missing-"));
  const bin = path.join(tmp, "harness");
  writeFileSync(bin, thinMachO(0x0100000c));
  assert.throws(
    () =>
      requireAppleSiliconZip([
        { id: "macos-arm64", bin, archive: path.join(tmp, "harness-macos-arm64-missing.zip") },
      ]),
    /was not produced/,
  );

  const x64Dir = mkdtempSync(path.join(os.tmpdir(), "harness-p32-x64-"));
  const x64Bin = path.join(x64Dir, "harness");
  const x64Zip = path.join(x64Dir, `harness-macos-arm64-${PROTOCOL_VERSION}.zip`);
  writeFileSync(x64Bin, thinMachO(0x01000007));
  writeFileSync(x64Zip, "zip");
  assert.ok(isMachoX64(thinMachO(0x01000007)));
  assert.throws(() => requireAppleSiliconZip([{ id: "macos-arm64", bin: x64Bin, archive: x64Zip }]), /not a Mach-O arm64/);
});

test("requireAppleSiliconZip accepts a Mach-O arm64 macos zip", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "harness-p32-ok-"));
  const bin = path.join(tmp, "harness");
  const archive = path.join(tmp, `harness-macos-arm64-${PROTOCOL_VERSION}.zip`);
  writeFileSync(bin, thinMachO(0x0100000c));
  writeFileSync(archive, "zip");
  const got = requireAppleSiliconZip([{ id: "macos-arm64", bin, archive }]);
  assert.equal(got.archive, archive);
  assert.equal(isMachoArm64(thinMachO(0x0100000c)), true);
});

test("darwin-arm64 pack produces Finder zip with Mach-O arm64", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "harness-p32-native-"));
  const built = await buildNative({ ids: ["darwin-arm64"], outDir: path.join(tmp, "native") });
  const mac = built.artifacts.find((a) => a.id === "macos-arm64");
  assert.ok(mac, "macos-arm64 artifact");
  assert.ok(mac.archive.endsWith(`harness-macos-arm64-${PROTOCOL_VERSION}.zip`));
  assert.equal(isMachoArm64(await readFile(mac.bin)), true);
  assert.equal(requireAppleSiliconZip(built.artifacts).id, "macos-arm64");
  const darwin = built.artifacts.find((a) => a.id === "darwin-arm64");
  assert.ok(darwin?.archive.endsWith(`harness-darwin-arm64-${PROTOCOL_VERSION}.tar.gz`));
});

test("fat Mach-O zip combines arm64 and x64 thins", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "harness-p32-fat-"));
  mkdirSync(tmp, { recursive: true });
  const arm = path.join(tmp, "arm");
  const x64 = path.join(tmp, "x64");
  const dest = path.join(tmp, "harness");
  writeFileSync(arm, thinMachO(0x0100000c, 128));
  writeFileSync(x64, thinMachO(0x01000007, 96));
  writeFatMachO(arm, x64, dest);
  const fat = readFileSync(dest);
  assert.equal(isFatMachO(fat), true);
  assert.equal(fat.readUInt32BE(0), 0xcafebabe);
  assert.equal(fat.readUInt32BE(4), 2);
  assert.equal(fat.readUInt32BE(8), 0x0100000c);
  assert.equal(fat.readUInt32BE(28), 0x01000007);
});

test("release notes and README list Apple Silicon as macos-arm64 zip", async () => {
  const notes = formatReleaseNotes({
    protocolVersion: PROTOCOL_VERSION,
    tag: `v${PROTOCOL_VERSION}-abcdef1`,
    sha: "abcdef1234567890",
    branch: "cursor/p32-macos-arm-558a",
    reason: "green_push",
  });
  assert.match(notes, new RegExp(`harness-macos-arm64-${PROTOCOL_VERSION}\\.zip`));
  assert.match(notes, /Apple Silicon/);
  assert.match(notes, /harness-macos-universal-/);
  const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");
  assert.match(readme, /harness-macos-arm64-\*\.zip/);
  const yml = await readFile(path.join(repoRoot, ".github/workflows/release.yml"), "utf8");
  assert.match(yml, /dist\/native\/\*\.zip/);
});
