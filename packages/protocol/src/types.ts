export const PROTOCOL_VERSION = "0.27.0";

export interface InboxSnapshot {
  queued: string[];
  consumed?: string;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export interface InitializeParams {
  cwd: string;
  harnessHome?: string;
  model?: string;
  mode?: "ask" | "plan" | "agent";
  profile?: string;
  inPlace?: boolean;
  yolo?: boolean;
  exec?: "local" | "docker";
  dockerImage?: string;
  network?: boolean;
  unattended?: boolean;
  cloud?: boolean;
  language?: string;
  leadModel?: string;
  sidekickModel?: string;
}

export interface InitializeResult {
  protocolVersion: string;
  serverName: string;
}

export interface ThreadSummary {
  threadId: string;
  title: string;
  model: string;
  startedAt: string;
  userRoot: string;
  parentThreadId?: string;
}
