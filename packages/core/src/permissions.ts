export type PluginFsScope = "workspace" | "host";

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

function omitUndefined<T extends Record<string, unknown> | undefined>(value: T): Partial<T> {
  if (!value) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}
