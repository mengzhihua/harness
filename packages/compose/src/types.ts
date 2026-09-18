export type Plane = "host" | "isolate";

export interface PluginLockEntry {
  id: string;
  version: string;
  plane: Plane;
  hash: string;
  enabled?: boolean;
}

export interface PluginLock {
  packages: PluginLockEntry[];
}

export interface ProfilePackage {
  id: string;
  plane: Plane;
  version?: string;
  inject?: string[];
}

export interface Profile {
  packages: ProfilePackage[];
}

export type PluginFactory = (ctx: import("./context.ts").Context, pkg: ProfilePackage) => Promise<void> | void;

export type WaterfallHandler<T> = (payload: T) => T | Promise<T>;
