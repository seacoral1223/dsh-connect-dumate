// 「方式二：手动导入 Cookie」的端到端回归。跑在沙箱 DSH_HOME 上。
//
// 为什么值得单独钉：这条路有两个静默失效点，都是实测踩出来的 ——
//   ① `expirationDate: 0` 是「会话级、无到期」，不是「已过期」；当过期处理会把导入的 Cookie 全丢光，
//      而报错只说「登录态无效」，人根本想不到是解析层吞掉了。
//   ② `bce-user-info` 的值本身就带成对双引号；当包裹符剥掉，值短 2 字符，上游直接拒。
// 全程还断言：Cookie 的**值**绝不出现在状态文件、返回值或日志里。
//
// 需要本机装有并登录过百度搭子桌面版（用它做「真 Cookie 的来源」）；拿不到就整份跳过，不算失败。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const upstream = require(path.join(import.meta.dirname, "..", "src/upstream.cjs"));

const bundle = upstream.listProfiles();
const client = upstream.clientForProfile(null, bundle);
if (!client) {
  console.log("SKIP：这台机器没有可用的搭子登录态，手动导入这条路只能靠 portable 用例的纯函数部分覆盖");
  process.exit(0);
}
const real = client.cookies.filter(c => ["bce-sessionid", "bce-user-info"].includes(c.name));
const secretValues = real.map(c => String(c.value));
const pasted = real.map(c => `${c.name}=${c.value}`).join("; ");

// --- 纯函数层：三种格式 + 两个静默坑
const round = upstream.parseCookieInput(pasted);
assert.equal(round.format, "header");
assert.equal(round.cookies.length, real.length, "header 往返不该丢条目");
for (let i = 0; i < real.length; i++) {
  assert.equal(round.cookies[i].value, real[i].value, `${real[i].name} 的值必须逐字符一致（引号也算）`);
}
console.log("  ok   header 文本往返：值逐字符一致（含 bce-user-info 自带的双引号）");

// 会话级 Cookie（没有到期字段）必须仍然被发出去
const header = upstream.buildCookieHeader
  ? null : null; // buildCookieHeader 未导出，用换 token 这一步间接验（下面）
const netscape = upstream.parseCookieInput([
  "#HttpOnly_.bce.baidu.com\tTRUE\t/\tTRUE\t0\tbce-sessionid\tsess-value",
  ".bce.baidu.com\tFALSE\t/\tFALSE\t0\tbce-user-info\t\"csrf-value\"",
].join("\n"));
assert.equal(netscape.cookies.length, 2, "cookies.txt 的 #HttpOnly_ 前缀不是注释，丢掉的就是最关键那条");
assert.equal(netscape.cookies[0].httpOnly, true);
assert.equal(netscape.cookies[1].value, '"csrf-value"', "Netscape 格式同样保留原值");
console.log("  ok   cookies.txt：#HttpOnly_ 前缀被识别成 HttpOnly 标记而不是注释");

assert.deepEqual(upstream.checkCookies([{ name: "bce-user-info", value: "x" }]).missing, ["bce-sessionid"]);
assert.equal(upstream.checkCookies([{ name: "bce-long-term-sessionid", value: "x" }, { name: "bce-user-info", value: "y" }]).ok, false,
  "实测 bce-long-term-sessionid 顶替不了 bce-sessionid，别在校验里放过");
console.log("  ok   checkCookies 的必需集与实测一致");

// 手动 Cookie 单独就能换到 token（不碰 App 的凭据对象）
const solo = upstream.clientFromCookies(round.cookies, null);
const token = await solo.gateway.get({ force: true });
assert.ok(typeof token === "string" && token.length > 20, "手动导入的 Cookie 换不到 token");
console.log(`  ok   只用粘回来的 Cookie 换到网关 token（长度 ${token.length}）`);

// --- Host 层：导入 / 切换 / 清除 + 明文不外泄
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "dumate-manual-login-"));
process.env.DSH_HOME = SANDBOX;
const { apply } = await import(pathToFileURL(path.join(import.meta.dirname, "..", "index.js")).href + "?ml=" + Date.now());

const routes = new Map();
const logs = [];
const disposers = [];
let adapter = null;
const ctx = {
  logger: { info: (...a) => logs.push(a.join(" ")), warn: (...a) => logs.push(a.join(" ")), error: (...a) => logs.push(a.join(" ")) },
  fiber: { entry: { options: { id: "dsh-connect-dumate" } } },
  effect: fn => {
    let r; try { r = fn(); } catch { return; }
    if (typeof r === "function") disposers.push(r);
    else if (r && typeof r[Symbol.iterator] === "function") for (const d of r) if (typeof d === "function") disposers.push(d);
  },
  emit: () => {}, get: () => undefined,
  inject: (_d, fn) => fn({
    commands: { register: () => () => {} },
    tools: { register: () => () => {} },
    webServer: { getOrigin: () => "http://x", register: r => { routes.set(r.path, r); return () => routes.delete(r.path); } },
  }),
  llm: {
    registerAdapter: (list, a) => { adapter = a; return () => { adapter = null; }; },
    registerConfigurableProviders: () => () => {},
    registerModelDiscovery: () => () => {},
    listProviders: async () => [], listModels: async () => [],
  },
};
apply(ctx, { enabled: true });
await new Promise(r => setTimeout(r, 3000));

async function action(body) {
  const req = Readable.from([JSON.stringify(body)]);
  req.method = "POST"; req.headers = { origin: "http://x" };
  let payload = "";
  await routes.get("/api/dumate/action").handler(req, { writeHead: () => {}, end: s => { payload = s; } });
  return JSON.parse(payload);
}
const state = async () => (await routes.get("/api/dumate/state").resource(new Request("http://x/api/dumate/state"))).json();

const junk = await action({ action: "login", kind: "import", text: "这不是 cookie" });
assert.equal(junk.ok, false);
assert.match(junk.error, /没认出格式|缺 /);
const half = await action({ action: "login", kind: "import", text: `bce-user-info=${secretValues[secretValues.length - 1]}` });
assert.equal(half.ok, false);
assert.match(half.error, /bce-sessionid/, "缺哪一项必须点名说");
console.log("  ok   垃圾与缺项都被拒，且说清缺哪个");

// 粘贴形态的边界（2026-11-16 修）：
// ① 从 Network 面板复制一定带 `Cookie:` 前缀 —— 不剥掉的话第一个键名变成
//    `Cookie: bce-sessionid`，通不过名字校验被**静默丢掉**，而它恰好是最关键那一个，
//    报错只会说「缺 bce-sessionid」，没人想到是前缀的事。
// ② 浏览器插件导出的 cookies.txt 有六列形状（没有 expiry 列），原先要求 ≥7 列，
//    整份文件被判「没有可用行」。
{
  const withPrefix = upstream.parseCookieInput(`Cookie: ${pasted.replace(/^Cookie:\s*/i, "")}`);
  assert.equal(withPrefix.cookies.length, 3, `带 Cookie: 前缀应当照样解析出 3 条，实际 ${withPrefix.cookies.length}`);
  assert.ok(withPrefix.cookies.some(c => c.name === "bce-sessionid"), "前缀没剥掉，bce-sessionid 被丢了");
  const checkP = upstream.checkCookies(withPrefix.cookies);
  assert.equal(checkP.ok, true, `带前缀的粘贴校验不过：${checkP?.missing?.join(",")}`);
  console.log("  ok   带 `Cookie:` 前缀的粘贴：前缀剥掉，两条必需项都在");

  // 标准六列 netscape：domain flag path expiry name value
  const exp = Math.floor(Date.now() / 1000) + 86400;
  const sixCol = [
    `.bce.baidu.com\tTRUE\t/\t${exp}\tbce-sessionid\t001dSESSION`,
    `.bce.baidu.com\tTRUE\t/\t${exp}\tbce-user-info\t"2026-11-16T00:00:00Z|abc"`,
  ].join("\n");
  const r6 = upstream.parseCookieInput(sixCol);
  assert.equal(r6.format, "netscape", "六列文件应当被认出是 cookies.txt");
  assert.equal(r6.cookies.length, 2, `六列被整份丢掉了：${r6.error}`);
  assert.equal(r6.cookies[0].name, "bce-sessionid", `六列的列序取错了，name=${r6.cookies[0].name}`);
  assert.equal(r6.cookies[0].value, "001dSESSION");
  assert.equal(r6.cookies[0].expirationDate, exp, "六列的 expiry 在第 4 列（索引 3），不是没有");
  assert.equal(r6.cookies[1].value, '"2026-11-16T00:00:00Z|abc"', "值里的成对引号必须原样保留");
  console.log("  ok   六列 cookies.txt 按标准列序解析（expiry 在索引 3）");

  // 名字里带空格/冒号的行要说清，不许静默丢
  const junk = upstream.parseCookieInput("Cookie 头: bce-user-info=x");
  assert.ok(!junk.error || /不像 Cookie|前缀|表头/.test(junk.error), `含糊报错：${junk.error}`);
}

const good = await action({ action: "login", kind: "import", text: pasted });
assert.equal(good.ok, true, `导入失败：${good.error}`);
assert.equal(good.verified, true, "导入必须真的验过才存");
assert.equal(good.names.length, good.count, "回执给名字与条数，不给值");
assert.ok(good.names.every(n => !secretValues.includes(n)), "names 里只能是名字");
console.log(`  ok   导入成功且已验证（${good.count} 条：${good.names.join(",")}）`);

// 回执必须说清「这份 Cookie 现在到底有没有被用上」。
// auto + 桌面版可用时它只是备胎，而导入 Cookie 的人多半正是想换账号 ——
// 不写这句，他会以为已经换上了，然后继续用桌面版那个号说话。
assert.ok(typeof good.note === "string" && good.note.length > 10, "导入回执必须有一句说明实际生效情况");
assert.ok(typeof good.inUse === "string", "回执必须带 inUse（实际用的凭据来源）");
if (good.inUse !== "manual") {
  assert.ok(/只用手动导入/.test(good.note), `没生效时要把切换动作说清楚：${good.note}`);
  console.log(`  ok   未生效时回执给出切换指引（inUse=${good.inUse}）`);
} else {
  console.log(`  ok   已生效（inUse=manual）`);
}
// state 里配置值与实际值要能同时看到，界面才有机会提示不一致
const sChk = await state();
assert.ok("authSource" in sChk.login && "inUse" in sChk.login,
  "login 必须同时给「配置选的」和「实际在用的」，否则界面无法提示两者不一致");

const s1 = await state();
assert.equal(s1.login.manual.present, true);
assert.equal(s1.login.manual.sufficient, true);
assert.equal(s1.login.app.available, true, "App 是否可用必须是布尔值，不能是个被 JSON 丢掉的函数");
console.log("  ok   login.app.available 是值不是函数引用（函数会被 stringify 静默丢掉）");

const sw = await action({ action: "login", kind: "source", value: "manual" });
assert.equal(sw.ok, true);
const s2 = await state();
assert.equal(s2.ok, true, "authSource=manual 时通道必须真的可用");
assert.equal(s2.channelKind, "gateway");
assert.ok(s2.models.length > 0);
console.log(`  ok   切到 manual 后通道仍通（目录 ${s2.models.length} 条）`);

const bogus = await action({ action: "login", kind: "source", value: "wechat" });
assert.equal(bogus.ok, false);

const onDisk = fs.readFileSync(path.join(SANDBOX, "dumate-state.json"), "utf8");
assert.match(onDisk, /manualCookiesCipher/, "存的是密文");
for (const v of secretValues) {
  assert.ok(!onDisk.includes(v), "状态文件里不许出现 Cookie 明文");
  assert.ok(!JSON.stringify(s2).includes(v), "返回值里不许出现 Cookie 明文");
  assert.ok(!logs.some(l => l.includes(v)), "日志里不许出现 Cookie 明文");
}
assert.ok(fs.statSync(path.join(SANDBOX, "dumate-cookies.key")).size === 32, "密钥文件应独立存在且 32 字节");
console.log("  ok   明文只存在于内存：状态文件、返回值、日志三处逐值比对均无");

const clr = await action({ action: "login", kind: "clear" });
assert.equal(clr.ok, true);
const s3 = await state();
assert.equal(s3.login.manual.present, false);
assert.ok(!/manualCookiesCipher":"[^"]+/.test(fs.readFileSync(path.join(SANDBOX, "dumate-state.json"), "utf8")), "清除后密文要真的没了");
console.log("  ok   清除后密文从文件里消失");

await action({ action: "login", kind: "source", value: "auto" });
for (const d of disposers.slice().reverse()) { try { await d(); } catch { /* 卸载失败不影响结论 */ } }
fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log("\nPASS：手动导入 Cookie 全流程（解析→校验→验证→存储→切换→清除），明文不外泄");
process.exit(0);
