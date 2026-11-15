// Cold-start proof: does the picker get models immediately, while the first
// network refresh is still in flight? Uses a stub ctx (no real DSH process).
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
import { pathToFileURL } from "node:url";

// 沙箱状态目录：这个测试会写 dumate-state.json（no-cache 模式更是整份覆盖），
// 跑在真机 ~/.dsh 上会把用户的勾选、显示名和自动签到一起抹掉 —— 之前就发生过。
const REAL_STATE_DIR = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "dumate-coldstart-"));
try {
  const src = path.join(REAL_STATE_DIR, "dumate-state.json");
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(SANDBOX, "dumate-state.json"));
} catch { /* 没有副本也可以跑 */ }
process.env.DSH_HOME = SANDBOX;

const STATE = path.join(SANDBOX, "dumate-state.json");
const mode = process.argv[2] || "with-cache";

if (mode === "no-cache") {
  fs.writeFileSync(STATE, JSON.stringify({ disabledModels: [], imageInput: {}, displayNames: {}, realNames: {}, lastCatalog: [], catalogAt: 0 }));
}

const { apply } = await import(pathToFileURL(path.join(import.meta.dirname, "..", "index.js")).href + "?probe=" + Date.now());

let capturedAdapter = null;
const providers = [];
const logger = {
  info: () => {},
  warn: (...a) => console.log("  warn:", ...a),
  error: (...a) => console.log("  error:", ...a),
};
const ctx = {
  logger,
  fiber: { entry: { options: { id: "dsh-connect-dumate" } } },
  // cordis 契约：普通函数体立刻执行、返回值当 disposer；生成器要跑到底、yield 出 disposer。
  effect: fn => {
    let r;
    try { r = fn(); } catch (e) { console.log("  effect ERR", e.message); return; }
    if (typeof r === "function") return r;
    if (r && typeof r[Symbol.iterator] === "function") { for (const d of r) if (typeof d === "function") return d; }
    return undefined;
  },
  emit: () => {},
  get: () => undefined,
  inject: () => {},                       // 跳过 commands / tools / webServer 三块
  llm: {
    registerAdapter(list, adapter) { providers.push(...list); capturedAdapter = adapter; return () => {}; },
    registerConfigurableProviders: () => () => {},
    registerModelDiscovery: () => {},
    async listProviders() { return providers.map(id => ({ id, name: "DuMate" })); },
    async listModels(id) { return capturedAdapter ? capturedAdapter.listModels(id) : []; },
  },
};

apply(ctx, { enabled: true, mode: "gateway", pollIntervalMs: 300000 });

console.log(`[${mode}] 第一次网络刷新还在飞的时候问选择器：`);
const t0 = Date.now();
const immediate = await capturedAdapter.listModels("dumate");
console.log(`   listModels -> ${immediate.length} 个，用时 ${Date.now() - t0}ms；前 4：${immediate.slice(0, 4).map(m => m.id).join(", ")}`);
// 原先这里只 console.log 耗时、没有任何时间断言，于是 README / tests/README / CHANGELOG
// 里那三个互相打脸的数字（0.8 秒 / 1ms / 1161ms）一个都没被钉住。
// 断言的是**语义**：第一帧不许为了等网络而空着 —— 空组会被宿主整组隐藏。
const coldMs = Date.now() - t0;
if (coldMs > 500) { console.log(`FAIL 第一帧等了 ${coldMs}ms（>500）—— 冷启动期间选择器会是空的`); process.exit(1); }
console.log(`   ok   第一帧 ${coldMs}ms 内交得出目录（上限 500ms）`);
console.log("   resolveModel(glm-5) ->", JSON.stringify(await capturedAdapter.resolveModel("dumate", "glm-5")));
console.log("   providerInfo ->", JSON.stringify(capturedAdapter.providerInfo("dumate")));

await new Promise(r => setTimeout(r, 3500));
const later = await capturedAdapter.listModels("dumate");
console.log(`   3.5 秒后 -> ${later.length} 个`);
if (!later.length) { console.log("FAIL 刷新后还是空"); process.exit(1); }
console.log("PASS");
process.exit(0);
