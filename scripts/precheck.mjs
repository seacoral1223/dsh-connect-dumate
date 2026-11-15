// 发布前自检：把「发出去才发现的问题」在这里拦住。
// 用法：node scripts/precheck.cjs   （或 npm run publish:check）
// 不联网也能跑大部分检查；GitHub 地址与 npm 登录状态需要联网，失败会明确说是哪一条。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const ROOT = path.join(import.meta.dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const require = createRequire(import.meta.url);

let bad = 0;
const ok = (label, pass, extra = "") => { if (!pass) bad++; console.log(`${pass ? "  ok  " : "  FAIL"} ${label}${extra ? ` — ${extra}` : ""}`); };

// ① 元数据齐不齐
const repoUrl = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url ?? "";
ok("repository 已填", !!repoUrl, repoUrl || "缺");
ok("author 已填", !!pkg.author, pkg.author ?? "缺");
ok("homepage 已填", !!pkg.homepage, pkg.homepage ?? "缺");
ok("bugs 已填", !!pkg.bugs, JSON.stringify(pkg.bugs ?? null));
ok("license 是 MIT", pkg.license === "MIT");
ok("没有 private:true", pkg.private !== true);
ok("engines.dsh 已声明", !!pkg.engines?.dsh, pkg.engines?.dsh);

// ② repository 必须指向一个真的、且名字对的仓库（发出去的包不能指着 404）
const m = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(repoUrl);
if (m) {
  const [, owner, name] = m;
  ok("仓库名与包名一致", name === pkg.name || name === pkg.name.replace(/^dsh-/, "dsh-"), `${owner}/${name}`);
  try {
    const r = await fetch(`https://api.github.com/repos/${owner}/${name}`, {
      headers: { "User-Agent": "dsh-precheck", Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(20000),
    });
    ok(`GitHub 仓库存在（${owner}/${name}）`, r.status === 200, `HTTP ${r.status}${r.status === 404 ? " —— 还没建，或名字/所有者不对；发布后别人的「查看源码」会 404" : ""}`);
  } catch (e) {
    console.log(`  ??   GitHub 仓库检查没跑成（${String(e.message).slice(0, 50)}）—— 离线就自己确认一下再发`);
  }
} else if (repoUrl) {
  ok("repository 是 GitHub 地址", false, repoUrl);
}

// npm 是 .cmd 批处理，execFileSync 在 Windows 上直接调它会失败 —— 必须走 shell。
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const runNpm = (args, opts = {}) => execFileSync(NPM, args, { cwd: ROOT, encoding: "utf8", shell: process.platform === "win32", ...opts });

// ③ npm 身份
try {
  const who = runNpm(["whoami"], { stdio: "pipe" }).trim();
  ok("npm 已登录", !!who, who);
} catch {
  ok("npm 已登录", false, "未登录 —— 先跑 npm login（这步只能你本人做）");
}

// ④ 版本号没被用过（发过的版本不能覆盖重发，提前发现比报错强）
try {
  const r = await fetch(`https://registry.npmjs.org/${pkg.name}`, { signal: AbortSignal.timeout(20000) });
  if (r.status === 404) {
    console.log(`  ok   npm 上还没有 ${pkg.name} —— 这次是首发，名字由你占下`);
  } else {
    const j = await r.json();
    const taken = !!j.versions?.[pkg.version];
    ok(`版本 ${pkg.version} 未被发布过`, !taken, taken ? `已存在，发不出去；要升版本号（npm version patch）` : "");
  }
} catch (e) { console.log(`  ??   registry 检查没跑成（${String(e.message).slice(0, 40)}）`); }

// ⑤ 回归与隐私（prepublishOnly 也会跑，这里提前跑一遍好定位）
try {
  runNpm(["test", "--silent"], { stdio: "pipe" });
  ok("全部回归通过", true);
} catch (e) {
  ok("回归未全过", false, String(e.stdout ?? e.message).split(/\r?\n/).filter(l => /FAIL/.test(l)).slice(0, 3).join(" / "));
}

// ⑥ 包里不许有内部笔记与本机凭据
const upstream = require(path.join(ROOT, "src/upstream.cjs"));
const secrets = new Set();
try { secrets.add(process.env.USERNAME || ""); } catch { /* 少一条 */ }
try {
  const b = upstream.listProfiles();
  for (const p of b.profiles ?? []) { if (p.displayName) secrets.add(p.displayName); if (p.bceUserId) secrets.add(p.bceUserId); }
} catch { /* 没登录就没这条 */ }
const listed = (() => {
  try {
    return JSON.parse(runNpm(["pack", "--dry-run", "--json"], { stdio: ["ignore", "pipe", "ignore"] }))[0].files.map(f => f.path);
  } catch { return []; }
})();
// 取不到清单就是 FAIL，不能让它带着 0 个文件继续往下「全绿」——
// 上面那些「包里必须有 X」和「没有隐私值」在空列表下都会自动通过，那是假绿灯。
ok("tarball 清单能取到", listed.length > 10, `${listed.length} 个文件`);
if (listed.length <= 10) {
  console.log("\n  ✗ 取不到 tarball 清单，后面的包内容检查没有意义，直接停在这里。");
  process.exit(1);
}
ok("AGENTS.md 不在包里", !listed.includes("AGENTS.md"));
ok("scripts/ 不在包里", !listed.some(f => f.startsWith("scripts/")));
for (const must of ["index.js", "client.js", "src/upstream.cjs", "LICENSE", "docs/PRIVACY.md", "cordis.patch.yml", "icon.svg"]) {
  if (!listed.includes(must)) ok(`包里必须有 ${must}`, false);
}
const leaks = [];
// ASCII 标识**整词**匹配：本机用户名常常是合法 GitHub handle 的前缀，
// 按子串匹配会把分发地址、署名这些本来该公开的东西报成泄漏（害处是逼人关掉检查）。
// 中文昵称没有词边界，仍按子串。
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hitBy = (line, s) => {
  if (!s) return false;
  if (!/^[\x20-\x7e]+$/.test(s)) return line.includes(s);
  return new RegExp(`(?<![A-Za-z0-9_.\\-])${esc(s)}(?![A-Za-z0-9_\\-])`).test(line);
};
const compared = listed.filter(f => /\.(js|cjs|mjs|json|md|yml)$/.test(f) && fs.existsSync(path.join(ROOT, f)));
for (const rel of compared) {
  const lines = fs.readFileSync(path.join(ROOT, rel), "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const s of secrets) {
      if (hitBy(line, s)) leaks.push(`${rel}:${i + 1} 含本机隐私值`);
    }
  });
}
// 反向证明整词匹配没把检查改松：真家目录必须仍然抓得住
ok("整词匹配仍能抓到真实家目录", hitBy(`cd C:\\Users\\${process.env.USERNAME}\\Documents`, process.env.USERNAME));
// 比对集太小 = 这条检查等于没跑，宁可判失败
ok(`包里没有本机隐私值（比对 ${compared.length} 个文件 / ${secrets.size} 个待查值）`,
  compared.length >= 10 && secrets.size >= 1 && leaks.length === 0,
  leaks.slice(0, 3).join(" / ") || (compared.length < 10 ? "比对文件太少" : secrets.size < 1 ? "取不到本机值，这条没生效" : ""));

console.log(bad
  ? `\n发布前还有 ${bad} 项要处理。修完再 npm publish（publish 也会自己跑一遍回归，不过发不出去）。`
  : `\n全部通过 —— 可以 npm publish 了。`);
process.exit(bad ? 1 : 0);
