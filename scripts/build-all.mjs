#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { buildRelease } from "./build-release.mjs";
import { buildNative } from "./build-native.mjs";
import { buildSpringBoot } from "./build-spring-boot.mjs";

export async function buildAll() {
  const npm = await buildRelease();
  const native = await buildNative({ staging: npm.dir });
  const server = await buildSpringBoot({ staging: npm.dir });
  return { npm, native, server };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const built = await buildAll();
  console.log(`harness ${built.npm.version}`);
  console.log(built.npm.tarball);
  for (const a of built.native.artifacts) console.log(a.archive);
  console.log(built.server.jar);
}
