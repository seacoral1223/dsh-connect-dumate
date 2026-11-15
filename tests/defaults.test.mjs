// 「推荐（按后端去重）」的用例。跑在沙箱 DSH_HOME 上，**素材自己造**，不读真机状态。
//
// 为什么强调自造：这条测试先后挂过两次，根因都是依赖环境 ——
//   ① 原先复制真机状态文件、只关掉三行，指望「同一后端的几行是开着的」；用户点过「推荐」后前置条件就不成立。
//   ② 改成清空 disabledModels 之后，在 GitHub 下载副本里又因为那份副本没有真机状态而 SKIP —— 等于没测。
// 现在给它一份确定的假目录 + 假后端映射，任何机器（包括 CI）上跑出来的都是同一条断言。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "dumate-defaults-"));

// 素材用**真实 id + 实测后端映射**（2026-11-15 逐个探测的结果）：
// 五个 id 落同一个后端 flash，两个 id 落 qwen3.8-flash，其余各自独占。
// 为什么用真 id：离线时 inspect 交的是静态兜底目录（22 行真 id），
// 假造的名字既不会被采用、也就测不到东西 —— 上一版就是这么变成 0 行的。
const FLASH = "deepseek-v4.1-flash-low-latency-1017";
const fixture = {
  disabledModels: [],
  routerEnabled: [],
  imageInput: {},
  displayNames: {},
  realNames: {
    "glm-5": { realModel: FLASH, displayName: "DeepSeek-V4.1 Flash", observedAt: Date.now() },
    "deepseek-v41-flash": { realModel: FLASH, displayName: "DeepSeek-V4.1 Flash", observedAt: Date.now() },
    "deepseek-v4-flash-0731": { realModel: FLASH, displayName: "DeepSeek-V4.1 Flash", observedAt: Date.now() },
    "ernie-4.5-turbo-vl-32k": { realModel: FLASH, displayName: "DeepSeek-V4.1 Flash", observedAt: Date.now() },
    "qwen2.5-vl-32b-instruct": { realModel: FLASH, displayName: "DeepSeek-V4.1 Flash", observedAt: Date.now() },
    "qwen3.5-397b-a17b": { realModel: "qwen3.8-flash", displayName: "Qwen-3.8 Flash", observedAt: Date.now() },
    "qwen38-flash": { realModel: "qwen3.8-flash", displayName: "Qwen-3.8 Flash", observedAt: Date.now() },
    "deepseek-v4-pro": { realModel: "deepseek-v4-pro-0813", displayName: "DeepSeek-V4 Pro", observedAt: Date.now() },
    "glm-53": { realModel: "glm-5.3", displayName: "GLM-5.3", observedAt: Date.now() },
    "glm-53-flash": { realModel: "glm-5.3-flash", displayName: "GLM-5.3 Flash", observedAt: Date.now() },
    "kimi-k3": { realModel: "kimi-k3", displayName: null, observedAt: Date.now() },
    "kimi-k31": { realModel: "kimi-k3.1-pro", displayName: "Kimi-K3.1 Pro", observedAt: Date.now() },
    "qwen3.8-max": { realModel: "qwen3.8-max", displayName: null, observedAt: Date.now() },
    "qwen3.5-27b": { realModel: "qwen3.5-27b", displayName: null, observedAt: Date.now() },
    "qwen3.5-35b-a3b": { realModel: "n2p5sdmw_qwen35-35b-a3b", displayName: null, observedAt: Date.now() },
    "doubao-seed-2-0-pro": { realModel: "doubao-seed-2-0-pro-260215", displayName: null, observedAt: Date.now() },
  },
  // 故意留一份和兜底不同的 lastCatalog 也无妨：离线走的是兜底那 22 行真 id
  catalogAt: Date.now(),
};
fs.writeFileSync(path.join(SANDBOX, "dumate-state.json"), JSON.stringify(fixture));
process.env.DSH_HOME = SANDBOX;

// 把网络掐掉：不掐的话 Host 一刷新就拿到真网关的 43 个模型，上面那份假目录直接被盖掉，
// 断言的就不再是「我造的那个场景」了。掐网之后 inspect 交不出通道，
// modelViews() 会退回 lastCatalog —— 正是这份 fixture，测试才真正环境无关。
const realFetch = globalThis.fetch;
globalThis.fetch = () => Promise.reject(new Error("offline for deterministic fixture"));

const { apply } = await import(pathToFileURL(path.join(import.meta.dirname, "..", "index.js")).href + "?d=" + Date.now());

const routes = new Map();
const emitted = [];
const disposers = [];
const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  fiber: { entry: { options: { id: "dsh-connect-dumate" } } },
  // 照 cordis 语义：生成器形式在挂载时只跑 body，disposer 留到最后才跑。
  // 当场执行 disposer 等于复现 v0.1「座位自己把自己拆掉」那个 bug。
  effect: fn => {
    let r;
    try { r = fn(); } catch { return; }
    if (typeof r === "function") disposers.push(r);
    else if (r && typeof r[Symbol.iterator] === "function") for (const d of r) if (typeof d === "function") disposers.push(d);
  },
  emit: (name, provider) => emitted.push([name, provider]),
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
    listProviders: async () => [{ id: "dumate" }],
    listModels: async () => [],
  },
};
apply(ctx, { enabled: true });
await new Promise(r => setTimeout(r, 1500));

async function action(body) {
  const req = Readable.from([JSON.stringify(body)]);
  req.method = "POST"; req.headers = { origin: "http://x" };
  let payload = "";
  await routes.get("/api/dumate/action").handler(req, { writeHead: () => {}, end: s => { payload = s; } });
  return JSON.parse(payload);
}
const state = async () => (await routes.get("/api/dumate/state").resource(new Request("http://x/api/dumate/state"))).json();

// 前置：造出来的乱局确实在（五个 id 落同一个后端，且全开着）
const before = await state();
const dupOn = before.models.filter(m => m.enabled && m.realModel === FLASH).map(m => m.key);
assert.equal(dupOn.length, 5, `前置条件：应有五行同后端开着，实际 ${dupOn.join(",")}`);
console.log(`  前置  同后端 ${FLASH} 开着 ${dupOn.length} 行：${dupOn.join(", ")}`);

const r = await action({ action: "defaults", kind: "recommended" });
assert.ok(r.ok, `推荐失败：${r.error}`);
const enabled = r.state.models.filter(m => m.enabled);
const backs = enabled.map(m => m.realModel || m.key);

assert.equal(new Set(backs).size, backs.length, `去重失败，仍有同后端重复：${backs.join(", ")}`);
assert.equal(enabled.filter(m => m.realModel === FLASH).length, 1, "同后端应只留一行");
assert.equal(enabled.filter(m => m.realModel === "qwen3.8-flash").length, 1, "qwen3.8-flash 那组也应只留一行");
assert.ok(enabled.every(m => !m.isRouter), "推荐默认不该开着自动路由档位");
// 同组留上下文最大的（glm-5 与 deepseek-v41-flash 都是 1M，并列按 key 取小 → deepseek-v41-flash）
assert.ok(enabled.some(m => m.key === "deepseek-v41-flash"), "同组应留上下文最大、并列按 key 取小，期望 deepseek-v41-flash");
assert.ok(!enabled.some(m => m.key === "glm-5"), "同组里 glm-5 应被去重掉");
assert.ok(!enabled.some(m => m.key === "qwen3.5-397b-a17b"), "397b 那行实际落 flash，应被去重掉");
// 独占后端的不能被误伤
for (const key of ["glm-53", "kimi-k3", "doubao-seed-2-0-pro", "qwen3.5-27b", "qwen3.5-35b-a3b"]) {
  assert.ok(enabled.some(m => m.key === key), `${key} 独占一个后端，不该被误伤`);
}
console.log(`  ok    推荐后 ${enabled.length} 行、后端互不相同：${enabled.map(m => m.key).join(", ")}`);

const again = await action({ action: "defaults", kind: "recommended" });
assert.deepEqual(again.state.models.filter(m => m.enabled).map(m => m.key).sort(), enabled.map(m => m.key).sort(), "推荐必须幂等");
console.log("  ok    幂等：再点一次结果一样");

assert.ok(emitted.filter(e => e[0] === "llm/models-updated").length >= 2, "批量改动后必须广播 llm/models-updated");
console.log(`  ok    广播 llm/models-updated ${emitted.filter(e => e[0] === "llm/models-updated").length} 次`);

const all = await action({ action: "defaults", kind: "all" });
assert.equal(all.kept, all.state.models.length, "全选应把每一行都点上（含路由档位）");
const none = await action({ action: "defaults", kind: "none" });
assert.equal(none.kept, 0, "全不选应清空");

// 诊断表必须现算（之前它冻在启动自检的快照上）
const rowOf = (s, key) => (s.checks ?? []).find(x => x[0] === key)?.[1];
const back2 = await action({ action: "defaults", kind: "recommended" });
assert.equal(Number(rowOf(back2.state, "选择器内启用数")), back2.state.models.filter(m => m.enabled).length,
  "诊断表的启用数必须是现值");
const allState = (await action({ action: "defaults", kind: "all" })).state;
assert.equal(Number(rowOf(allState, "选择器内启用数")), allState.models.length, "全选后诊断表要立刻反映为全部行数");
console.log(`  ok    诊断表现算：推荐后=${rowOf(back2.state, "选择器内启用数")} 全选后=${rowOf(allState, "选择器内启用数")}/${allState.models.length}`);

for (const d of disposers.slice().reverse()) { try { await d(); } catch { /* 卸载失败不影响结论 */ } }
globalThis.fetch = realFetch;
fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\nPASS：素材自造 + 断网跑 —— 同后端 ${dupOn.length} 行 → 留 1 行，独有后端不误伤，幂等，广播 ${emitted.length} 次`);
process.exit(0);
