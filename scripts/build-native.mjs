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
  }
  return { version, outDir, artifacts };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const ids = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const built = await buildNative(ids.length ? { ids } : undefined);
  console.log(`harness ${built.version} native`);
  for (const a of built.artifacts) console.log(a.archive);
}
