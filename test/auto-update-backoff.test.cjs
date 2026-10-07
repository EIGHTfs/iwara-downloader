#!/usr/bin/env node
// 自动更新：连续失败退避序列
// 规则（用户确认）：实际间隔 = 设定值 × 2^min(连续失败次数, 3)，即 1h→2h→4h→8h，之后维持 8h；
// 任意一次成功即把失败连击归零、立即回到基础间隔。手动「立即检查」不计入连击。
// 纯函数验证，零依赖、无副作用。
// 用法：在项目根执行  node test/auto-update-backoff.test.cjs
"use strict";
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const { createAutoUpdate } = require(path.join(ROOT, "server", "update", "auto-update.js"));
const au = createAutoUpdate({ projectName: "unit-test", defaultRepo: "" });
const { intervalMsWithBackoff, BACKOFF_MAX_STEPS } = au;

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try { fn(); console.log("  ✓ " + name); pass++; }
  catch (e) { console.log("  ✗ " + name + " → " + (e && e.message)); fail++; }
}
const sec = (ms) => ms / 1000;

console.log("═══ 退避序列（基础 3600 秒 = 1 小时）═══");
ok("无失败 → 1h（3600s）", () => assert.strictEqual(sec(intervalMsWithBackoff(3600, 0)), 3600));
ok("失败 1 次 → 2h（7200s）", () => assert.strictEqual(sec(intervalMsWithBackoff(3600, 1)), 7200));
ok("失败 2 次 → 4h（14400s）", () => assert.strictEqual(sec(intervalMsWithBackoff(3600, 2)), 14400));
ok("失败 3 次 → 8h（28800s）", () => assert.strictEqual(sec(intervalMsWithBackoff(3600, 3)), 28800));
ok("失败 4 次仍 8h（最多回避 3 次，不继续翻倍）", () => assert.strictEqual(sec(intervalMsWithBackoff(3600, 4)), 28800));
ok("失败 99 次仍 8h（封顶）", () => assert.strictEqual(sec(intervalMsWithBackoff(3600, 99)), 28800));
ok("负数失败次数按 0 处理（= 基础间隔）", () => assert.strictEqual(sec(intervalMsWithBackoff(3600, -3)), 3600));

console.log("═══ 其他基础值 ═══");
ok("base=300（git 默认）：失败 1 次 → 600s", () => assert.strictEqual(sec(intervalMsWithBackoff(300, 1)), 600));
ok("base=1800：失败 2 次 → 7200s", () => assert.strictEqual(sec(intervalMsWithBackoff(1800, 2)), 7200));

console.log("═══ 常量一致性 ═══");
ok("BACKOFF_MAX_STEPS = 3（最多回避 3 次）", () => assert.strictEqual(BACKOFF_MAX_STEPS, 3));

console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
