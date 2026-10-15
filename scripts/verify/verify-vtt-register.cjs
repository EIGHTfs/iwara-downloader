// 计划④前端验证：initPlayer 的 art.once("ready") 注册 VTT 插件（模拟 info.thumbVtt + 插件全局）
"use strict";
const fs = require("fs"), path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");
(async () => {
  let pass = 0, fail = 0;
  const check = (n, ok, d) => { ok ? pass++ : fail++; console.log((ok ? "  ✓ " : "  ✗ ") + n + (d ? "  [" + d + "]" : "")); };
  const playApp = fs.readFileSync(path.join(__dirname, "..", "server", "public", "play-app.js"), "utf8");
  const vc = new VirtualConsole();
  vc.on("jsdomError", e => console.log("jsdomError:", String(e.detail && e.detail.message || e.message)));
  // 去掉自动执行尾部（init() 需要真实页面），函数进全局
  const dom = new JSDOM(`<!DOCTYPE html><html><body>
    <div id="player"></div><div id="err"></div>
    <script>${playApp.replace(/\ninit\(\);\s*$/, "\n// init 由测试手动驱动")}</script>
  </body></html>`, {
    runScripts: "dangerously", url: "http://127.0.0.1:8643/play.html?id=AAA111",
    pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(win) {
      if (!win.localStorage) { const s = {}; win.localStorage = { getItem: k => k in s ? s[k] : null, setItem: (k,v)=>{s[k]=String(v);}, removeItem: k=>{delete s[k];} }; }
    }
  });
  const win = dom.window; const doc = win.document;
  let registered = null, readyCb = null;
  // 造 Artplayer 假体：构造时记录 options，once("ready") 存回调
  win.Artplayer = function (opts) {
    this.opts = opts;
    this.video = doc.createElement("video");
    this.plugins = { add: (p) => { registered = p && typeof p === "function" ? "fn" : String(p && p.name || p); } };
    this.on = function () { return this; };
    this.once = function (ev, cb) { if (ev === "ready") readyCb = cb; return this; };
    this.destroy = function () {};
    this.currentTime = 0; this.duration = 100; this.playbackRate = 1;
  };
  win.artplayerPluginVttThumbnail = function (cfg) { return cfg; }; // 插件全局存在
  win.$ = (sel) => doc.querySelector(sel);
  // 手动驱动 initPlayer（info.thumbVtt 存在）
  win.initPlayer({ hasFile: true, partial: false, thumbVtt: "/api/thumbnail-vtt?id=AAA111", ext: ".mkv", title: "t", username: "", avatar: "", fileId: "", duration: 100, tags: [] }, "");
  check("art 实例创建（Artplayer 被调用）", win.art && win.art.opts && true, "(instance)");
  await new Promise(r => setTimeout(r, 50));
  check("ready 回调已注册（once）", typeof readyCb === "function", typeof readyCb);
  readyCb(); // 触发 ready → plugins.add
  check("ready 后 VTT 插件已注册（plugins.add 收到配置对象）", registered !== null, String(registered));
  // 无 thumbVtt 时不注册（partial/未生成场景）
  registered = null; readyCb = null;
  win.initPlayer({ hasFile: true, partial: true, thumbVtt: "", ext: ".mkv", title: "t", username: "", avatar: "", fileId: "", duration: 100, tags: [] }, "");
  await new Promise(r => setTimeout(r, 50));
  check("partial 无 thumbVtt 不注册", readyCb === null && registered === null, "readyCb=" + readyCb);
  console.log("\n结果: " + fail + " 失败 / " + pass + " 通过");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("TOP", e); process.exit(1); });
