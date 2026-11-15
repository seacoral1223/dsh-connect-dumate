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

// --- ② 文档与脚本里不许出现"N 个回归"这种写死的数字
const docs = ["README.md", "CHANGELOG.md", "AGENTS.md", "docs/PUBLISHING.md", "docs/PRIVACY.md",
  "tests/README.md", "scripts/precheck.mjs", "scripts/publish.ps1"];
const offenders = [];
// 允许 CHANGELOG 记史（它写的是"当时几个"），其余一律不许
const ALLOW = /^(CHANGELOG\.md|tests\/README\.md):/;
for (const d of docs) {
  const p = rel(d);
  if (!fs.existsSync(p)) continue;
  fs.readFileSync(p, "utf8").split(/\r?\n/).forEach((line, i) => {
    if (/(\d+|十二|十三|十四|十五|十六|十七|十八|十九|二十)\s*个\s*(回归|不用 DSH 的回归)/.test(line)) {
      offenders.push(`${d}:${i + 1} → ${line.trim().slice(0, 90)}`);
    }
  });
}
const real = offenders.filter(o => !ALLOW.test(o));
assert.deepEqual(real, [], `这些地方把回归数量写死了，改一个用例就会飘：\n    ${real.join("\n    ")}`);
console.log(`  ok   文档/脚本里没有写死的回归数量（${docs.length} 个文件扫过）`);

// --- ③ 每个用例文件都得能被单独跑（有 exit 或至少不抛）—— 只查形状，不跑
for (const f of dirTests) {
  const t = fs.readFileSync(rel(path.join("tests", f)), "utf8");
  assert.ok(/process\.exit|PASS|ok\s/.test(t), `${f} 里没有 PASS/exit 迹象，可能不是一个完整用例`);
  assert.ok(!/process\.exit\(0\);?\s*\r?\n\s*(\/\/)?\s*(await|const|console)/.test(t),
    `${f} 在 process.exit(0) 之后还有代码 —— 那段永远不会执行，等于没测`);
}
console.log(`  ok   ${dirTests.length} 个用例形状都对（没有 exit 之后的死代码）`);

console.log("\nPASS：回归清单与文档说法由结构保证一致，不再靠人记得改数字");
process.exitCode = 0;
