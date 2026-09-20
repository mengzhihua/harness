#!/usr/bin/env node
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function readProductVersion() {
  const src = readFileSync(path.join(root, "packages/protocol/src/types.ts"), "utf8");
  const match = src.match(/PROTOCOL_VERSION = "([^"]+)"/);
  if (!match) throw new Error("PROTOCOL_VERSION not found");
  return match[1];
}

export async function buildRelease(outDir = path.join(root, "dist", "release")) {
  const esbuild = require("esbuild");
  const version = readProductVersion();
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(path.join(outDir, "dist"), { recursive: true });
  mkdirSync(path.join(outDir, "bin"), { recursive: true });

  await esbuild.build({
    absWorkingDir: root,
    entryPoints: [path.join(root, "packages/cli/src/main.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    outfile: path.join(outDir, "dist", "harness.cjs"),
    legalComments: "none",
    logLevel: "silent",
    packages: "bundle",
  });

  cpSync(path.join(root, "profiles"), path.join(outDir, "profiles"), { recursive: true });
  cpSync(path.join(root, "catalog"), path.join(outDir, "catalog"), { recursive: true });
  writeFileSync(
    path.join(outDir, "bin", "harness.cjs"),
    `#!/usr/bin/env node\nrequire("../dist/harness.cjs");\n`,
  );
  chmodSync(path.join(outDir, "bin", "harness.cjs"), 0o755);

  const readme = `# Harness ${version}

Coding agent runtime. Requires Node.js 22+. No source checkout or tsx.

\`\`\`bash
npm i -g ./harness-cli-${version}.tgz
harness --version
harness doctor
cd <repo> && harness exec --model mock --prompt "把失败的登录测试修了"
\`\`\`

After a \`v${version}\` (or \`v*\`) git tag, GitHub Actions uploads this same tarball to the Release.
`;
  writeFileSync(path.join(outDir, "README.md"), readme);
  writeFileSync(
    path.join(outDir, "package.json"),
    `${JSON.stringify(
      {
        name: "@harness/cli",
        version,
        description: "Harness coding agent runtime",
        type: "module",
        bin: { harness: "./bin/harness.cjs" },
        engines: { node: ">=22" },
        files: ["bin", "dist", "profiles", "catalog", "README.md"],
        license: "MIT",
        publishConfig: { access: "public" },
        repository: { type: "git", url: "https://github.com/mengzhihua/harness.git" },
      },
      null,
      2,
    )}\n`,
  );

  const packed = spawnSync("npm", ["pack", "--pack-destination", outDir], {
    cwd: outDir,
    encoding: "utf8",
  });
  if (packed.status !== 0) {
    throw new Error(packed.stderr || packed.stdout || "npm pack failed");
  }
  const filename = packed.stdout.trim().split("\n").at(-1)?.trim();
  if (!filename) throw new Error("npm pack produced no tarball");
  const tarball = path.join(outDir, filename);
  return {
    version,
    dir: outDir,
    tarball,
    bin: path.join(outDir, "bin", "harness.cjs"),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const built = await buildRelease();
  console.log(`harness ${built.version}`);
  console.log(built.tarball);
}
