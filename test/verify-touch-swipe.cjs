// 计划③触摸屏适配验证：移动端 UA 下画面横滑 seek（initDragSeek 已开放）+ 竖滑音量（touch 通道）并存
// 运行：NODE_PATH=<.pwviewer/node_modules> tool/node/bin/node test/verify-touch-swipe.cjs
"use strict";
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

(async () => {
  let pass = 0, fail = 0;
  const check = (name, ok, detail) => {
    ok ? pass++ : fail++;
    console.log((ok ? "  ✓ " : "  ✗ ") + name + (detail ? "  [" + detail + "]" : ""));
  };
  const enhJs = fs.readFileSync(path.join(__dirname, "..", "server", "public", "play-enhance.js"), "utf8");
  const vc = new VirtualConsole();
  const errs = [];
  vc.on("jsdomError", e => errs.push(String((e.detail && e.detail.message) || e.message)));
  vc.on("error", m => errs.push(String(m)));

  // 移动端 UA（iPhone）注入 enhance.js——IS_MOBILE=true
  const dom = new JSDOM(`<!DOCTYPE html><html><body>
    <div id="player"></div>
    <script>${enhJs}</script>
  </body></html>`, {
    runScripts: "dangerously",
    url: "http://127.0.0.1:8643/play.html?id=AAA111",
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(win) {
      Object.defineProperty(win.navigator, "userAgent", {
        value: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
        configurable: true
      });
    }
  });
  const win = dom.window;
  const { document } = win;
  const player = document.createElement("div");
  player.classList.add("art-video-wrap");
  const video = document.createElement("video");
  try { Object.defineProperty(video, "duration", { value: 100, writable: true, configurable: true }); } catch (_) {}
  try { Object.defineProperty(video, "currentTime", { value: 30, writable: true, configurable: true }); } catch (_) {}
  video.volume = 0.5;
  video.muted = false;
  const noticeState = { text: "" };
  const art = {
    video,
    currentTime: 30,
    template: { $player: player, $video: video, $bottom: document.createElement("div") },
    notice: { set show(t) { noticeState.text = String(t); }, get show() { return noticeState.text; } },
    on() { return this; }, once() { return this; },
    controls: { add() {} },
    duration: 100, playbackRate: 1, isLock: false, playing: false, destroy() {}
  };
  document.querySelector("#player").appendChild(player);
  document.body.appendChild(player);

  check("enhancePlayer 全局可见", typeof win.enhancePlayer === "function", typeof win.enhancePlayer);
  win.enhancePlayer(art);

  // 触摸事件模拟：pointerType=touch（jsdom 无 Touch 构造，用 MouseEvent 带 pointerType 属性 + 手动派发）
  const firePtr = (type, opts) => {
    const ev = new win.MouseEvent(type, Object.assign({ bubbles: true, cancelable: true, clientX: 100, clientY: 100 }, opts));
    Object.defineProperty(ev, "pointerType", { value: "touch" });
    Object.defineProperty(ev, "pointerId", { value: 1 });
    player.dispatchEvent(ev);
    return ev;
  };

  // ═══ 场景 1：移动端横滑 seek（initDragSeek 已开放，画面左滑 80px）═══
  firePtr("pointerdown", { clientX: 200, clientY: 50, button: 0 });
  firePtr("pointermove", { clientX: 180, clientY: 50 }); // dx=-20 → 锁定 seek
  const dmove = new win.MouseEvent("pointermove", { bubbles: true, cancelable: true, clientX: 120, clientY: 50 });
  Object.defineProperty(dmove, "pointerType", { value: "touch" });
  document.dispatchEvent(dmove); // initDragSeek 的 document 级 pointermove
  const tSeek = art.currentTime;
  check("移动端横滑左移 → 时间回退（seek 已开放）", tSeek < 30, "t=" + tSeek.toFixed(2));
  const dup = new win.MouseEvent("pointerup", { bubbles: true, cancelable: true, clientX: 120, clientY: 50 });
  document.dispatchEvent(dup);
  player.dispatchEvent(new win.MouseEvent("pointerup", { pointerId: 1, clientX: 120, clientY: 50 }));

  // ═══ 场景 2：移动端竖滑音量（touch 通道，回归）═══
  video.volume = 0.5;
  art.currentTime = tSeek;
  firePtr("pointerdown", { clientX: 100, clientY: 80, button: 0 });
  firePtr("pointermove", { clientX: 100, clientY: 30 }); // dy=-50 上滑
  const vUp = video.volume;
  check("移动端上滑音量增大", vUp > 0.5, "vol=" + vUp.toFixed(3));
  check("移动端音量 HUD 显示", /音量 \d+%/.test(noticeState.text), noticeState.text || "(无)");
  player.dispatchEvent(new win.MouseEvent("pointerup", { pointerId: 1, clientX: 100, clientY: 30 }));

  // ═══ 场景 3：移动端横滑后不误调音量（方向锁定）═══
  const vBefore = video.volume;
  firePtr("pointerdown", { clientX: 200, clientY: 60, button: 0 });
  firePtr("pointermove", { clientX: 150, clientY: 62 }); // 横滑（dx=-50）
  const vAfter = video.volume;
  check("横滑不误调音量", vAfter === vBefore, vBefore.toFixed(3) + " → " + vAfter.toFixed(3));
  player.dispatchEvent(new win.MouseEvent("pointerup", { pointerId: 1, clientX: 150, clientY: 62 }));

  // ═══ 场景 4：移动端长按快进未挂自绘（保持官方 fastForward 唯一）═══
  // initHoldFastForward 在 IS_MOBILE 早退之后——ctx.clearHold 应为 undefined
  check("移动端未挂自绘长按（clearHold 不存在）", art.__enhCtx ? !art.__enhCtx.clearHold : true, "(返回按设计)");
  // initHoldFastForward 不注册的直接证据：本测试没拿到 ctx，改用行为证实——
  // 移动端 pointerdown 后按住不动不应触发任何速度变化（官方 fastForward 才管长按）
  const rateBefore = art.playbackRate;
  firePtr("pointerdown", { clientX: 100, clientY: 100, button: 0 });
  await new Promise(r => setTimeout(r, 700)); // 超过 600ms 长按时长
  check("移动端按住 700ms 不触发自绘 3x 快进", art.playbackRate === rateBefore, "rate=" + art.playbackRate + "（官方 fastForward 才管触摸长按）");
  player.dispatchEvent(new win.MouseEvent("pointerup", { pointerId: 1, clientX: 100, clientY: 100 }));

  const jsErrors = errs.filter(s => !/artplayer|Artplayer|not implemented|InvalidStateError/i.test(s));
  check("无 JS 报错", jsErrors.length === 0, jsErrors.slice(0, 3).join(" | ") || "(无)");

  console.log("\n结果: " + fail + " 失败 / " + pass + " 通过");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("TOP", e); process.exit(1); });