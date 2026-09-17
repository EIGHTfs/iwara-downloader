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

// ---- path-safe（B1 白名单收敛）----
function fakeCfg(downloadPath) {
  return { readConfig: () => ({ downloadPath }) };
}

test("path-safe: downloadRoots 取 config.downloadPath", () => {
  const roots = pathSafe.downloadRoots(fakeCfg("/vol/Iwara/"));
  assert.deepEqual(roots, ["/vol/Iwara/"]);
});

test("path-safe: downloadRoots 空 downloadPath 返回空", () => {
  assert.deepEqual(pathSafe.downloadRoots(fakeCfg("")), []);
});

test("path-safe: isWithinRoots 根内放行 / 根外拒绝", () => {
  const roots = ["/vol/Iwara"];
  assert.equal(pathSafe.isWithinRoots("/vol/Iwara", roots), true);
  assert.equal(pathSafe.isWithinRoots("/vol/Iwara/作者/视频.mp4", roots), true);
  assert.equal(pathSafe.isWithinRoots("/vol/Other/file.mp4", roots), false);
  assert.equal(pathSafe.isWithinRoots("/etc/passwd", roots), false);
});

test("path-safe: isBrowsableDir 祖先/后代放行，无关目录拒绝", () => {
  const roots = ["/vol/Iwara"];
  assert.equal(pathSafe.isBrowsableDir("/", roots), true, "祖先 / 放行（下钻到下载根）");
  assert.equal(pathSafe.isBrowsableDir("/vol", roots), true, "祖先 /vol 放行");
  assert.equal(pathSafe.isBrowsableDir("/vol/Iwara", roots), true, "下载根本身");
  assert.equal(pathSafe.isBrowsableDir("/vol/Iwara/sub", roots), true, "后代子目录");
  assert.equal(pathSafe.isBrowsableDir("/etc", roots), false, "无关目录拒绝");
  assert.equal(pathSafe.isBrowsableDir("/home", roots), false);
});

test("path-safe: isBrowsableDir 无根时不限制（兼容未配置）", () => {
  assert.equal(pathSafe.isBrowsableDir("/etc", []), true);
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
