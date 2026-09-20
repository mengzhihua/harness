#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildRelease, readProductVersion } from "./build-release.mjs";
import { buildNative } from "./build-native.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bootDir = path.join(root, "servers", "spring-boot");

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
  return result;
}

function walkFiles(dir, prefix = "") {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...walkFiles(path.join(dir, ent.name), rel));
    else out.push(rel);
  }
  return out;
}

async function ensureMaven() {
  const dest = path.join(root, "dist", "cache", "maven");
  const mvn = path.join(dest, "bin", "mvn");
  if (existsSync(mvn)) return mvn;
  mkdirSync(path.dirname(dest), { recursive: true });
  const url = "https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.9/apache-maven-3.9.9-bin.tar.gz";
  const archive = path.join(root, "dist", "cache", "apache-maven-3.9.9-bin.tar.gz");
  if (!existsSync(archive)) {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`maven download ${res.status}`);
    const { writeFileSync: write } = await import("node:fs");
    write(archive, Buffer.from(await res.arrayBuffer()));
  }
  mkdirSync(dest, { recursive: true });
  run("tar", ["-xzf", archive, "-C", dest, "--strip-components=1"]);
  return mvn;
}

export async function buildSpringBoot(opts = {}) {
  const version = readProductVersion();
  const staging = opts.staging ?? path.join(root, "dist", "release");
  if (!existsSync(path.join(staging, "dist", "harness.cjs"))) {
    await buildRelease(staging);
  }
  const nativeRoot = path.join(root, "dist", "native");
  const linuxPack = path.join(nativeRoot, `harness-linux-x64-${version}`);
  if (!existsSync(path.join(linuxPack, "harness"))) {
    await buildNative({ ids: ["linux-x64"], staging, outDir: nativeRoot });
  }

  const resDir = path.join(bootDir, "src", "main", "resources", "harness");
  rmSync(resDir, { recursive: true, force: true });
  mkdirSync(resDir, { recursive: true });
  cpSync(path.join(staging, "dist", "harness.cjs"), path.join(resDir, "dist", "harness.cjs"));
  cpSync(path.join(staging, "profiles"), path.join(resDir, "profiles"), { recursive: true });
  cpSync(path.join(staging, "catalog"), path.join(resDir, "catalog"), { recursive: true });
  for (const id of ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win-x64"]) {
    const pack = path.join(nativeRoot, `harness-${id}-${version}`);
    const binName = id.startsWith("win") ? "harness.exe" : "harness";
    const src = path.join(pack, binName);
    if (!existsSync(src)) continue;
    mkdirSync(path.join(resDir, "natives", id), { recursive: true });
    cpSync(src, path.join(resDir, "natives", id, binName));
  }
  const files = walkFiles(resDir);
  writeFileSync(path.join(resDir, "files.txt"), `${files.join("\n")}\n`);

  const pomPath = path.join(bootDir, "pom.xml");
  const pom = readFileSync(pomPath, "utf8").replace(
    /(<artifactId>harness-server<\/artifactId>\s*<version>)[^<]+/,
    `$1${version}`,
  );
  writeFileSync(pomPath, pom);

  const mvn = await ensureMaven();
  run(mvn, ["-q", "-DskipTests", "package"], { cwd: bootDir });
  const jarName = `harness-server-${version}.jar`;
  const builtJar = path.join(bootDir, "target", jarName);
  if (!existsSync(builtJar)) throw new Error(`expected ${builtJar}`);
  const outDir = opts.outDir ?? path.join(root, "dist", "release");
  mkdirSync(outDir, { recursive: true });
  const dest = path.join(outDir, jarName);
  cpSync(builtJar, dest);
  return { version, jar: dest };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const built = await buildSpringBoot();
  console.log(`harness ${built.version} spring-boot`);
  console.log(built.jar);
}
