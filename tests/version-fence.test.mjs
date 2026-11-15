// 版本围栏回归。钉两件事，都是照 dsh-connect-workbuddy 的口径来的：
//
//  ① **两处声明必须一致**。`engines.dsh` 是宿主门禁的第一顺位（plugin_manager 原话：
//     "Unmet DSH version requirements (engines.dsh, else DSH peer dependencies)"），
//     `dsh.compatibility.dsh` 是给人读的。上一版前者写 `<0.3.0`、后者写 `<0.3.0-0`，
//     于是「文档说的围栏」和「真正生效的围栏」不是同一个。
//
//  ② **上界必须带 -0**。宿主求值用 `includePrerelease: true`，而 `<0.3.0` 在那个模式下
//     **会放行整条 `0.3.0-alpha.1` / `0.3.0-rc.1`** —— 一条我们从未验证过的线，围栏形同虚设。
//     写成 `<0.3.0-0` 才把它挡住。
//
// semver 从 npm 自带的副本取，不新增依赖；取不到就 SKIP 并说明，不装成通过。
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.join(import.meta.dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

let semver = null;
for (const c of [
  "C:/Program Files/nodejs/node_modules/npm/node_modules/semver",
  "npm/node_modules/semver",
]) {
  try { semver = require(c); break; } catch { /* 换下一个 */ }
}
if (!semver) {
  try { semver = await import(path.join(path.dirname(process.execPath), "node_modules", "npm", "node_modules", "semver", "index.js")); }
  catch { /* 下面 SKIP */ }
}
if (!semver?.satisfies) {
  console.log("SKIP：取不到 semver（这台机器的 npm 布局不一样），版本围栏这条没测到");
  process.exit(0);
}

const eng = pkg.engines?.dsh;
const comp = pkg.dsh?.compatibility?.dsh;
assert.ok(eng, "engines.dsh 必须声明（宿主门禁读它）");
assert.ok(comp, "dsh.compatibility.dsh 必须声明（给人读的同一件事）");
assert.equal(eng, comp, `两处围栏不是同一个范围：engines.dsh=${eng} vs dsh.compatibility.dsh=${comp}`);
console.log(`  ok   两处声明一致：${eng}`);

// 必须收的：当前实测宿主 + 同一条线上的正式版与预发布
const accept = ["0.2.2", "0.2.2-rc.3", "0.2.3", "0.2.9"];
// 必须拒的：未验证的下一条线（含它的预发布 —— 这就是悬崖）、以及更老的线
const reject = ["0.3.0-alpha.1", "0.3.0-rc.1", "0.3.0", "0.4.0-rc.1", "0.1.7", "0.2.1"];

for (const v of accept) {
  assert.ok(semver.satisfies(v, eng, { includePrerelease: true }), `应当支持 ${v}，实际被拒`);
}
for (const v of reject) {
  assert.ok(!semver.satisfies(v, eng, { includePrerelease: true }),
    `应当拒绝 ${v}（未验证的那条线），实际被放行 —— 上界必须写成 <下一版-0`);
}
console.log(`  ok   收 ${accept.length} 条 / 拒 ${reject.length} 条（含 0.3.0-alpha.1 与 0.3.0-rc.1 这两个悬崖用例）`);

// 反向证明这条断言不是摆设：把**上界**的 -0 去掉，0.3.0-rc.1 必须变成被放行。
// （第一版这里用 eng.replace(/-0/) 去的是下界那个 -0，围栏没动，于是"反向验证"自己就是假的。）
const loose = eng.replace(/<\s*(\d+\.\d+\.\d+)-0/, "<$1");
if (loose !== eng) {
  assert.ok(semver.satisfies("0.3.0-rc.1", loose, { includePrerelease: true }),
    `反向验证失败：上界退回「${loose}」仍然拦不住 0.3.0-rc.1，说明用例设计错了`);
  assert.ok(!semver.satisfies("0.3.0-rc.1", eng, { includePrerelease: true }),
    "反向验证失败：当前范围本来就已经放行了 0.3.0-rc.1");
  console.log(`  ok   反向验证：上界退回「${loose}」就会放行 0.3.0-rc.1 —— 这条断言真的在守`);
} else {
  assert.fail(`没能从上界构造出宽松版本（范围是 ${eng}），反向验证没跑成`);
}

console.log("\nPASS：版本围栏两处一致，且未验证的下一条线（含预发布）被明确拒绝");
process.exit(0);
