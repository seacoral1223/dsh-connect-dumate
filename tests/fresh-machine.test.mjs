// Fresh-machine simulation: no DuMate install, no state file, no network.
// The provider group must still be non-empty, otherwise DSH hides it entirely.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HERE = path.join(import.meta.dirname, "..");
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "dumate-fresh-"));
process.env.APPDATA = sandbox;
process.env.DSH_HOME = sandbox;

let upstreamFails = 0;
const { apply } = await import(pathToFileURL(path.join(HERE, "index.js")).href + "?fresh=" + Date.now());
// 让 inspect 也失败：模拟网络完全不通
const upstreamPath = path.join(HERE, "src", "upstream.cjs");

const cleanups = [];
let adapter = null;
const providers = [];
const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  fiber: { entry: { options: { id: "dsh-connect-dumate" } } },
  effect: fn => {
    let r; try { r = fn(); } catch { return; }
    if (typeof r === "function") cleanups.push(r);
    else if (r && typeof r[Symbol.iterator] === "function") for (const d of r) if (typeof d === "function") cleanups.push(d);
  },
  emit: () => {},
  get: () => undefined,
  inject: () => {},
  llm: {
    registerAdapter(list, a) { providers.push(...list); adapter = a; return () => { providers.length = 0; }; },
    registerConfigurableProviders: () => () => {},
    registerModelDiscovery: () => {},
    async listProviders() { return providers.map(id => ({ id, name: "DuMate" })); },
    async listModels(id) { return adapter.listModels(id); },
  },
};

// 用一个会抛的 upstream 覆盖：先加载真模块，再 monkey-patch 它的 inspect
const upstream = await import("node:module").then(m => m.createRequire(import.meta.url)(upstreamPath));
const realInspect = upstream.inspect;
upstream.inspect = async (opts) => {
  // 完全离线的机器：目录都不存在，直接抛
  if (opts?.forceFail !== false) { upstreamFails++; throw new Error("offline: 网络不可达"); }
  return realInspect(opts);
};

apply(ctx, { enabled: true, mode: "auto", pollIntervalMs: 300000 });

const rows = await adapter.listModels("dumate");
console.log("离线全新机器：");
console.log("  providers        =", providers);
console.log("  inspect 抛过      =", upstreamFails, "次");
console.log("  listModels        =", rows.length, "个 ->", rows.map(r => r.id).join(", "));
const info = await adapter.resolveModel("dumate", "glm-5");
console.log("  resolveModel     =", JSON.stringify(info));
const unknown = await adapter.resolveModel("dumate", "根本没这个");
console.log("  未知模型也不抛    =", JSON.stringify(unknown));

const ok = providers.length === 1 && rows.length > 0 && info.context.contextWindow > 0 && unknown.context.contextWindow > 0;
console.log("\n" + (ok ? "PASS" : "FAIL") + "：断网 + 全新机器，这一组仍然有模型可列（不会被 buildModelCatalog 隐藏）");
fs.rmSync(sandbox, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
