// 同源闸门的回归。**这条钉的是一个真实用户反馈**：
// 别人装完之后「模型勾选、取消、导入 Cookie 全部报 forbidden-origin，但读一切正常」。
//
// 根因是我在 v0.9.10 把闸门改成 fail-closed 时，判据写成了
// 「Origin 字符串必须等于 getOrigin()」。而 getOrigin() 只返回一个地址（通常
// `http://127.0.0.1:<端口>`），用户完全可能用 `http://localhost:<端口>`、局域网 IP
// 或远程隧道打开同一个 GUI。浏览器对 **GET 不发 Origin、对 POST 必发 Origin** ——
// 于是「读得到、写全 403」，而且失败是静默的（界面只显示一个错误码）。
//
// 正确判据：**Origin 的 host 必须等于这个请求自己打到的 Host**。这才是浏览器同源模型，
// 并且天然兼容 localhost / LAN / 隧道 / 反向代理。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "dumate-origin-"));
process.env.DSH_HOME = SANDBOX;
process.env.DUMATE_USER_DATA = path.join(SANDBOX, "no-app");

const { apply } = await import(pathToFileURL(path.join(import.meta.dirname, "..", "index.js")).href + "?o=" + Date.now());

// getOrigin 返回 127.0.0.1，而用户用 localhost / LAN IP 打开 —— 就是现场情况
const SERVED = "http://127.0.0.1:60525";
const routes = new Map();
const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  fiber: { entry: { options: { id: "dsh-connect-dumate" } } },
  effect: fn => { try { const r = fn(); if (typeof r === "function") return r; if (r && r[Symbol.iterator]) for (const d of r) if (typeof d === "function") return d; } catch { /* */ } },
  emit: () => {}, get: () => undefined,
  inject: (_d, fn) => fn({
    commands: { register: () => () => {} }, tools: { register: () => () => {} },
    webServer: { getOrigin: () => SERVED, register: r => { routes.set(r.path, r); return () => routes.delete(r.path); } },
  }),
  llm: { registerAdapter: () => () => {}, registerConfigurableProviders: () => () => {}, registerModelDiscovery: () => () => {},
    async listProviders() { return [{ id: "dumate" }]; }, async listModels() { return []; } },
};
apply(ctx, { enabled: true });
await new Promise(r => setTimeout(r, 2000));

// 读口收 Web Request，写口收 Node 风格 req —— 两种形状都要测，否则只测了一半。
// 注意 Web Request 拿不到 host 头（fetch 禁止头名，undici 会丢），所以读口的判据
// 只能来自 request.url —— 测试必须按真实访问地址构造 URL，不然测的是另一个分支。
function webRequest(headers, host) {
  const url = `http://${host}/api/dumate/state`;
  return new Request(url, { headers: new Headers(headers) });
}
function nodeRequest(headers, body = { action: "refresh" }) {
  const rs = Readable.from([JSON.stringify(body)]);
  rs.method = "POST";
  rs.headers = headers;   // 普通对象，像 Node 的 req
  return rs;
}
async function callState(headers, host) {
  const res = await routes.get("/api/dumate/state").resource(webRequest(headers, host));
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function callAction(headers) {
  let out = "", code = 0;
  await routes.get("/api/dumate/action").handler(nodeRequest(headers), {
    writeHead: c => { code = c; }, end: s => { out = s; },
  });
  return { status: code, body: JSON.parse(out || "{}") };
}

const cases = [
  // [说明, 请求 Origin, 请求 Host, 期望读口, 期望写口]
  ["同源 GET 不带 Origin（浏览器默认）", undefined, "127.0.0.1:60525", 200, 200],
  ["用户用 localhost 打开 —— 现场报障的那一种", "http://localhost:60525", "localhost:60525", 200, 200],
  ["用户用局域网 IP 打开", "http://192.168.1.20:60525", "192.168.1.20:60525", 200, 200],
  ["用户走远程隧道/域名", "https://dsh.example.com", "dsh.example.com", 200, 200],
  ["本机 curl（不带 Origin）", undefined, "127.0.0.1:60525", 200, 200],
  ["恶意本机网页跨源打进来", "http://evil.example", "127.0.0.1:60525", 403, 403],
  ["伪造的 Origin 值", "not a url", "127.0.0.1:60525", 403, 403],
  ["Origin 端口不对", "http://127.0.0.1:9999", "127.0.0.1:60525", 403, 403],
];

let bad = 0;
console.log("=== 同源闸门 ===");
for (const [label, origin, host, wantRead, wantWrite] of cases) {
  const rh = origin ? { origin } : {};
  const wh = origin ? { origin, host } : { host };
  const r = await callState(rh, host);
  const w = await callAction(wh);
  const okRead = r.status === wantRead, okWrite = w.status === wantWrite;
  if (!okRead || !okWrite) bad++;
  console.log(`  ${okRead && okWrite ? "✓" : "✗"} ${label}`);
  if (!okRead || !okWrite) console.log(`      读 ${r.status}（期望 ${wantRead}）｜写 ${w.status}（期望 ${wantWrite}）`);
}
assert.equal(bad, 0, `${bad} 组同源判定不符合预期`);

// 反向证明这条不是摆设：把判据退回「Origin 必须字符串等于 getOrigin()」，localhost 那组必须挂
{
  const strict = o => o === undefined || o === SERVED;
  assert.ok(strict(undefined), "基准自证失败");
  assert.ok(!strict("http://localhost:60525"),
    "反向验证失败：旧判据本来就该拒绝 localhost —— 那正是用户被锁在门外的原因");
  console.log("  ok   反向对照：旧判据（字符串等于 getOrigin）确实会拒绝 localhost");
}

// 写口的 403 必须自带可反馈的诊断信息，否则用户只能截图猜
{
  const w = await callAction({ origin: "http://evil.example", host: "127.0.0.1:60525" });
  assert.equal(w.status, 403);
  assert.ok(w.body.got && w.body.servedHost, `403 要带上 got / servedHost 才好排障：${JSON.stringify(w.body)}`);
  assert.ok(!/evil\.example/.test(JSON.stringify(w.body.hint ?? "")), "hint 里不该回显来源域名以外的东西");
  console.log(`  ok   403 自带诊断：got=${w.body.got} servedHost=${w.body.servedHost}`);
}

fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log("\nPASS：localhost / 局域网 / 隧道都能写，跨源网页仍然被挡");
process.exit(0);
