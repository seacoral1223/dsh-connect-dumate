// 积分汇总的解析回归。**全部离线**，不打上游。
//
// 为什么单独一条：上游是逆向来的私有接口，字段形态随时会变。
// 原先 summarizePackages 有三处会**静默把余额算成 0**：
//   ① `Number("1,000") || 0` → NaN → 0（带千分位就归零）；
//   ② `status === "active"` 精确匹配 → 大写 / 数字枚举 / 换词全部落空，余额 0 且无提示；
//   ③ 过期但上游仍标 active 的包照算进余额 → 余额虚高，还被打成「0 天内过期」。
// 这三种都不会报错，只会让 Coral 以为积分没了 —— 静默失效比崩溃坏。
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const up = require(path.join(import.meta.dirname, "..", "src/upstream.cjs"));
const sum = up.summarizePackages;

const nowSec = () => Math.floor(Date.now() / 1000);

// --- ① 数字形态
assert.equal(sum({ packages: [{ status: "active", totalPoints: "1,000", usedPoints: "0", expireDate: 0 }] }).available, 1000,
  "千分位字符串必须解析出来");
assert.equal(sum({ packages: [{ status: "active", totalPoints: " 500 ", usedPoints: 100, expireDate: 0 }] }).available, 400,
  "带空格的字符串同样要能算");
assert.equal(sum({ packages: [{ status: "active", totalPoints: null, usedPoints: undefined, expireDate: 0 }] }).available, 0,
  "缺字段退 0，不许抛");
assert.equal(sum({ packages: [{ status: "active", totalPoints: 100, usedPoints: 150, expireDate: 0 }] }).available, 0,
  "used > total 时 remain 夹到 0，不许出负余额");
console.log("  ok   数字形态：千分位/空格/null/used>total 都不归零也不抛");

// --- ② 状态形态
for (const s of ["active", "ACTIVE", "Active", " usable ", "1", true, 1]) {
  const r = sum({ packages: [{ status: s, totalPoints: 500, usedPoints: 0, expireDate: 0 }] });
  assert.equal(r.available, 500, `状态 ${JSON.stringify(s)} 应当算可用`);
}
// 完全不认识的状态：**不能静默显示 0**，必须把事实带出来
const weird = sum({ packages: [{ status: "weird_new_value", totalPoints: 800, usedPoints: 0, expireDate: 0 }] });
assert.equal(weird.available, 0, "认不出的状态不该算进余额（宁少不多）");
assert.deepEqual(weird.unrecognizedStatus, ["weird_new_value"], "但必须报出来，否则界面只显示 0 分，没人知道是解析问题");
const mixed = sum({ packages: [
  { status: "active", totalPoints: 100, usedPoints: 0, expireDate: 0 },
  { status: "???", totalPoints: 900, usedPoints: 0, expireDate: 0 },
] });
assert.equal(mixed.available, 100);
assert.equal(mixed.totalCount, 2, "总包数要带上，界面才能说「2 个包里有 1 个没算」");
console.log("  ok   状态形态：大小写/数字/换词都认；认不出的不算但会报出来");

// --- ③ 过期判定
const expired = sum({ packages: [{ status: "active", totalPoints: 500, usedPoints: 0, expireDate: nowSec() - 86400 }] });
assert.equal(expired.available, 0, "已过期仍标 active 的包不许算进余额（原先会虚高 500）");
assert.equal(expired.expiringSoon.length, 0, "已过期的不许出现在「三天内过期」里");
assert.equal(expired.expiredHeld, 500, "但要单独报出来，好解释余额为什么比上游列表少");
const soon = sum({ packages: [{ status: "active", totalPoints: 300, usedPoints: 0, expireDate: nowSec() + 86400 }] });
assert.equal(soon.available, 300);
assert.equal(soon.expiringSoon.length, 1);
assert.ok(soon.expiringSoon[0].daysLeft >= 1 && soon.expiringSoon[0].daysLeft <= 2, `daysLeft 不合理：${soon.expiringSoon[0].daysLeft}`);
const forever = sum({ packages: [{ status: "active", totalPoints: 300, usedPoints: 0, expireDate: 0 }] });
assert.equal(forever.expiringSoon.length, 0, "expireDate=0 是长期，不许当已过期/即将过期");
assert.equal(forever.available, 300);
console.log("  ok   过期判定：过期不算余额也不进「将过期」；长期包不误判");

// --- ④ 空与畸形输入一律不抛
for (const bad of [null, undefined, {}, { packages: null }, { packages: [] }, { packages: [{}] }, "字符串", 42, []]) {
  assert.doesNotThrow(() => sum(bad), `summarizePackages 对 ${JSON.stringify(bad)} 抛了`);
}
console.log("  ok   九种畸形输入都不抛");

console.log("\nPASS：积分汇总不会因为字段形态变化而静默把余额报成 0");
process.exit(0);
