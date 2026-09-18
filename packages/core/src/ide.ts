import { execFile as execFileCb } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { renderWorkbench, WORKBENCH_FORK, workbenchCommands } from "@harness/ide";
import { LocalFs } from "./runtime-local.ts";

const execFile = promisify(execFileCb);

export type IdeCommandName = (typeof workbenchCommands)[number];

export function parseIdeCommand(cmd: string): IdeCommandName {
  if ((workbenchCommands as readonly string[]).includes(cmd)) return cmd as IdeCommandName;
  throw new Error(`unknown ide command ${cmd}`);
}

/** Parse TUI / REPL `/ide apply|undo|steer|open|tui`. */
export function parseIdeSlash(line: string): { cmd: IdeCommandName; text?: string; path?: string } {
  const raw = line.trim();
  if (raw !== "/ide" && !raw.startsWith("/ide ")) throw new Error("not an /ide command");
  const rest = raw.slice(4).trim();
  if (!rest) throw new Error("usage: /ide apply|undo|steer|open|tui");
  const space = rest.indexOf(" ");
  const cmd = parseIdeCommand(space === -1 ? rest : rest.slice(0, space));
  const arg = space === -1 ? "" : rest.slice(space + 1).trim();
  if (cmd === "steer") {
    if (!arg) throw new Error("steer requires text");
    return { cmd, text: arg };
  }
  if (cmd === "open") {
    if (!arg) throw new Error("open requires path");
    return { cmd, path: arg };
  }
  return { cmd };
}

export async function whichEditor(): Promise<string | undefined> {
  const raw = process.env.HARNESS_IDE;
  if (raw === "none" || raw === "off" || raw === "-") return undefined;
  const env = raw || process.env.VISUAL || process.env.EDITOR;
  if (env) return env;
  for (const bin of ["cursor", "code", "codium"]) {
    try {
      const { stdout } = await execFile("which", [bin]);
      const found = stdout.trim();
      if (found) return found;
    } catch {
      /* not on PATH */
    }
  }
  return undefined;
}

export async function ideStatus(agentRoot?: string): Promise<{
  editor?: string;
  worktree?: string;
  bridge: "harness-ide";
  fork: typeof WORKBENCH_FORK;
  workbench: true;
  commands: string[];
}> {
  return {
    editor: await whichEditor(),
    worktree: agentRoot,
    bridge: "harness-ide",
    fork: WORKBENCH_FORK,
    workbench: true,
    commands: [...workbenchCommands],
  };
}

export function ideWorkbench(opts?: { threadId?: string; worktree?: string }) {
  return renderWorkbench({ threadId: opts?.threadId, worktree: opts?.worktree });
}

export async function ideReadFile(opts: { worktree: string; path: string }): Promise<{
  ok: boolean;
  path: string;
  content: string;
}> {
  const fs = new LocalFs(opts.worktree);
  try {
    let content = await fs.readRaw(opts.path);
    if (content.length > 64_000) content = `${content.slice(0, 64_000)}\n…`;
    return { ok: true, path: opts.path, content };
  } catch (err) {
    return { ok: false, path: opts.path, content: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Open a file in the user's editor or the Harness IDE workbench.
 * Honors HARNESS_IDE, then cursor/code, then $VISUAL/$EDITOR. Fails closed if none.
 */
export async function openInIde(opts: { path: string; line?: number; cwd?: string }): Promise<IdeOpenResult> {
  const editor = await whichEditor();
  if (!editor) {
    return { ok: false, editor: "", command: "", message: "no editor (set HARNESS_IDE or install cursor/code)" };
  }
  const target = path.resolve(opts.cwd ?? process.cwd(), opts.path);
  if (!existsSync(target) && !existsSync(path.dirname(target))) {
    return { ok: false, editor, command: "", message: `path not found: ${target}` };
  }
  const args = gotoArgs(editor, target, opts.line);
  const command = `${editor} ${args.join(" ")}`;
  try {
    await execFile(editor, args, { cwd: opts.cwd, timeout: 8_000 });
    return { ok: true, editor, command, message: `opened ${target}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, editor, command, message };
  }
}

function gotoArgs(editor: string, file: string, line?: number): string[] {
  const base = path.basename(editor);
  if ((base === "code" || base === "cursor" || base === "codium") && line) return ["--goto", `${file}:${line}`];
  if (base === "code" || base === "cursor" || base === "codium") return ["--reuse-window", file];
  return line ? [`${file}:${line}`] : [file];
}
