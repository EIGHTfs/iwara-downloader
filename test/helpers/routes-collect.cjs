// ============================================================
// test/helpers/routes-collect.cjs —— 路由注册清单收集助手（下载器系通用）
// 用途：验证项目 routes/*.js 的注册清单（防丢路由/改路径）——
//   gbmd p1-routes 的模式通用化：项目测试里 require 自己的路由表，
//   collectTable 提取 "METHOD path" 键，与预期清单比对。
// 兼容两种路由导出：
//   ① createRoute 表式（nexus/gbmd 新版）：{ "GET /api/games": fn }
//   ② 旧式函数式（api 桩）：require(file)(api) 后从桩收集
// ============================================================
"use strict";

/**
 * 收集 createRoute 表的路由清单。
 * @param {object} routeTable createRoute 返回的表（键形如 "GET /api/x"）
 * @returns {Array<{method:string, path:string}>}
 */
function collectTable(routeTable) {
  const out = [];
  for (const key of Object.keys(routeTable || {})) {
    const m = key.match(/^(\S+)\s+(\S+)$/);
    if (m) out.push({ method: m[1], path: m[2] });
  }
  return out;
}

/**
 * 旧式函数式路由收集：以 api 桩 require 路由文件，收集注册的 (method path)。
 * @param {string} filePath 路由文件绝对路径（require 用）
 * @returns {{authed:Array<{method,path}>, pub:Array<{method,path}>}}
 */
function collectFunction(filePath) {
  const authed = [];
  const pub = [];
  const api = {
    route: (m, p) => authed.push({ method: m, path: p }),
    routePublic: (m, p) => pub.push({ method: m, path: p }),
  };
  // 调用方自己的路由文件可能依赖更多注入；这里给出可覆盖的桩，
  // 项目测试如需更多注入可先 Object.assign(api, {...}) 再调。
  require(filePath)(api);
  return { authed, pub };
}

/**
 * 断言表式路由与预期完全一致（忽略顺序，method+path 集合比对）。
 * @param {object} routeTable createRoute 表
 * @param {Array<string>} expected 形如 ["GET /api/games", "POST /api/search"]
 * @param {object} assert node:assert/strict
 */
function assertRoutes(routeTable, expected, assert) {
  const got = collectTable(routeTable).map((r) => r.method + " " + r.path);
  const exp = [...expected].sort();
  got.sort();
  assert.deepEqual(got, exp, "路由清单与预期不一致");
  return got;
}

module.exports = { collectTable, collectFunction, assertRoutes };
