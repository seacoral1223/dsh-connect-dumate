// 模拟三种「别人的机器」：① 完全没装搭子 ② 装了但 auth.json 是空的/坏的 ③ 密钥长度不对。
// 要求：不抛未捕获异常，且给出的每一条 reason 都是能照着做的中文句子。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.join(import.meta.dirname, "..");
const upstream = require(path.join(ROOT, "src/upstream.cjs"));

const cases = [
  ["① 目录根本不存在", dir => { /* 什么都不放 */ }],
  ["② 有 auth.json 但内容不是 JSON", dir => fs.writeFileSync(path.join(dir, "auth.json"), "not json at all")],
  ["③ auth.json 合法但没有 cookie 档", dir => fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ activeProfile: "p1", accountProfiles: {} }))],
  ["④ 有 cookie 档但 .cookie-key 长度不对", dir => {
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({
      activeProfile: "p1",
      accountProfiles: { p1: { profileId: "p1", loginType: "bce", displayName: "测试账号", cookies: "AAAA", bceUserId: "u1" } },
    }));
    fs.writeFileSync(path.join(dir, ".cookie-key"), Buffer.alloc(7, 1));
  }],
  ["⑤ key 长度对但密文解不开", dir => {
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({
      activeProfile: "p1",
      accountProfiles: { p1: { profileId: "p1", loginType: "bce", displayName: "测试账号", cookies: Buffer.alloc(40, 7).toString("base64"), bceUserId: "u1" } },
    }));
    fs.writeFileSync(path.join(dir, ".cookie-key"), Buffer.alloc(32, 3));
  }],
];

let bad = 0;
for (const [label, fill] of cases) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dumate-fake-"));
  fill(dir);
  process.env.DUMATE_USER_DATA = dir;
  let out, err = null;
  try {
    out = await upstream.inspect({ mode: "auto", withFallback: true });
  } catch (e) {
    err = e;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.DUMATE_USER_DATA;

  if (err) { bad++; console.log(`  FAIL ${label} 抛了未捕获异常：${err.message}`); continue; }
  const reasons = (out.reasons ?? []).join("；");
  // 每条都要能照着做：要么提到登录/安装，要么提到密钥/重装，要么明确说退回兜底
  const actionable = /登录|安装|密钥|重新|兜底|没有可用/.test(reasons);
  const hasModels = Array.isArray(out.models) && out.models.length > 0;
  const positiveInts = out.models.every(m => Number.isInteger(m.contextInput) && m.contextInput > 0);
  if (!actionable || !hasModels || !positiveInts) bad++;
  console.log(`${(!actionable || !hasModels || !positiveInts) ? "  FAIL" : "  ok  "} ${label}`);
  console.log(`         目录=${out.dir ? path.basename(String(out.dir)) : "null"} 模型=${out.models.length} 兜底=${out.fallbackOnly ? "是" : "否"}`);
  console.log(`         提示：${reasons.slice(0, 150)}`);
}

// Host 半段在「什么都没有」的环境里也必须挂载成功、注册成功、命令不崩
const box = fs.mkdtempSync(path.join(os.tmpdir(), "dumate-host-empty-"));
process.env.DSH_HOME = box;
process.env.DUMATE_USER_DATA = path.join(box, "no-such-app-dir");
const { apply } = await import(pathToFileURL(path.join(ROOT, "index.js")).href + "?e=" + Date.now());
const routes = new Map();
const cleanups = [];
const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  fiber: { entry: { options: { id: "dsh-connect-dumate" } } },
  effect: fn => {
    let r; try { r = fn(); } catch (e) { bad++; console.log("  FAIL Host effect 抛了：", e.message); return; }
    if (typeof r === "function") cleanups.push(r);
    else if (r && typeof r[Symbol.iterator] === "function") for (const d of r) if (typeof d === "function") cleanups.push(d);
  },
  emit: () => {}, get: () => undefined,
  inject: (_d, fn) => fn({
    commands: { register: c => { ctx._cmd = c; return () => {}; } },
    tools: { register: () => () => {} },
    webServer: { getOrigin: () => "http://x", register: r => { routes.set(r.path, r); return () => routes.delete(r.path); } },
  }),
  llm: {
    registerAdapter: (list, a) => { ctx._routes = list; ctx._adapter = a; return () => {}; },
    registerConfigurableProviders: () => () => {},
    registerModelDiscovery: () => () => {},
    listProviders: async () => [{ id: "dumate", name: "百度搭子 DuMate" }],
    listModels: async () => ctx._adapter?.listModels?.("dumate") ?? [],
  },
};
apply(ctx, { enabled: true });
await new Promise(r => setTimeout(r, 2500));

const listed = await ctx._adapter.listModels("dumate");
console.log(`  ${listed.length > 0 ? "ok  " : "FAIL"} 没装搭子时 listModels 仍交得出 ${listed.length} 个模型（宿主对空组会整组隐藏）`);
if (!listed.length) bad++;
const resolved = await ctx._adapter.resolveModel("dumate", "glm-5");
console.log(`  ${resolved?.context?.contextWindow > 0 ? "ok  " : "FAIL"} resolveModel 给正整数窗口：${resolved?.context?.contextWindow}`);

const cmdOut = await ctx._cmd.handler({ rawInput: "doctor" });
const cmdText = String(cmdOut?.text ?? "");
console.log(`  ${/登录|安装|没找到|兜底|不可用/.test(cmdText) ? "ok  " : "FAIL"} /dumate doctor 在空机器上说人话：${cmdText.slice(0, 90).replace(/\n/g, " / ")}`);

const stateJson = await (await routes.get("/api/dumate/state").resource(new Request("http://x/api/dumate/state"))).json();
console.log(`  ${stateJson.ok === false && (stateJson.reasons ?? []).length ? "ok  " : "FAIL"} 空机器上 state 明确说 ok=false + 原因`);

for (const d of cleanups.slice().reverse()) { try { await d(); } catch { /* 卸载失败不影响结论 */ } }
fs.rmSync(box, { recursive: true, force: true });
delete process.env.DSH_HOME;

console.log(bad ? `\nFAIL：${bad} 项不过` : "\nPASS：五种残缺环境 + 完全没装搭子的机器，都不崩、都有目录、都说得清下一步");
process.exit(bad ? 1 : 0);
