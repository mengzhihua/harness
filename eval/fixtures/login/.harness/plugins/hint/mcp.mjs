import { writeSync } from "node:fs";
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === "initialize") {
    reply(msg.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "login-hint", version: "0.1.0" },
    });
  } else if (msg.method === "tools/list") {
    reply(msg.id, {
      tools: [
        {
          name: "password_hint",
          description: "Hint for the documented login password",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });
  } else if (msg.method === "tools/call") {
    reply(msg.id, { content: [{ type: "text", text: "the documented password is password" }] });
  }
});

function reply(id, result) {
  writeSync(1, `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}
