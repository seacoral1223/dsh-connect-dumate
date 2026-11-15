// 「推荐（按后端去重）」的规则用例：跑在沙箱 DSH_HOME 上，不碰真机状态文件。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const REAL_DIR = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "dumate-defaults-"));
try {
  const src = path.join(REAL_DIR, "dumate-state.json");
  if (fs.existsSync(src)) {
    const j = JSON.parse(fs.readFileSync(src, "utf8"));
    // 故意摆一个烂摊子：同一后端的五行全开，独有后端反而被关掉
    j.disabledModels = ["glm-53", "kimi-k3", "doubao-seed-2-0-pro"];
    fs.writeFileSync(path.join(SANDBOX, "dumate-state.json"), JSON.stringify(j));
  }
} catch { /* 没副本也能跑，插件会退回静态兜底目录 */ }
process.env.DSH_HOME = SANDBOX;

const { apply } = await import(pathToFileURL(path.join(import.meta.dirname, "..", "index.js")).href + "?d=" + Date.now());

const routes = new Map();
const emitted = [];
const disposers = [];
const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  fiber: { entry: { options: { id: "dsh-connect-dumate" } } },
  // 照 cordis 语义：生成器形式在挂载时只跑 body，disposer 要等到 dispose 才跑。
  // 这里要是当场执行 disposer，座位和路由就被自己拆掉了（v0.1 的真实翻车形状）。
  effect: fn => {
    let r;
    try { r = fn(); } catch { return; }
    if (typeof r === "function") disposers.push(r);
    else if (r && typeof r[Symbol.iterator] === "function") for (const d of r) if (typeof d === "function") disposers.push(d);
  },
  emit: (name, provider) => emitted.push([name, provider]),
  get: () => undefined,
  inject: (_deps, fn) => fn({
    commands: { register: () => () => {} },
    tools: { register: () => () => {} },
    webServer: {
      getOrigin: () => "http://x",
      register: r => { routes.set(r.path, r); return () => routes.delete(r.path); },
    },
  }),
  llm: {
    registerAdapter: () => () => {},
    registerConfigurableProviders: () => () => {},
    registerModelDiscovery: () => () => {},
    listProviders: async () => [{ id: "dumate" }],
    listModels: async () => [],
  },
};
apply(ctx, { enabled: true });
await new Promise(r => setTimeout(r, 3500));

async function action(body) {
  const req = Readable.from([JSON.stringify(body)]);
  req.method = "POST";
  req.headers = { origin: "http://x" };
  let payload = "";
  await routes.get("/api/dumate/action").handler(req, { writeHead: () => {}, end: s => { payload = s; } });
  return JSON.parse(payload);
}
async function state() {
  return (await routes.get("/api/dumate/state").resource(new Request("http://x/api/dumate/state"))).json();
}

const before = await state();
const flashRows = before.models.filter(m => m.enabled && m.realModel === "deepseek-v4.1-flash-low-latency-1017").map(m => m.key);
assert.ok(flashRows.length >= 3, `前置条件没造出来：同一后端应该有好几行都开着，实际 ${flashRows.join(",")}`);

const r = await action({ action: "defaults", kind: "recommended" });
assert.ok(r.ok, `推荐失败：${r.error}`);
const enabled = r.state.models.filter(m => m.enabled);
const backends = enabled.map(m => m.realModel || m.key);

// 核心断言：启用集里不允许两行落同一个后端
assert.equal(new Set(backends).size, backends.length, `去重失败，仍有同后端重复：${backends.join(", ")}`);
// 自动路由档位一律关
assert.ok(enabled.every(m => !m.isRouter), "推荐默认不该把自动路由档位开着");
// 独有的后端不能被误伤（glm-5.3 / kimi-k3 / doubao 各自独占一个后端）
for (const key of ["glm-53", "kimi-k3", "doubao-seed-2-0-pro"]) {
  assert.ok(enabled.some(m => m.key === key), `${key} 独占一个后端，推荐不该把它关掉`);
}
// 幂等：再点一次结果一样
const again = await action({ action: "defaults", kind: "recommended" });
assert.deepEqual(again.state.models.filter(m => m.enabled).map(m => m.key).sort(), enabled.map(m => m.key).sort(), "推荐必须幂等");
// 每次都广播了目录变化（选择器靠这个事件重拉）
assert.ok(emitted.filter(e => e[0] === "llm/models-updated").length >= 2, "批量改动后必须广播 llm/models-updated");

const all = await action({ action: "defaults", kind: "all" });
assert.equal(all.kept, all.state.models.length, "全选应把每一行都点上（含路由档位）");
const none = await action({ action: "defaults", kind: "none" });
assert.equal(none.kept, 0, "全不选应清空");

// 诊断表必须跟着勾选现算。之前「选择器内启用数」是启动自检时算一次就冻住的，
// 点完推荐启用数已经变了、诊断表还显示旧数字 —— 排障时陈旧数字比没有更坏。
const back2 = await action({ action: "defaults", kind: "recommended" });
const rowOf = (state, key) => (state.checks ?? []).find(r => r[0] === key)?.[1];
const enabledNow = back2.state.models.filter(m => m.enabled).length;
assert.equal(Number(rowOf(back2.state, "选择器内启用数")), enabledNow,
  `诊断表的启用数必须是现值（表=${rowOf(back2.state, "选择器内启用数")} 实际=${enabledNow}）`);
const allState = (await action({ action: "defaults", kind: "all" })).state;
assert.equal(Number(rowOf(allState, "选择器内启用数")), allState.models.length,
  "全选后诊断表要立刻反映为全部行数");
console.log(`  ok   诊断表现算：推荐后=${rowOf(back2.state, "选择器内启用数")} 全选后=${rowOf(allState, "选择器内启用数")}/${allState.models.length}`);
await action({ action: "defaults", kind: "recommended" });

console.log(`PASS：乱局 ${flashRows.length} 行同后端 → 推荐后 ${enabled.length} 行、后端互不相同、幂等、广播 ${emitted.length} 次`);
console.log("  推荐启用：", enabled.map(m => `${m.key}→${m.realModel || "?"}`).join("  "));
for (const d of disposers.reverse()) { try { await d(); } catch { /* 卸载失败不影响结论 */ } }
fs.rmSync(SANDBOX, { recursive: true, force: true });
process.exit(0);
