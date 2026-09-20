// 计划①验证：播放页点赞/关注按钮 toggle 行为
// 断言：data-on=true 点击 → DELETE；data-on=false 点击 → POST；成功翻转、失败不翻转
// 运行：tool/node/bin/node test/verify-toggle.cjs（需被测服务在 BASE 上）
"use strict";
const BASE = process.env.BASE || "http://127.0.0.1:28463";

(async () => {
  const { JSDOM, VirtualConsole } = require("jsdom");
  let pass = 0, fail = 0;
  const check = (name, ok, detail) => {
    ok ? pass++ : fail++;
    console.log((ok ? "  ✓ " : "  ✗ ") + name + (detail ? "  [" + detail + "]" : ""));
  };

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

  const calls = [];
  const dom = new JSDOM(`<!DOCTYPE html><html><head></head><body>${body}
<script>${listJs}</script>
<script>${enhJs}</script>
<script>${appJs}</script>
</body></html>`, {
    url: BASE + "/play.html?id=QML6BlAS2fOyN9",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(win) {
      win.fetch = (url, opts) => {
        calls.push({ url: String(url), method: (opts && opts.method) || "GET" });
        return Promise.resolve({
          json: () => Promise.resolve({ ok: true }),
          ok: true
        });
      };
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
  const likeBtn = win.document.getElementById("likeBtn");
  const followBtn = win.document.getElementById("followBtn");
  check("三件套加载无异常", typeof win.initPlayTools === "function" && typeof win.bindStateButtons === "function",
    "initPlayTools=" + typeof win.initPlayTools + " bindStateButtons=" + typeof win.bindStateButtons);

  // ── 场景 1：按钮初始 data-on=false → 点击应发 POST ──
  calls.length = 0;
  likeBtn.dataset.on = "false";
  likeBtn.disabled = false;
  likeBtn.click();
  await new Promise(r => setTimeout(r, 100));
  const postLike = calls.find(c => c.url.indexOf("/api/like") >= 0);
  check("未赞点击 likeBtn → POST /api/like", postLike && postLike.method === "POST",
    postLike ? postLike.method + " " + postLike.url : "(无调用)");
  check("点赞成功按钮翻转 data-on=true", likeBtn.dataset.on === "true", "data-on=" + likeBtn.dataset.on);

  // ── 场景 2：data-on=true → 点击应发 DELETE（取消点赞）──
  calls.length = 0;
  likeBtn.dataset.on = "true";
  likeBtn.disabled = false;
  likeBtn.click();
  await new Promise(r => setTimeout(r, 100));
  const delLike = calls.find(c => c.url.indexOf("/api/like") >= 0);
  check("已赞点击 likeBtn → DELETE /api/like", delLike && delLike.method === "DELETE",
    delLike ? delLike.method + " " + delLike.url : "(无调用)");
  check("取消成功按钮翻转 data-on=false", likeBtn.dataset.on === "false", "data-on=" + likeBtn.dataset.on);

  // ── 场景 3：关注按钮 toggle（含 authorId 缺失拦截）──
  calls.length = 0;
  followBtn.dataset.authorId = "";
  followBtn.dataset.on = "false";
  followBtn.disabled = false;
  followBtn.click();
  await new Promise(r => setTimeout(r, 100));
  check("无 authorId 点击不调 /api/follow", calls.filter(c => c.url.indexOf("/api/follow") >= 0).length === 0, "(应被拦截)");

  calls.length = 0;
  followBtn.dataset.authorId = "84128602-26ef-4a9d-9f0a-ee174ccbd94f";
  followBtn.dataset.on = "false";
  followBtn.disabled = false;
  followBtn.click();
  await new Promise(r => setTimeout(r, 100));
  const postF = calls.find(c => c.url.indexOf("/api/follow") >= 0);
  check("未关注点击 followBtn → POST /api/follow", postF && postF.method === "POST",
    postF ? postF.method + " " + postF.url : "(无调用)");

  calls.length = 0;
  followBtn.dataset.on = "true";
  followBtn.disabled = false;
  followBtn.click();
  await new Promise(r => setTimeout(r, 100));
  const delF = calls.find(c => c.url.indexOf("/api/follow") >= 0);
  check("已关注点击 followBtn → DELETE /api/follow", delF && delF.method === "DELETE",
    delF ? delF.method + " " + delF.url : "(无调用)");

  const jsErrors = errs.filter(s => !/artplayer|Artplayer/i.test(s));
  check("页面无 JS 报错（除 artplayer 库）", jsErrors.length === 0, jsErrors.slice(0, 3).join(" | ") || "(无)");

  console.log("\n结果: " + fail + " 失败 / " + pass + " 通过");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("TOP", e); process.exit(1); });