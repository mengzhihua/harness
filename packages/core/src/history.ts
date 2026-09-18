import type { ChatMessage } from "./llm.ts";
import type { ToolCall } from "./tools.ts";
import type { TrajEvent } from "./traj.ts";

export function applyRewinds(events: TrajEvent[]): TrajEvent[] {
  const rewinds = events.filter((e) => e.type === "rewind");
  const last = rewinds.at(-1);
  if (!last) return events;
  const id = (last.payload as { id?: string }).id;
  if (!id) return events;
  const idx = events.findIndex(
    (e) => e.type === "checkpoint/created" && (e.payload as { id?: string }).id === id,
  );
  if (idx < 0) return events;
  return events.slice(0, idx + 1);
}

export function projectMessages(events: TrajEvent[]): ChatMessage[] {
  const visible = applyRewinds(events);
  const msgs: ChatMessage[] = [];
  for (const e of visible) {
    if (e.type === "turn/start") {
      const prompt = (e.payload as { prompt?: string }).prompt ?? "";
      msgs.push({ role: "user", content: prompt });
    } else if (e.type === "steer") {
      const text = (e.payload as { text?: string }).text ?? "";
      msgs.push({ role: "user", content: `[steer] ${text}` });
    } else if (e.type === "step") {
      const p = e.payload as {
        content?: string;
        tool_calls?: Array<{ id: string; name: string; arguments: string }>;
      };
      const tool_calls: ToolCall[] | undefined = p.tool_calls?.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: c.arguments },
      }));
      msgs.push({ role: "assistant", content: p.content ?? "", tool_calls });
    } else if (e.type === "tool_result") {
      const p = e.payload as { callId?: string; name?: string; content?: string };
      msgs.push({
        role: "tool",
        tool_call_id: p.callId,
        name: p.name,
        content: p.content ?? "",
      });
    } else if (e.type === "verify_nudge") {
      msgs.push({ role: "user", content: (e.payload as { text?: string }).text ?? "[verify]" });
    } else if (e.type === "check_nudge") {
      msgs.push({ role: "user", content: (e.payload as { text?: string }).text ?? "[check]" });
    } else if (e.type === "done_report") {
      const d = e.payload as {
        changed_files?: string[];
        apply_ready?: boolean;
        checks?: Array<{ cmd?: string; exit_code?: number }>;
        message?: string;
      };
      const last = d.checks?.at(-1);
      const check = last ? `${last.cmd ?? "check"} exit ${last.exit_code}` : "no checks";
      msgs.push({
        role: "user",
        content: `[done] files=${(d.changed_files ?? []).join(",") || "-"} apply_ready=${d.apply_ready} ${check}`,
      });
    } else if (e.type === "compact") {
      msgs.push({
        role: "user",
        content:
          (e.payload as { text?: string }).text ??
          "[compacted earlier steps; kept plan, recent steps, latest checks. see trajectory]",
      });
    }
  }
  return msgs;
}

export function compactMessages(messages: ChatMessage[], maxChars = 80_000): ChatMessage[] {
  const total = messages.reduce((n, m) => n + m.content.length, 0);
  if (total <= maxChars || messages.length < 6) return messages;
  const system = messages.filter((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");
  const keep = new Set<number>();
  for (let i = 0; i < Math.min(2, rest.length); i++) keep.add(i);
  for (let i = Math.max(0, rest.length - 8); i < rest.length; i++) keep.add(i);
  for (let i = 0; i < rest.length; i++) {
    if (keep.has(i)) continue;
    const m = rest[i]!;
    const c = m.content ?? "";
    if (m.role === "tool" && (m.name === "bash" || /exit \-?\d+/.test(c))) keep.add(i);
    else if (/\[verify\]|\[check\]|## plan|\[done\]/.test(c)) keep.add(i);
  }
  const pinned = [...keep].sort((a, b) => a - b).map((i) => rest[i]!);
  const note: ChatMessage = {
    role: "user",
    content: "[compacted earlier steps; kept plan, recent steps, latest checks. see trajectory]",
  };
  const head = Math.min(2, pinned.length);
  return [...system, ...pinned.slice(0, head), note, ...pinned.slice(head)];
}

export function modelVisibleSubsetOfTraj(messages: ChatMessage[], events: TrajEvent[]): boolean {
  const projected = projectMessages(events);
  const conv = messages.filter((m) => m.role !== "system");
  if (conv.length > projected.length) return false;
  for (let i = 0; i < conv.length; i++) {
    if (conv[i]!.role !== projected[i]!.role) return false;
    if ((conv[i]!.content ?? "") !== (projected[i]!.content ?? "")) return false;
  }
  return true;
}

/** True when `next` is `prev` plus zero or more trailing messages (prefix-stable assemble). */
export function messagesArePrefix(prev: ChatMessage[], next: ChatMessage[]): boolean {
  if (next.length < prev.length) return false;
  for (let i = 0; i < prev.length; i++) {
    if (prev[i]!.role !== next[i]!.role) return false;
    if ((prev[i]!.content ?? "") !== (next[i]!.content ?? "")) return false;
  }
  return true;
}
