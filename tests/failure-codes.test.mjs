// 失败码与重试策略的用例。
//
// 为什么要单独钉：dsh-llm-retry 是按 failure.code 判断能不能退避重试的，
// 而 code 必须来自 dsh-llm `src/error.ts` 的 LLM_FAILURE_CODES 那张表。
// v0.5 写的是 RATE_LIMITED / UPSTREAM_ERROR —— 不在表里，于是搭子一句 429
// 就把一整轮对话判死（2026-11-15 实测撞在这个上）。
//
// 表里的名字抄自安装版：app.asar/dsh/node_modules/@deepseek-ai/dsh-llm/src/error.ts
// DSH 升级后如果改名，这个测试会告诉我们哪些码失效了。
import http from "node:http";
import assert from "node:assert/strict";
import { DuMateAdapter, readableFailure, failureFromResponse } from "../lib/adapter.js";

const OFFICIAL_CODES = new Set([
  "ABORTED", "ACCOUNT_QUOTA", "ACCOUNT_SIGN_IN_REQUIRED", "ACCOUNT_TOKEN_INVALID", "AUTH",
  "CLIENT_UPGRADE_REQUIRED", "CONTEXT_WINDOW_EXCEEDED", "DISCOVERY_FAILED", "DISCOVERY_UNSUPPORTED",
  "DUPLICATE_ADAPTER", "DUPLICATE_DIRECTORY", "DUPLICATE_DISCOVERY", "EMPTY_RESPONSE", "FILES_API",
  "IMAGE_OFFLOAD_REQUIRED", "INVALID_ADAPTER", "INVALID_CATALOG", "INVALID_CONFIG", "INVALID_CREDENTIAL",
  "INVALID_DIRECTORY", "INVALID_DISCOVERY", "INVALID_MODEL_CONTEXT", "INVALID_MODEL_INFO",
  "INVALID_MODEL_MAX_TOKENS", "INVALID_MODEL_REASONING", "INVALID_PREPARED_CALL", "INVALID_REPLAY_STATE",
  "INVALID_REQUEST", "INVALID_RESPONSE", "MALFORMED_RESPONSE", "MISSING_CREDENTIAL", "MODEL_SWITCH_COMPACTION_FAILED",
  "MODEL_UNSUPPORTED", "NO_ADAPTER", "NO_CREDENTIAL_STORE", "NO_DISCOVERY", "PI_AI_ERROR", "QUOTA",
  "RATE_LIMIT", "REGISTRATION_DISPOSED", "REQUEST_EXTENSION", "REQUEST_HEADERS", "SERVER", "STREAM_CLOSED",
  "TIMEOUT", "TRANSPORT", "UNKNOWN", "UNKNOWN_MODEL", "UNSTORABLE_PROVIDER_ID", "UNSUPPORTED_CONTENT",
  "UNSUPPORTED_OPTION", "UNSUPPORTED_REASONING_EFFORT",
]);

const models = [{ key: "glm-5", displayName: "glm-5", enabled: true, imageInput: false, contextInput: 1000000, output: 128000 }];

const servers = [];
function serverFor(status, headers = {}, body) {
  const srv = http.createServer((req, res) => {
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, String(v));
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(body ?? JSON.stringify({
      error: { code: "user_rate_limit_exceeded", message: "user_rate_limit_exceeded. 用户级限流", type: "rate_limit_exceeded" },
      gd_id: "gd-kti85v6758",
    }));
  });
  return new Promise(resolve => {
    servers.push(srv);
    srv.listen(0, "127.0.0.1", () => {
      resolve({
        srv,
        adapter: new DuMateAdapter({
          getState: async () => ({ baseURL: `http://127.0.0.1:${srv.address().port}/v1`, authHeader: {}, models, imageInput: {} }),
          resolveImage: async () => null,
        }),
      });
    });
  });
}

async function finishOf(adapter) {
  for await (const c of adapter.stream({ provider: "dumate", model: "glm-5", messages: [{ role: "user", content: "hi" }] })) {
    if (c.type === "finish") return c;
  }
  return null;
}

const cases = [
  ["429 用户级限流", 429, { "retry-after": 7 }, "RATE_LIMIT"],
  ["402 积分不足", 402, {}, "QUOTA"],
  ["401 登录态被拒", 401, {}, "AUTH"],
  ["503 网关抖动", 503, {}, "SERVER"],
  ["400 请求不合法", 400, {}, "INVALID_REQUEST"],
];

let bad = 0;
for (const [label, status, headers, want] of cases) {
  const { srv, adapter } = await serverFor(status, headers);
  const fin = await finishOf(adapter);
  const f = fin?.reason?.failure ?? {};
  const checks = {
    "kind 是 error": fin?.reason?.kind === "error",
    [`code=${want}`]: f.code === want,
    "code 在官方表里": OFFICIAL_CODES.has(f.code),
    "带上 HTTP 状态": f.status === status,
    "带上请求号": typeof f.requestId === "string" && f.requestId.startsWith("gd-"),
  };
  if (status === 429) checks["retry-after 折成毫秒"] = f.providerRetryAfterMs === 7000;
  const fails = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  if (fails.length) bad++;
  console.log(`${fails.length ? "  FAIL" : "  ok  "} ${label.padEnd(14)} ${f.code ?? "无"}${fails.length ? ` ← ${fails.join("、")}` : ""}`);
  srv.close();
}

// 连不上也不能抛：必须是一条带官方码的 finish
const dead = new DuMateAdapter({
  getState: async () => ({ baseURL: "http://127.0.0.1:1/v1", authHeader: {}, models, imageInput: {} }),
  resolveImage: async () => null,
});
const deadFin = await finishOf(dead);
const deadOk = deadFin?.reason?.kind === "error" && OFFICIAL_CODES.has(deadFin.reason.failure.code);
if (!deadOk) bad++;
console.log(`${deadOk ? "  ok  " : "  FAIL"} 连不上         ${deadFin?.reason?.failure?.code ?? "无"}`);

// 重试策略
const { srv: s0, adapter: a0 } = await serverFor(200, {}, "{}");
const policy = a0.providerRetryPolicy("dumate");
const rules = {
  "RATE_LIMIT 可重试": policy.retryableCodes.includes("RATE_LIMIT"),
  "SERVER 可重试": policy.retryableCodes.includes("SERVER"),
  "AUTH 不重试": !policy.retryableCodes.includes("AUTH"),
  "QUOTA 不重试": !policy.retryableCodes.includes("QUOTA"),
  "STREAM_CLOSED 不重放": !policy.retryableCodes.includes("STREAM_CLOSED"),
  "所有码名都在表里": policy.retryableCodes.every(c => OFFICIAL_CODES.has(c)),
  "重试有上限": policy.mode === "normal" && policy.maxRetries >= 1 && policy.maxRetries <= 4,
  "最长等待有界": policy.maxDelayMs <= 30000,
};
for (const [label, ok] of Object.entries(rules)) { if (!ok) bad++; console.log(`${ok ? "  ok  " : "  FAIL"} 策略：${label}`); }
s0.close();

// 文案不许污染分类关键词，也不许做绝对承诺。
// 宿主重试按 code 判（dsh-llm-retry 的 retryPolicy），但 pi-ai 那一层还会按
// **错误文本正则**再分一次类 —— WorkBuddy 的已知限制里就记着 model_busy 被
// 译成 quota_exceeded 的事故。这里不假装复刻宿主的正则（读不全），
// 只钉一条与实现无关的性质：限流那句里不许出现积分类词，反之亦然。
{
  const texts = {
    RATE_LIMIT: readableFailure(429, "RATE_LIMIT", ""),
    QUOTA: readableFailure(402, "QUOTA", ""),
    AUTH: readableFailure(401, "AUTH", ""),
    SERVER: readableFailure(503, "SERVER", ""),
  };
  const FORBIDDEN = {
    RATE_LIMIT: ["积分不足", "额度用尽", "配额到顶"],
    QUOTA: ["限流", "太密"],
    AUTH: ["限流", "积分不足"],
    SERVER: ["积分不足", "重新登录"],
  };
  for (const [code, list] of Object.entries(FORBIDDEN)) {
    for (const w of list) {
      if (texts[code].includes(w)) { bad++; console.log(`  FAIL ${code} 文案含「${w}」，会被按文本分类那层抢判：${texts[code]}`); }
    }
  }
  for (const [code, t] of Object.entries(texts)) {
    if (/会自动重试/.test(t)) { bad++; console.log(`  FAIL ${code} 承诺了"会自动重试"，但重试取决于宿主装没装重试插件：${t}`); }
  }
  // AUTH 必须同时给两条出路：只说"重新登录"对应不上方式二（手动 Cookie）的用户
  if (!/Cookie/.test(texts.AUTH)) { bad++; console.log(`  FAIL AUTH 文案没覆盖手动导入那条路：${texts.AUTH}`); }
  if (!bad) console.log("  ok   四条文案互不污染分类关键词、不承诺绝对自动重试、AUTH 覆盖两种登录方式");
}

// retry-after 的边界：providerRetryAfterMs 的规格是**正有限数**，
// 交一个 0 或非法值会让宿主直接抛 `LlmError providerRetryAfterMs must be a positive finite number`，
// 一整轮对话崩成 UNKNOWN —— 而 429 本来只是"等一会儿"。
// 现场就是上游回 `retry-after: 0`（限流窗口刚重置时确实会这样）触发的。
{
  const res = (headers, status = 429) => ({
    status, ok: false,
    headers: { get: k => headers[String(k).toLowerCase()] ?? null },
  });
  const shapes = [
    ["retry-after: 0", { "retry-after": "0" }, null],
    ["retry-after: 0.0001（四舍五入会变 0）", { "retry-after": "0.0001" }, null],
    ["retry-after: 空串", { "retry-after": "" }, null],
    ["retry-after: 缺失", {}, null],
    ["retry-after: HTTP 日期", { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }, null],
    ["retry-after: 负数", { "retry-after": "-5" }, null],
    ["retry-after: 荒谬大数", { "retry-after": "999999" }, null],
    ["retry-after: 6.878（现场那个值）", { "retry-after": "6.878" }, 6878],
    ["retry-after: 30", { "retry-after": "30" }, 30000],
    ["retry-after: 1", { "retry-after": "1" }, 1000],
  ];
  for (const [label, headers, want] of shapes) {
    const f = failureFromResponse(res(headers), `{"error":{"code":"user_rate_limit_exceeded"}}`);
    const got = f.providerRetryAfterMs ?? null;
    if (got !== want) { bad++; console.log(`  FAIL ${label} → providerRetryAfterMs=${JSON.stringify(got)}（期望 ${JSON.stringify(want)}）`); }
    // 关键不变式：只要给了这个字段，就必须是正有限数
    if (got !== null && !(Number.isFinite(got) && got > 0)) {
      bad++; console.log(`  FAIL ${label} → 给出了非法值 ${got}，宿主会抛 LlmError 让整轮崩`);
    }
    if (f.code !== "RATE_LIMIT") { bad++; console.log(`  FAIL ${label} → code=${f.code}，429 必须仍是可重试的 RATE_LIMIT`); }
  }
  if (!bad) console.log("  ok   retry-after 十种形状：非法值一律不给而不是给 0，429 始终判 RATE_LIMIT");
}

console.log(bad ? `\nFAIL：${bad} 条不对` : "\nPASS：失败码全部落在 dsh-llm 官方表内，429 会退避重试，AUTH/QUOTA/半截流不重试");
// 先让 undici 的连接池散掉再退出，否则 libuv 会在 process.exit 时甩一句断言
for (const srv of servers) { try { srv.closeAllConnections?.(); srv.close(); } catch { /* 已经关了 */ } }
await new Promise(r => setTimeout(r, 200));
process.exit(bad ? 1 : 0);
