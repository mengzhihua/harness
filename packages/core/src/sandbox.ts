export type ExecProvider = "local" | "docker" | "remote";

const SECRET_KEY = /(?:^|_)(API_KEY|ACCESS_TOKEN|SECRET|PASSWORD|TOKEN)$/i;

export function stripSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key.startsWith("NODE_TEST")) continue;
    if (SECRET_KEY.test(key) || /API_KEY|SECRET_KEY/.test(key)) continue;
    out[key] = value;
  }
  return out;
}

/** Point HTTP(S) at a closed port so "network off" still works without CAP_NET_ADMIN. */
export const NETWORK_SINK = "http://127.0.0.1:1";

export function applyNetworkSink(env: NodeJS.ProcessEnv, network: boolean): NodeJS.ProcessEnv {
  if (network) return env;
  env.HTTP_PROXY = NETWORK_SINK;
  env.HTTPS_PROXY = NETWORK_SINK;
  env.ALL_PROXY = NETWORK_SINK;
  env.FTP_PROXY = NETWORK_SINK;
  env.http_proxy = NETWORK_SINK;
  env.https_proxy = NETWORK_SINK;
  env.all_proxy = NETWORK_SINK;
  env.ftp_proxy = NETWORK_SINK;
  env.NO_PROXY = "";
  env.no_proxy = "";
  return env;
}

export function sandboxEnv(network: boolean): NodeJS.ProcessEnv {
  return applyNetworkSink(stripSecrets({ ...process.env }), network);
}

export function sandboxInstructions(opts: {
  exec: ExecProvider;
  network: boolean;
  image?: string;
}): string {
  const net = opts.network
    ? "on"
    : "off (HTTP(S)_PROXY sink; docker --network none; unshare -n when permitted)";
  const exec =
    opts.exec === "docker"
      ? `docker image=${opts.image ?? "node:22-bookworm"}`
      : opts.exec === "remote"
        ? "remote worker"
        : "local";
  return [
    "## sandbox / permissions",
    `exec: ${exec}`,
    `network: ${net}`,
    "writes confined to AgentWorkspace; path escape is denied",
    "inference API keys are stripped from the agent subprocess environment",
  ].join("\n");
}
