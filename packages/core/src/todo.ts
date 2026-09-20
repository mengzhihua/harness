import type { Context } from "@harness/compose";
import type { TrajStore } from "./traj.ts";

export type TodoStatus = "pending" | "in_progress" | "done" | "cancelled";

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

export function normalizeTodos(items: unknown): TodoItem[] {
  if (!Array.isArray(items)) return [];
  return items.map((raw, i) => {
    const rec = raw as Partial<TodoItem> & { content?: unknown; title?: unknown };
    const status: TodoStatus =
      rec.status === "done" || rec.status === "cancelled" || rec.status === "in_progress" ? rec.status : "pending";
    const content = String(rec.content ?? rec.title ?? "").trim();
    return { id: String(rec.id ?? i + 1), content, status };
  }).filter((t) => t.content);
}

export function formatTodos(items: TodoItem[] | undefined): string {
  if (!items?.length) return "";
  const mark = (s: TodoStatus) => (s === "done" ? "x" : s === "cancelled" ? "-" : s === "in_progress" ? "*" : " ");
  return items.map((t) => `- [${mark(t.status)}] ${t.id} ${t.content}`).join("\n");
}

export function currentTodos(ctx: Context): TodoItem[] {
  return ctx.has("todos") ? ctx.get<TodoItem[]>("todos") : [];
}

export async function setTodos(
  ctx: Context,
  items: TodoItem[],
  source: "user" | "model" = "model",
): Promise<{ todos: TodoItem[] }> {
  const todos = normalizeTodos(items);
  ctx.provide("todos", todos);
  await ctx.get<TrajStore>("traj").append("assistant", "todo/updated", { todos, source });
  return { todos };
}
