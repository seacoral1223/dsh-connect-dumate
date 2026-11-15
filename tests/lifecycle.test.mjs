// Offline harness: mount the Host half against a cordis-faithful stub ctx and drive
// every surface, then simulate unload to prove the registrations really are owned.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { Readable } = require("node:stream");
import { pathToFileURL } from "node:url";

// 测试必须跑在临时 DSH_HOME 上：这些组件会真的写 dumate-state.json，
// 直接在真机状态文件上跑会改掉用户自己的勾选（这一版之前就干过这事）。
// 初始副本用真机那份，这样断言里的「切换前后」仍然有意义。
const REAL_STATE_DIR = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "dumate-lifecycle-"));
try {
  const src = path.join(REAL_STATE_DIR, "dumate-state.json");
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(SANDBOX, "dumate-state.json"));
} catch { /* 没副本也行，插件会自己建 */ }
process.env.DSH_HOME = SANDBOX;

const STATE = path.join(SANDBOX, "dumate-state.json");
const { apply } = await import(pathToFileURL(path.join(import.meta.dirname, "..", "index.js")).href + "?probe=" + Date.now());

const cleanups = [];
let adapter = null;
const routes = new Map(), commands = new Map(), tools = new Map();
const providers = [];
const emitted = [];
const ctx = {
  logger: { info: () => {}, warn: (...a) => console.log("  warn:", ...a), error: (...a) => console.log("  error:", ...a) },
  fiber: { entry: { options: { id: "dsh-connect-dumate" } } },
  // cordis 契约：effect 体立刻执行；返回函数=disposer；生成器跑到底，yield 出来的才是 disposer。
  effect: fn => {
    let r;
    try { r = fn(); } catch (e) { ctx.logger.error(e); return; }
    if (typeof r === "function") cleanups.push(r);
    else if (r && typeof r[Symbol.iterator] === "function") {
      for (const d of r) if (typeof d === "function") cleanups.push(d);
    }
  },
  emit: (...a) => emitted.push(a),
  get: () => undefined,
  inject: (_deps, fn) => fn({
    commands: { register: d => { const c = new Map(); c.set(d.name, d); commands.set(d.name, d); return () => commands.delete(d.name); } },
    tools: { register: d => { tools.set(d.name, d); return () => tools.delete(d.name); } },
    webServer: {
      getOrigin: () => "http://127.0.0.1:64852",
      register: r => { routes.set(r.path, r); return () => routes.delete(r.path); },
    },
  }),
  llm: {
    registerAdapter(list, a) { providers.push(...list); adapter = a; return () => { providers.length = 0; }; },
    registerConfigurableProviders: () => () => {},
    registerModelDiscovery: (_ns, fn) => { ctx.__discover = fn; },
    async listProviders() { return providers.map(id => ({ id, name: "DuMate" })); },
    async listModels(id) { return adapter.listModels(id); },
  },
};

apply(ctx, { enabled: true, mode: "gateway", pollIntervalMs: 300000 });

const wait = ms => new Promise(r => setTimeout(r, ms));
await wait(3000);

console.log("mounted: providers=[" + providers.join(",") + "] routes=[" + [...routes.keys()].join(",") + "]");
console.log("commands=[" + [...commands.keys()].join(",") + "] tools=[" + [...tools.keys()].join(",") + "]");
if (!providers.includes("dumate")) { console.log("FAIL 供应商没挂上"); process.exit(1); }
if (!routes.has("/api/dumate/state")) { console.log("FAIL 路由没挂上"); process.exit(1); }

const state = await (await routes.get("/api/dumate/state").resource(new Request("http://127.0.0.1:64852/api/dumate/state"))).json();
console.log("\nstate ok=" + state.ok + " mode=" + state.mode + " channel=" + state.channelKind
  + " catalogSource=" + state.catalogSource + " models=" + state.models.length
  + " credit=" + state.credit?.available?.toFixed?.(2));
console.log("hostView:", JSON.stringify(state.hostView));
console.log("emitted events:", emitted.map(e => e[0] + ":" + e[1]).join(", ") || "(none)");

const foreign = await routes.get("/api/dumate/state").resource(new Request("http://127.0.0.1:64852/api/dumate/state", { headers: { origin: "https://evil.example" } }));
console.log("foreign-origin ->", foreign.status, (await foreign.text()).slice(0, 60));

async function callAction(body) {
  const req = Readable.from([JSON.stringify(body)]);
  req.method = "POST";
  req.headers = { origin: "http://127.0.0.1:64852" };
  let code = 0, payload = "";
  await routes.get("/api/dumate/action").handler(req, { writeHead: c => { code = c; }, end: s => { payload = s; } });
  return { status: code, ...JSON.parse(payload) };
}
const off = await callAction({ action: "model", key: "glm-53-flash", enabled: false });
console.log("toggle off -> ok=" + off.ok + " enabled=" + off.state.models.filter(m => m.enabled).length);
await callAction({ action: "model", key: "glm-53-flash", enabled: true });
const back = await (await routes.get("/api/dumate/state").resource(new Request("http://127.0.0.1:64852/api/dumate/state"))).json();
console.log("toggle back -> enabled=" + back.models.filter(m => m.enabled).length);

console.log("\ndumate_models -> " + (await tools.get("dumate_models").execute({}, {})).split("\n").slice(0, 2).join(" / ").slice(0, 200));
const doc = await commands.get("dumate").handler({ rawInput: "doctor" });
console.log("/dumate doctor -> " + doc.kind + " | hostView 在里面: " + /hostView/.test(doc.text));
console.log("discovery ->", (await ctx.__discover({})).length, "models");

console.log("\n--- 模拟卸载（跑 collected disposers）---");
for (const d of cleanups.slice().reverse()) { try { await d(); } catch (e) { console.log("  cleanup ERR", e.message); } }
console.log("after unload: providers=[" + providers.join(",") + "] routes=[" + [...routes.keys()].join(",") + "] | disposers=" + cleanups.length);
const okUnload = providers.length === 0 && routes.size === 0;
console.log((okUnload ? "PASS" : "FAIL") + "：挂载后都在、卸载后都释放");
process.exit(okUnload ? 0 : 1);
