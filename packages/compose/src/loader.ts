import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { Context } from "./context.ts";
import type { Plane, PluginFactory, PluginLock, PluginLockEntry, Profile, ProfilePackage } from "./types.ts";

export class Loader {
  private readonly registry = new Map<string, PluginFactory>();

  register(id: string, factory: PluginFactory): this {
    this.registry.set(id, factory);
    return this;
  }

  async mount(ctx: Context, profilePath: string, plane: Plane): Promise<void> {
    const profile = loadProfile(profilePath);
    for (const pkg of profile.packages) {
      if (pkg.plane !== plane) continue;
      const factory = this.registry.get(pkg.id);
      if (!factory) {
        throw new Error(`unknown package: ${pkg.id}`);
      }
      if (pkg.inject?.length) await ctx.inject(pkg.inject);
      await factory(ctx, pkg);
      recordLock(ctx, pkg);
    }
  }

  async await(ctx: Context): Promise<void> {
    // P1: mount() already refuses to start a half tree.
    void ctx;
  }

  lock(ctx: Context): PluginLock {
    return ctx.pluginLock();
  }
}

export function loadProfile(profilePath: string): Profile {
  const raw = parse(readFileSync(profilePath, "utf8")) as Profile;
  if (!raw?.packages?.length) throw new Error(`invalid profile: ${profilePath}`);
  return raw;
}

function recordLock(ctx: Context, pkg: ProfilePackage): void {
  const version = pkg.version ?? "0.1.0";
  const entry: PluginLockEntry = {
    id: pkg.id,
    version,
    plane: pkg.plane,
    hash: createHash("sha256").update(`${pkg.id}@${version}`).digest("hex").slice(0, 16),
  };
  const lock = ctx.own<PluginLock>("plugin_lock") ?? { packages: [] };
  lock.packages.push(entry);
  ctx.provide("plugin_lock", lock);
}
