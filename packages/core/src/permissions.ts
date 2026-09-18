export type PluginFsScope = "workspace" | "host";

export type PluginOrigin = "official" | "project" | "local" | "remote";

export interface PluginPermissions {
  network: boolean;
  secrets: boolean;
  subprocess: boolean;
  fs: PluginFsScope;
}

export interface PluginPermissionInput {
  network?: boolean;
  secrets?: boolean;
  subprocess?: boolean;
  fs?: PluginFsScope;
}

export type PluginNeed = "network" | "secrets" | "subprocess" | "host-fs";

const SECRET_ENV = /(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|AUTHORIZATION|PRIVATE[_-]?KEY|CREDENTIAL)/i;
const SECRET_VALUE = /^(sk-|ghp_|github_pat_|AKIA)/;
const PATH_KEYS = ["path", "file", "cwd", "target", "dir"];

export function defaultPermissions(kind: string): PluginPermissions {
  if (kind === "mcp" || kind === "command" || kind === "tool") {
    return { network: false, secrets: false, subprocess: true, fs: "workspace" };
  }
  if (kind === "adapter") {
    return { network: false, secrets: false, subprocess: false, fs: "workspace" };
  }
  return { network: false, secrets: false, subprocess: false, fs: "workspace" };
}

export function normalizePermissions(kind: string, declared?: PluginPermissionInput): PluginPermissions {
  return { ...defaultPermissions(kind), ...omitUndefined(declared) };
}

export function missingPermission(perms: PluginPermissions, need: PluginNeed): PluginNeed | undefined {
  if (need === "network" && !perms.network) return "network";
  if (need === "secrets" && !perms.secrets) return "secrets";
  if (need === "subprocess" && !perms.subprocess) return "subprocess";
  if (need === "host-fs" && perms.fs !== "host") return "host-fs";
  return undefined;
}

export function isOfficialPluginId(id: string): boolean {
  return id.startsWith("@harness/") || id.startsWith("harness.");
}

export function inferPluginOrigin(id: string, declared?: string): PluginOrigin {
  if (declared === "official" || declared === "project" || declared === "local" || declared === "remote") {
    return declared;
  }
  if (isOfficialPluginId(id)) return "official";
  return "project";
}

export function isSecretEnvKey(key: string): boolean {
  return SECRET_ENV.test(key);
}

/** Classify what a plugin tool call needs so undeclared capabilities fail closed. */
export function inferPluginNeed(name: string, args: Record<string, unknown> = {}): PluginNeed | undefined {
  if (looksLikeSecretArgs(args)) return "secrets";
  if (name === "web_search" || name === "web_fetch" || name === "browser") return "network";
  if (name === "bash") {
    const cmd = String(args.command ?? "");
    if (/\b(curl|wget|npm\s+i|pnpm\s+add|pip\s+install)\b/i.test(cmd)) return "network";
  }
  const url = String(args.url ?? "");
  if (/^https?:\/\//i.test(url)) return "network";
  if (pathEscapesWorkspace(args)) return "host-fs";
  return undefined;
}

export function pathEscapesWorkspace(args: Record<string, unknown>): boolean {
  for (const key of PATH_KEYS) {
    const v = args[key];
    if (typeof v !== "string" || !v) continue;
    if (v.startsWith("/") || /^[A-Za-z]:[\\/]/.test(v)) return true;
    if (v.split(/[\\/]/).includes("..")) return true;
  }
  return false;
}

function looksLikeSecretArgs(args: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(args)) {
    if (isSecretEnvKey(k)) return true;
    if (typeof v === "string" && SECRET_VALUE.test(v)) return true;
  }
  return false;
}

/** Env passed to plugin subprocesses. Secrets stay out unless permissions.secrets is true. */
export function pluginEnv(perms: PluginPermissions, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue;
    if (!perms.secrets && isSecretEnvKey(k)) continue;
    out[k] = v;
  }
  return out;
}

function omitUndefined<T extends Record<string, unknown> | undefined>(value: T): Partial<T> {
  if (!value) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}
