// 播放器交互增强（B 站式）：倍速按钮 + 长按 3x 快进 + 画面左右拖动 scrub seek + 长按抑制设置菜单
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
    drag: null, suppressCtxMenu: false, ctxClearTimer: null,
    volSwipe: null
  };
  initSpeedButton(art);
  initTapToPlay(art, ctx);
  initCtxSuppress(art, ctx);
  initVolumeSwipe(art, ctx); // 画面竖滑音量（桌面 + 移动端都启用）
  initDragSeek(art, ctx);    // 画面横滑 scrub seek（桌面 + 移动端都启用：pointer 事件 + touch-action:none，
                             // 触摸拖动天然派发 pointermove；官方 gesture 只在进度条 $bar，区域不冲突）
  initProgressTouch(art);    // 进度条触摸滑动 seek（官方只有桌面 mouse 拖动，触屏滑动补 pointer 通道）
  if (IS_MOBILE) return; // 移动端：长按快进走官方 fastForward（触摸长按与自绘长按避免双份冲突）
  initHoldFastForward(art, ctx);
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

// 4b) 按住画面左右拖动 → 画面 scrub seek（拖动中进度条/时间实时跟随，画面实时跳帧，1s 最小单位）
//     用户语义：拖动画面时「拖的进度条时间跟着变」——不是松手才跳。实现：
//       - 拖动中按位移实时计算目标时间并取整到整秒（1s 最小单位），实时 art.currentTime 赋值
//         → ArtPlayer 内部自动更新进度条/时间显示，画面 seek 到目标帧（画面实时变动）；
//       - 播放中拖动先暂停（避免连续 seek 触发缓冲抖动），松手恢复播放（若原本在播）；
//       - 方向判定：|dx|>|dy| 才进入 seek（竖滑交给 initVolumeSwipe），12px 阈值防误触。
//     pointer 捕获保证拖出画面后 pointermove/up 仍派发给画面；document 级跟随持续更新。
//     触摸屏也适用：touch-action:none 让触摸拖动不被浏览器滚动接管（否则 pointermove 被吞、拖不动）。
function initDragSeek(art, ctx) {
  var player = art.template.$player;
  player.style.touchAction = "none"; // 关键：触摸拖动时持续派发 pointermove，不触发滚动/pointercancel
  if (art.template.$video) art.template.$video.style.touchAction = "none";

  function targetTime(e) {
    var dx = e.clientX - ctx.drag.startX;
    var ratio = dx / ctx.drag.width;
    return Math.min(Math.max(ctx.drag.startTime + ratio * ctx.drag.duration, 0), ctx.drag.duration - 0.1);
  }
  // 1s 最小单位：目标时间取整到整秒（拖动中进度条/时间按整秒跟随）
  function snapToSec(t) {
    if (!isFinite(t)) return 0;
    return Math.max(0, Math.round(t));
  }
  function onDragMove(e) {
    if (!ctx.drag || !ctx.drag.seeking || !art.video) return;
    var sec = snapToSec(targetTime(e));
    if (ctx.drag.lastT === sec) return; // 同一秒不重复 seek
    ctx.drag.lastT = sec;
    // 播放中拖动：先暂停（连续 seek 播放中会频繁触发缓冲抖动），画面停在目标帧实时变动
    if (ctx.drag.wasPlaying === undefined) ctx.drag.wasPlaying = !art.video.paused;
    if (ctx.drag.wasPlaying && !art.video.paused) art.pause();
    art.currentTime = sec; // 实时 seek：进度条/时间自动跟随，画面跳到目标帧
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
      ctx.drag = { startX: e.clientX, startTime: art.currentTime || 0, duration: d, width: player.clientWidth || 1, lastT: -1, seeking: false, wasPlaying: undefined };
    }
  });
  player.addEventListener("pointermove", function (e) {
    if (!ctx.drag || ctx.drag.seeking) return;
    if (Math.abs(e.clientX - ctx.drag.startX) < 10) return; // 拖动阈值
    ctx.drag.seeking = true; // 进入拖动：取消长按计时（否则拖动超过 600ms 会被误判为长按快进）
    if (ctx.clearHold) ctx.clearHold();
  });
  player.addEventListener("pointerup", function (e) {
    if (ctx.drag) {
      if (ctx.drag.seeking) {
        var sec = snapToSec(targetTime(e));
        if (art.video) art.currentTime = sec; // 结束定格在最终整秒位置
        // 原本在播放 → 恢复播放
        if (ctx.drag.wasPlaying && art.video && art.video.paused) {
          try { art.play(); } catch (_) {}
        }
      }
      ctx.drag = null;
    }
  });
  player.addEventListener("pointercancel", function () { ctx.drag = null; });
  player.addEventListener("pointerleave", function () {
    if (ctx.drag && ctx.drag.seeking) return; // 拖出画面继续拖
    ctx.drag = null;
  });
}

// 4c) 画面上下滑动 → 实时音量（B 站式手势；桌面 pointer + 移动端 touch 都启用）。
//     方向分发：首个位移超阈值（12px）的方向锁定模式——|dx|>|dy| 是横滑（交给 initDragSeek
//     左右拖进度），|dy|>|dx| 是竖滑（本函数调音量）。锁定后不切换，避免方向抖动。
//     与 600ms 长按快进互斥：位移超阈值即 clearHold；与单击暂停互斥：进入手势就取消 tapArmed。
function initVolumeSwipe(art, ctx) {
  var player = art.template.$player;
  // 触摸拖动不被浏览器滚动接管（移动端画面竖滑音量；桌面 pointer 无碍）
  try { player.style.touchAction = "none"; art.template.$video.style.touchAction = "none"; } catch (_) {}
  var THRESH = 12; // 首个位移判定阈值：超过才锁定方向（区分「点」与「滑」）

  function onMove(e) {
    var g = ctx.volSwipe;
    if (!g) return;
    if (!g.mode) {
      var dx = (e.clientX !== undefined ? e.clientX : e.touches[0].clientX) - g.startX;
      var dy = (e.clientY !== undefined ? e.clientY : e.touches[0].clientY) - g.startY;
      if (Math.abs(dx) < THRESH && Math.abs(dy) < THRESH) return; // 未过阈值：仍是「点」
      g.mode = Math.abs(dy) > Math.abs(dx) ? "vol" : "seek"; // 锁定方向
      if (ctx.clearHold) ctx.clearHold(); // 进入手势：取消长按快进计时
      ctx.tapArmed = false; // 进入手势：取消「点击即播」，防松开误触发播放
      if (g.mode === "seek") return; // 横滑交给 initDragSeek 的 document 级拖动
    }
    if (g.mode !== "vol" || !art.video) return;
    var dy2 = (e.clientY !== undefined ? e.clientY : e.touches[0].clientY) - g.startY;
    // 目标音量 = 按下时音量 ± 位移/半屏高（满半屏滑满）；dy 负（上滑）→ 音量 +
    var delta = -dy2 / (player.clientHeight / 2 || 100);
    var v = Math.min(Math.max(g.base + delta, 0), 1);
    art.video.volume = v;
    art.volume = v; // 官方 volume 属性同步（图标/控制条联动）
    if (v > 0 && art.video.muted) art.video.muted = false;
    art.notice.show = "音量 " + Math.round(v * 100) + "%";
  }
  function onEnd() {
    if (ctx.volSwipe) { ctx.volSwipe = null; }
    // notice 不需要手动清：ArtPlayer 会自动淡出
  }

  player.addEventListener("pointerdown", function (e) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    var t = e.target;
    if (t && t.closest && t.closest(".art-bottom")) return;
    if (art.isLock) return;
    try { if (e.target.setPointerCapture) e.target.setPointerCapture(e.pointerId); } catch (_) {}
    var startX = e.clientX !== undefined ? e.clientX : (e.touches && e.touches[0] && e.touches[0].clientX);
    var startY = e.clientY !== undefined ? e.clientY : (e.touches && e.touches[0] && e.touches[0].clientY);
    var baseVol = (art.video && art.video.volume !== undefined) ? art.video.volume : (art.volume || 0.7);
    ctx.volSwipe = { startX, startY, base: baseVol, mode: null };
    ctx.suppressCtxMenu = true; // 按住期间不弹 contextmenu（与 4a/4b 共用）
  });
  player.addEventListener("pointermove", onMove);
  player.addEventListener("pointerup", onEnd);
  player.addEventListener("pointercancel", onEnd);
  player.addEventListener("pointerleave", function () {
    // 拖出画面：竖滑音量继续（与 seek 一致，不中途打断）；非活动态才清
    if (!ctx.volSwipe) return;
  });
  // 触摸端：touch 事件也接同一分发（与 pointer 通道并存：pointer 先于 touch 派发，方向锁定以 pointer 为准；
  // touch 通道是保底——个别环境 pointer 事件不完整时竖滑音量仍可用；横滑 seek 由 initDragSeek 的
  // document 级 pointermove 接力，触摸屏 touch-action:none 保证 pointer 事件持续派发）
  try {
    player.addEventListener("touchstart", function (e) {
      var t = e.target;
      if (t && t.closest && t.closest(".art-bottom")) return;
      if (art.isLock) return;
      var tc = e.touches[0];
      ctx.volSwipe = { startX: tc.clientX, startY: tc.clientY, base: (art.video && art.video.volume !== undefined) ? art.video.volume : 0.7, mode: null };
      ctx.suppressCtxMenu = true;
    }, { passive: true });
    player.addEventListener("touchmove", function (e) {
      onMove(e); // touches 由 onMove 兼容读取
      if (ctx.volSwipe && ctx.volSwipe.mode === "vol") e.preventDefault(); // 竖滑音量时阻止页面滚动
    }, { passive: false });
    player.addEventListener("touchend", onEnd);
    player.addEventListener("touchcancel", onEnd);
  } catch (_) {}
}

// 4d) 进度条触摸滑动 seek。
// 背景：ArtPlayer 官方进度条拖动只在桌面绑 mouse 事件（minified 源码 `p||(...)` 分支，
//   p=移动端判定，移动端进度条不绑任何拖动事件）；且触摸屏上默认 touch-action 会把滑动
//   当成页面滚动接管，mousemove 不连续派发——表现为「点进度条可以、滑动没反应」。
// 这里给官方 .art-progress 补 pointer 触摸通道：touch-action:none + pointer 事件
//   （仅 pointerType≠mouse 介入），桌面鼠标仍走官方 mousedown 拖动，互不干扰；
//   指针捕获保证按住拖出进度条后 pointermove/up 仍派发给进度条，不丢尾段。
function initProgressTouch(art) {
  var bar = art.template.$progress;
  if (!bar) return;
  bar.style.touchAction = "none"; // 关键：触摸滑动不被页面滚动/pointercancel 吞掉
  var dragging = false;
  function seekByX(clientX) {
    if (!art.video || !art.duration) return;
    var rect = bar.getBoundingClientRect();
    var ratio = Math.min(Math.max((clientX - rect.left) / (rect.width || 1), 0), 1);
    art.currentTime = ratio * art.duration;
  }
  bar.addEventListener("pointerdown", function (e) {
    if (e.pointerType === "mouse") return; // 鼠标交给官方 mousedown 拖动
    dragging = true;
    try { if (bar.setPointerCapture) bar.setPointerCapture(e.pointerId); } catch (_) {}
    seekByX(e.clientX); // 按下即跳（与官方点击 seek 一致）
  });
  bar.addEventListener("pointermove", function (e) {
    if (!dragging || e.pointerType === "mouse") return;
    seekByX(e.clientX);
  });
  function endDrag(e) {
    if (dragging && e && e.pointerType !== "mouse") dragging = false;
  }
  bar.addEventListener("pointerup", endDrag);
  bar.addEventListener("pointercancel", endDrag);
  art.on("destroy", function () {
    bar.style.touchAction = "";
  });
}