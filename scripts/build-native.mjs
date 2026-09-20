#!/usr/bin/env node
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildRelease, readProductVersion } from "./build-release.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

export const NATIVE_TARGETS = [
  { id: "linux-x64", os: "linux", arch: "x64", bin: "harness", macho: false, kind: "posix" },
  { id: "linux-arm64", os: "linux", arch: "arm64", bin: "harness", macho: false, kind: "posix" },
  { id: "darwin-x64", os: "darwin", arch: "x64", bin: "harness", macho: true, kind: "posix" },
  { id: "darwin-arm64", os: "darwin", arch: "arm64", bin: "harness", macho: true, kind: "posix" },
  { id: "win-x64", os: "win", arch: "x64", bin: "harness.exe", macho: false, kind: "win" },
];

export function nodeVersion() {
  return process.versions.node;
}

function cacheDir() {
  const dir = path.join(root, "dist", "cache", "node");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed: ${result.stderr || result.stdout || result.status}`);
  }
  return result;
}

async function download(url, dest) {
  if (existsSync(dest) && readFileSync(dest).length > 1000) return dest;
  mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  let lastErr;
  for (const delay of [0, 4000, 8000]) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    try {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) throw new Error(`${url} -> ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(tmp, buf);
      renameSync(tmp, dest);
      return dest;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function fetchNodeBinary(target) {
  const ver = nodeVersion();
  if (target.id === "linux-x64" && process.platform === "linux" && process.arch === "x64") {
    return process.execPath;
  }
  if (target.kind === "win") {
    const dest = path.join(cacheDir(), `node-v${ver}-win-x64.exe`);
    await download(`https://nodejs.org/dist/v${ver}/win-x64/node.exe`, dest);
    return dest;
  }
  const ext = target.os === "linux" ? "tar.xz" : "tar.gz";
  const name = `node-v${ver}-${target.os}-${target.arch}`;
  const archive = path.join(cacheDir(), `${name}.${ext}`);
  await download(`https://nodejs.org/dist/v${ver}/${name}.${ext}`, archive);
  const extract = path.join(cacheDir(), name);
  if (!existsSync(path.join(extract, "bin", "node"))) {
    rmSync(extract, { recursive: true, force: true });
    mkdirSync(extract, { recursive: true });
    if (ext === "tar.xz") run("tar", ["-xJf", archive, "-C", extract, "--strip-components=1"]);
    else run("tar", ["-xzf", archive, "-C", extract, "--strip-components=1"]);
  }
  return path.join(extract, "bin", "node");
}

function writeSeaBlob(cjs, blobPath) {
  const cfg = path.join(path.dirname(blobPath), "sea-config.json");
  writeFileSync(
    cfg,
    `${JSON.stringify(
      {
        main: cjs,
        output: blobPath,
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: false,
      },
      null,
      2,
    )}\n`,
  );
  run(process.execPath, ["--experimental-sea-config", cfg], { cwd: path.dirname(cfg) });
  if (!existsSync(blobPath)) throw new Error("SEA blob was not produced");
  return blobPath;
}

function injectSea(nodeBin, dest, blob, macho) {
  copyFileSync(nodeBin, dest);
  chmodSync(dest, 0o755);
  const args = [dest, "NODE_SEA_BLOB", blob, "--sentinel-fuse", FUSE];
  if (macho) args.push("--macho-segment-name", "NODE_SEA");
  const postject = path.join(root, "node_modules", ".bin", "postject");
  run(existsSync(postject) ? postject : "npx", existsSync(postject) ? args : ["postject", ...args], { cwd: root });
}

function platformReadme(version, target) {
  const run = target.kind === "win" ? ".\\harness.exe" : "./harness";
  return `# Harness ${version} (${target.id})

Unpack and run. Node.js does not need to be installed.

\`\`\`
${run} --version
${run} doctor
${run} exec --model mock --prompt "把失败的登录测试修了"
${run} serve --http --port 8080 --bind 0.0.0.0
\`\`\`

Keep \`profiles/\` and \`catalog/\` next to the executable (or set HARNESS_ROOT).
macOS: if Gatekeeper blocks the binary, run \`xattr -cr .\` in this folder then \`codesign --force --deep --sign - ./harness\`.
`;
}

function archiveDir(dir, archive) {
  rmSync(archive, { force: true });
  const parent = path.dirname(dir);
  const base = path.basename(dir);
  if (archive.endsWith(".zip")) {
    run("python3", ["-c", "import shutil,sys; shutil.make_archive(sys.argv[1], 'zip', sys.argv[2], sys.argv[3])", archive.replace(/\.zip$/, ""), parent, base]);
    return;
  }
  run("tar", ["-czf", archive, "-C", parent, base]);
}

export function isMachoArm64(buf) {
  if (buf.length < 8) return false;
  if (buf[0] !== 0xcf || buf[1] !== 0xfa || buf[2] !== 0xed || buf[3] !== 0xfe) return false;
  const cpu = buf.readUInt32LE(4);
  return cpu === 0x0100000c;
}

export function isMachoX64(buf) {
  if (buf.length < 8) return false;
  if (buf[0] !== 0xcf || buf[1] !== 0xfa || buf[2] !== 0xed || buf[3] !== 0xfe) return false;
  const cpu = buf.readUInt32LE(4);
  return cpu === 0x01000007;
}

export function isFatMachO(buf) {
  return buf.length >= 8 && buf[0] === 0xca && buf[1] === 0xfe && buf[2] === 0xba && buf[3] === 0xbe;
}

export function thinMachO(cputype, size = 64) {
  const buf = Buffer.alloc(size);
  buf[0] = 0xcf;
  buf[1] = 0xfa;
  buf[2] = 0xed;
  buf[3] = 0xfe;
  buf.writeUInt32LE(cputype, 4);
  return buf;
}

export function requireAppleSiliconZip(artifacts) {
  const armZip = artifacts.find((a) => a.id === "macos-arm64");
  if (!armZip || !existsSync(armZip.archive)) {
    throw new Error("Apple Silicon macOS zip (harness-macos-arm64-*.zip) was not produced");
  }
  const armBin = readFileSync(armZip.bin);
  if (!isMachoArm64(armBin)) {
    throw new Error("harness-macos-arm64 binary is not a Mach-O arm64 executable");
  }
  return armZip;
}

function writeMacosZip(packDir, outDir, version, arch) {
  const aliasName = `harness-macos-${arch}-${version}`;
  const aliasDir = path.join(outDir, aliasName);
  rmSync(aliasDir, { recursive: true, force: true });
  cpSync(packDir, aliasDir, { recursive: true });
  writeFileSync(
    path.join(aliasDir, "README.md"),
    `# Harness ${version} (macOS ${arch === "arm64" ? "Apple Silicon" : "Intel"})

Unpack this zip in Finder, then:

\`\`\`
./harness --version
./harness doctor
\`\`\`

Keep profiles/ and catalog/ next to the executable.
If macOS blocks it: \`xattr -cr .\` then \`codesign --force --sign - ./harness\`.
`,
  );
  const archive = path.join(outDir, `${aliasName}.zip`);
  archiveDir(aliasDir, archive);
  return { dir: aliasDir, archive };
}

function align(n, bits) {
  const a = 1 << bits;
  return (n + a - 1) & ~(a - 1);
}

/** Build a universal2 (arm64 + x86_64) Mach-O from two thin SEA binaries. */
export function writeFatMachO(arm64Bin, x64Bin, dest) {
  const arm = readFileSync(arm64Bin);
  const x64 = readFileSync(x64Bin);
  if (!isMachoArm64(arm)) throw new Error("universal: first input is not Mach-O arm64");
  if (!isMachoX64(x64)) throw new Error("universal: second input is not Mach-O x86_64");
  const alignBits = 14;
  const headerSize = 8 + 20 * 2;
  const offArm = align(headerSize, alignBits);
  const offX64 = align(offArm + arm.length, alignBits);
  const buf = Buffer.alloc(offX64 + x64.length);
  buf.writeUInt32BE(0xcafebabe, 0);
  buf.writeUInt32BE(2, 4);
  buf.writeUInt32BE(0x0100000c, 8);
  buf.writeUInt32BE(0, 12);
  buf.writeUInt32BE(offArm, 16);
  buf.writeUInt32BE(arm.length, 20);
  buf.writeUInt32BE(alignBits, 24);
  buf.writeUInt32BE(0x01000007, 28);
  buf.writeUInt32BE(3, 32);
  buf.writeUInt32BE(offX64, 36);
  buf.writeUInt32BE(x64.length, 40);
  buf.writeUInt32BE(alignBits, 44);
  arm.copy(buf, offArm);
  x64.copy(buf, offX64);
  writeFileSync(dest, buf);
  chmodSync(dest, 0o755);
  return dest;
}

function writeMacosUniversal(armBin, x64Bin, outDir, version) {
  const name = `harness-macos-universal-${version}`;
  const dir = path.join(outDir, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, "harness");
  writeFatMachO(armBin, x64Bin, dest);
  const armDir = path.dirname(armBin);
  cpSync(path.join(armDir, "profiles"), path.join(dir, "profiles"), { recursive: true });
  cpSync(path.join(armDir, "catalog"), path.join(dir, "catalog"), { recursive: true });
  writeFileSync(
    path.join(dir, "README.md"),
    `# Harness ${version} (macOS universal: Apple Silicon + Intel)

One zip for every Mac. Unpack and run \`./harness\`.
`,
  );
  const archive = path.join(outDir, `${name}.zip`);
  archiveDir(dir, archive);
  return { id: "macos-universal", dir, bin: dest, archive, version };
}

export async function buildNative(opts = {}) {
  const version = readProductVersion();
  const outDir = opts.outDir ?? path.join(root, "dist", "native");
  const ids = opts.ids ?? NATIVE_TARGETS.map((t) => t.id);
  const targets = NATIVE_TARGETS.filter((t) => ids.includes(t.id));
  if (!targets.length) throw new Error("no native targets");

  const staging = opts.staging ?? path.join(root, "dist", "release");
  const cjs = path.join(staging, "dist", "harness.cjs");
  if (!opts.reuse || !existsSync(cjs)) {
    await buildRelease(staging);
  }
  mkdirSync(outDir, { recursive: true });
  const work = mkdtempSync(path.join(os.tmpdir(), "harness-sea-"));
  const blob = path.join(work, "sea-prep.blob");
  writeSeaBlob(path.join(staging, "dist", "harness.cjs"), blob);

  const artifacts = [];
  for (const target of targets) {
    const packName = `harness-${target.id}-${version}`;
    const packDir = path.join(outDir, packName);
    rmSync(packDir, { recursive: true, force: true });
    mkdirSync(packDir, { recursive: true });
    const nodeBin = await fetchNodeBinary(target);
    const dest = path.join(packDir, target.bin);
    injectSea(nodeBin, dest, blob, target.macho);
    cpSync(path.join(staging, "profiles"), path.join(packDir, "profiles"), { recursive: true });
    cpSync(path.join(staging, "catalog"), path.join(packDir, "catalog"), { recursive: true });
    writeFileSync(path.join(packDir, "README.md"), platformReadme(version, target));
    const archive = path.join(outDir, target.kind === "win" ? `${packName}.zip` : `${packName}.tar.gz`);
    archiveDir(packDir, archive);
    artifacts.push({ id: target.id, dir: packDir, bin: dest, archive, version });
    if (target.os === "darwin") {
      const mac = writeMacosZip(packDir, outDir, version, target.arch);
      artifacts.push({ id: `macos-${target.arch}`, dir: mac.dir, bin: path.join(mac.dir, target.bin), archive: mac.archive, version });
    }
  }
  if (targets.some((t) => t.id === "darwin-arm64")) {
    requireAppleSiliconZip(artifacts);
  }
  const armThin = artifacts.find((a) => a.id === "darwin-arm64");
  const x64Thin = artifacts.find((a) => a.id === "darwin-x64");
  if (armThin && x64Thin) {
    const uni = writeMacosUniversal(armThin.bin, x64Thin.bin, outDir, version);
    artifacts.push(uni);
  }
  return { version, outDir, artifacts };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const ids = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const built = await buildNative(ids.length ? { ids } : undefined);
  console.log(`harness ${built.version} native`);
  for (const a of built.artifacts) console.log(a.archive);
}
