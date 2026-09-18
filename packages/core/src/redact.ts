import { createHash } from "node:crypto";

const SECRET =
  /sk-[A-Za-z0-9_-]{10,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN [A-Z ]+PRIVATE KEY-----/g;

export function redactSecrets<T>(value: T): T {
  if (typeof value === "string") return value.replace(SECRET, "[redacted]") as T;
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/api[_-]?key|secret|token|authorization|private[_-]?key/i.test(k) && typeof v === "string" && v.length > 4) {
        out[k] = "[redacted]";
      } else {
        out[k] = redactSecrets(v);
      }
    }
    return out as T;
  }
  return value;
}

export function envHash(): string {
  const blob = `${process.platform}|${process.version}|${process.env.SHELL ?? ""}|${process.env.HOME ?? ""}`;
  return createHash("sha256").update(blob).digest("hex").slice(0, 16);
}
