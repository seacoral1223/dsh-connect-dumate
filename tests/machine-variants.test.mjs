// 「本机看不见、别人一定踩」的四种机器形态回归。全部离线：假 App 目录 + 假上游。
//
// 这四条都是 2026-11-16 对抗审查挖出来的，共同点是在**开发机自己的形态**下永远正常：
//   S2 只有一个账号档时，选谁都是 active 档，走的是顶层 cookies 兜底 → 永远不坏；
//   S1 装了 App 时 dir 永远非 null，readCatalog(null) 那条路径根本不执行；
//   S13 内层目录正好叫 qianfan_desk_xdg 时，那段"扫描候选"是死代码也看不出来；
//   S3 密钥文件好着的时候，读取路径不会覆盖它 —— 一次 EBUSY 才暴露。
// 所以这里逐个构造出**非默认形态**，而不是只测"我这台机器现在这样"。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.join(import.meta.dirname, "..");
const up = require(path.join(ROOT, "src/upstream.cjs"));

const box = fs.mkdtempSync(path.join(os.tmpdir(), "dumate-variants-"));
const APP = path.join(box, "appdata", "qianfan-desktop-app");
const INNER = path.join(APP, "qianfan_desk_xdg");
fs.mkdirSync(path.join(INNER, "u-aaa", "config", "opencode"), { recursive: true });
fs.mkdirSync(path.join(APP, "data", "sts"), { recursive: true });

const key = Buffer.alloc(32, 7);
const ck = c => up.encryptCookies(c, key);
const A = [{ name: "bce-sessionid", value: "AAA-session" }, { name: "bce-user-info", value: '"A-info"' }];
const B = [{ name: "bce-sessionid", value: "BBB-session" }, { name: "bce-user-info", value: '"B-info"' }];

fs.writeFileSync(path.join(APP, "auth.json"), JSON.stringify({
  activeProfileId: "p-one",
  cookies: ck(A),
  accountProfiles: [
    { profileId: "p-one", displayName: "号一", bceUserId: "u-aaa", encryptedCookies: ck(A), loginType: "baidu", lastLogin: 1 },
    { profileId: "p-two", displayName: "号二", bceUserId: "u-bbb", encryptedCookies: ck(B), loginType: "baidu", lastLogin: 2 },
  ],
}));
fs.writeFileSync(path.join(APP, ".cookie-key"), key);
fs.writeFileSync(path.join(INNER, "u-aaa", "config", "opencode", "opencode.json"), JSON.stringify({
  provider: { QianfanPersonalQuota: { options: { baseURL: "http://127.0.0.1:9001/api/qianfanproxy/v1" } } },
}));

// DUMATE_USER_DATA 严格生效（不回退扫全机），下面换目录就是换它
const useApp = p => { process.env.DUMATE_USER_DATA = p; };
useApp(APP);

// --- S2 多账号档：非 active 档也必须解得开
{
  const lp = up.listProfiles();
  assert.equal(lp.profiles.length, 2, "假目录里应有两个账号档");
  assert.deepEqual(lp.profiles.map(p => p.usable), [true, true], "两档都该被标为可用");
  const seen = {};
  for (const [id, expect] of [["p-one", "AAA-session"], ["p-two", "BBB-session"]]) {
    const c = up.clientForProfile(id, lp);
    assert.ok(c, `clientForProfile(${id}) 返回 null —— 非 active 档解不开（这就是选第二个账号后通道消失的原因）`);
    const sess = c.cookies.find(x => x.name === "bce-sessionid")?.value;
    assert.equal(sess, expect, `${id} 解出来的是别人的 Cookie：${sess}`);
    seen[id] = sess;
  }
  assert.notEqual(seen["p-one"], seen["p-two"], "两档必须各自用自己的凭据，不能都退回顶层那份");
  console.log("  ok   S2 多账号档：非 active 档也解得开，且各用各的凭据");
}

// --- S1 没有 App 目录：读取路径一律不抛，且只靠手动 Cookie 能建客户端
{
  useApp(path.join(box, "does-not-exist"));
  assert.equal(up.userDataDir(), null, "userDataDir 应老实返回 null");
  assert.equal(up.readCatalog(null, "u1"), null, "readCatalog(null) 必须返回 null，不能抛 ERR_INVALID_ARG_TYPE");
  assert.equal(up.readCatalog(undefined, "u1"), null, "同上");
  assert.equal(up.innerDir?.(null, ["x"]) ?? null, null);
  const manual = [{ name: "bce-sessionid", value: "M" }, { name: "bce-user-info", value: '"X"' }];
  const cli = up.clientFromCookies(manual, null);
  assert.ok(cli?.cloud && cli?.gateway, "只有手动 Cookie 时也要能建出云端客户端");
  const r = await up.inspect({ mode: "auto", authSource: "manual", manualCookies: manual, withFallback: false });
  assert.ok(!String(r.reasons?.join(" ") ?? "").match(/must be of type string|ERR_INVALID_ARG_TYPE|undefined is not/),
    `原因里不许出现 Node 英文报错：${r.reasons?.join(" ")}`);
  console.log("  ok   S1 无 App 目录：不抛、客户端建得出、原因都是中文");
}

// --- S13 内层目录名不在候选里：扫描必须真的下探 uid 一层
{
  const ALT = path.join(box, "alt", "qianfan-desktop-app");
  fs.mkdirSync(path.join(ALT, "DuMateProfile", "u1", "config", "opencode"), { recursive: true });
  fs.writeFileSync(path.join(ALT, "DuMateProfile", "u1", "config", "opencode", "opencode.json"), JSON.stringify({
    provider: { QianfanPersonalQuota: { options: { baseURL: "http://127.0.0.1:1234/api/qianfanproxy/v1" } } },
  }));
  const rc = up.readCatalog(ALT, "u1");
  assert.ok(rc, "内层目录叫别的名字时 readCatalog 返回 null —— 那段候选扫描是死代码");
  assert.match(rc.baseURL ?? "", /1234/, `命中了错目录：${JSON.stringify(rc)}`);
  console.log("  ok   S13 内层目录名非默认时也能找到本地代理配置");
}

// --- S3 密钥被截断：读取路径绝不覆盖密钥文件，且状态要能区分
{
  const dsh = path.join(box, "dsh");
  fs.mkdirSync(dsh, { recursive: true });
  process.env.DSH_HOME = dsh;
  const kf = path.join(dsh, "dumate-cookies.key");
  const goodKey = Buffer.alloc(32, 11);
  fs.writeFileSync(kf, Buffer.alloc(31, 11)); // 模拟同步盘截断成 31 字节
  const broken = fs.readFileSync(kf);
  const cipher = up.encryptCookies(A, goodKey);
  fs.writeFileSync(path.join(dsh, "dumate-state.json"), JSON.stringify({
    manualCookiesCipher: cipher, manualCookiesAt: Date.now(), manualCookieNames: ["bce-sessionid", "bce-user-info"],
    authSource: "manual", disabledModels: [], routerEnabled: [], imageInput: {}, displayNames: {}, realNames: {},
  }));

  const { apply } = await import(pathToFileURL(path.join(ROOT, "index.js")).href + "?v=" + Date.now());
  const routes = new Map();
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    fiber: { entry: { options: { id: "dsh-connect-dumate" } } },
    effect: fn => { try { const r = fn(); if (typeof r === "function") return r; if (r && r[Symbol.iterator]) for (const d of r) if (typeof d === "function") return d; } catch { /* */ } },
    emit: () => {}, get: () => undefined,
    inject: (_d, f2) => f2({ commands: { register: () => () => {} }, tools: { register: () => () => {} },
      webServer: { getOrigin: () => "http://x", register: r => { routes.set(r.path, r); return () => routes.delete(r.path); } } }),
    llm: { registerAdapter: () => () => {}, registerConfigurableProviders: () => () => {}, registerModelDiscovery: () => () => {},
      async listProviders() { return [{ id: "dumate" }]; }, async listModels() { return []; } },
  };
  apply(ctx, { enabled: true });
  await new Promise(r => setTimeout(r, 2500));
  for (let i = 0; i < 3; i++) {
    await (await routes.get("/api/dumate/state").resource(new Request("http://x/api/dumate/state"))).json();
  }
  const after = fs.readFileSync(kf);
  assert.equal(after.length, broken.length, `密钥文件被改写了（${broken.length}→${after.length} 字节）—— 覆盖旧密钥等于把密文永久作废`);
  assert.ok(after.every((b, i) => b === broken[i]), "密钥字节变了：读取路径写了盘");
  const st = await (await routes.get("/api/dumate/state").resource(new Request("http://x/api/dumate/state"))).json();
  assert.equal(st.login.manual.state, "key-missing",
    `必须区分「没导入」和「导入过但密钥不可用」，实际 state=${st.login.manual.state}`);
  assert.equal(st.login.manual.present, false);
  console.log("  ok   S3 密钥损坏：读取三次一个字节都没动，且状态可区分");
}

fs.rmSync(box, { recursive: true, force: true });
console.log("\nPASS：四种非默认机器形态都不崩、不误覆盖、状态说得清");
process.exit(0);
