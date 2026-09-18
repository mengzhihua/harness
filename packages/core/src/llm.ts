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
}

export interface AssistantMessage {
  role: "assistant";
  content: string;
  tool_calls?: ToolCall[];
}

export interface Llm {
  chat(req: ChatRequest, signal?: AbortSignal): Promise<AssistantMessage>;
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
        return call("grep", { pattern: "password|passw0rd|login", glob: "**/*.{js,ts,mjs,cjs}" });
      }
      return say(
        "BRIEF:\ngoal: make login tests pass\nfiles: src/auth.js\nedit: replace passw0rd with password\ntest: node --test\nconstraints: do not touch unrelated files",
      );
    }

    if (testsPassed && (used.has("str_replace") || used.has("write_file"))) {
      return say("Login tests pass. The documented password is accepted. Ready to apply.");
    }

    if (!used.has("bash")) {
      return call("bash", { command: "node --test" });
    }

    if (blob.includes("passw0rd") && !used.has("str_replace")) {
      const file = extractSourcePath(blob) ?? "src/auth.js";
      return call("str_replace", { path: file, old_string: "passw0rd", new_string: "password" });
    }

    if (!used.has("grep") && !used.has("read_file") && !used.has("glob")) {
      return call("grep", { pattern: "password|passw0rd|login", glob: "**/*.{js,ts,mjs,cjs}" });
    }

    if (!used.has("read_file")) {
      const file = extractSourcePath(blob) ?? "src/auth.js";
      return call("read_file", { path: file });
    }

    if (used.has("str_replace") || used.has("write_file")) {
      return call("bash", { command: "node --test" });
    }

    if (blob.includes("passw0rd")) {
      const file = extractSourcePath(blob) ?? "src/auth.js";
      return call("str_replace", { path: file, old_string: "passw0rd", new_string: "password" });
    }

    return say("I could not find a failing assertion to fix.");
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
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`llm http ${res.status}: ${body.slice(0, 500)}`);
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: AssistantMessage }>;
    };
    const msg = json.choices?.[0]?.message;
    if (!msg) throw new Error("llm returned no message");
    return { role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls };
  }
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
