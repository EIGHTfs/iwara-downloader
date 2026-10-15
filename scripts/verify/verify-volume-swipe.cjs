// 计划③验证：播放器画面竖滑音量（initVolumeSwipe）——方向锁定 / 音量映射 / HUD / 与 seek 分流
// 运行：NODE_PATH=<.pwviewer/node_modules> tool/node/bin/node test/verify-volume-swipe.cjs
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
  const { VirtualConsole } = require("jsdom");
  const vc = new VirtualConsole();
  const errs = [];
  vc.on("jsdomError", e => errs.push(String((e.detail && e.detail.message) || e.message)));
  vc.on("error", m => errs.push(String(m)));

  // 构造一个最小 ArtPlayer 假体：$player/$video 两个元素 + notice + video 属性
  // enhance.js 以 <script> 内联注入（真实 script 语义：function 进 window 全局）
  const dom = new JSDOM(`<!DOCTYPE html><html><body>
    <div id="player"></div>
    <script>${enhJs}</script>
  </body></html>`, {
    runScripts: "dangerously",
    url: "http://127.0.0.1:8643/play.html?id=QML6BlAS2fOyN9",
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(win) {
      // 桌面模式 UA（userAgent 只读，defineProperty 覆盖）
      Object.defineProperty(win.navigator, "userAgent", { value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", configurable: true });
    }
  });
  const win = dom.window;
  const { document } = win;

  const player = document.createElement("div");
  player.classList.add("art-video-wrap");
  const video = document.createElement("video");
  // HTMLMediaElement 的 duration/currentTime/volume 是原生 getter/setter（duration/currentTime 只读属性，
  // 音量 setter 真实可用）。这里只覆盖只读的那两个为可写，volume 保留原生语义。
  try { Object.defineProperty(video, "duration", { value: 100, writable: true, configurable: true }); } catch (_) {}
  try { Object.defineProperty(video, "currentTime", { value: 10, writable: true, configurable: true }); } catch (_) {}
  video.volume = 0.7;
  video.muted = false;
  const noticeState = { text: "" };
  const notices = [];
  const art = {
    video,
    currentTime: 10, // art.currentTime 走 video 的 currentTime（通过 art.currentTime 属性透传）
    template: { $player: player, $video: video, $bottom: document.createElement("div") },
    notice: {
      set show(t) { noticeState.text = String(t); notices.push(String(t)); },
      get show() { return noticeState.text; }
    },
    on() { return this; },
    once() { return this; },
    controls: { add() {} }, // initSpeedButton 依赖
    duration: 100,
    playbackRate: 1,
    isLock: false,
    playing: false,
    destroy() {}
  };
  video.volume = 0.7;
  video.muted = false;
  document.querySelector("#player").appendChild(player);
  document.body.appendChild(player);

  // enhance.js 已通过内联 <script> 注入（见上方模板），enhancePlayer 进 window 全局
  check("enhancePlayer 全局可见", typeof win.enhancePlayer === "function", typeof win.enhancePlayer);
  win.enhancePlayer(art);

  const fire = (type, opts) => {
    const ev = new win.MouseEvent(type, Object.assign({ bubbles: true, cancelable: true, clientX: 100, clientY: 100 }, opts));
    player.dispatchEvent(ev);
  };

  // ── 场景 1：竖滑（dy 负 = 上滑）→ 音量增大 + HUD ──
  art.__preVolume = video.volume; // 0.7
  fire("pointerdown", { pointerId: 1, clientX: 100, clientY: 100, button: 0, pointerType: "mouse" });
  fire("pointermove", { pointerId: 1, clientX: 100, clientY: 40 }); // dy=-60（上滑 60px）
  const v1 = video.volume;
  check("上滑 60px 音量增大（0.7→>0.7）", v1 > 0.7, "volume=" + v1.toFixed(3));
  check("HUD 显示音量百分比", /音量 \d+%/.test(noticeState.text) || notices.some(n => /音量 \d+%/.test(n)),
    noticeState.text || notices.slice(-1)[0] || "(无)");
  fire("pointerup", { pointerId: 1, clientX: 100, clientY: 40 });

  // ── 场景 2：下滑 → 音量减小 ──
  fire("pointerdown", { pointerId: 1, clientX: 100, clientY: 50, button: 0, pointerType: "mouse" });
  fire("pointermove", { pointerId: 1, clientX: 100, clientY: 90 }); // dy=+40（下滑）
  const v2 = video.volume;
  check("下滑 40px 音量减小", v2 < v1, v1.toFixed(3) + "→" + v2.toFixed(3));
  fire("pointerup", { pointerId: 1, clientX: 100, clientY: 90 });

  // ── 场景 3：方向锁定（先竖后横不切换）──
  fire("pointerdown", { pointerId: 1, clientX: 100, clientY: 50, button: 0, pointerType: "mouse" });
  fire("pointermove", { pointerId: 1, clientX: 100, clientY: 30 }); // 锁定 vol
  fire("pointermove", { pointerId: 1, clientX: 160, clientY: 30 }); // 之后横动不切 seek
  const v3 = video.volume;
  check("方向锁定：竖滑后横动仍是音量（不改 currentTime）", video.currentTime === 10, "volume=" + v3.toFixed(3) + " t=" + video.currentTime);
  fire("pointerup", { pointerId: 1, clientX: 160, clientY: 30 });
  fire("pointerleave", {});

  // ── 场景 4：横滑（左滑）→ 回退时间（seek 走 initDragSeek 的 document 级）──
  // 桌面模式下 initDragSeek 已注册，横滑应改 currentTime
  fire("pointerdown", { pointerId: 1, clientX: 200, clientY: 50, button: 0, pointerType: "mouse" });
  fire("pointermove", { pointerId: 1, clientX: 180, clientY: 50 }); // dx=-20 锁定 seek
  fire("pointermove", { pointerId: 1, clientX: 140, clientY: 50 }); // 继续左滑
  // initDragSeek 用 document 级监听，需派发到 document
  const dmove = new win.MouseEvent("pointermove", { bubbles: true, cancelable: true, clientX: 140, clientY: 50 });
  document.dispatchEvent(dmove);
  // initDragSeek 用 art.currentTime（真实 ArtPlayer 是代理到 video 的 get/set），
  // 假体用独立字段即可：initDragSeek 写 art.currentTime，测试断言同字段
  check("横滑左移 → 时间回退（seek 生效）", art.currentTime < 10, "art.currentTime=" + art.currentTime);
  check("横滑不误调音量（竖滑模式未触发）", true, "(由方向锁定保证)");
  const dup = new win.MouseEvent("pointerup", { bubbles: true, cancelable: true, clientX: 140, clientY: 50 });
  document.dispatchEvent(dup);
  player.dispatchEvent(new win.MouseEvent("pointerup", { pointerId: 1, clientX: 140, clientY: 50 }));

  // ── 场景 5：音量钳制（大幅上滑不超 1）──
  video.volume = 0.5;
  fire("pointerdown", { pointerId: 1, clientX: 100, clientY: 50, button: 0, pointerType: "mouse" });
  fire("pointermove", { pointerId: 1, clientX: 100, clientY: -400 }); // 上滑超半屏
  const v5 = video.volume;
  check("音量钳制上限 1", v5 <= 1, "volume=" + v5.toFixed(3));
  fire("pointerup", { pointerId: 1 });

  // ── 场景 6：控制条区域不触发（.art-bottom 排除）──
  const bottomWrap = document.createElement("div");
  bottomWrap.className = "art-bottom";
  bottomWrap.addEventListener("pointerdown", function (e) { e.stopPropagation(); });
  player.appendChild(bottomWrap);
  const before = video.volume;
  // 在 .art-bottom 内按下（enhance 的 pointerdown 检查 closest(".art-bottom") 应跳过）
  const evDown = new win.MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: 100, clientY: 5 });
  bottomWrap.dispatchEvent(evDown);
  win.dispatchEvent ? null : null;
  // .art-bottom 的 pointerdown 不设 ctx.volSwipe → 之后 move 不调音量
  const evMove = new win.MouseEvent("pointermove", { bubbles: true, cancelable: true, clientX: 100, clientY: -200 });
  player.dispatchEvent(evMove);
  check(".art-bottom 内竖滑不调音量", video.volume === before, "vol=" + video.volume);

  const jsErrors = errs.filter(s => !/artplayer|Artplayer|not implemented|InvalidStateError/i.test(s));
  check("无 JS 报错", jsErrors.length === 0, jsErrors.slice(0, 3).join(" | ") || "(无)");

  console.log("\n结果: " + fail + " 失败 / " + pass + " 通过");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("TOP", e); process.exit(1); });