#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// 作者头像全链路测试（前端级强化版）
// 验证链路：/api/play-info → avatar 字段 → avatar 文件可访问 →
//   前端真实脚本语义渲染（jsdom 以 <script> 方式加载真实 play.html body +
//   play-list/play-enhance/play-app 三件套）→ 断言 #author 渲染 <img class="author-avatar">
// 用法：
//   node test-author-avatar.cjs <BASE_URL> <VIDEO_ID> [--old-html <旧play.html>] [--new-js <新play-app.js>]
// 示例：
//   node test-author-avatar.cjs http://127.0.0.1:8643 QML6BlAS2fOyN9
// ═══════════════════════════════════════════════════════════════
"use strict";

const fs = require("fs");

const BASE = process.argv[2] || "http://127.0.0.1:8643";
const VID = process.argv[3] || "";
const OLD_HTML = process.argv[4] || "/tmp/iwara-old/server/public/play.html";
const NEW_JS = process.argv[5] || "";

let pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log((ok ? "  ✓ " : "  ✗ ") + name + (detail ? "  [" + detail + "]" : ""));
  ok ? pass++ : fail++;
}

async function main() {
  console.log("═══ 作者头像全链路测试（前端级）═══");
  console.log("BASE:", BASE, "| VIDEO:", VID || "(未指定)");
  if (!VID) { console.log("  ✗ 必须指定视频 id"); process.exit(1); }

  // ── 第 1 步：请求 /api/play-info ──
  console.log("\n[1] GET /api/play-info?id=" + VID);
  let info = null;
  try {
    const r = await fetch(BASE + "/api/play-info?id=" + encodeURIComponent(VID), { timeout: 8000 });
    info = await r.json();
    check("play-info HTTP " + r.status, r.ok, String(r.status));
  } catch (e) { check("play-info 请求", false, String(e.message)); process.exit(1); }
  if (!info || !info.ok) {
    check("play-info ok", false, JSON.stringify(info).slice(0, 120));
    console.log("\n结果: " + fail + " 失败 / " + pass + " 通过");
    process.exit(1);
  }
  check("play-info ok", true);
  check("avatar 字段非空", !!info.avatar, info.avatar || "(空)");
  check("avatar 路径格式 /^\\/avatar\\/[0-9a-f-]+\\/[0-9a-f-]+\\.jpg$/", /^\/avatar\/[0-9a-f-]+\/[0-9a-f-]+\.jpg$/i.test(info.avatar || ""), info.avatar || "");

  // ── 第 2 步：请求本地 avatar 文件 ──
  console.log("\n[2] GET " + (info.avatar || "(无 avatar)"));
  if (info.avatar) {
    try {
      const ar = await fetch(BASE + info.avatar, { timeout: 8000 });
      const buf = Buffer.from(await ar.arrayBuffer());
      check("avatar 文件 HTTP " + ar.status, ar.ok && buf.length > 0, "HTTP " + ar.status + ", " + buf.length + " 字节");
    } catch (e) { check("avatar 文件请求", false, String(e.message)); }
  } else {
    check("avatar 文件请求", false, "无 avatar 字段跳过");
  }

  // ── 第 3 步：前端真实脚本语义渲染（jsdom <script> 内联方式，非 win.eval）──
  console.log("\n[3] 前端真实脚本语义渲染（jsdom 加载真实 play.html + 三件套）");
  let JSDOM = null, VirtualConsole = null;
  try {
    const j = require("jsdom");
    JSDOM = j.JSDOM; VirtualConsole = j.VirtualConsole;
  } catch (e) {
    console.log("  - jsdom 不可用，跳过渲染验证:", e.message);
    console.log("\n结果: " + fail + " 失败 / " + pass + " 通过");
    process.exit(fail ? 1 : 0);
  }

  let newRendered = "";
  try {
    // 拉取被测服务实际的页面与脚本（看「浏览器拿到的代码」而非磁盘源文件）
    const html = await (await fetch(BASE + "/play.html", { timeout: 8000 })).text();
    const bodyM = html.match(/<body[^>]*>([\s\S]*?)<\/body>/);
    const body = bodyM ? bodyM[1] : "";
    const listJs = await (await fetch(BASE + "/play-list.js", { timeout: 8000 })).text();
    const enhJs = await (await fetch(BASE + "/play-enhance.js", { timeout: 8000 })).text();
    const appJs = await (await fetch(BASE + "/play-app.js", { timeout: 8000 })).text();

    const vc = new VirtualConsole();
    const errs = [];
    vc.on("jsdomError", e => errs.push(String((e.detail && e.detail.message) || e.message)));
    vc.on("error", m => errs.push(String(m)));

    // 关键：以 <script> 内联方式注入（与真实浏览器 script 语义一致：var/function 进 window 全局）。
    // 不要用 window.eval 逐个执行 —— jsdom 的 eval 作用域与 <script> 不同，跨文件会找不到函数
    // （此前 win.eval 出现 "initPlayTools is not defined" 假象，fromURL/内联 script 方式则全部可见）。
    const dom = new JSDOM(`<!DOCTYPE html><html><head></head><body>${body}
<script>${listJs}</script>
<script>${enhJs}</script>
<script>${appJs}</script>
</body></html>`, {
      url: BASE + "/play.html?id=" + encodeURIComponent(VID),
      runScripts: "dangerously",
      pretendToBeVisual: true,
      virtualConsole: vc,
      beforeParse(win) {
        // fetch stub：相对路径转绝对，转发到被测真实服务
        win.fetch = (url, opts) => fetch(new URL(url, win.location.href), opts);
        win.Artplayer = function () {
          this.on = function () { return this; };
          this.destroy = function () {};
          this.poster = "";
          this.mounted = function () {};
        };
        try { win.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); }; } catch (_) {}
      }
    });
    await new Promise(r => setTimeout(r, 2500));

    const win = dom.window;
    const authorEl = win.document.getElementById("author");
    newRendered = authorEl ? authorEl.innerHTML : "";
    check("三件套 JS 无异常（initPlayTools/renderAuthor 全局可见）",
      typeof win.initPlayTools === "function" && typeof win.renderAuthor === "function",
      "initPlayTools=" + typeof win.initPlayTools + " renderAuthor=" + typeof win.renderAuthor);
    check("#author 渲染出 <img class=\"author-avatar\">", /<img class="author-avatar"/.test(newRendered), newRendered.slice(0, 120) || "(空)");
    const likeBtn = win.document.getElementById("likeBtn");
    check("收藏按钮存在", !!likeBtn, likeBtn ? likeBtn.textContent : "无 #likeBtn");
    const jsErrors = errs.filter(s => !/artplayer|Artplayer/i.test(s)); // 过滤 artplayer 库自身噪音
    check("页面无 JS 报错（除 artplayer 库）", jsErrors.length === 0, jsErrors.slice(0, 3).join(" | ") || "(无)");
    dom.window.close();
  } catch (e) {
    check("前端脚本语义渲染执行", false, String(e.message));
  }

  // ── 第 4 步：新旧 renderAuthor 同数据渲染对比（函数级，作为前端渲染的补充断言）──
  console.log("\n[4] renderAuthor 函数级渲染对比（同一份 play-info 数据）");

  function extractFunction(srcFile, fnName) {
    if (!srcFile || !fs.existsSync(srcFile)) return null;
    let text;
    try { text = fs.readFileSync(srcFile, "utf8"); } catch (e) { return null; }
    const lines = text.split("\n");
    const start = lines.findIndex(l => new RegExp("function\\s+" + fnName + "\\s*\\(").test(l));
    if (start < 0) return null;
    let depth = 0, end = -1;
    for (let i = start; i < lines.length; i++) {
      for (const ch of lines[i]) { if (ch === "{") depth++; else if (ch === "}") depth--; }
      if (depth === 0) { end = i; break; }
    }
    if (end < 0) return null;
    return lines.slice(start, end + 1).join("\n");
  }

  function runRenderAuthor(src) {
    let captured = "";
    const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const $ = (sel) => (sel === "#author" ? { set innerHTML(v) { captured = v; } } : { set innerHTML(v) {}, set textContent(v) {} });
    const fn = new Function("esc", "$", "j", src + "\nrenderAuthor(j);");
    fn(esc, $, { name: info.name || "测试作者", username: info.username || "testuser", avatar: info.avatar || "" });
    return captured;
  }

  const oldSrc = extractFunction(OLD_HTML, "renderAuthor");
  if (oldSrc) {
    try {
      const out = runRenderAuthor(oldSrc);
      check("旧项目 renderAuthor 渲染", /<img class="author-avatar"/.test(out), out.slice(0, 90) || "(空)");
    } catch (e) { check("旧项目 renderAuthor 执行", false, String(e.message)); }
  } else { console.log("  - 旧项目 renderAuthor 未提取到，跳过"); }

  const newSrc = extractFunction(NEW_JS, "renderAuthor") || extractFunction("./server/public/play-app.js", "renderAuthor");
  if (newSrc) {
    try {
      const out = runRenderAuthor(newSrc);
      check("新项目 renderAuthor 渲染", /<img class="author-avatar"/.test(out), out.slice(0, 90) || "(空)");
    } catch (e) { check("新项目 renderAuthor 执行", false, String(e.message)); }
  } else { console.log("  - 新项目 renderAuthor 未提取到，跳过"); }

  console.log("\n═══ 测试结果: " + pass + " 通过 / " + fail + " 失败 ═══");
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error("测试脚本异常:", e); process.exit(2); });
