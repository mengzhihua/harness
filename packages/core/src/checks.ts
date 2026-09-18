import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

const KNOWN = /\b(node --test|pnpm test|npm test|yarn test|pytest|mvn test|go test)\b/;

/** Test command from AGENTS.md or a lockfile. Never hardcode a default into the loop. */
export async function detectCheckCommand(agentRoot: string): Promise<string | undefined> {
  const agents = path.join(agentRoot, "AGENTS.md");
  if (existsSync(agents)) {
    const body = await readFile(agents, "utf8");
    const tick = body.match(/`((?:pnpm|npm|yarn|node|pytest|mvn|go)[^`]+)`/);
    if (tick) return tick[1]!.trim();
    const known = body.match(KNOWN);
    if (known) return known[1];
  }
  if (existsSync(path.join(agentRoot, "package.json"))) return "node --test";
  if (existsSync(path.join(agentRoot, "pyproject.toml")) || existsSync(path.join(agentRoot, "pytest.ini"))) {
    return "pytest";
  }
  return undefined;
}
