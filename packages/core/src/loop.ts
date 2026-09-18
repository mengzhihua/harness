import type { Context } from "@harness/compose";
import type { HarnessConfig } from "./config.ts";
import type { ChatMessage } from "./llm.ts";
import type { Llm } from "./llm.ts";
import type { ToolCall, ToolRouter } from "./tools.ts";
import { READONLY_TOOLS, describeTool, hitCount, parseToolArgs } from "./tools.ts";
import type { TrajStore } from "./traj.ts";
import type { Workspace } from "./workspace.ts";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { compactMessages, messagesArePrefix, modelVisibleSubsetOfTraj, projectMessages } from "./history.ts";
import type { ToolResult } from "./tools.ts";
import { sandboxInstructions } from "./sandbox.ts";
import { knowledgeCatalog, loadKnowledge } from "./knowledge.ts";
import { loadAgentsMd } from "./agentsmd.ts";
import { loadAttachments } from "./attach.ts";
import { formatPlan, type PlanStep } from "./mode.ts";
import { humanizeStuck } from "./stuck.ts";

export interface TurnInput {
  prompt: string;
  onEvent?: (line: string) => void;
  onNotify?: (method: string, params: unknown) => void;
  inbox?: string[];
  signal?: AbortSignal;
}

export interface DoneReport {
  changed_files: string[];
  checks: Array<{ cmd: string; exit_code: number; summary: string; summary_path?: string }>;
  residual_risks: string[];
  apply_ready: boolean;
  checkpoint?: string;
  message: string;
  interrupted?: boolean;
  agents_md_suggestion?: string;
}

export interface TurnResult {
  done: DoneReport;
  threadId: string;
  trajDir: string;
}

export class AgentLoop {
  async runTurn(ctx: Context, input: TurnInput): Promise<TurnResult> {
    const config = ctx.get<HarnessConfig>("config");
    const traj = ctx.get<TrajStore>("traj");
    const llm = ctx.get<Llm>("llm");
    const tools = ctx.get<ToolRouter>("tools");
    const workspace = ctx.get<Workspace>("workspace");
    const emit = input.onEvent ?? (() => undefined);
    const inbox = input.inbox ?? [];

    const begin = await workspace.checkpoint("turn-begin");
    await traj.append("checkpoint", "checkpoint/created", { id: begin, label: "turn-begin" });
    const attached = await loadAttachments([workspace.agentRoot, workspace.userRoot], input.prompt);
    const prompt = attached.text;
    if (attached.attachments.length) {
      await traj.append("user", "attachment", {
        paths: attached.attachments.map((a) => a.path),
        bytes: attached.attachments.reduce((n, a) => n + a.content.length, 0),
      });
    }
    await traj.append("user", "turn/start", { prompt, mode: config.mode, attachments: attached.attachments.map((a) => a.path) });
    emit(`turn/start  thread=${ctx.name}  mode=${config.mode}`);

    let messages = await assemble(ctx, prompt);
    await traj.append("system", "prompt/assemble", {
      roles: messages.map((m) => m.role),
      chars: messages.reduce((n, m) => n + m.content.length, 0),
    });
    if (needsCompact(messages)) {
      messages = await stampCompact(traj, messages, { reason: "assemble" });
    }

    const checks: DoneReport["checks"] = [];
    let lastAssistant = "";
    let interrupted = false;
    let nudged = false;
    let checkNudged = false;

    for (let step = 0; step < config.maxSteps; step++) {
      if (input.signal?.aborted) {
        interrupted = true;
        emit("interrupted");
        await traj.append("system", "turn/interrupted", { step });
        break;
      }

      const events = await traj.events();
      if (!events.some((e) => e.type === "compact") && !modelVisibleSubsetOfTraj(messages, events)) {
        await traj.append("system", "integrity/mismatch", { step });
        throw new Error("model-visible messages are not a subset of the trajectory");
      }

      emit(`step ${step + 1}`);
      const snapshot = messages.slice();
      const schemas = filterTools(tools.schemas(), config.mode);
      let reply;
      try {
        reply = await llm.chat(
          {
            model: config.model,
            messages,
            tools: schemas,
            onDelta: (text) => input.onNotify?.("item/delta", { text, append: true, source: "llm" }),
          },
          input.signal,
        );
      } catch (err) {
        if (input.signal?.aborted || isAbortError(err)) {
          interrupted = true;
          emit("interrupted");
          await traj.append("system", "turn/interrupted", { step, reason: "abort" });
          break;
        }
        throw err;
      }
      lastAssistant = reply.content ?? "";
      if (reply.usage) {
        await traj.append("assistant", "llm/usage", { step, ...reply.usage });
        input.onNotify?.("llm/usage", { step, ...reply.usage });
      }
      messages.push({
        role: "assistant",
        content: reply.content ?? "",
        tool_calls: reply.tool_calls,
      });
      await traj.append("assistant", "step", {
        step,
        content: reply.content,
        tool_calls: reply.tool_calls?.map((c) => ({
          id: c.id,
          name: c.function.name,
          arguments: c.function.arguments,
        })),
      });

      if (!reply.tool_calls?.length) {
        const mid = await workspace.listDiff();
        if (config.mode === "agent" && mid.files.length > 0 && checks.length === 0 && !nudged && !interrupted) {
          nudged = true;
          const text =
            "[verify] Files changed but no check output yet. Run the project tests now and use that evidence.";
          messages.push({ role: "user", content: text });
          await traj.append("system", "verify_nudge", { text });
          emit("verify nudge");
          continue;
        }
        const lastCheck = checks.at(-1);
        const stuckNow = lastCheck ? humanizeStuck(lastCheck) : undefined;
        if (
          config.mode === "agent" &&
          lastCheck &&
          lastCheck.exit_code !== 0 &&
          !stuckNow &&
          !checkNudged &&
          !interrupted
        ) {
          checkNudged = true;
          const text = `[check] Last command failed (exit ${lastCheck.exit_code}). Keep fixing with that output, or clearly state the blocker.`;
          messages.push({ role: "user", content: text });
          await traj.append("system", "check_nudge", { text, exit_code: lastCheck.exit_code });
          emit("check nudge");
          continue;
        }
        break;
      }

      const results = await runCalls(tools, reply.tool_calls, emit, input.signal, (chunk) =>
        input.onNotify?.("item/delta", { text: chunk, append: true, source: "bash" }),
        input.onNotify,
      );
      const wrote = results.some(
        ([c]) => c.function.name === "str_replace" || c.function.name === "write_file",
      );
      if (wrote) {
        const mid = await workspace.listDiff();
        const payload = { files: mid.files, summary: mid.summary };
        await traj.append("system", "diff/updated", payload);
        input.onNotify?.("diff/updated", payload);
        emit(`diff ${mid.files.join(",") || "-"}`);
      }
      for (const [call, result] of results) {
        if (call.function.name === "bash") {
          const exit = /exit (\-?\d+)/.exec(result.content);
          const art = /full log: (.+)$/m.exec(result.content);
          checks.push({
            cmd: safeJson(call.function.arguments).command ?? "bash",
            exit_code: exit ? Number(exit[1]) : result.ok ? 0 : 1,
            summary: result.content.slice(0, 400),
            summary_path: art?.[1],
          });
        }
        const clipped = result.content.slice(0, 4000);
        await traj.append("tool", "tool_result", {
          callId: result.callId,
          name: result.name,
          ok: result.ok,
          content: clipped,
        });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.function.name,
          content: clipped,
        });
      }

      if (input.signal?.aborted) {
        interrupted = true;
        emit("interrupted");
        await traj.append("system", "turn/interrupted", { step, reason: "tool" });
        break;
      }

      while (inbox.length) {
        const text = inbox.shift()!;
        messages.push({ role: "user", content: `[steer] ${text}` });
        await traj.append("user", "steer", { text });
        emit(`steer: ${text}`);
      }

      if (needsCompact(messages)) {
        messages = await stampCompact(traj, messages, { step });
      } else if (!messagesArePrefix(snapshot, messages)) {
        await traj.append("system", "integrity/mismatch", { step, reason: "prefix" });
        throw new Error("assembled prompt is not a prefix of the previous step");
      }
    }

    const diff = await workspace.listDiff();
    input.onNotify?.("diff/updated", { files: diff.files, summary: diff.summary });
    const checkpoint = await workspace.checkpoint("turn-end");
    await traj.append("checkpoint", "checkpoint/created", { id: checkpoint, label: "turn-end", files: diff.files });

    const lastCheck = checks.at(-1);
    const lastFailed = lastCheck ? lastCheck.exit_code !== 0 : false;
    const stuck = checks.map(humanizeStuck).filter((s): s is string => Boolean(s));
    const agentsMdSuggestion = suggestAgentsMd(workspace.agentRoot, checks);
    const done: DoneReport = {
      changed_files: diff.files,
      checks,
      residual_risks: [
        ...(lastFailed ? ["last checks still failing"] : []),
        ...stuck,
        ...(interrupted ? ["interrupted"] : []),
      ],
      apply_ready: !interrupted && config.mode === "agent" && diff.files.length > 0 && !!lastCheck && !lastFailed,
      checkpoint,
      message:
        interrupted
          ? "interrupted"
          : lastAssistant ||
            stuck[0] ||
            (diff.files.length ? `changed ${diff.files.join(", ")}` : "no file changes"),
      interrupted,
      agents_md_suggestion: agentsMdSuggestion,
    };
    await traj.append("system", "done_report", done);
    await traj.append("system", "turn/end", { apply_ready: done.apply_ready, interrupted });
    emit(`done  files=${done.changed_files.join(",") || "-"}  apply_ready=${done.apply_ready}`);
    return { done, threadId: ctx.name, trajDir: traj.dir };
  }
}

async function runCalls(
  tools: ToolRouter,
  calls: ToolCall[],
  emit: (line: string) => void,
  signal?: AbortSignal,
  onStdout?: (chunk: string) => void,
  onNotify?: (method: string, params: unknown) => void,
): Promise<Array<[ToolCall, ToolResult]>> {
  const prev = tools.onStdout;
  tools.onStdout = onStdout;
  try {
    for (const call of calls) {
      const view = describeTool(call.function.name, parseToolArgs(call.function.arguments));
      onNotify?.("item/started", { type: "tool", ...view });
    }
    const reads = calls.filter((c) => READONLY_TOOLS.has(c.function.name));
    const writes = calls.filter((c) => !READONLY_TOOLS.has(c.function.name));
    const byId = new Map<string, ToolResult>();
    if (reads.length) {
      if (reads.length > 1) emit(`  parallel ${reads.map((c) => c.function.name).join(",")}`);
      else emit(`  ${reads[0]!.function.name} ${reads[0]!.function.arguments}`);
      const results = await Promise.all(reads.map((c) => tools.execute(c, signal)));
      for (let i = 0; i < reads.length; i++) byId.set(reads[i]!.id, results[i]!);
    }
    for (const call of writes) {
      emit(`  ${call.function.name} ${call.function.arguments}`);
      byId.set(call.id, await tools.execute(call, signal));
    }
    const ordered = calls.map((c) => [c, byId.get(c.id)!] as [ToolCall, ToolResult]);
    for (const [call, result] of ordered) {
      const args = parseToolArgs(call.function.arguments);
      const hits = call.function.name === "grep" || call.function.name === "glob" ? hitCount(result.content) : undefined;
      onNotify?.("item/completed", { type: "tool", ...describeTool(call.function.name, args, { hits }), ok: result.ok });
    }
    return ordered;
  } finally {
    tools.onStdout = prev;
  }
}

const COMPACT_NOTE = "[compacted earlier steps; kept plan, recent steps, latest checks. see trajectory]";

async function stampCompact(
  traj: TrajStore,
  messages: ChatMessage[],
  extra: Record<string, unknown>,
): Promise<ChatMessage[]> {
  const compacted = compactMessages(messages);
  await traj.append("system", "compact", {
    before: messages.length,
    after: compacted.length,
    text: COMPACT_NOTE,
    ...extra,
  });
  return compacted;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || /aborted|interrupted/i.test(err.message));
}

function filterTools(
  schemas: ReturnType<ToolRouter["schemas"]>,
  mode: HarnessConfig["mode"],
): ReturnType<ToolRouter["schemas"]> {
  if (mode === "agent") return schemas;
  const allow = new Set([
    "read_file",
    "grep",
    "glob",
    "read_skill",
    ...(mode === "plan" ? ["update_plan", "bash"] : []),
  ]);
  return schemas.filter((s) => allow.has(s.function.name));
}

export async function assemble(ctx: Context, prompt: string): Promise<ChatMessage[]> {
  const config = ctx.get<HarnessConfig>("config");
  const workspace = ctx.get<Workspace>("workspace");
  const traj = ctx.get<TrajStore>("traj");
  const dirty = await workspace.userDirty();
  const agentsMd = await loadAgentsMd({ agentRoot: workspace.agentRoot, userRoot: workspace.userRoot });
  const skills =
    (ctx.has("skillCatalog") ? ctx.get<string>("skillCatalog") : "") || (await loadProjectSkills(workspace.userRoot));
  const knowledge = knowledgeCatalog(await loadKnowledge(workspace.userRoot));

  const system = [
    "You are a coding agent running inside Harness.",
    config.mode === "ask"
      ? "Ask mode: explain and search only. Do not edit files or run mutating commands."
      : config.mode === "plan"
        ? "Plan mode: inspect the repo and call update_plan. Do not edit files."
        : "Fix the user's request with small diffs. Do not touch unrelated files.",
    config.language === "zh"
      ? "Reply in Simplified Chinese (简体中文) unless the user writes in another language."
      : "Reply in English unless the user writes in another language.",
    config.fusionRole === "lead"
      ? "You are the Fusion Lead. Produce a BRIEF for the Sidekick. Do not edit files. Do not share this transcript with the Sidekick."
      : config.fusionRole === "sidekick"
        ? "You are the Fusion Sidekick. Execute the BRIEF only. You do not see the Lead's transcript or the original user conversation."
        : "",
    "You MUST run the relevant tests or commands and use that output as evidence when in agent mode.",
    "Work only in the AgentWorkspace. The user's original directory may be dirty — never write there.",
    "Prefer read_file / grep / glob / str_replace / bash. Call read_skill to load a skill body. Do not call apply or undo; those are user commands.",
    "You may call delegate for a bounded sub-task, or fusion for Lead/Sidekick. Parent traj only sees the brief/result.",
    "",
    sandboxInstructions({ exec: config.exec, network: config.network, image: config.dockerImage }),
    config.unattended
      ? "unattended: ask-once (net/install/push) is auto-allowed and audited; destructive commands still blocked."
      : "",
    "",
    "## environment_context",
    `mode: ${config.mode}`,
    `model: ${config.model}`,
    `language: ${config.language}`,
    `user cwd: ${workspace.userRoot}`,
    `agent cwd: ${workspace.agentRoot} (${workspace.kind})`,
    dirty ? `user tree is dirty:\n${dirty}\nDo not modify those files in the user tree.` : "user tree is clean.",
    agentsMd ? `\n## project docs (AGENTS.md)\n${agentsMd}` : "",
    skills ? `\n## skills\n${skills}` : "",
    knowledge ? `\n## knowledge\n${knowledge}` : "",
    ctx.has("plan") ? `\n## plan\n${formatPlan(ctx.get<PlanStep[]>("plan"))}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const history = projectMessages(await traj.events()).filter((m) => {
    // current prompt is appended after history; drop the trailing turn/start we just wrote
    return true;
  });
  if (history.at(-1)?.role === "user" && history.at(-1)?.content === prompt) {
    history.pop();
  }

  return [{ role: "system", content: system }, ...history, { role: "user", content: prompt }];
}

function needsCompact(messages: ChatMessage[], maxChars = 80_000): boolean {
  if (messages.length < 6) return false;
  return messages.reduce((n, m) => n + m.content.length, 0) > maxChars;
}

async function readIfExists(file: string): Promise<string> {
  if (!existsSync(file)) return "";
  return readFile(file, "utf8");
}

export function suggestAgentsMd(
  agentRoot: string,
  checks: DoneReport["checks"],
): string | undefined {
  if (existsSync(path.join(agentRoot, "AGENTS.md"))) return undefined;
  const passing = checks.find((c) => c.exit_code === 0 && /\btest\b/i.test(c.cmd));
  const cmd = passing?.cmd ?? (existsSync(path.join(agentRoot, "package.json")) ? "node --test" : undefined);
  if (!cmd) {
    return "Create AGENTS.md describing how to build and test this repo. Harness will not write it unless you ask.";
  }
  return `Create AGENTS.md documenting the test command \`${cmd}\`. Harness will not write it unless you ask.`;
}

async function loadProjectSkills(userRoot: string): Promise<string> {
  const dir = path.join(userRoot, ".harness", "plugins");
  if (!existsSync(dir)) return "";
  const { readdir } = await import("node:fs/promises");
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return "";
  }
  const lines: string[] = [];
  for (const name of entries) {
    const manifest = path.join(dir, name, "plugin.json");
    if (!existsSync(manifest)) continue;
    try {
      const json = JSON.parse(await readFile(manifest, "utf8")) as {
        id?: string;
        kind?: string;
        description?: string;
      };
      if (json.kind === "skill") {
        lines.push(`- ${json.id ?? name}: ${json.description ?? ""}`);
      }
    } catch {
      /* skip broken plugin */
    }
  }
  return lines.join("\n");
}

function safeJson(raw: string): { command?: string } {
  try {
    return JSON.parse(raw) as { command?: string };
  } catch {
    return {};
  }
}
