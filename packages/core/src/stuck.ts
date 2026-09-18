export function humanizeStuck(opts: { cmd: string; exit_code: number; summary: string }): string | undefined {
  const blob = `${opts.cmd}\n${opts.summary}`;
  if (opts.exit_code === 127 || /not found|ENOENT|command not found/i.test(blob)) {
    return `can't run \`${opts.cmd}\`: command missing. Install it, or tell harness the real test command in AGENTS.md.`;
  }
  if (opts.exit_code === 126 || /EACCES|permission denied/i.test(blob)) {
    return `can't run \`${opts.cmd}\`: permission denied. Check file mode or run a different command.`;
  }
  if (opts.exit_code !== 0 && /ECONNREFUSED|ENETUNREACH|network is unreachable/i.test(blob)) {
    return `can't run \`${opts.cmd}\`: network blocked (agent net is off unless --network).`;
  }
  return undefined;
}
