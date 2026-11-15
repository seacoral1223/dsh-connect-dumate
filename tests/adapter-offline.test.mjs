// Offline test of the adapter's wire conversion + SSE decoding, against a stub dsh-llm
// and a fake OpenAI-compatible SSE server. Nothing here touches the real DuMate app.
import http from "node:http";
import assert from "node:assert/strict";
import { DuMateAdapter, toWireMessages, mapUsage } from "../lib/adapter.js";

const PORT = await new Promise(resolve => {
  const s = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunks = [
        { choices: [{ delta: { role: "assistant", reasoning_content: "thinking" } }] },
        { choices: [{ delta: { content: "Hel" } }] },
        { choices: [{ delta: { content: "lo" } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "pwsh", arguments: "{\"comm" } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "and\":\"ls\"}" } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 120, completion_tokens: 20, total_tokens: 140, completion_tokens_details: { reasoning_tokens: 5 } } },
      ];
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      globalThis.__lastBody = JSON.parse(body);
    });
  });
  s.listen(0, "127.0.0.1", () => resolve(s.address().port));
});

const models = [
  { key: "glm-5", displayName: "Glm-5", enabled: true, imageInput: false, contextInput: 1000000, output: 128000 },
  { key: "kimi-k3", displayName: "Kimi-K3", enabled: true, imageInput: true, contextInput: 1048576, output: 1048576 },
  { key: "internal-model", displayName: "x", enabled: false, imageInput: false },
];

// --- 1. message conversion
const wire = await toWireMessages({
  messages: [
    { role: "system", content: [{ type: "text", text: "sys prompt" }] },
    { role: "user", content: [{ type: "text", text: "hi" }, { type: "file", attachment: { name: "a.txt", bytes: 12 } }] },
    { role: "assistant", content: [{ type: "text", text: "calling" }, { type: "tool-call", id: "call_1", name: "pwsh", arguments: "{\"command\":\"ls\"}" }] },
    { role: "tool", toolCallId: "call_1", content: [{ type: "text", text: "tool output" }] },
    { role: "tool", toolCallId: "call_2", content: [{ type: "image", attachment: { attachmentId: "att1", mediaType: "image/png", bytes: 10, width: 2, height: 2 } }] },
    { role: "user", content: [{ type: "image", attachment: { attachmentId: "att2", mediaType: "image/png", bytes: 8, width: 1, height: 1 } }] },
  ],
  system: undefined,
  supportsImages: true,
  resolveImage: async ref => `data:image/png;base64,AAA:${ref.attachmentId}`,
});
assert.equal(wire[0].role, "system");
assert.equal(wire[0].content, "sys prompt");
assert.equal(wire[1].content[1].type, "text");   // file 投影成文字
assert.equal(wire[2].tool_calls[0].function.name, "pwsh");
assert.equal(wire[3].role, "tool");
assert.equal(wire[3].tool_call_id, "call_1");
assert.equal(wire[4].role, "tool");
assert.equal(wire[5].role, "user");               // 工具结果里的图另起 user
assert.equal(wire[5].content[1].image_url.url, "data:image/png;base64,AAA:att1");
assert.equal(wire[6].content[0].image_url.url, "data:image/png;base64,AAA:att2");

// 不支持图片的模型：图变成文字占位，绝不塞 image_url
const noImg = await toWireMessages({
  messages: [{ role: "user", content: [{ type: "image", attachment: { attachmentId: "x" } }] }],
  supportsImages: false,
  resolveImage: async () => "data:,",
});
assert.equal(typeof noImg[0].content, "string");

// --- 2. streaming chunks
const adapter = new DuMateAdapter({
  getState: async () => ({ baseURL: `http://127.0.0.1:${PORT}/v1`, models, imageInput: { "glm-5": false, "kimi-k3": true } }),
  resolveImage: async () => null,
});
const seen = [];
for await (const chunk of adapter.stream({ provider: "dumate", model: "kimi-k3", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })) {
  seen.push(chunk);
}
const types = seen.map(c => c.type);
assert.deepEqual(types.slice(0, 2), ["block-start", "reasoning-delta"]);
assert.ok(types.includes("tool-call-delta"));
assert.equal(types[types.length - 1], "finish");
assert.equal(types[types.length - 2], "usage");
const textBlocks = seen.filter(c => c.type === "block-end").map(c => c.block);
assert.ok(textBlocks.some(b => b.type === "reasoning" && b.text === "thinking"));
assert.ok(textBlocks.some(b => b.type === "text" && b.text === "Hello"));
assert.ok(textBlocks.some(b => b.type === "tool-call" && b.id === "call_1" && b.name === "pwsh" && b.arguments === '{"command":"ls"}'));
assert.deepEqual(seen.at(-1).reason, { kind: "tool-calls" });
assert.deepEqual(seen.at(-2).usage, { inputTokens: 120, outputTokens: 20, totalTokens: 140, reasoningTokens: 5 });
assert.equal(globalThis.__lastBody.model, "kimi-k3");
assert.equal(globalThis.__lastBody.stream, true);
assert.ok(Array.isArray(globalThis.__lastBody.messages));
assert.equal(globalThis.__lastBody.messages[0].role, "user");

// --- 3. catalog surface
const listed = await adapter.listModels("dumate");
assert.deepEqual(listed.map(m => m.id), ["glm-5", "kimi-k3"]);
assert.deepEqual(listed[1].inputModalities, ["text", "image"]);
const resolved = await adapter.resolveModel("dumate", "kimi-k3");
assert.equal(resolved.context.contextWindow, 1048576);
assert.equal(resolved.defaultMaxTokens, 32768);
// 目录里没有的模型**不能抛**：宿主 buildModelCatalog 对每个 provider 单独 try/catch，
// 抛错会把整组从选择器里抹掉。现在按保守值应答。
const ghost = await adapter.resolveModel("dumate", "nope");
assert.equal(ghost.id, "nope");
assert.ok(ghost.context.contextWindow > 0, "未知模型也要给出正整数上下文窗口");
assert.equal(ghost.name, "nope");
// 同理：一条都不启用时也不能返回空数组
const noneEnabled = new DuMateAdapter({
  getState: async () => ({ baseURL: "http://x/v1", models: models.map(m => ({ ...m, enabled: false })), imageInput: {} }),
  resolveImage: async () => null,
});
assert.ok((await noneEnabled.listModels("dumate")).length > 0, "全关时也要有兜底目录，否则整组被隐藏");
assert.equal(mapUsage({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens: 7 }).inputTokens, 60);

console.log("adapter offline test: PASS", `(${types.length} chunks, ${wire.length} wire msgs)`);

// 假 SSE server 不关掉会挂住进程
process.exit(0);