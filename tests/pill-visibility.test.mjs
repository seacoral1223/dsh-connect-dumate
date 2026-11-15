// 把 client.js 里 GATE 标记块抠出来直接测 —— 测的就是浏览器实际跑的那段代码，
// 不是另抄一份副本（这个 bundle 没有构建步骤，抄一份迟早会漂）。
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const src = fs.readFileSync(path.join(import.meta.dirname, "..", "client.js"), "utf8");
const block = src.match(/\/\/ <!--GATE-START[\s\S]*?\/\/ <!--GATE-END-->/);
assert.ok(block, "client.js 里找不到 GATE 标记块");

const body = block[0].replace(/^\/\/ <!--GATE-START[^\n]*\n/, "").replace(/\/\/ <!--GATE-END-->/, "");
const { selectedProviderOf, shouldShowPill } = new Function(`${body}; return { selectedProviderOf, shouldShowPill };`)();

const IDS = ["dumate"];
const cases = [
  ["选中了 dumate（next）", { next: { provider: "dumate", model: "glm-5" } }, true],
  ["next 优先于 lastUsed", { next: { provider: "dumate" }, lastUsed: { provider: "deepseek" } }, true],
  ["还没提交过，用 lastUsed", { lastUsed: { provider: "dumate" } }, true],
  ["选的是别的 provider", { next: { provider: "deepseek", model: "deepseek-chat" } }, false],
  ["选的是 workbuddy", { lastUsed: { provider: "workbuddy" } }, false],
  ["投影还没有", undefined, false],
  ["投影是空对象", {}, false],
  ["provider 是空串", { next: { provider: "" } }, false],
  ["provider 不是字符串", { next: { provider: 42 } }, false],
  ["名单里没有这条路由", { next: { provider: "dumate" } }, false],
];

let bad = 0;
for (const [label, projection, want] of cases) {
  const ids = label === "名单里没有这条路由" ? ["other"] : IDS;
  const got = shouldShowPill(projection, ids);
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label.padEnd(24)} -> ${got}（期望 ${want}）`);
}

// 会话没选搭子时，绝不能发出一次积分请求
assert.equal(shouldShowPill({ next: { provider: "aliyun" } }, IDS), false);
assert.equal(selectedProviderOf({ next: { provider: "dumate" } }), "dumate");

console.log(bad ? `\nFAIL：${bad} 条不对` : "\nPASS：只有选中百度搭子才显示，别的 provider 一律不出现、也不发请求");
process.exit(bad ? 1 : 0);
