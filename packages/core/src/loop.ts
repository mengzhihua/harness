import type { Context } from "@harness/compose";
import type { HarnessConfig } from "./config.ts";
import type { ChatMessage } from "./llm.ts";
import type { Llm } from "./llm.ts";
import type { ToolRouter } from "./tools.ts";
import type { TrajStore } from "./traj.ts";
import type { Workspace } from "./workspace.ts";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface TurnInput {
  prompt: string;
  onEvent?: (line: string) => void;
}

export interface DoneReport {
  changed_files: string[];
  checks: Array<{ cmd: string; exit_code: number; summary: string }>;
  residual_risks: string[];
  apply_ready: boolean;
  checkpoint?: string;
  message: string;
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

    await traj.append("user", "turn/start", { prompt: input.prompt, mode: config.mode });
    emit(`turn/start  thread=${ctx.name}`);

    const messages = await assemble(ctx, input.prompt);
    await traj.append("system", "prompt/assemble", {
      roles: messages.map((m) => m.role),
      chars: messages.reduce((n, m) => n + m.content.length, 0),
    });

    const checks: DoneReport["checks"] = [];
    let lastAssistant = "";

    for (let step = 0; step < config.maxSteps; step++) {
      emit(`step ${step + 1}`);
      const reply = await llm.chat({ model: config.model, messages, tools: tools.schemas() });
      lastAssistant = reply.content ?? "";
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

      if (!reply.tool_calls?.length) break;

      for (const call of reply.tool_calls) {
        emit(`  ${call.function.name} ${call.function.arguments}`);
        const result = await tools.execute(call);
        if (call.function.name === "bash") {
          const exit = /exit (\-?\d+)/.exec(result.content);
          checks.push({
            cmd: safeJson(call.function.arguments).command ?? "bash",
            exit_code: exit ? Number(exit[1]) : result.ok ? 0 : 1,
            summary: result.content.slice(0, 400),
          });
        }
        await traj.append("tool", "tool_result", {
          callId: result.callId,
          name: result.name,
          ok: result.ok,
          content: result.content.slice(0, 4000),
        });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.function.name,
          content: result.content,
        });
      }
    }

    const diff = await workspace.listDiff();
    const checkpoint = await workspace.checkpoint("turn-end");
    await traj.append("checkpoint", "checkpoint/created", { id: checkpoint, files: diff.files });

    const lastCheck = checks.at(-1);
    const lastFailed = lastCheck ? lastCheck.exit_code !== 0 : checks.length === 0;
    const done: DoneReport = {
      changed_files: diff.files,
      checks,
      residual_risks: lastFailed ? ["last checks still failing"] : [],
      apply_ready: diff.files.length > 0 && !lastFailed && !!lastCheck,
      checkpoint,
      message: lastAssistant || (diff.files.length ? `changed ${diff.files.join(", ")}` : "no file changes"),
    };
    await traj.append("system", "done_report", done);
    await traj.append("system", "turn/end", { apply_ready: done.apply_ready });
    emit(`done  files=${done.changed_files.join(",") || "-"}  apply_ready=${done.apply_ready}`);
    return { done, threadId: ctx.name, trajDir: traj.dir };
  }
}

async function assemble(ctx: Context, prompt: string): Promise<ChatMessage[]> {
  const config = ctx.get<HarnessConfig>("config");
  const workspace = ctx.get<Workspace>("workspace");
  const dirty = await workspace.userDirty();
  const agentsMd = await readIfExists(path.join(workspace.agentRoot, "AGENTS.md"));
  const skills = await loadProjectSkills(workspace.userRoot);

  const system = [
    "You are a coding agent running inside Harness.",
    "Fix the user's request with small diffs. Do not touch unrelated files.",
    "You MUST run the relevant tests or commands and use that output as evidence.",
    "Work only in the AgentWorkspace. The user's original directory may be dirty — never write there.",
    "Prefer read_file / grep / glob / str_replace / bash. Do not call apply or undo; those are user commands.",
    "",
    "## environment_context",
    `mode: ${config.mode}`,
    `model: ${config.model}`,
    `user cwd: ${workspace.userRoot}`,
    `agent cwd: ${workspace.agentRoot} (${workspace.kind})`,
    dirty ? `user tree is dirty:\n${dirty}\nDo not modify those files in the user tree.` : "user tree is clean.",
    agentsMd ? `\n## project docs (AGENTS.md)\n${agentsMd}` : "",
    skills ? `\n## skills\n${skills}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: prompt },
  ];
}

async function readIfExists(file: string): Promise<string> {
  if (!existsSync(file)) return "";
  return readFile(file, "utf8");
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
