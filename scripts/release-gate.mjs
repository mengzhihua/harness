#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readProductVersion } from "./build-release.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_RE = /\[skip release\]|\[skip ci\]/i;
const SKIP_LINE_RE = /^\s*\[skip (?:release|ci)\]\s*$/i;
const BOT_SKIP_RE = /dependabot|renovate/i;
const ZERO_SHA = /^0+$/;

export function hasSkipMarker(message = "") {
  const lines = message.replace(/\r\n/g, "\n").split("\n");
  const subject = lines[0] ?? "";
  if (SKIP_RE.test(subject)) return true;
  return lines.slice(1).some((line) => SKIP_LINE_RE.test(line));
}

export function shortSha(sha = "") {
  return sha.slice(0, 7);
}

export function releaseTag({ protocolVersion, sha, refType, refName }) {
  if (refType === "tag") {
    const name = refName || "";
    return name.startsWith("v") ? name : `v${name}`;
  }
  return `v${protocolVersion}-${shortSha(sha)}`;
}

export function isDocsOnlyPath(file) {
  if (!file) return true;
  if (file.startsWith(".github/")) return false;
  if (file.startsWith("scripts/")) return false;
  if (file.startsWith("packages/")) return false;
  if (file.startsWith("servers/")) return false;
  if (file.startsWith("extensions/")) return false;
  if (file.startsWith("catalog/")) return false;
  if (file.startsWith("profiles/")) return false;
  if (file === "package.json" || file === "pnpm-lock.yaml" || file === "pnpm-workspace.yaml") return false;
  if (file.startsWith("eval/") && (file.endsWith(".ts") || file.endsWith(".mjs") || file.endsWith(".js"))) return false;
  return (
    file.endsWith(".md") ||
    file.startsWith("docs/") ||
    file === "LICENSE" ||
    file.endsWith(".txt")
  );
}

export function decideRelease(input) {
  const {
    eventName,
    refType,
    refName = "",
    sha = "",
    commitMessage = "",
    protocolVersion,
    changedFiles,
    existingReleaseTags = [],
    actor = "",
  } = input;

  const skip = (reason) => ({
    shouldRelease: false,
    tag: "",
    title: "",
    reason,
    makeLatest: false,
  });

  if (eventName === "pull_request") return skip("pull_request");
  if (eventName !== "workflow_dispatch" && hasSkipMarker(commitMessage)) return skip("skip_marker");
  if (BOT_SKIP_RE.test(actor)) return skip("bot");

  const tag = releaseTag({ protocolVersion, sha, refType, refName });
  if (existingReleaseTags.includes(tag)) return skip("already_released");

  if (eventName !== "workflow_dispatch" && Array.isArray(changedFiles) && changedFiles.length > 0 && changedFiles.every(isDocsOnlyPath)) {
    return skip("docs_only");
  }

  return {
    shouldRelease: true,
    tag,
    title: refType === "tag" ? tag : `v${protocolVersion} (${shortSha(sha)})`,
    reason: eventName === "workflow_dispatch" ? "manual" : refType === "tag" ? "tag" : "green_push",
    makeLatest: true,
  };
}

export function formatReleaseNotes({ protocolVersion, tag, sha, branch, reason }) {
  return `# Harness ${protocolVersion}

\`pnpm test\` 通过后自动发行。解压即可用，不需要源码或 \`tsx\`。

- 协议：${protocolVersion}
- 标记：${tag}
- 提交：${sha}
- 分支：${branch || ""}
- 原因：${reason}

最新版：https://github.com/mengzhihua/harness/releases/latest

## 下载哪个文件

Release 资产里按平台选：

| 平台 | 文件 |
| --- | --- |
| Windows x64 | \`harness-win-x64-${protocolVersion}.zip\`（内含 \`harness.exe\`） |
| macOS Apple Silicon (M1+) | \`harness-macos-arm64-${protocolVersion}.zip\` |
| macOS Intel | \`harness-macos-x64-${protocolVersion}.zip\` |
| macOS 通用 (ARM+Intel) | \`harness-macos-universal-${protocolVersion}.zip\` |
| Linux x64 | \`harness-linux-x64-${protocolVersion}.tar.gz\` |
| Linux ARM64 | \`harness-linux-arm64-${protocolVersion}.tar.gz\` |
| 服务端 (JDK 21+) | \`harness-server-${protocolVersion}.jar\` |
| npm 全局安装 | \`harness-cli-${protocolVersion}.tgz\` |

Apple Silicon 必出 zip；缺 \`harness-macos-arm64-*.zip\` 时打包失败。\`harness-darwin-*-*.tar.gz\` 仍保留给脚本。

提交说明写 \`[skip release]\` 或 \`[skip ci]\` 时不发版。Pull Request 只跑测试。
`;
}

function gitLines(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) return [];
  return (result.stdout || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function listChangedFiles({ before, sha }) {
  if (!sha) return [];
  const zero = !before || ZERO_SHA.test(before);
  if (zero) return gitLines(["diff-tree", "--no-commit-id", "--name-only", "-r", sha]);
  return gitLines(["diff", "--name-only", before, sha]);
}

function listGitTags() {
  return gitLines(["tag", "-l"]);
}

function listReleaseTags() {
  const result = spawnSync("gh", ["release", "list", "--limit", "100", "--json", "tagName", "--jq", ".[].tagName"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) return [];
  return (result.stdout || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function commitMessageFromGit(sha) {
  const args = sha ? ["log", "-1", "--format=%B", sha] : ["log", "-1", "--format=%B"];
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return (result.stdout || "").trim();
}

function writeGithubOutput(values) {
  const dest = process.env.GITHUB_OUTPUT;
  const body = Object.entries(values)
    .map(([key, value]) => `${key}=${String(value ?? "").replace(/\r?\n/g, " ")}`)
    .join("\n")
    .concat("\n");
  if (dest) appendFileSync(dest, body);
  else process.stdout.write(body);
}

export function runGate(env = process.env, opts = {}) {
  const protocolVersion = opts.protocolVersion ?? readProductVersion();
  const eventName = env.EVENT_NAME || env.GITHUB_EVENT_NAME || "";
  const refType = env.REF_TYPE || env.GITHUB_REF_TYPE || "";
  const refName = env.REF_NAME || env.GITHUB_REF_NAME || "";
  const sha = env.SHA || env.GITHUB_SHA || "";
  const actor = env.ACTOR || env.GITHUB_ACTOR || "";
  const before = env.BEFORE || "";
  const commitMessage = opts.commitMessage ?? commitMessageFromGit(sha);
  const changedFiles = opts.changedFiles ?? listChangedFiles({ before, sha });
  const existingTags = opts.existingTags ?? listGitTags();
  const existingReleaseTags = opts.existingReleaseTags ?? listReleaseTags();
  const decision = decideRelease({
    eventName,
    refType,
    refName,
    sha,
    actor,
    commitMessage,
    protocolVersion,
    changedFiles,
    existingTags,
    existingReleaseTags,
  });
  const notes = formatReleaseNotes({
    protocolVersion,
    tag: decision.tag || `v${protocolVersion}`,
    sha,
    branch: refType === "branch" ? refName : "",
    reason: decision.reason,
  });
  if (opts.notesPath) writeFileSync(opts.notesPath, notes);
  writeGithubOutput({
    should_release: decision.shouldRelease ? "true" : "false",
    tag: decision.tag,
    title: decision.title,
    reason: decision.reason,
    make_latest: decision.makeLatest ? "true" : "false",
  });
  return { ...decision, protocolVersion, notes };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const notesIdx = process.argv.indexOf("--write-notes");
  const notesPath = notesIdx >= 0 ? process.argv[notesIdx + 1] : "";
  const decision = runGate(process.env, { notesPath });
  console.error(JSON.stringify({ ...decision, notes: undefined }));
}
