// 播放器交互增强（B 站式）：倍速按钮 + 长按 3x 快进 + 左右拖动进度条 + 长按抑制设置菜单
// 从 play-app.js 的 initPlayer 拆分而来（play-app.js 超 400 行按职责拆分）；
// initPlayer 创建 artplayer 实例后调用 enhancePlayer(art)。
// 移动端长按倍速走 ArtPlayer 官方 fastForward（artOptions 里 fastForward: true），不在此实现。
"use strict";

var SPEEDS = [1, 1.25, 1.5, 2, 3];
var IS_MOBILE = /Mobi|Android|iPhone|iPad|iPod|HarmonyOS/i.test(navigator.userAgent || "");

function speedBtnHtml(v) {
  return '<span class="art-speed-btn" style="font-size:12px;font-weight:700;letter-spacing:.5px;min-width:34px;text-align:center">' + v + 'x</span>';
}
function currentSpeedIndex(art) {
  var idx = SPEEDS.indexOf(art.playbackRate || 1);
  return idx === -1 ? 0 : idx;
}
function syncSpeedBtn(art) {
  var el = document.querySelector(".art-control .art-speed-btn");
  if (el) el.textContent = (art.playbackRate || 1) + "x";
}

function enhancePlayer(art) {
  if (!art) return;
  // 交互共享状态（每次 enhancePlayer 独立一份，旧实例 destroy 后随闭包释放）
  var ctx = {
    tapArmed: false, suppressTapClick: false,
    holdTimer: null, holdOn: false, holdBase: 1, suppressClick: false,
    drag: null, suppressCtxMenu: false, ctxClearTimer: null
  };
  initSpeedButton(art);
  initTapToPlay(art, ctx);
  initCtxSuppress(art, ctx);
  if (IS_MOBILE) return; // 移动端：seek/长按走官方 gesture
  initHoldFastForward(art, ctx);
  initDragSeek(art, ctx);
  // 捕获阶段拦截长按结束的 click，防止内核「单击暂停」在松手时误触发
  art.template.$player.addEventListener("click", function (e) {
    if (ctx.suppressClick) { e.stopPropagation(); e.preventDefault(); }
  }, true);
}

// 1) 控制条右上角倍速按钮：循环切换 1 → 1.25 → 1.5 → 2 → 3 → 1
function initSpeedButton(art) {
  art.controls.add({
    name: "speed",
    position: "right",
    index: 20,
    html: speedBtnHtml(1),
    tooltip: "倍速",
    click: function () {
      var next = SPEEDS[(currentSpeedIndex(art) + 1) % SPEEDS.length];
      art.playbackRate = next;
      art.notice.show = "倍速 " + next + "x";
      syncSpeedBtn(art);
    }
  });
  // 设置面板/快捷键改速时按钮文字也要同步
  art.on("video:ratechange", function () { syncSpeedBtn(art); });
  art.on("video:play", function () { syncSpeedBtn(art); });
}

// 2) autoplay 被浏览器拦截（有声自动播放策略）时：首次点画面立即开始播放
//    自动播放失败约 1 秒后仍处于暂停 → 武装「点击即播」；按下瞬间 play()，并把这个
//    click 拦下来（否则刚 play 又被内核「单击暂停」停掉）。与长按互斥：长按要求播放中。
function initTapToPlay(art, ctx) {
  setTimeout(function () {
    if (art.video && art.video.paused && !art.playing) ctx.tapArmed = true;
  }, 800);
  art.template.$player.addEventListener("pointerdown", function (e) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    var t = e.target;
    if (t && t.closest && t.closest(".art-bottom")) return;
    if (ctx.tapArmed && art.video && art.video.paused && !art.playing) {
      ctx.tapArmed = false;
      ctx.suppressTapClick = true;
      setTimeout(function () { ctx.suppressTapClick = false; }, 80);
      art.play();
    }
  }, true);
  art.template.$player.addEventListener("click", function (e) {
    if (ctx.suppressTapClick) { e.stopPropagation(); e.preventDefault(); }
  }, true);
}

// 3) 长按画面抑制浏览器 contextmenu（ArtPlayer 的右键「播放速度/画面比例/统计信息」面板
//    由 contextmenu 事件触发；移动端长按/桌面左键长按结束会误弹，按住期间拦截它。
//    右键（button=2）不在此列：pointerdown 的 button!==0 分支已放行右键，菜单保留）
function initCtxSuppress(art, ctx) {
  art.template.$player.addEventListener("contextmenu", function (e) {
    if (ctx.suppressCtxMenu) {
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation(); // 阻断同节点 ArtPlayer 的弹面板
    }
  }, true);
  // 按住结束后延迟解除抑制（长按松开瞬间仍可能触发 contextmenu）
  art.template.$player.addEventListener("pointerup", function () {
    if (ctx.ctxClearTimer) clearTimeout(ctx.ctxClearTimer);
    ctx.ctxClearTimer = setTimeout(function () { ctx.suppressCtxMenu = false; }, 250);
  });
  art.template.$player.addEventListener("pointercancel", function () {
    if (ctx.ctxClearTimer) clearTimeout(ctx.ctxClearTimer);
    ctx.ctxClearTimer = setTimeout(function () { ctx.suppressCtxMenu = false; }, 250);
  });
}

// 4a) 桌面长按画面 600ms → 3x 快进（官方 fastForward 仅移动端生效，桌面端自定义实现）
function initHoldFastForward(art, ctx) {
  art.template.$player.addEventListener("pointerdown", function (e) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    var t = e.target;
    if (t && t.closest && t.closest(".art-bottom")) return; // 控制条/进度条区域不触发
    if (art.isLock) return;
    if (!art.playing || art.paused) return;
    ctx.holdBase = art.playbackRate || 1;
    ctx.holdTimer = setTimeout(function () {
      ctx.holdOn = true;
      art.playbackRate = 3;
      art.notice.show = "3x 快进中，松开恢复";
      syncSpeedBtn(art);
    }, 600);
  });
  function clearHold() {
    if (ctx.holdTimer) { clearTimeout(ctx.holdTimer); ctx.holdTimer = null; }
    if (ctx.holdOn) {
      ctx.holdOn = false;
      ctx.suppressClick = true;
      setTimeout(function () { ctx.suppressClick = false; }, 80);
      art.playbackRate = ctx.holdBase;
      art.notice.show = "";
      syncSpeedBtn(art);
    }
  }
  ctx.clearHold = clearHold; // 暴露给 initDragSeek：进入拖动时取消长按计时，避免拖动期间误触发 3x
  art.template.$player.addEventListener("pointerup", clearHold);
  art.template.$player.addEventListener("pointercancel", clearHold);
  art.template.$player.addEventListener("pointerleave", clearHold);
}

// 4b) 按住画面左右拖动 → 拖进度条 seek（移动超过阈值即取消长按快进）
//     pointer 捕获保证拖出画面后 pointermove/up 仍派发给画面；document 级跟随持续更新。
//     触摸屏也适用：touch-action:none 让触摸拖动不被浏览器滚动接管（否则 pointermove 被吞、拖不动）。
function initDragSeek(art, ctx) {
  var player = art.template.$player;
  player.style.touchAction = "none"; // 关键：触摸拖动时持续派发 pointermove，不触发滚动/pointercancel
  if (art.template.$video) art.template.$video.style.touchAction = "none";
  function onDragMove(e) {
    if (!ctx.drag || !ctx.drag.seeking || !art.video) return;
    var dx = e.clientX - ctx.drag.startX;
    var ratio = dx / ctx.drag.width;
    var nt = Math.min(Math.max(ctx.drag.startTime + ratio * ctx.drag.duration, 0), ctx.drag.duration - 0.1);
    if (Math.abs(nt - ctx.drag.lastT) > 0.05) {
      ctx.drag.lastT = nt;
      art.currentTime = nt;
    }
  }
  document.addEventListener("pointermove", onDragMove);
  art.on("destroy", function () { document.removeEventListener("pointermove", onDragMove); });
  player.addEventListener("pointerdown", function (e) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    var t = e.target;
    if (t && t.closest && t.closest(".art-bottom")) return;
    if (art.isLock) return;
    try { if (e.target.setPointerCapture) e.target.setPointerCapture(e.pointerId); } catch (_) {}
    ctx.suppressCtxMenu = true; // 按住期间不弹 contextmenu（与 4a 共用）
    var d = art.duration || 0;
    if (d > 0) {
      ctx.drag = { startX: e.clientX, startTime: art.currentTime || 0, duration: d, width: player.clientWidth || 1, lastT: -1, seeking: false };
    }
  });
  player.addEventListener("pointermove", function (e) {
    if (!ctx.drag || ctx.drag.seeking) return;
    if (Math.abs(e.clientX - ctx.drag.startX) < 10) return; // 拖动阈值
    ctx.drag.seeking = true; // 进入拖动：取消长按计时（否则拖动超过 600ms 会被误判为长按快进）
    if (ctx.clearHold) ctx.clearHold();
  });
  player.addEventListener("pointerup", function (e) {
    if (ctx.drag && ctx.drag.seeking) {
      var dx = e.clientX - ctx.drag.startX;
      var ratio = dx / ctx.drag.width;
      var nt = Math.min(Math.max(ctx.drag.startTime + ratio * ctx.drag.duration, 0), ctx.drag.duration - 0.1);
      if (art.video) art.currentTime = nt; // 结束定格在最终位置
    }
    ctx.drag = null;
  });
  player.addEventListener("pointercancel", function () { ctx.drag = null; });
  player.addEventListener("pointerleave", function () {
    if (ctx.drag && ctx.drag.seeking) return; // 拖出画面继续拖
    ctx.drag = null;
  });
}