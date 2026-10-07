#!/usr/bin/env node
// 自动更新：模式默认间隔 + 参数规范化
// 纯函数验证，零依赖、不联网、无副作用（不启动监控、不碰 git/网络）。
// 用法：在项目根执行  node test/auto-update-interval.test.cjs
"use strict";
const path = require("path");
const assert = require("assert");

// 相对定位：本文件在 <项目根>/test/，被测模块在 <项目根>/server/update/auto-update.js
const ROOT = path.join(__dirname, "..");
const { createAutoUpdate } = require(path.join(ROOT, "server", "update", "auto-update.js"));

const au = createAutoUpdate({ projectName: "unit-test", defaultRepo: "" });
const { normInterval, DEFAULT_INTERVAL_SEC, INTERVAL_MIN_SEC, INTERVAL_MAX_SEC } = au;

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try { fn(); console.log("  ✓ " + name); pass++; }
  catch (e) { console.log("  ✗ " + name + " → " + (e && e.message)); fail++; }
}

console.log("═══ 模式默认间隔 ═══");
ok("github 默认 3600 秒（1 小时）", () => assert.strictEqual(normInterval({}, "github"), 3600));
ok("git 默认 300 秒（本地 pull，成本低）", () => assert.strictEqual(normInterval({}, "git"), 300));
ok("watch 无间隔（null）", () => assert.strictEqual(normInterval({}, "watch"), null));

console.log("═══ 显式 interval 生效 ═══");
ok("显式 1800 生效", () => assert.strictEqual(normInterval({ interval: 1800 }, "github"), 1800));
ok("字符串数字 '1800' 生效", () => assert.strictEqual(normInterval({ interval: "1800" }, "github"), 1800));

console.log("═══ 边界与钳制 ═══");
ok(`过小值钳到下限 ${INTERVAL_MIN_SEC}`, () => assert.strictEqual(normInterval({ interval: 1 }, "github"), INTERVAL_MIN_SEC));
ok(`过大值钳到上限 ${INTERVAL_MAX_SEC}`, () => assert.strictEqual(normInterval({ interval: 999999 }, "github"), INTERVAL_MAX_SEC));
ok("非法字符串回退默认", () => assert.strictEqual(normInterval({ interval: "abc" }, "github"), 3600));
ok("undefined 回退默认", () => assert.strictEqual(normInterval({}, "github"), 3600));
ok("null 回退默认", () => assert.strictEqual(normInterval({ interval: null }, "github"), 3600));
ok("空串回退默认", () => assert.strictEqual(normInterval({ interval: "" }, "github"), 3600));
ok("负数按钳制处理（不会变成负数间隔）", () => {
  const v = normInterval({ interval: -5 }, "github");
  assert.ok(v >= INTERVAL_MIN_SEC, "应 >= 下限，实际 " + v);
});

console.log("═══ 默认值表 ===");
ok("三模式默认值与设计一致", () => {
  assert.deepStrictEqual(DEFAULT_INTERVAL_SEC, { watch: null, git: 300, github: 3600 });
});

console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
