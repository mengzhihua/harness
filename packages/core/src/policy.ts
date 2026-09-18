export type Verdict = "allow" | "deny" | "ask";

export interface GateRequest {
  name: string;
  args: Record<string, unknown>;
  deny: boolean;
  reason?: string;
  audit?: boolean;
}

export interface PolicyOptions {
  mode: "ask" | "plan" | "agent";
  yolo: boolean;
  unattended?: boolean;
  approver?: (req: GateRequest, reason: string) => Promise<"allow" | "deny" | "allow_session">;
}

const READ = new Set(["read_file", "grep", "glob"]);
const WRITE = new Set(["str_replace", "write_file"]);

export class Policy {
  readonly memory = new Map<string, "allow" | "deny">();
  approver?: PolicyOptions["approver"];

  constructor(private readonly opts: PolicyOptions) {
    this.approver = opts.approver;
  }

  async gate(req: GateRequest): Promise<GateRequest> {
    const { verdict, reason, signature } = this.decide(req);
    const remembered = this.memory.get(signature);
    if (remembered === "allow") return req;
    if (remembered === "deny") return { ...req, deny: true, reason: reason ?? "remembered deny" };

    if (verdict === "allow") return req;
    if (verdict === "deny") {
      return { ...req, deny: true, reason };
    }

    if (this.opts.unattended && isAskOnceSignature(signature)) {
      this.memory.set(signature, "allow");
      return { ...req, audit: true, reason };
    }

    if (this.opts.yolo) {
      this.memory.set(signature, "allow");
      return req;
    }
    if (this.approver) {
      const answer = await this.approver(req, reason ?? "approval required");
      if (answer === "allow_session") {
        this.memory.set(signature, "allow");
        return req;
      }
      if (answer === "deny") {
        this.memory.set(signature, "deny");
        return { ...req, deny: true, reason };
      }
      if (answer === "allow") return req;
    }
    return { ...req, deny: true, reason: `${reason} (not interactive; pass --yolo to allow this class)` };
  }

  decide(req: GateRequest): { verdict: Verdict; reason: string; signature: string } {
    const name = req.name;
    const args = req.args;
    const signature = `${name}:${stable(args)}`;

    if (
      this.opts.mode === "ask" &&
      (WRITE.has(name) || name === "bash" || name === "delegate" || name === "fusion" || name === "browser" || name === "web_search" || name === "web_fetch" || name === "ask_user")
    ) {
      return { verdict: "deny", reason: "ask mode is read-only", signature };
    }
    if (this.opts.mode === "plan" && WRITE.has(name)) {
      return { verdict: "deny", reason: "plan mode cannot edit files", signature };
    }
    if (this.opts.mode === "plan" && (name === "delegate" || name === "fusion" || name === "browser" || name === "web_search" || name === "web_fetch" || name === "ask_user")) {
      return { verdict: "deny", reason: `${name} is agent-mode only`, signature };
    }
    if (this.opts.mode === "plan" && name === "bash" && !isCheckCommand(String(args.command ?? ""))) {
      return { verdict: "deny", reason: "plan mode only allows inspection commands", signature };
    }

    if (READ.has(name) || name === "update_plan") {
      return { verdict: "allow", reason: "read", signature };
    }

    if (WRITE.has(name)) {
      return { verdict: "allow", reason: "workspace write", signature };
    }

    if (name === "delegate" || name === "fusion") {
      return { verdict: "allow", reason: "workspace delegate", signature };
    }

    if (name === "browser") {
      const action = String(args.action ?? "");
      if (action === "navigate") {
        return { verdict: "ask", reason: "browser network", signature: "browser:navigate" };
      }
      return { verdict: "allow", reason: "browser", signature };
    }

    if (name === "web_search" || name === "web_fetch") {
      return { verdict: "ask", reason: "outbound network", signature: "web:net" };
    }

    if (name === "ask_user") {
      if (this.opts.unattended) {
        return { verdict: "deny", reason: "ask_user is not available unattended", signature: "ask_user" };
      }
      return { verdict: "ask", reason: "ask the user", signature: `ask_user:${String(args.question ?? "")}` };
    }

    if (name === "bash") {
      const cmd = String(args.command ?? "");
      if (isDeniedCommand(cmd)) {
        return { verdict: "deny", reason: "dangerous command", signature: `bash:${cmd}` };
      }
      if (isAlwaysAsk(cmd)) {
        return { verdict: "ask", reason: "destructive or secret path", signature: `bash:${cmd}` };
      }
      if (isAskOnce(cmd)) {
        return { verdict: "ask", reason: "network / install / push", signature: `bash:${normalizeAsk(cmd)}` };
      }
      return { verdict: "allow", reason: "workspace command", signature: `bash:${cmd}` };
    }

    return { verdict: "allow", reason: "plugin tool", signature };
  }
}

export function isCheckCommand(cmd: string): boolean {
  return /\b(test|lint|fmt|format|build|typecheck|tsc|jest|vitest|mocha|pytest|eslint|prettier)\b/i.test(cmd);
}

function isDeniedCommand(cmd: string): boolean {
  return /\/etc\/shadow|OPENAI_API_KEY|HARNESS_API|\.ssh\/id_|\bmkfs\b/i.test(cmd);
}

function isAlwaysAsk(cmd: string): boolean {
  return /\brm\s+(-[a-zA-Z]*f|\s).*(-[a-zA-Z]*r|\/\s|$)|git\s+push\s+.*--force|\brebase\s+-i\b|\.env\b/i.test(cmd);
}

function isAskOnce(cmd: string): boolean {
  return /\b(curl|wget|npm\s+i|npm\s+install|pnpm\s+add|pip\s+install|git\s+push)\b/i.test(cmd);
}

function isAskOnceSignature(signature: string): boolean {
  return (
    signature === "bash:net" ||
    signature === "bash:install" ||
    signature === "bash:push" ||
    signature === "browser:navigate" ||
    signature === "web:net"
  );
}

function normalizeAsk(cmd: string): string {
  if (/\bcurl\b|\bwget\b/i.test(cmd)) return "net";
  if (/\bnpm\s+i|\bnpm\s+install|\bpnpm\s+add|\bpip\s+install/i.test(cmd)) return "install";
  if (/\bgit\s+push/i.test(cmd)) return "push";
  return cmd;
}

function stable(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}
