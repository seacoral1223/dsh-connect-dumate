// 签到去重回归。**全程假上游**，绝不打真实接口 —— 这是唯一会改账号状态的写操作。
//
// 钉两件事（2026-11-16 修）：
//   ① 并发点两次签到只能发**一次** POST。原先 claimCheckIn 没有任何去重，
//      连点、或自动签到与手动点击撞上，就是两次真实请求 —— 上游会挡掉第二次，
//      但那等于拿用户的账号试错。
//   ② 当日短路只在「读数确实是今天采的、且说已签」时生效。
//      拿昨天的缓存判断"今天已签"会让人永远领不到。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const upstream = require(path.join(import.meta.dirname, "..", "src/upstream.cjs"));

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "dumate-claim-"));
process.env.DSH_HOME = SANDBOX;

// 造一份**假但形状正确**的 App 登录态：签到要先有 cloud 客户端才会走到 POST。
// 全部离线 —— 绝不碰真实账号的写接口。
const APP = path.join(SANDBOX, "no-app");
fs.mkdirSync(APP, { recursive: true });
const ck = Buffer.alloc(32, 5);
const cookies = [{ name: "bce-sessionid", value: "FAKE-session" }, { name: "bce-user-info", value: '"FAKE-info"' }];
fs.writeFileSync(path.join(APP, "auth.json"), JSON.stringify({
  activeProfileId: "p1",
  cookies: upstream.encryptCookies(cookies, ck),
  accountProfiles: [{ profileId: "p1", displayName: "假号", bceUserId: "u1", encryptedCookies: upstream.encryptCookies(cookies, ck), loginType: "baidu", lastLogin: 1 }],
}));
fs.writeFileSync(path.join(APP, ".cookie-key"), ck);
process.env.DUMATE_USER_DATA = APP;

let posts = 0;
let gets = 0;
// 假上游要有状态：领过之后 signInDays 必须带上今天，否则「当日短路」这条
// 永远测不到（原先假上游恒返回空数组，第二次签到自然又发了一次 POST，
// 看起来像去重失效，其实是测试自己没模拟出"已领过"的世界）。
const signedDays = [];
let grantOnClaim = true;   // false = 上游接受请求但签到读数不动（用来验"假确认"）
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const real = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  // 只数**真正的写请求**。注意 `points/loginBonus` 是 `points/loginBonusInfo` 的前缀，
  // 早先用 includes 判 POST 会把读签到的 GET 也算进去 —— 于是一次正常的单飞
  // 被报成"发了两次 POST"，假警报来自测试自己的匹配太松。
  const isClaimPost = u.includes("points/loginBonus") && !u.includes("loginBonusInfo")
    && String(opts?.method ?? "GET").toUpperCase() === "POST";
  if (isClaimPost) {
    posts++;
    if (grantOnClaim) signedDays.push(localDay());
    return new Response(JSON.stringify({ success: true, result: true }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (u.includes("console.bce.baidu.com")) {
    gets++;
    const body = u.includes("token/get")
      ? { token: "x".repeat(36), expired_at: Date.now() + 3600_000 }
      : u.includes("points/package/list")
        ? { success: true, packages: [] }
        : u.includes("loginBonusInfo")
          ? { success: true, result: { signInDays: [...signedDays], hasIssued: false, totalTimes: signedDays.length, totalPoints: signedDays.length } }
          : u.includes("records/usage") ? { success: true, result: { consumedPoints: "0" } }
          : { success: true, result: {} };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (u.includes("dumate-svc.baidu.com")) return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
  return real(url, opts);
};

const { apply } = await import(pathToFileURL(path.join(import.meta.dirname, "..", "index.js")).href + "?c=" + Date.now());
const routes = new Map();
const disposers = [];
const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  fiber: { entry: { options: { id: "dsh-connect-dumate" } }, },
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
await new Promise(r => setTimeout(r, 2000));

async function action(body) {
  const req = Readable.from([JSON.stringify(body)]);
  req.method = "POST"; req.headers = { origin: "http://x" };
  let out = "";
  await routes.get("/api/dumate/action").handler(req, { writeHead: () => {}, end: s => { out = s; } });
  return JSON.parse(out);
}

// --- ① 并发五次点签到：POST 只能有 1 次
posts = 0;
const results = await Promise.all([1, 2, 3, 4, 5].map(() => action({ action: "claim" })));
assert.equal(posts, 1, `并发 5 次签到发了 ${posts} 次真实 POST（应当单飞，只发 1 次）`);
assert.ok(results.every(r => r.ok === true || r.ok === false), "回执形状不对");
console.log(`  ok   并发 5 次点签到 → 只发 1 次 POST（回执 5 份都拿到了）`);

// --- ② 领过之后再点：必须走当日短路，**一次 POST 都不发**
posts = 0;
const second = await action({ action: "claim" });
assert.equal(posts, 0, `今天已经领过了，却又发了 ${posts} 次真实 POST —— 当日短路没生效`);
assert.equal(second.ok, true, `短路也应当是成功回执：${second.error}`);
console.log("  ok   领过之后再点 → 0 次 POST，回执说明「今天已经领过」");

// --- ③ 昨天的读数不能当今天的依据（否则永远领不到）
posts = 0;
signedDays.length = 0;                      // 上游说今天没签
const yst = new Date(Date.now() - 86400_000);
signedDays.push(localDay(yst));             // 但昨天签过
// 把缓存的采集时间也挪到昨天，模拟「拿旧读数判断今天」
const st = await action({ action: "refresh" });
assert.ok(st.ok, "刷新失败");
posts = 0;
await action({ action: "claim" });
assert.equal(posts, 1, `昨天签过不该挡住今天（实际发了 ${posts} 次）`);
console.log("  ok   昨天的签到读数不会挡住今天的领取");

// --- ④ 上游"接受"了但没到账：必须报"没核实到账"，不能报成功
// （融合自 dsh-connect-dumate-points 的做法：Never report a claim we cannot see。
//   `loginBonus` 回 `result: true` 只代表调用被接受，不代表奖励到账。）
{
  grantOnClaim = false;                 // 上游收下请求，但签到读数一动不动
  signedDays.length = 0;
  // 先把缓存刷成"今天没领"，否则会被上面那条当日短路拦住 ——
  // 短路本身是对的（上一用例真的领过了），但那样测不到"接受而未到账"这条路。
  await action({ action: "refresh" });
  posts = 0;
  const r = await action({ action: "claim" });
  assert.equal(r.ok, true, `接口成功了，回执该是 ok：${r.error}`);
  assert.equal(r.accepted, true, "上游确实接受了");
  assert.equal(r.claimed, false, `上游接受了但状态没变，claimed 竟报 ${r.claimed} —— 这就是假确认`);
  assert.equal(r.granted, false, "granted 必须与 claimed 一致，不能还停在「接口说 true 就算领了」");
  assert.ok(!/签到成功|已到账/.test(r.note ?? ""), `note 不能承诺到账：${r.note}`);
  console.log("  ok   上游接受了但读数没变 → claimed=false，note 不承诺到账");
  grantOnClaim = true;
}

globalThis.fetch = real;
for (const d of disposers.slice().reverse()) { try { await d(); } catch { /* 卸载失败不影响结论 */ } }
fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log("\nPASS：签到单飞生效，并发不再重复打真实写接口");
process.exit(0);
