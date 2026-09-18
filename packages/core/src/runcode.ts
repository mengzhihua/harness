import type { LocalFs, Subprocess } from "./runtime-local.ts";

export async function runSandboxedCode(opts: {
  language: string;
  code: string;
  fs: LocalFs;
  subprocess: Subprocess;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<string> {
  const language = normalizeLang(opts.language);
  if (!language) throw new Error(`unsupported run_code language: ${opts.language}`);
  if (!opts.code.trim()) throw new Error("run_code requires code");
  if (opts.code.length > 20_000) throw new Error("run_code snippet too large");
  const id = `snippet-${Date.now().toString(36)}`;
  const rel = `.harness/run/${id}.${language.ext}`;
  await opts.fs.writeFile(rel, opts.code);
  const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? 8_000, 100), 30_000);
  const result = await opts.subprocess.exec(`${language.bin} ${rel}`, {
    timeoutMs,
    signal: opts.signal,
    network: false,
  });
  return `exit ${result.exitCode}\nlanguage: ${language.id}\n--- stdout ---\n${result.stdout || "(empty)"}\n--- stderr ---\n${result.stderr}`;
}

function normalizeLang(raw: string): { id: "javascript" | "python"; bin: string; ext: string } | undefined {
  const v = raw.trim().toLowerCase();
  if (v === "js" || v === "javascript" || v === "node") return { id: "javascript", bin: "node", ext: "mjs" };
  if (v === "py" || v === "python" || v === "python3") return { id: "python", bin: "python3", ext: "py" };
  return undefined;
}
