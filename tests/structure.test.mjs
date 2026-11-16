// 结构守卫：文档里的回归数量不许写死。
//
// 起因（2026-11-16 对标审查实测）：同一个"回归多少个"在仓库里有 5 个不同答案 ——
// 目录里 18 个、package.json 链 18 个、README 写 17、PUBLISHING 写 12、
// precheck 与 publish.ps1 也写 12。项目自己的规矩写着「死键不是洁癖问题，
// 是文案改了、界面没跟上的信号」，数字飘了同理：**门禁话术变成假的**。
// 所以这里不核对"数字对不对"（那还是要人记得改），而是**禁止写死数字**。
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const ROOT = path.join(import.meta.dirname, "..");
const rel = p => path.join(ROOT, p);

// --- ① package.json 的 test 链必须覆盖 tests/ 里每一个 .test.mjs，且不多不少
const dirTests = fs.readdirSync(rel("tests")).filter(f => f.endsWith(".test.mjs")).sort();
const chain = JSON.parse(fs.readFileSync(rel("package.json"), "utf8")).scripts.test;
const inChain = [...chain.matchAll(/node tests\/([\w-]+\.test\.mjs)/g)].map(m => m[1]).sort();
assert.deepEqual(inChain, dirTests,
  `test 链与 tests/ 目录不一致：链里缺 ${dirTests.filter(f => !inChain.includes(f))}，多 ${inChain.filter(f => !dirTests.includes(f))}`);
assert.ok(dirTests.length >= 15, `回归数量异常少（${dirTests.length}），确认目录没被误删`);
console.log(`  ok   test 链覆盖全部 ${dirTests.length} 个回归，一一对应`);

// --- ② README 的结构：安装必须排在警告前面
// 2026-11-16 的实际问题：安装说明在第 50 行，前面 49 行是风险提示与原理。
// 而 DSH 插件详情页与市场卡片读的就是 README 开头 —— 第一眼看不到怎么装，就真不会装。
{
  const r = fs.readFileSync(rel("README.md"), "utf8").split(/\r?\n/);
  const at = re => r.findIndex(l => re.test(l));
  const install = at(/^## .*(装好|装上|安装)/);
  const risk = at(/^## 风险提示/);
  const disclaimer = at(/^## 免责声明/);
  // 注意用 >= 0：0 是「标题在第一行」这个合法位置，写成 > 0 会把排序问题误报成「章节不存在」
  assert.ok(install >= 0, "README 没有安装章节");
  assert.ok(risk < 0 || install < risk, `安装(${install + 1} 行)必须排在风险提示(${risk + 1} 行)前面`);
  assert.ok(install <= 12, `安装章节出现在第 ${install + 1} 行，太靠后了 —— 第一屏就该看到`);
  assert.ok(disclaimer < 0 || install < disclaimer, "免责声明不该挡在安装前面（放文末即可）");
  // 安装步骤里必须有"重启"，这是"装完看不见东西"的头号原因
  const installBlock = r.slice(install, install + 22).join("\n");
  assert.ok(/重启 DSH/.test(installBlock), "安装步骤必须写明要重启 DSH");
  assert.ok(/Add plugin|添加插件/.test(installBlock), "安装步骤必须写明在插件管理里选目录");
  assert.ok(/npm i -g|npm install -g/.test(r.join("\n")) && /不要用|无效|不会把/.test(r.join("\n")),
    "必须警告不要用 npm i -g（全局安装不会注册进 profile）");
  console.log(`  ok   README 结构：安装在第 ${install + 1} 行、风险提示在第 ${risk + 1} 行、含重启与 Add plugin 两步`);
}

// --- ③ 文档与脚本里不许出现"N 个回归"这种写死的数字
const docs = ["README.md", "CHANGELOG.md", "AGENTS.md", "docs/PUBLISHING.md", "docs/PRIVACY.md",
  "tests/README.md", "scripts/precheck.mjs", "scripts/publish.ps1"];
const offenders = [];
// 允许 CHANGELOG 记史（它写的是"当时几个"），其余一律不许
const ALLOW = /^(CHANGELOG\.md|tests\/README\.md):/;
for (const d of docs) {
  const p = rel(d);
  if (!fs.existsSync(p)) continue;
  fs.readFileSync(p, "utf8").split(/\r?\n/).forEach((line, i) => {
    // 允许中间夹 markdown 强调/空格（`**十五个**不用 DSH 进程的回归` 这种写法曾经绕过检查）
    if (/(\d+|十二|十三|十四|十五|十六|十七|十八|十九|二十|廿)\s*个[\s*]*?(回归|不用 DSH)/.test(line)) {
      offenders.push(`${d}:${i + 1} → ${line.trim().slice(0, 90)}`);
    }
  });
}
const real = offenders.filter(o => !ALLOW.test(o));
assert.deepEqual(real, [], `这些地方把回归数量写死了，改一个用例就会飘：\n    ${real.join("\n    ")}`);
console.log(`  ok   文档/脚本里没有写死的回归数量（${docs.length} 个文件扫过）`);

// --- ④ 每个用例文件都得能被单独跑（有 exit 或至少不抛）—— 只查形状，不跑
for (const f of dirTests) {
  const t = fs.readFileSync(rel(path.join("tests", f)), "utf8");
  assert.ok(/process\.exit|PASS|ok\s/.test(t), `${f} 里没有 PASS/exit 迹象，可能不是一个完整用例`);
  assert.ok(!/process\.exit\(0\);?\s*\r?\n\s*(\/\/)?\s*(await|const|console)/.test(t),
    `${f} 在 process.exit(0) 之后还有代码 —— 那段永远不会执行，等于没测`);
}
console.log(`  ok   ${dirTests.length} 个用例形状都对（没有 exit 之后的死代码）`);

console.log("\nPASS：回归清单与文档说法由结构保证一致，不再靠人记得改数字");
process.exitCode = 0;
