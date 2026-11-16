// 「禁用」必须是真的静默。
// 发布前这条是假的：config.enabled=false 只包住模型注册，积分轮询的 setInterval 和三个工具
// 都在判断之外 —— 用户以为关了，插件照旧每 5 分钟打一次上游。
// 这里把 fetch 换成计数器实测：禁用后必须一个请求都不发，且工具要说清是开关的事。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const upstream = require(path.join(import.meta.dirname, "..", "src/upstream.cjs"));

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "dumate-disabled-"));
process.env.DSH_HOME = SANDBOX;

// **自带一份假登录态 + 假上游**。原先这条依赖真机装过搭子：
// 在没装 App 的机器上（也就是别人刚下载这个包的那台机器）对照组必然 0 请求，
// 于是 `npm test` 直接失败 —— 而 README 明明写着"装完可以自己跑 npm test 验证包完整"。
// 那是句做不到的承诺。现在它在哪台机器上都该绿。
const APP = path.join(SANDBOX, "app");
fs.mkdirSync(path.join(APP, "data", "sts"), { recursive: true });
const ck = Buffer.alloc(32, 9);
const cookies = [{ name: "bce-sessionid", value: "FAKE-session" }, { name: "bce-user-info", value: '"FAKE-info"' }];
fs.writeFileSync(path.join(APP, "auth.json"), JSON.stringify({
  activeProfileId: "p1", cookies: upstream.encryptCookies(cookies, ck),
  accountProfiles: [{ profileId: "p1", displayName: "假号", bceUserId: "u1", encryptedCookies: upstream.encryptCookies(cookies, ck), loginType: "baidu", lastLogin: 1 }],
}));
fs.writeFileSync(path.join(APP, ".cookie-key"), ck);
process.env.DUMATE_USER_DATA = APP;

const { apply } = await import(pathToFileURL(path.join(import.meta.dirname, "..", "index.js")).href + "?off=" + Date.now());

const calls = [];
// 假上游：只记地址并给一个形状正确的空响应，绝不真连百度
globalThis.fetch = async (url, opt) => {
  const u = String(url);
  calls.push(u);
  const body = u.includes("token/get") ? { token: "x".repeat(36), expired_at: Date.now() + 3600_000 }
    : u.includes("points/package/list") ? { success: true, packages: [] }
    : u.includes("loginBonusInfo") ? { success: true, result: { signInDays: [], hasIssued: false, totalTimes: 0, totalPoints: 0 } }
    : u.includes("records/usage") ? { success: true, result: { consumedPoints: "0" } }
    : u.includes("/models") ? { data: [] }
    : { success: true, result: {} };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
};

const routes = new Map();
const tools = {};
const disposers = [];
let adapter = null;
const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  fiber: { entry: { options: { id: "dsh-connect-dumate" } } },
  effect: fn => {
    let r;
    try { r = fn(); } catch { return; }
    if (typeof r === "function") disposers.push(r);
    else if (r && typeof r[Symbol.iterator] === "function") for (const d of r) if (typeof d === "function") disposers.push(d);
  },
  emit: () => {}, get: () => undefined,
  inject: (_deps, fn) => fn({
    commands: { register: () => () => {} },
    tools: { register: t => { tools[t.name] = t; return () => {}; } },
    webServer: { getOrigin: () => "http://x", register: r => { routes.set(r.path, r); return () => routes.delete(r.path); } },
  }),
  llm: {
    registerAdapter: (list, a) => { adapter = a; return () => { adapter = null; }; },
    registerConfigurableProviders: () => () => {},
    registerModelDiscovery: () => () => {},
    listProviders: async () => [],
    listModels: async () => [],
  },
};

apply(ctx, { enabled: false });
await new Promise(r => setTimeout(r, 3000));

assert.equal(adapter, null, "禁用后不该注册模型适配器");
assert.equal(calls.length, 0, `禁用后不该向任何上游发请求，实际发了 ${calls.length} 个：${calls.slice(0, 3).join(", ")}`);

const state = await (await routes.get("/api/dumate/state").resource(new Request("http://x/api/dumate/state"))).json();
assert.equal(state.ok, false, "禁用时 state 必须说 ok=false");
assert.match(state.reasons.join("；"), /已禁用/, `reasons 该点明是开关问题：${state.reasons.join("；")}`);

for (const name of ["dumate_credits", "dumate_models", "dumate_claim_checkin"]) {
  const reply = String(await tools[name].execute({}));
  assert.match(reply, /已禁用/, `${name} 在禁用时该回一句「已禁用」，实际：${reply.slice(0, 70)}`);
  assert.doesNotMatch(reply, /读不到积分：未知|Error/, `${name} 不该抛含糊错误`);
}
assert.equal(calls.length, 0, "调用工具也不该触发上游请求");

// 对照组：enabled=true 必须真的会发请求，否则上面那个 0 只是计数器没接上
// 对照组会自己再装一个假上游，这里不需要恢复真实 fetch
const box2 = fs.mkdtempSync(path.join(os.tmpdir(), "dumate-enabled-"));
process.env.DSH_HOME = box2;
// 对照组也走假上游：它要证明的是「计数器接上了」，不是「真能连百度」
const APP2 = path.join(box2, "app");
fs.mkdirSync(path.join(APP2, "data", "sts"), { recursive: true });
fs.writeFileSync(path.join(APP2, "auth.json"), JSON.stringify({
  activeProfileId: "p1", cookies: upstream.encryptCookies(cookies, ck),
  accountProfiles: [{ profileId: "p1", displayName: "假号", bceUserId: "u1", encryptedCookies: upstream.encryptCookies(cookies, ck), loginType: "baidu", lastLogin: 1 }],
}));
fs.writeFileSync(path.join(APP2, ".cookie-key"), ck);
process.env.DUMATE_USER_DATA = APP2;
const { apply: applyOn } = await import(pathToFileURL(path.join(import.meta.dirname, "..", "index.js")).href + "?on=" + Date.now());
const onCalls = [];
globalThis.fetch = async (url, opt) => {
  const u = String(url);
  onCalls.push(u);
  const body = u.includes("token/get") ? { token: "x".repeat(36), expired_at: Date.now() + 3600_000 }
    : u.includes("points/package/list") ? { success: true, packages: [] }
    : u.includes("loginBonusInfo") ? { success: true, result: { signInDays: [], hasIssued: false, totalTimes: 0, totalPoints: 0 } }
    : u.includes("records/usage") ? { success: true, result: { consumedPoints: "0" } }
    : u.includes("/models") ? { data: [] }
    : { success: true, result: {} };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
};
const routes2 = new Map();
let adapter2 = null;
const onDisposers = [];
const ctxOn = {
  ...ctx,
  // 照 cordis 语义：挂载只跑 body，disposer 留到最后才跑。
  // 这里要是当场执行 disposer，就等于复现 v0.1 那个「注册被自己拆掉」的 bug，对照组会假失败。
  effect: fn => {
    let r;
    try { r = fn(); } catch { return; }
    if (typeof r === "function") onDisposers.push(r);
    else if (r && typeof r[Symbol.iterator] === "function") for (const d of r) if (typeof d === "function") onDisposers.push(d);
  },
  inject: (_d, fn) => fn({
    commands: { register: () => () => {} },
    tools: { register: () => () => {} },
    webServer: { getOrigin: () => "http://x", register: r => { routes2.set(r.path, r); return () => routes2.delete(r.path); } },
  }),
  llm: { ...ctx.llm, registerAdapter: (l, a) => { adapter2 = a; return () => { adapter2 = null; }; } },
};
applyOn(ctxOn, { enabled: true });
await new Promise(r => setTimeout(r, 3000));
assert.ok(adapter2, "启用时该注册适配器");
assert.ok(onCalls.length > 0, `启用时该真的发请求（否则「禁用=0」是假绿）；实际 ${onCalls.length} 个`);

for (const d of disposers.slice().reverse()) { try { await d(); } catch { /* 卸载失败不影响结论 */ } }
for (const d of onDisposers.slice().reverse()) { try { await d(); } catch { /* 同上 */ } }
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.rmSync(box2, { recursive: true, force: true });

console.log(`PASS：禁用后 0 个上游请求、ok=false、三个工具都回「已禁用」；对照启用组发了 ${onCalls.length} 个（计数器有效）`);
process.exit(0);
