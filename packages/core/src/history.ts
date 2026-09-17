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
    }
  }
  return msgs;
}

export function compactMessages(messages: ChatMessage[], maxChars = 80_000): ChatMessage[] {
  const total = messages.reduce((n, m) => n + m.content.length, 0);
  if (total <= maxChars || messages.length < 6) return messages;
  const system = messages.filter((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");
  const head = rest.slice(0, 2);
  const tail = rest.slice(-8);
  return [...system, ...head, { role: "user", content: "[compacted earlier steps; see trajectory]" }, ...tail];
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
