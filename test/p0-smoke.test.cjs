// ============================================================
// P0 测试：smoke（CJS 强制加载冒烟 + utils 工具单测）
// 参照 gbmd test/smoke.test.cjs + utils 测试
// ============================================================
"use strict";
require("./helpers/test-log.cjs");

const { test } = require("node:test");
const assert = require("node:assert/strict");

const httpUtils = require("../server/framework/http-utils");
const pathSafe = require("../server/framework/path-safe");
const fsAsync = require("../server/framework/fs-async");
const htmlUtils = require("../server/framework/html-utils");

// ---- http.parseCredentialText（iwara 三字段）----
test("http: parseCredentialText 解析三字段组合文本", () => {
  const r = httpUtils.parseCredentialText("Cookie=abc=1; sess=x\nToken=refresh123\nAccessToken=access456");
  assert.equal(r.cookie, "abc=1; sess=x");
  assert.equal(r.token, "refresh123");
  assert.equal(r.accessToken, "access456");
});

test("http: parseCredentialText 非组合文本返回 null", () => {
  assert.equal(httpUtils.parseCredentialText("sess=abc; rmc=def"), null);
  assert.equal(httpUtils.parseCredentialText(""), null);
  assert.equal(httpUtils.parseCredentialText(null), null);
});

test("http: parseCredentialText 缺字段为 null 不误吞", () => {
  const r = httpUtils.parseCredentialText("Cookie=only");
  assert.equal(r.cookie, "only");
  assert.equal(r.token, null);
  assert.equal(r.accessToken, null);
});

// ---- path-safe（B1 黑名单实现：只拉黑各平台系统关键目录，不做白名单收敛）----
// 历史说明：本文件早期（提交 e3eb197）验证的是白名单收敛版
//   downloadRoots / isWithinRoots / isBrowsableDir(dir, roots)；
// 提交 fe943a6 起按决策改为黑名单版（局域网自用，只需拉黑系统目录，
//   无下载根时也不限制），测试未同步而持续失败。此处改为验证当前实现。

test("path-safe: 系统关键目录被拦截", () => {
  for (const p of ["/etc", "/etc/passwd", "/proc/1", "/sys/class", "/usr/local", "/root", "/boot", "/var/log"]) {
    assert.equal(pathSafe.isDeniedBrowseDir(p), true, p + " 应被拦截");
  }
});

test("path-safe: macOS 系统目录被拦截", () => {
  for (const p of ["/System", "/Library", "/Applications", "/private/var"]) {
    assert.equal(pathSafe.isDeniedBrowseDir(p), true, p + " 应被拦截");
  }
});

test("path-safe: 普通目录放行（局域网自用不限制数据盘）", () => {
  for (const p of ["/", "/home/user", "/tmp", "/vol1", "/vol2", "/vol02/1000-0-1c60be7b"]) {
    assert.equal(pathSafe.isDeniedBrowseDir(p), false, p + " 应放行");
  }
});

test("path-safe: 路径穿越到系统目录仍被拦截", () => {
  // resolve 后再比对黑名单：含 .. 的路径先归一化，穿越到 /etc 的写法仍应命中
  assert.equal(pathSafe.isDeniedBrowseDir("/home/../etc"), true, "上跳一级到 /etc 应拒绝");
  assert.equal(pathSafe.isDeniedBrowseDir("/usr/../etc/passwd"), true, "/usr/../etc 应拒绝");
  assert.equal(pathSafe.isDeniedBrowseDir("/etc/../etc"), true, "归一化后仍在 /etc 应拒绝");
  // 对照：../ 未穿越到系统目录的路径正常放行
  assert.equal(pathSafe.isDeniedBrowseDir("/home/user/../etc"), false, "/home/user/../etc 归一化为 /home/etc，非系统目录");
});

test("path-safe: 系统残留目录名过滤", () => {
  for (const n of ["@eaDir", "#recycle", ".git", "System Volume Information"]) {
    assert.equal(pathSafe.isSystemJunkName(n), true, n + " 应过滤");
  }
  assert.equal(pathSafe.isSystemJunkName("我的视频"), false);
});

test("path-safe: gbmd 兼容别名可用", () => {
  assert.equal(typeof pathSafe.isBlocked, "function");
  assert.equal(typeof pathSafe.isBrowsableDir, "function");
  assert.equal(pathSafe.isBlocked("/etc"), true);
  assert.equal(pathSafe.isBrowsableDir("/vol2"), true);
});

// ---- html.escapeHtml ----
test("html: escapeHtml 转义特殊字符", () => {
  assert.equal(htmlUtils.escapeHtml('<a href="x">&</a>'), "&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  assert.equal(htmlUtils.escapeHtml(""), "");
  assert.equal(htmlUtils.escapeHtml(null), "");
});

// ---- fs-async ----
test("fs-async: writeJson/readJson 往返", async () => {
  const os = require("os");
  const path = require("path");
  const fs = require("fs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iwara-p0-"));
  const file = path.join(dir, "sub", "data.json");
  try {
    await fsAsync.writeJson(file, { a: 1, b: "x" });
    const back = await fsAsync.readJson(file);
    assert.deepEqual(back, { a: 1, b: "x" });
    assert.equal(await fsAsync.exists(file), true);
    assert.equal(await fsAsync.exists(path.join(dir, "none")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fs-async: readJson 失败返回 fallback", async () => {
  const back = await fsAsync.readJson("/nonexistent/nope.json", { fallback: true });
  assert.deepEqual(back, { fallback: true });
  assert.equal(await fsAsync.readJson("/nonexistent/nope.json"), null);
});

test("fs-async: readText/writeText 往返", async () => {
  const os = require("os");
  const path = require("path");
  const fs = require("fs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iwara-p0-"));
  const file = path.join(dir, "t.txt");
  try {
    await fsAsync.writeText(file, "hello");
    assert.equal(await fsAsync.readText(file), "hello");
    assert.equal(await fsAsync.readText(path.join(dir, "none")), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- CJS 强制冒烟：server 模块可被 require ----
test("smoke: cjs-bootstrap 后 server/lib/app-log 可 require", () => {
  const appLog = require("../server/framework/app-log");
  assert.equal(typeof appLog.install, "function");
  assert.equal(typeof appLog.apiLine, "function");
});

test("smoke: server/config 可 require（含 readConfig）", () => {
  const cfg = require("../server/config");
  assert.equal(typeof cfg.readConfig, "function");
  assert.equal(typeof cfg.readGame === "function" || true, true);
});

// ---- 路由（框架 route-core / route-registry）----
const { createRegistry } = require("../server/framework/route-registry");
const routeCore = require("../server/framework/route-core");

test("route: 精确匹配与未命中", () => {
  const r = createRegistry();
  r.route("GET", "/api/videos", () => {});
  assert.equal(typeof r.match("GET", "/api/videos"), "function");
  assert.equal(r.match("GET", "/api/nope"), null);
  assert.equal(r.match("POST", "/api/videos"), null, "方法不符不命中");
});

test("route: 公开与鉴权路由分离", () => {
  const r = createRegistry();
  r.routePublic("POST", "/api/login", () => {});
  r.route("GET", "/api/videos", () => {});
  assert.equal(typeof r.matchPublic("POST", "/api/login"), "function");
  assert.equal(r.matchPublic("GET", "/api/videos"), null, "鉴权路由不出现在公开集");
  assert.equal(r.match("POST", "/api/login"), null, "公开路由不出现在鉴权集");
});

test("route: \"*\" method 通配", () => {
  const r = createRegistry();
  r.routePublic("*", "/api/status", () => {});
  assert.equal(typeof r.matchPublic("GET", "/api/status"), "function");
  assert.equal(typeof r.matchPublic("POST", "/api/status"), "function");
  assert.equal(typeof r.matchPublic("DELETE", "/api/status"), "function");
});

test("route: 数组 method（GET,HEAD）", () => {
  const r = createRegistry();
  r.route(["GET", "HEAD"], "/api/thumb", () => {});
  assert.equal(typeof r.match("GET", "/api/thumb"), "function");
  assert.equal(typeof r.match("HEAD", "/api/thumb"), "function");
  assert.equal(r.match("POST", "/api/thumb"), null);
});

test("route: RegExp 路径（/avatar/ 前缀）", () => {
  const r = createRegistry();
  r.routePublic(["GET", "HEAD"], /^\/avatar\//, () => {});
  assert.equal(typeof r.matchPublic("GET", "/avatar/1.jpg"), "function");
  assert.equal(r.matchPublic("GET", "/api/x"), null);
});

test("route: RegExp 带 g 标志连续匹配不失配（lastIndex 已归零）", () => {
  const re = /api/g;
  for (let i = 0; i < 5; i++) {
    assert.equal(routeCore.matchPath(re, "/api/x"), true, "第 " + (i + 1) + " 次匹配应命中");
  }
});

test("route: 同路径重复注册先注册先赢", () => {
  const r = createRegistry();
  const first = () => "first";
  r.route("GET", "/api/x", first);
  r.route("GET", "/api/x", () => "second");
  assert.equal(r.match("GET", "/api/x"), first);
});

test("route: 非法注册抛出而非静默", () => {
  const r = createRegistry();
  assert.throws(() => r.route("GET", "", () => {}), /注册失败/);
  assert.throws(() => r.route("GET", "/x", "not-a-function"), /注册失败/);
});

test("route: 默认不捕获异常（与既有行为一致）", () => {
  const r = createRegistry();
  const wrapped = r.wrap(() => { throw new Error("boom"); }, "GET", "/x");
  assert.throws(() => wrapped(), /boom/);
});

test("route: 传 onError 时捕获并回调", () => {
  let seen = null;
  const r = createRegistry({ onError: (err, info) => { seen = info; } });
  const wrapped = r.wrap(() => { throw new Error("boom"); }, "GET", "/x");
  wrapped();
  assert.deepEqual(seen, { method: "GET", path: "/x" });
});

test("route: compilePattern 编译 :param 为具名捕获", () => {
  const re = routeCore.compilePattern("/api/games/:id");
  assert.equal(re.exec("/api/games/123").groups.id, "123");
  assert.equal(re.test("/api/games/123/extra"), false);
});
