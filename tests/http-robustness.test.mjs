// 同源 HTTP 面的健壮性回归。跑在沙箱 DSH_HOME，绝不碰真机状态。
//
// 这条测试钉三件事，都是实测出来的洞：
//   ① 乱传参数不许让插件崩、不许把本机标识吐回浏览器、不许写坏状态文件；
//   ② key 必须是目录里真存在的模型 —— 原先只验「是不是字符串」，于是任何客户端
//      都能往 displayNames / disabledModels 里塞任意键，垃圾只随状态文件永久堆积；
//   ③ 显示名必须有长度上限与控制字符过滤 —— 5000 字的名字会整段塞进模型选择器。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "dumate-robust-"));
process.env.DSH_HOME = SANDBOX;

const { apply } = await import(pathToFileURL(path.join(import.meta.dirname, "..", "index.js")).href + "?r=" + Date.now());

const routes = new Map();
const logs = [];
const disposers = [];
const ctx = {
  logger: { info: (...a) => logs.push(a.join(" ")), warn: (...a) => logs.push(a.join(" ")), error: (...a) => logs.push(a.join(" ")) },
  fiber: { entry: { options: { id: "dsh-connect-dumate" } } },
  effect: fn => {
    let r;
    try { r = fn(); } catch { return; }
    if (typeof r === "function") disposers.push(r);
    else if (r && typeof r[Symbol.iterator] === "function") for (const d of r) if (typeof d === "function") disposers.push(d);
  },
  emit: () => {},
  get: () => undefined,
  inject: (_d, fn) => fn({
    commands: { register: () => () => {} },
    tools: { register: () => () => {} },
    webServer: { getOrigin: () => "http://x", register: r => { routes.set(r.path, r); return () => routes.delete(r.path); } },
  }),
  llm: {
    registerAdapter: () => () => {},
    registerConfigurableProviders: () => () => {},
    registerModelDiscovery: () => () => {},
    async listProviders() { return [{ id: "dumate" }]; },
    async listModels() { return []; },
  },
};
apply(ctx, { enabled: true });
await new Promise(r => setTimeout(r, 2500));

async function post(body) {
  const req = Readable.from([JSON.stringify(body)]);
  req.method = "POST";
  req.headers = { origin: "http://x" };
  let out = "", code = 200;
  await routes.get("/api/dumate/action").handler(req, { writeHead: c => { code = c; }, end: s => { out = s; } });
  let json = null;
  try { json = JSON.parse(out); } catch { /* 下面单独断言 */ }
  return { code, text: out, json };
}
const stateFile = path.join(SANDBOX, "dumate-state.json");
const readState = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));

// --- ① 乱传参数：不崩、不外泄、返回必须是 JSON
const secrets = [os.userInfo().username, os.homedir()].filter(Boolean);
const junk = [
  ["空对象", {}],
  ["action 是数字", { action: 123 }],
  ["action 是不存在的串", { action: "rm -rf" }],
  ["kind 是对象", { action: "defaults", kind: { x: 1 } }],
  ["kind 是数组", { action: "defaults", kind: ["recommended"] }],
  ["model 缺 key", { action: "model" }],
  ["key 是对象", { action: "model", key: { a: 1 }, enabled: true }],
  ["pollIntervalMs 负数", { action: "knobs", pollIntervalMs: -1 }],
  ["pollIntervalMs 极大", { action: "knobs", pollIntervalMs: 1e15 }],
  ["pollIntervalMs 字符串", { action: "knobs", pollIntervalMs: "abc" }],
  ["profileId 路径穿越", { action: "knobs", profileId: "../../../etc/passwd" }],
  ["authSource 乱值", { action: "login", kind: "source", value: "../../x" }],
  ["import 超长文本", { action: "login", kind: "import", text: "a".repeat(2_000_000) }],
  ["import null", { action: "login", kind: "import", text: null }],
  ["enabled 非布尔", { action: "knobs", enabled: "yes" }],
];
for (const [label, body] of junk) {
  const r = await post(body);
  assert.ok(r.code < 500, `${label}：HTTP ${r.code}`);
  assert.ok(r.json, `${label}：返回不是 JSON`);
  for (const s of secrets) {
    assert.ok(!(r.text || "").includes(s), `${label}：回显里出现本机标识`);
  }
}
console.log(`  ok   ${junk.length} 组乱参数：不崩、返回都是 JSON、不回显本机标识`);

// 状态文件必须还能解析
assert.doesNotThrow(() => readState(), "乱参数之后状态文件坏了");
console.log("  ok   乱参数之后状态文件仍可解析");

// --- ② key 必须存在于目录
const known = (await (await routes.get("/api/dumate/state").resource(new Request("http://x/api/dumate/state"))).json()).models;
assert.ok(known.length > 0, "沙箱里也该有兜底目录，否则这条断言没意义");
for (const bad of ["根本不存在", "../../etc/passwd", "a".repeat(3000)]) {
  const r = await post({ action: "name", key: bad, displayName: "塞进去" });
  assert.equal(r.json.ok, false, `不存在的 key「${bad.slice(0, 16)}」被接受了`);
  assert.ok(/没有|不存在/.test(r.json.error || ""), `拒绝时必须说清原因，实际：${r.json.error}`);
}
assert.equal(Object.keys(readState().displayNames || {}).length, 0, "拒绝的 key 不许留下任何痕迹");
// 注意：上面 junk 循环里的 defaults 会**合法地**写入 disabledModels（推荐去重要关一批），
// 所以这里断言的是「垃圾 key 没有新增条目」，不是「等于 0」。
const beforeJunk = readState().disabledModels.length;
for (let i = 0; i < 5; i++) {
  const r = await post({ action: "model", key: `垃圾${i}`, enabled: false });
  assert.equal(r.json.ok, false, `垃圾 key「垃圾${i}」被 model 动作接受了`);
}
assert.equal(readState().disabledModels.length, beforeJunk,
  `不存在的 key 让 disabledModels 从 ${beforeJunk} 涨到 ${readState().disabledModels.length}`);
for (const k of readState().disabledModels) {
  assert.ok(known.some(m => m.key === k), `disabledModels 里有目录外的键：${k.slice(0, 20)}`);
}
console.log(`  ok   不存在的 key 一律拒绝并说明原因（目录 ${known.length} 个模型为准）`);

// --- ③ 显示名长度与控制字符
const longName = "长".repeat(5000);
const rl = await post({ action: "name", key: known[0].key, displayName: longName });
assert.equal(rl.json.ok, true, "合法 key 的改名应当成功");
const stored = readState().displayNames[known[0].key];
assert.ok(stored.length <= 80, `显示名没截断，存了 ${stored.length} 字`);
const rc = await post({ action: "name", key: known[0].key, displayName: "正\u0000常\u001f名" });
assert.equal(rc.json.ok, true);
assert.ok(!/[\u0000-\u001f\u007f]/.test(readState().displayNames[known[0].key]), "控制字符没被过滤");
assert.equal(readState().displayNames[known[0].key], "正常名");
console.log("  ok   显示名截到 80 字以内，控制字符被剥掉");

// --- ④ 日志里不许有凭据
const logText = logs.join("\n");
assert.ok(!/bce-sessionid=[A-Za-z0-9]/.test(logText), "日志里出现了 cookie 值");
for (const s of secrets) assert.ok(!logText.includes(s), "日志里出现了本机标识");
console.log(`  ok   ${logs.length} 条日志里没有凭据、没有本机标识`);

for (const d of disposers.slice().reverse()) { try { await d(); } catch { /* 卸载失败不影响结论 */ } }
fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log("\nPASS：HTTP 面乱参数不崩不外泄；key 校验与显示名上限都挡住");
process.exit(0);
