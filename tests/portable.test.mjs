// 发布前自检：这个包能不能装到**别人的机器、我自己的账号**上。
// ① 跨平台找登录目录 ② 包里不许有本机隐私 ③ 发布完整性。
//
// 关于 ②：违禁样式**一律在运行时从本机推导**（用户名、账号昵称、账号 id 都从系统/登录态里现取），
// 绝不把真值写进这个文件。原因很硬：这个文件会随包发布，把真值写成正则字面量
// 等于把「作者的账号是谁」永久钉在公开代码里；而上一版就是这么干的，
// 还顺手让它跳过自己，于是自检由红转绿 —— 那是假绿灯，比没有检查更坏。
// 所以这里也**不跳过任何文件**，包括这个文件本身。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.join(import.meta.dirname, "..");
const upstream = require(path.join(ROOT, "src/upstream.cjs"));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

let bad = 0;
const warns = [];
const check = (label, ok, extra = "") => { if (!ok) bad++; console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${extra ? ` — ${extra}` : ""}`); };
const norm = s => String(s).replace(/\\/g, "/");
// 命中项只报「在哪一行、属于哪类」，绝不把命中的原文带进日志（否则这个测试自己的输出就成了泄漏面）
const redact = s => String(s).replace(/[^\s]/g, "•").slice(0, 24);

// ---------------------------------------------------------------- ① 跨平台
const originalPlatform = process.platform;
const originalEnv = { ...process.env };
const KEYS = ["APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "HOME", "USERPROFILE", "DUMATE_USER_DATA"];
// Windows 上 os.homedir() 无视 HOME 环境变量，所以模拟 POSIX 必须直接换掉 os.homedir。
// upstream.cjs 里的 `os` 与这里是同一个缓存模块对象，改它代码就能看到。
const osMod = require("os");
const originalHomedir = osMod.homedir;

function candidatesFor(platform, env = {}, homedir) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  if (homedir) osMod.homedir = () => homedir;
  try { return upstream.userDataCandidates().map(norm); } finally {
    if (homedir) osMod.homedir = originalHomedir;
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    for (const k of KEYS) delete process.env[k];
    Object.assign(process.env, originalEnv);
  }
}

const win = candidatesFor("win32", {
  APPDATA: "C:/Users/someone/AppData/Roaming",
  LOCALAPPDATA: "C:/Users/someone/AppData/Local",
  USERPROFILE: "C:/Users/someone",
});
check("Windows 同时试 APPDATA 与 LOCALAPPDATA", win.some(d => d.includes("AppData/Roaming/")) && win.some(d => d.includes("AppData/Local/")), `${win.length} 个候选`);
check("Windows 不止猜一种目录名", ["qianfan-desktop-app", "DuMate", "qianfan_desk_xdg"].every(n => win.some(d => d.endsWith(`/${n}`))));

const mac = candidatesFor("darwin", {}, "/Users/someone");
check("macOS 走 Library/Application Support", mac.length >= 2 && mac.every(d => d.startsWith("/Users/someone/Library/Application Support/")), mac[0]);
const lin = candidatesFor("linux", {}, "/home/someone");
check("Linux 走 ~/.config", lin.length >= 2 && lin.every(d => d.startsWith("/home/someone/.config/")), lin[0]);
const linXdg = candidatesFor("linux", { XDG_CONFIG_HOME: "/tmp/xdg" }, "/home/someone");
check("Linux 认 XDG_CONFIG_HOME", linXdg.every(d => d.startsWith("/tmp/xdg/")), linXdg[0]);

const custom = candidatesFor("win32", { DUMATE_USER_DATA: "D:/Dumate/profile", APPDATA: "C:/Users/x/AppData/Roaming" });
check("DUMATE_USER_DATA 严格生效：只认它，不退回扫全机", custom.length === 1 && custom[0] === "D:/Dumate/profile", `${custom.length} 个候选`);

// 显式指定的目录不存在时，必须说清是「这个目录」没有，而不是悄悄用别的登录态跑起来
const savedEnv = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME, DUM: process.env.DUMATE_USER_DATA };
process.env.DUMATE_USER_DATA = path.join(os.tmpdir(), "dumate-strict-missing-dir");
let strictDir = "unset";
try { strictDir = upstream.userDataDir(); } catch { strictDir = "THREW"; }
// 赋 undefined 会变成字符串 "undefined" 污染后面的推导，必须 delete
if (savedEnv.DUM === undefined) delete process.env.DUMATE_USER_DATA; else process.env.DUMATE_USER_DATA = savedEnv.DUM;
check("DUMATE_USER_DATA 指错时返回 null（不回退到别的账号数据）", strictDir === null || strictDir === undefined, String(strictDir));

// 找不到登录数据时不能抛
const savedHome = process.env.HOME, savedXdg = process.env.XDG_CONFIG_HOME, savedApp = process.env.APPDATA;
Object.defineProperty(process, "platform", { value: "linux", configurable: true });
process.env.HOME = "/nonexistent-user-dir-for-test";
process.env.XDG_CONFIG_HOME = "/nonexistent-user-dir-for-test/.config";
let dirOut = "unset", threw = null;
try { dirOut = upstream.userDataDir(); } catch (e) { threw = e; }
Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
process.env.HOME = savedHome; process.env.XDG_CONFIG_HOME = savedXdg; process.env.APPDATA = savedApp;
check("没有登录数据时返回 null 而不是抛", !threw && (dirOut === null || dirOut === undefined), threw ? String(threw.message) : String(dirOut));

// ---------------------------------------------------------------- ② 隐私红线
// 违禁值全部运行时推导：本机用户名、本机搭子账号的昵称与 id（拿得到才比对）
const secrets = new Set();
try {
  const u = os.userInfo().username;
  if (u && u.length >= 3) secrets.add(u);
} catch { /* 拿不到就少一条断言 */ }
try {
  const bundle = upstream.listProfiles();
  for (const p of bundle.profiles ?? []) {
    if (p.displayName && p.displayName !== "(未命名)") secrets.add(p.displayName);
    if (p.bceUserId) secrets.add(p.bceUserId);
    if (p.profileId) secrets.add(p.profileId);
  }
} catch { /* 没登录的机器上这条自然为空 */ }
const home = os.homedir();
if (home && home !== "/" && home.length >= 4) secrets.add(home);

const secretList = [...secrets].filter(Boolean);
check(`从本机推导出了 ${secretList.length} 个待排查值`, secretList.length >= 1, "推导不到就说明这台机器没登录，那 ② 只能靠通用样式");

// 通用样式：不依赖具体值
const PATTERNS = [
  ["疑似 cookie 密文（≥160 位 base64）", /[A-Za-z0-9+/]{160,}={0,2}/],
  ["疑似 bearer token", /Bearer\s+[A-Za-z0-9]{28,}/],
  ["疑似 AES 密钥字面量", /["'][0-9a-f]{64}["']/i],
  ["疑似 UUID 形态的 profileId", /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/],
  ["疑似 32 位十六进制账号 id", /["'][0-9a-f]{32}["']/i],
];

// 扫描范围 = **会进 tarball 的那些文件**（files 白名单展开），不是仓库里所有文件。
// 差别很重要：AGENTS.md 是内部逆向笔记、docs/PUBLISHING.md 是维护流程，两者都不发布。
// 把它们算进判定只会制造假失败，让人开始怀疑扫描器、然后绕过它 —— 那才是真风险。
const globRe = g => new RegExp("^" + norm(g).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
function covered(rel) {
  const r = norm(rel);
  return (pkg.files ?? []).some(f => {
    const e = norm(f);
    if (e.includes("*")) return globRe(e).test(r);
    return r === e || r.startsWith(e.replace(/\/$/, "") + "/");
  });
}
const allFiles = [];
(function walk(dir, relBase) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const rel = relBase ? `${relBase}/${e.name}` : e.name;
    if (e.isDirectory()) { walk(path.join(dir, e.name), rel); continue; }
    allFiles.push(rel);
  }
})(ROOT, "");
const shipped = allFiles.filter(covered);
check(`扫描范围就是发布范围（${shipped.length} 个文件）`, shipped.length > 12 && shipped.includes("index.js") && shipped.includes("docs/PRIVACY.md"));
for (const must of ["AGENTS.md", "docs/PUBLISHING.md"]) check(`${must} 不在发布范围里`, !shipped.includes(must));
check("tmp/ 与状态文件不在发布范围里", !shipped.some(f => f.startsWith("tmp/") || /state\.json$/.test(f)));

const scanned = [];
for (const rel of shipped) {
  if (!/\.(js|cjs|mjs|json|md|yml|svg)$/.test(rel) && rel !== "LICENSE") continue;
  scanned.push({ rel, text: fs.readFileSync(path.join(ROOT, rel), "utf8") });
}
// 守门人自己也在范围内（它会被发布，所以它自己更不能含真值）
check("扫描集包含 portable.test.mjs 自己", scanned.some(s => s.rel === "tests/portable.test.mjs"));
check(`扫了 ${scanned.length} 个发布文件`, scanned.length > 12);

// 匹配方式：ASCII 标识（用户名、家目录里的名字）必须**整词**命中才算泄漏。
// 本机用户名常常是合法 GitHub handle 的前缀，按子串匹配会把分发地址、署名这些
// 本来就该公开的东西报成泄漏 —— 子串误报的害处不是烦，是逼人关掉这条检查。
// 中文昵称没有词边界可言，仍按子串匹配。
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isAscii = s => /^[\x20-\x7e]+$/.test(s);
const hitBy = (line, s) => {
  if (!s) return false;
  if (!isAscii(s)) return line.includes(s);
  return new RegExp(`(?<![A-Za-z0-9_.\\-])${esc(s)}(?![A-Za-z0-9_\\-])`).test(line);
};

const offenders = [];
for (const { rel, text } of scanned) {
  text.split(/\r?\n/).forEach((line, i) => {
    for (const s of secretList) {
      if (hitBy(line, s)) offenders.push(`${rel}:${i + 1} 含本机隐私值（已隐去）→ ${redact(line)}`);
    }
    for (const [label, re] of PATTERNS) {
      if (re.test(line)) offenders.push(`${rel}:${i + 1} ${label} → ${redact(line)}`);
    }
  });
}
check(`发布集里没有本机隐私值与凭据样式（比对 ${scanned.length} 个文件 / ${secretList.length} 个本机值）`,
  scanned.length > 12 && secretList.length >= 1 && offenders.length === 0, offenders.slice(0, 4).join(" | ") || "零命中");

// 反向证明整词匹配没有把检查改松：真家目录必须仍然抓得住
{
  const user = os.userInfo().username;
  assert.ok(hitBy(`cd C:\\Users\\${user}\\Documents\\x`, user), "整词匹配必须仍能抓到真实家目录");
  assert.ok(hitBy(`home is ${user} here`, user), "单独出现的用户名要能抓到");
  if (user !== `${user}1223`) {
    assert.ok(!hitBy(`https://github.com/${user}1223/dsh-connect-dumate`, user), "长 handle 里的子串不该误报");
  }
  console.log("  ok   整词匹配双向验证：真路径仍抓得住，合法 handle 不误报");
}

// 运行时输出面也不许把账号主键交给浏览器：同源接口是「可能被贴出去」的面
const indexText = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
const upstreamText = fs.readFileSync(path.join(ROOT, "src/upstream.cjs"), "utf8");
const snapBlock = indexText.slice(indexText.indexOf("async function snapshot"), indexText.indexOf("async function snapshot") + 4600);
// 只看真正会返回出去的字段行（注释里提到字段名是正常的，甚至是该写的）
const snapFields = snapBlock.split(/\r?\n/).filter(l => /^\s{4,}[A-Za-z][\w]*:/.test(l) && !/\/\//.test(l));
check("snapshot 返回体里没有 accountId 字段", !snapFields.some(l => /^\s*accountId:/.test(l)), snapFields.filter(l => /accountId/.test(l)).join(" | "));
check("snapshot 返回体里没有 bceUserId 字段", !snapFields.some(l => /bceUserId/.test(l)));
check("inspect 返回的 profiles 映射里没有 bceUserId", !/bceUserId:\s*p\.bceUserId/.test(upstreamText.slice(upstreamText.indexOf("function inspect"))));
check("诊断/界面里的家目录一律缩成 ~", !/stateFile:\s*stateFile\(\)/.test(indexText) || /tidyPath|homeTilde|replace\(home/.test(indexText));

// 缩写的**形状**也要对：这是设计来整段贴进问题反馈的文本。
// 之前整串替换后 `~\AppData\Local\…` 不再以 home 开头，tidyPath 不处理它，
// 于是输出「波浪号配反斜杠」的混排 —— 看着像没脱敏干净，实际脱了，但没人敢确定。
// 从 index.js 里把真函数抠出来跑，不复制实现（复制一份迟早漂）。
{
  const grab = name => {
    const i = indexText.indexOf(`function ${name}(`);
    assert.ok(i > 0, `找不到 ${name}，这条没测到`);
    let depth = 0, end = -1;
    for (let j = indexText.indexOf("{", i); j < indexText.length; j++) {
      if (indexText[j] === "{") depth++;
      else if (indexText[j] === "}") { depth--; if (depth === 0) { end = j + 1; break; } }
    }
    return indexText.slice(i, end);
  };
  const src = `
    const os = require("os");
    const homePrefix = () => os.homedir() || "";
    ${grab("tidyPath")}
    ${grab("tidyText")}
    module.exports = { tidyPath, tidyText };
  `;
  const tmpMod = path.join(os.tmpdir(), `tidy-shape-${Date.now()}.cjs`);
  fs.writeFileSync(tmpMod, src);
  const { tidyText, tidyPath } = require(tmpMod);
  fs.rmSync(tmpMod, { force: true });
  const home = os.homedir();
  const cases = [
    [`${home}\\AppData\\Local\\Temp\\x`, "~/AppData/Local/Temp/x"],
    [`找过这些地方：${home}\\AppData\\Roaming\\qianfan-desktop-app`, "找过这些地方：~/AppData/Roaming/qianfan-desktop-app"],
    [`EPERM: rename '${home}\\.dsh\\dumate-state.json'`, "EPERM: rename '~/.dsh/dumate-state.json'"],
  ];
  for (const [input, want] of cases) {
    const got = tidyText(input);
    assert.equal(got, want, `缩写形状不对：${got}`);
    assert.ok(!got.includes(home), `还留着家目录：${got}`);
    assert.ok(!/~\\/.test(got), `波浪号后还配反斜杠：${got}`);
  }
  // 正文里的反斜杠不许动（那是正则示例/转义说明，改了反而错）
  const prose = tidyText("示例 \\d+\\w 与 C:\\\\Windows 无关");
  assert.ok(prose.includes("\\d+\\w"), `正文反斜杠被改了：${prose}`);
  check("家目录缩写形状统一成 ~/，正文反斜杠不受影响", true);
}

// ---------------------------------------------------------------- ③ 发布完整性
check("没有 private:true（它会挡住发布）", pkg.private !== true, `private=${pkg.private}`);
check("license = MIT", pkg.license === "MIT", pkg.license);
check("有 LICENSE 文件", fs.existsSync(path.join(ROOT, "LICENSE")));
check("有隐私说明（读 cookie 的插件必须有）", fs.existsSync(path.join(ROOT, "docs/PRIVACY.md")));
check("有 CHANGELOG", fs.existsSync(path.join(ROOT, "CHANGELOG.md")));
check("name 是合法 npm 包名", /^[a-z0-9][a-z0-9._-]*$/.test(pkg.name), pkg.name);
check("engines.node 有声明", !!pkg.engines?.node, pkg.engines?.node);
check("keywords 带 dsh-plugin", (pkg.keywords ?? []).includes("dsh-plugin"));
check("description 够长", (pkg.description ?? "").length > 20);
if (!pkg.repository) warns.push("缺 repository / homepage / author：要仓库地址与署名，不能替你编");

// 文档不许引用发布集之外的路径（别人拿到包打不开那些链接）
const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
const dangling = [...readme.matchAll(/tmp\/dumate\/[\w.-]+/g)].map(m => m[0]);
check("README 不引用发布集外的 tmp/ 路径", dangling.length === 0, dangling.slice(0, 3).join(", "));
// 具体余额这类账号专属数字不该进公开文档
check("README 没有大额余额样式的数字", !/\b\d{2},\d{3}\.\d{2}\b/.test(readme));

const REQUIRED = ["index.js", "client.js", "lib/adapter.js", "src/upstream.cjs", "cordis.patch.yml", "icon.svg", "README.md", "LICENSE", "docs/PRIVACY.md"];
// covered() / globRe() 已在 ② 段定义（扫描范围与覆盖判定共用同一把尺子）
for (const rel of REQUIRED) if (!covered(rel)) check(`files 覆盖了 ${rel}`, false);
check(`files 覆盖全部 ${REQUIRED.length} 个运行必需文件`, REQUIRED.every(covered));
check("CJS 核心保住 .cjs 后缀（包是 type:module）", JSON.stringify(pkg.files).includes("src/upstream.cjs") && fs.existsSync(path.join(ROOT, "src/upstream.cjs")));
check("files 里没有状态文件/临时产物", !(pkg.files ?? []).some(f => /state|tmp\/|\.log|node_modules/i.test(f)));

const patchText = fs.readFileSync(path.join(ROOT, "cordis.patch.yml"), "utf8");
check("cordis.patch.yml 用 insert，不 replace 用户配置", /insert:/.test(patchText) && !/replace:/.test(patchText));
check("patch 里的 providerId 与代码默认一致", /providerId:\s*dumate/.test(patchText));

for (const rel of REQUIRED.filter(r => /\.(js|cjs)$/.test(r))) {
  const t = fs.readFileSync(path.join(ROOT, rel), "utf8");
  const statics = [...t.matchAll(/(?:^|[^.\w])from\s+["'](@deepseek-ai\/[^"']+|dsh[^"']+)["']/g)].map(m => m[1]);
  if (statics.length) check(`${rel} 不静态 import DSH 包`, false, statics.join(","));
}
check("四个运行文件都不静态 import DSH 包（link 安装解析不到 app.asar）", REQUIRED.filter(r => /\.(js|cjs)$/.test(r)).every(rel => {
  const t = fs.readFileSync(path.join(ROOT, rel), "utf8");
  return !/(?:^|[^.\w])from\s+["'](@deepseek-ai\/|dsh)/.test(t);
}));
const adapterText = fs.readFileSync(path.join(ROOT, "lib/adapter.js"), "utf8");
check("适配器里的动态 import 有 try 兜底", /try\s*\{[\s\S]{0,200}@deepseek-ai\/dsh-llm/.test(adapterText));
check("UA 版本号不写死在旧版（每次请求都发给上游）", !/dsh-connect-dumate\/0\.[0-7]\.\d/.test(adapterText) || /version/.test(adapterText));

for (const rel of ["index.js", "src/upstream.cjs"]) {
  const t = fs.readFileSync(path.join(ROOT, rel), "utf8");
  const writes = [...t.matchAll(/fs\.(?:writeFileSync|appendFileSync|mkdirSync|rmSync)\(\s*([^,)]{1,60})/g)].map(m => m[1].trim());
  // 允许的落点白名单：状态文件本身、它的 .tmp、以及手动 Cookie 的密钥文件 —— 三者都在 DSH_HOME 里。
  // 这条断言的意义是「别写到用户别处去」，所以新增合法落点要显式加进来，而不是放宽成正则糊过去。
  const ALLOWED = /stateFile|STATE|cookieKeyFile|keyFile|path\.dirname\(f|path\.dirname\(file|tmp\b|userDataCandidates|dir\b/;
  const suspicious = writes.filter(w => !ALLOWED.test(w));
  if (suspicious.length) check(`${rel} 的写操作只落在 DSH_HOME 内`, false, suspicious.join(" | "));
}
check("运行期写操作只落在 DSH_HOME 内（状态文件 + 密钥文件）", ["index.js", "src/upstream.cjs"].every(rel => {
  const t = fs.readFileSync(path.join(ROOT, rel), "utf8");
  return [...t.matchAll(/fs\.(?:writeFileSync|appendFileSync|mkdirSync|rmSync)\(\s*([^,)]{1,60})/g)]
    .every(m => /stateFile|STATE|cookieKeyFile|keyFile|path\.dirname\(f|path\.dirname\(file|tmp\b|userDataCandidates|dir\b/.test(m[1]));
}));
// 正面确认：确实只有这两类落点，且都在同一个目录下
{
  const t = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
  check("密钥文件与状态文件同目录（都在 DSH_HOME 下）", /dumate-cookies\.key/.test(t) && /dumate-state\.json/.test(t) && /DSH_HOME/.test(t));
}

const clientText = fs.readFileSync(path.join(ROOT, "client.js"), "utf8");
check("客户端没有硬编码端口", !/127\.0\.0\.1:\d{4,5}/.test(clientText));
// 真正要守的是「客户端只跟自己的同源接口说话」，不是「文案里不许出现网址」——
// 登录指引里必须写出 console.bce.baidu.com 让人去登录，那是说明文字。
const fetches = [...clientText.matchAll(/fetch\(\s*(["'`])([^"'`]+)\1/g)].map(m => m[2]);
check("客户端所有 fetch 都是同源相对路径", fetches.length > 0 && fetches.every(u => u.startsWith("/api/")), fetches.join(" , "));
check("客户端不直接请求上游域名", !/fetch\([^)]*(dumate-svc|console\.bce)/.test(clientText));
// 面板读的键名必须和宿主写的键名一致，否则界面永远显示占位符
// 只比**数据字段**（credit.consumedXxx），不比文案键 —— 文案键里也有 consumed24 这种名字，
// 早先按 `consumed(\w+)` 全局匹配会把 t("panel.consumed24") 也算成字段，报出假不一致。
const hostKeys = [...new Set([...indexText.matchAll(/credit\.consumed(\w+)|consumed(\w+):\s/g)].map(m => m[1] ?? m[2]).filter(Boolean))];
const clientKeys = [...new Set([...clientText.matchAll(/credit\.consumed(\w+)/g)].map(m => m[1]))];
check("宿主与客户端的消耗字段名一致", hostKeys.length > 0 && clientKeys.every(k => hostKeys.includes(k)), `宿主=${hostKeys} 客户端=${clientKeys}`);

for (const w of warns) console.log(`  待补 ${w}`);
console.log(bad ? `\nFAIL：${bad} 项不过` : `\nPASS：跨平台 / 隐私（不跳过任何文件）/ 发布完整性全过${warns.length ? `，另有 ${warns.length} 项待补` : ""}`);
process.exit(bad ? 1 : 0);
