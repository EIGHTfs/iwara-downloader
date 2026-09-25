// ============================================================
// test/p0-smoke.test.cjs —— P0 基建冒烟（下载器系通用模板）
// 断言：cjs-bootstrap 让 server .js 以 CJS 加载 + 项目核心模块可 require。
// 项目复制后可把 CORE_MODULES 换成自己的核心模块（config/lib/routes 等）。
// 运行：node --test test/
// ============================================================
const { makeLog, loggedTest } = require("./helpers/test-log.cjs");
const assert = require("node:assert/strict");

const log = makeLog("p0-smoke");

// 项目核心模块（按项目替换/扩充；相对 test/ 上一级的 server/）
// ⚠ 不要列 server/app.js（入口：require 即启动服务，会占用端口）
const CORE_MODULES = [
  "../server/config.js",
];

loggedTest(log, "cjs-bootstrap 让 server .js 以 CJS 加载（否则 ESM 父目录报 ERR_REQUIRE_ESM）", async () => {
  for (const mod of CORE_MODULES) {
    const loaded = require(mod);
    log.info(mod + " 加载成功 → " + typeof loaded);
    assert.ok(loaded, mod + " 应可 require（cjs-bootstrap 生效）");
  }
});

// 路由注册清单收集助手可加载（通用基建）
loggedTest(log, "helpers/routes-collect.cjs 可加载且 collectTable 可用", async () => {
  const { collectTable, assertRoutes } = require("./helpers/routes-collect.cjs");
  const table = { "GET /api/status": () => {}, "POST /api/login": () => {} };
  assert.deepEqual(collectTable(table), [
    { method: "GET", path: "/api/status" },
    { method: "POST", path: "/api/login" },
  ]);
  assertRoutes(table, ["POST /api/login", "GET /api/status"], assert);
  log.info("routes-collect 冒烟通过");
});
