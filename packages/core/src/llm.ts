import type { ToolCall, ToolSchema } from "./tools.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools: ToolSchema[];
  /** Live tokens for TUI. Not written per-token to the trajectory. */
  onDelta?: (chunk: string) => void;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: string;
  tool_calls?: ToolCall[];
  usage?: TokenUsage;
}

export interface Llm {
  chat(req: ChatRequest, signal?: AbortSignal): Promise<AssistantMessage>;
}

export function estimateUsage(req: ChatRequest, reply: AssistantMessage): TokenUsage {
  const prompt = req.messages.reduce((n, m) => n + m.content.length, 0);
  const completion =
    (reply.content?.length ?? 0) +
    (reply.tool_calls?.reduce((n, c) => n + c.function.arguments.length + c.function.name.length, 0) ?? 0);
  return {
    prompt_tokens: Math.max(1, Math.ceil(prompt / 4)),
    completion_tokens: Math.max(1, Math.ceil(completion / 4)),
    cached_tokens: 0,
  };
}

function withUsage(req: ChatRequest, msg: AssistantMessage): AssistantMessage {
  return { ...msg, usage: msg.usage ?? estimateUsage(req, msg) };
}

function finish(req: ChatRequest, msg: AssistantMessage): AssistantMessage {
  if (req.onDelta) {
    if (msg.content) {
      for (let i = 0; i < msg.content.length; i += 24) req.onDelta(msg.content.slice(i, i + 24));
    } else {
      const call = msg.tool_calls?.[0];
      if (call) req.onDelta(`→ ${call.function.name} ${call.function.arguments.slice(0, 100)}\n`);
    }
  }
  return withUsage(req, msg);
}

export function createLlm(opts: { model: string; apiKey?: string; baseUrl?: string }): Llm {
  if (opts.model === "mock") return new MockLlm();
  if (!opts.apiKey) {
    throw new Error("OPENAI_API_KEY is required unless --model mock");
  }
  return new OpenAICompatLlm(opts.model, opts.baseUrl ?? "https://api.openai.com/v1", opts.apiKey);
}

export class MockLlm implements Llm {
  private n = 0;

  async chat(req: ChatRequest, signal?: AbortSignal): Promise<AssistantMessage> {
    this.n += 1;
    if (signal?.aborted) throw new Error("aborted");
    const turn = currentTurn(req.messages);
    const used = toolNames(turn);
    const blob = flatten(turn);
    const testsPassed = testPass(blob) && used.has("bash");

    if (/Fusion Lead/i.test(blob)) {
      if (!used.has("grep") && !used.has("read_file") && !used.has("glob")) {
        return finish(req, call("grep", { pattern: "password|passw0rd|login", glob: "**/*.{js,ts,mjs,cjs}" }));
      }
      return finish(
        req,
        say(
          "BRIEF:\ngoal: make login tests pass\nfiles: src/auth.js\nedit: replace passw0rd with password\ntest: node --test\nconstraints: do not touch unrelated files",
        ),
      );
    }

    if (testsPassed && (used.has("str_replace") || used.has("write_file"))) {
      return finish(req, say("Login tests pass. The documented password is accepted. Ready to apply."));
    }

    if (!used.has("bash")) {
      return finish(req, call("bash", { command: "node --test" }));
    }

    if (blob.includes("passw0rd") && !used.has("str_replace")) {
      const file = extractSourcePath(blob) ?? "src/auth.js";
      return finish(req, call("str_replace", { path: file, old_string: "passw0rd", new_string: "password" }));
    }

    if (!used.has("grep") && !used.has("read_file") && !used.has("glob")) {
      return finish(req, call("grep", { pattern: "password|passw0rd|login", glob: "**/*.{js,ts,mjs,cjs}" }));
    }

    if (!used.has("read_file")) {
      const file = extractSourcePath(blob) ?? "src/auth.js";
      return finish(req, call("read_file", { path: file }));
    }

    if (used.has("str_replace") || used.has("write_file")) {
      return finish(req, call("bash", { command: "node --test" }));
    }

    if (blob.includes("passw0rd")) {
      const file = extractSourcePath(blob) ?? "src/auth.js";
      return finish(req, call("str_replace", { path: file, old_string: "passw0rd", new_string: "password" }));
    }

    return finish(req, say("I could not find a failing assertion to fix."));
  }
}

export class OpenAICompatLlm implements Llm {
  constructor(
    private readonly model: string,
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async chat(req: ChatRequest, signal?: AbortSignal): Promise<AssistantMessage> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const res = await fetch(url, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: req.messages,
        tools: req.tools.length ? req.tools : undefined,
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`llm http ${res.status}: ${body.slice(0, 500)}`);
    }
    const ctype = res.headers.get("content-type") ?? "";
    if (!ctype.includes("text/event-stream") && !ctype.includes("text/plain")) {
      return this.parseJson(req, res);
    }
    return this.parseSse(req, res, signal);
  }

  private async parseJson(req: ChatRequest, res: Response): Promise<AssistantMessage> {
    const json = (await res.json()) as StreamPayload;
    const msg = json.choices?.[0]?.message;
    if (!msg) throw new Error("llm returned no message");
    const out: AssistantMessage = {
      role: "assistant",
      content: msg.content ?? "",
      tool_calls: msg.tool_calls,
      usage: usageOf(json.usage, req, msg),
    };
    return finish(req, out);
  }

  private async parseSse(req: ChatRequest, res: Response, signal?: AbortSignal): Promise<AssistantMessage> {
    if (!res.body) throw new Error("llm stream had no body");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let content = "";
    const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
    let usage: StreamPayload["usage"];
    let named = false;
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let json: StreamPayload;
        try {
          json = JSON.parse(data) as StreamPayload;
        } catch {
          continue;
        }
        if (json.usage) usage = json.usage;
        const delta = json.choices?.[0]?.delta ?? json.choices?.[0]?.message;
        if (!delta) continue;
        if (delta.content) {
          content += delta.content;
          req.onDelta?.(delta.content);
        }
        for (const tc of delta.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          const row = (toolCalls[idx] ??= { id: "", name: "", arguments: "" });
          if (tc.id) row.id = tc.id;
          if (tc.function?.name) {
            row.name += tc.function.name;
            if (!named) {
              named = true;
              req.onDelta?.(`→ ${row.name}\n`);
            }
          }
          if (tc.function?.arguments) row.arguments += tc.function.arguments;
        }
      }
    }
    if (signal?.aborted) throw new Error("aborted");
    const msg: AssistantMessage = {
      role: "assistant",
      content,
      tool_calls: toolCalls.length
        ? toolCalls.map((c) => ({
            id: c.id || `call_${c.name}`,
            type: "function",
            function: { name: c.name, arguments: c.arguments },
          }))
        : undefined,
    };
    msg.usage = usageOf(usage, req, msg);
    return msg;
  }
}

interface StreamPayload {
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
    };
    message?: AssistantMessage;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    prompt_cache_hit_tokens?: number;
  };
}

function usageOf(
  usage: StreamPayload["usage"],
  req: ChatRequest,
  msg: AssistantMessage,
): TokenUsage {
  const fallback = estimateUsage(req, msg);
  return {
    prompt_tokens: usage?.prompt_tokens ?? fallback.prompt_tokens,
    completion_tokens: usage?.completion_tokens ?? fallback.completion_tokens,
    cached_tokens: usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens ?? 0,
  };
}

function say(content: string): AssistantMessage {
  return { role: "assistant", content };
}

function call(name: string, args: Record<string, unknown>): AssistantMessage {
  return {
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: `call_${name}_${Math.random().toString(36).slice(2, 8)}`,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}

function currentTurn(messages: ChatMessage[]): ChatMessage[] {
  let idx = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === "user" && !m.content.startsWith("[steer]")) idx = i;
  }
  return messages.slice(idx);
}

function flatten(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      const tools = m.tool_calls?.map((c) => `${c.function.name}:${c.function.arguments}`).join("\n") ?? "";
      return `${m.role}\n${m.content}\n${tools}`;
    })
    .join("\n");
}

function toolNames(messages: ChatMessage[]): Set<string> {
  const used = new Set<string>();
  for (const m of messages) {
    for (const c of m.tool_calls ?? []) used.add(c.function.name);
  }
  return used;
}

function testPass(blob: string): boolean {
  if (/#\s*fail\s+0\b/.test(blob) && /#\s*pass\s+[1-9]/.test(blob)) return true;
  if (/ℹ\s+fail\s+0/.test(blob) && /ℹ\s+pass\s+[1-9]/.test(blob)) return true;
  if (/tests?\s+passed/i.test(blob) && !/#\s*fail\s+[1-9]/.test(blob)) return true;
  return false;
}

function extractSourcePath(blob: string): string | undefined {
  const fromGrep = blob.match(/((?:src|lib|app)\/[A-Za-z0-9_./-]+\.(?:js|ts|mjs|cjs)):\d+/);
  if (fromGrep) return fromGrep[1];
  const any = blob.match(/\b((?:src|lib|app)\/[A-Za-z0-9_./-]+\.(?:js|ts|mjs|cjs))\b/);
  return any?.[1];
}
