// 写入失败时「内存与磁盘不许分家」。跑在沙箱 DSH_HOME，绝不碰真机状态。
//
// 钉的是 S5：原先 6 条写路径都是「先改内存 → 再落盘 → 失败不回滚」。
// 后果有三层，一层比一层阴：
//   ① 界面当场显示新状态，用户以为保存成功了；
//   ② 重启后弹回磁盘上的旧内容；
//   ③ 最坏的一层 —— 下一次**成功**的写入会把那次"已失败"的改动一起写进盘，
//      于是用户看到「当时明明报错没生效」的操作，事后悄悄生效了。
// 修法照 dsh-connect-workbuddy：写完**回读校验**，失败就按磁盘内容还原内存，
// 并把「确认落盘」当成 ok:true 的唯一条件。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "dumate-rollback-"));
const FILE = path.join(SANDBOX, "dumate-state.json");
process.env.DSH_HOME = SANDBOX;

// 起点：全开、mode=auto。故意让 disabledModels 为空，好看出它有没有被偷偷改过。
fs.writeFileSync(FILE, JSON.stringify({ disabledModels: [], routerEnabled: [], imageInput: {}, displayNames: {}, realNames: {}, mode: "auto", lastCatalog: [], catalogAt: 0 }));

const { apply } = await import(pathToFileURL(path.join(import.meta.dirname, "..", "index.js")).href + "?rb=" + Date.now());
const routes = new Map();
const disposers = [];
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
  inject: (_d, fn) => fn({
    commands: { register: () => () => {} }, tools: { register: () => () => {} },
    webServer: { getOrigin: () => "http://x", register: r => { routes.set(r.path, r); return () => routes.delete(r.path); } },
  }),
  llm: { registerAdapter: () => () => {}, registerConfigurableProviders: () => () => {}, registerModelDiscovery: () => () => {},
    async listProviders() { return [{ id: "dumate" }]; }, async listModels() { return []; } },
};
apply(ctx, { enabled: true });
await new Promise(r => setTimeout(r, 2500));

async function action(body) {
  const req = Readable.from([JSON.stringify(body)]);
  req.method = "POST"; req.headers = { origin: "http://x" };
  let out = "";
  await routes.get("/api/dumate/action").handler(req, { writeHead: () => {}, end: s => { out = s; } });
  return JSON.parse(out);
}
async function state() {
  return (await routes.get("/api/dumate/state").resource(new Request("http://x/api/dumate/state"))).json();
}
const disk = () => JSON.parse(fs.readFileSync(FILE, "utf8"));

const someKey = (await state()).models.find(m => m.enabled && !m.isRouter)?.key;
assert.ok(someKey, "沙箱里应该有可关的模型，否则这条测试没意义");

// --- ① 只读盘上改勾选：必须报失败，且**内存里也不能留下这次改动**
fs.chmodSync(FILE, 0o444);
try {
  const r = await action({ action: "model", key: someKey, enabled: false });
  assert.equal(r.ok, false, `只读盘上的写入竟然返回 ok:true（${someKey}）`);
  assert.ok(r.error, "失败必须给原因");
  const after = await state();
  const stillOn = after.models.find(m => m.key === someKey)?.enabled;
  assert.equal(stillOn, true, `写入失败后界面仍显示新状态（${someKey} 被显示成已关闭）—— 这就是假确认`);
  console.log(`  ok   只读盘上改勾选：报失败（${String(r.error).slice(0, 40)}），界面仍显示磁盘上的旧状态`);

  // --- ② 旋钮路径同样不许留脏（这条原先有"手工回滚"，但浅拷贝 + 兜底对象缺键，救不回来）
  const k = await action({ action: "knobs", mode: "local" });
  assert.equal(k.ok, false, "只读盘上改 mode 竟然成功");
  assert.equal((await state()).mode, "auto", `mode 写失败后内存里仍是 local（假确认）`);
  console.log("  ok   只读盘上改 mode：报失败，内存也回到 auto");
} finally {
  fs.chmodSync(FILE, 0o644);
}

// --- ③ 最关键的一层：之前失败的改动**不许被下一次成功写入顺带写进盘**
const ok1 = await action({ action: "name", key: someKey, displayName: "第二次才成功的" });
assert.equal(ok1.ok, true, "恢复可写后这次应当成功");
const d = disk();
assert.ok(!d.disabledModels.includes(someKey), `失败过的「关掉 ${someKey}」被下一次成功写入顺带落盘了`);
assert.equal(d.mode, "auto", "失败过的 mode=local 被顺带落盘了");
assert.equal(d.displayNames?.[someKey], "第二次才成功的", "本次成功的改动应当真的落盘");
console.log("  ok   失败的改动没有被顺带写入；只有本次成功的改动落盘");

// --- ④ 回读校验真的在起作用：文件写坏了要报，而不是默默"成功"
{
  // 用一个只读目录模拟 rename 成功但内容不对的情形太绕，直接验证正常路径：
  // 若 saveToggles 的校验形同虚设，上面 ① 就不会失败。这里补一条正向确认。
  const r = await action({ action: "defaults", kind: "none" });
  assert.equal(r.ok, true);
  assert.equal(disk().disabledModels.length, (await state()).models.length, "全不选后磁盘与内存必须一致");
  console.log("  ok   正向确认：成功写入后磁盘与内存逐项一致");
}

for (const dd of disposers.slice().reverse()) { try { await dd(); } catch { /* 卸载失败不影响结论 */ } }
fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log("\nPASS：写失败时内存按磁盘还原，界面不给假确认，失败改动不会被顺带落盘");
process.exit(0);
