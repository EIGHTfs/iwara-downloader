// 计划③补充：画面左右拖动 scrub seek 验证（拖动中进度条时间实时跟随、1s 最小单位、播放中暂停防卡顿、松手恢复）
// 运行：NODE_PATH=<.pwviewer/node_modules> tool/node/bin/node test/verify-drag-scrub.cjs
"use strict";
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

(async () => {
  let pass = 0, fail = 0;
  const check = (name, ok, detail) => {
    ok ? pass++ : fail++;
    console.log((ok ? "  ✓ " : "  ✗ ") + name + (detail ? "  [" + detail + "]" : ""));
  };

  const enhJs = fs.readFileSync(path.join(__dirname, "..", "server", "public", "play-enhance.js"), "utf8");

  // 构造带 API 的 mock ArtPlayer（enhancePlayer 只依赖 template/on/video/duration/currentTime/isLock/play/pause/controls.add）
  const dom = new JSDOM(`<!DOCTYPE html><html><body>
    <div id="player" style="width:800px;height:450px">
      <video id="video"></video>
      <div class="art-bottom"></div>
    </div>
  </body></html>`, { runScripts: "dangerously", url: "http://127.0.0.1:8643/play.html?id=T1" });
  const { window } = dom;
  const playerEl = window.document.getElementById("player");
  const videoEl = window.document.getElementById("video");

  let vPaused = false; // mock 内部暂停态（art.play/pause 与 video.paused getter 共用）
  const art = {
    template: { $player: playerEl, $video: videoEl, $progress: null },
    duration: 100,
    currentTime: 0,
    isLock: false,
    playing: false,
    controls: { add: function () {} },
    on: function (ev, fn) { this._h = this._h || {}; (this._h[ev] = this._h[ev] || []).push(fn); },
    play: function () { this.playing = true; vPaused = false; },
    pause: function () { this.playing = false; vPaused = true; },
    destroy: function () {},
    video: videoEl
  };
  try {
    Object.defineProperty(art.video, "paused", { configurable: true, get: function () { return vPaused; } });
    Object.defineProperty(art.video, "duration", { configurable: true, get: function () { return 100; } });
  } catch (_) {}
  art.video.play = function () { art.playing = true; vPaused = false; };
  art.video.pause = function () { art.playing = false; vPaused = true; };

  window.__mockArt = art;
  window.enhancePlayer = undefined;
  // 注入 play-enhance.js（enhancePlayer 定义进 window 全局）
  const script = window.document.createElement("script");
  script.textContent = enhJs;
  window.document.body.appendChild(script);
  const enhancePlayer = window.enhancePlayer;
  if (typeof enhancePlayer !== "function") { console.log("FAIL: enhancePlayer 未挂载"); process.exit(1); }
  enhancePlayer(art);

  // 触发 pointerdown → 横移 400px（半宽=50s）→ 模拟拖动过程
  function fire(el, type, x, y, pointerId) {
    let ev;
    try {
      ev = new window.PointerEvent(type, { clientX: x, clientY: y, pointerId: pointerId || 1, bubbles: true, pointerType: "touch" });
    } catch (err) {
      console.log("!! PointerEvent 构造失败:", err.message);
      ev = new window.Event(type, { bubbles: true });
      ev.clientX = x; ev.clientY = y; ev.pointerId = pointerId || 1; ev.pointerType = "touch";
    }
    el.dispatchEvent(ev);
    return ev;
  }

  // 1) pointerdown 在画面（避开 .art-bottom）
  const rect = { left: 0, top: 0, width: 800, height: 450 };
  playerEl.getBoundingClientRect = () => rect;
  try { Object.defineProperty(playerEl, "clientWidth", { configurable: true, get: function () { return 800; } }); } catch (_) {}
  art.currentTime = 10; // 从 10s 开始拖
  fire(playerEl, "pointerdown", 400, 200);
  // 2) 横移超 10px 阈值 → seeking
  fire(playerEl, "pointermove", 415, 205);
  // 3) 拖到 600px（+200px = +25s → 目标 35s），document 级 pointermove 驱动
  fire(window.document, "pointermove", 600, 205);
  check("拖动中实时 seek（进度条时间跟随）", art.currentTime === 35, "currentTime=" + art.currentTime);
  check("拖动中取整到整秒", Number.isInteger(art.currentTime), "currentTime=" + art.currentTime);
  check("播放中拖动先暂停（防连续 seek 缓冲）", art.video.paused === true, "paused=" + art.video.paused);
  check("暂停后画面停在目标帧（currentTime 已赋值）", art.currentTime === 35, "currentTime=" + art.currentTime);

  // 4) 继续拖到 750px（+350px=43.75s → 目标 53.75 → 取整 54s）
  vPaused = true;
  fire(window.document, "pointermove", 750, 205);
  check("二次拖动目标取整到秒（53.75→54）", art.currentTime === 54, "currentTime=" + art.currentTime);

  // 5) 松手 → 定格 + 恢复播放（原本在播）
  fire(playerEl, "pointerup", 750, 205);
  check("松手恢复播放（原本在播）", art.playing === true && art.video.paused === false, "playing=" + art.playing);
  check("松手后定格在最终整秒", art.currentTime === 54, "currentTime=" + art.currentTime);

  // 6) 拖动过程未超过 1s 不重复 seek（同一秒内抖动不触发）
  art.currentTime = 54; vPaused = false; art.playing = true;
  fire(playerEl, "pointerdown", 700, 200);
  fire(playerEl, "pointermove", 712, 200); // 超阈值进入 seeking
  const before = art.currentTime;
  fire(window.document, "pointermove", 713, 200); // 1px 抖动：目标仍在 54s 附近
  fire(window.document, "pointermove", 714, 200);
  check("同一秒内微动不重复 seek（1s 最小单位）", art.currentTime === before, "currentTime=" + art.currentTime);
  fire(playerEl, "pointerup", 714, 200);

  // 7) 暂停状态下拖动：松手保持暂停（不误恢复）
  vPaused = true; art.playing = false;
  art.currentTime = 0;
  fire(playerEl, "pointerdown", 400, 200);
  fire(playerEl, "pointermove", 500, 200);
  fire(window.document, "pointermove", 640, 200);
  fire(playerEl, "pointerup", 640, 200);
  check("原本暂停：拖动后保持暂停", art.video.paused === true && art.playing === false, "paused=" + art.video.paused);

  console.log("\n结果: " + pass + " 通过 / " + fail + " 失败");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("ERR", e); process.exit(1); });
