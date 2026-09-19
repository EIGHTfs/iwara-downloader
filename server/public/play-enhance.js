// 播放器交互增强（B 站式）：倍速按钮 + 长按 3x 快进 + 左右拖动进度条 + 长按抑制设置菜单
// 从 play-app.js 的 initPlayer 拆分而来（play-app.js 超 400 行按职责拆分）；
// initPlayer 创建 artplayer 实例后调用 enhancePlayer(art)。
// 移动端长按倍速走 ArtPlayer 官方 fastForward（artOptions 里 fastForward: true），不在此实现。
"use strict";

function enhancePlayer(art) {
  if (!art) return;
  // 1) 控制条右上角倍速按钮：循环切换 1 → 1.25 → 1.5 → 2 → 3 → 1
  var SPEEDS = [1, 1.25, 1.5, 2, 3];
  function speedBtnHtml(v) {
    return '<span class="art-speed-btn" style="font-size:12px;font-weight:700;letter-spacing:.5px;min-width:34px;text-align:center">' + v + 'x</span>';
  }
  function currentSpeedIndex() {
    var idx = SPEEDS.indexOf(art.playbackRate || 1);
    return idx === -1 ? 0 : idx;
  }
  function syncSpeedBtn() {
    var el = document.querySelector(".art-control .art-speed-btn");
    if (el) el.textContent = (art.playbackRate || 1) + "x";
  }
  art.controls.add({
    name: "speed",
    position: "right",
    index: 20,
    html: speedBtnHtml(1),
    tooltip: "倍速",
    click: function () {
      var next = SPEEDS[(currentSpeedIndex() + 1) % SPEEDS.length];
      art.playbackRate = next;
      art.notice.show = "倍速 " + next + "x";
      syncSpeedBtn();
    }
  });
  // 设置面板/快捷键改速时按钮文字也要同步
  art.on("video:ratechange", syncSpeedBtn);
  art.on("video:play", syncSpeedBtn);

  // 3) autoplay 被浏览器拦截（有声自动播放策略）时：首次点画面立即开始播放
  //    自动播放失败约 1 秒后仍处于暂停 → 武装「点击即播」；按下瞬间 play()，并把这个
  //    click 拦下来（否则刚 play 又被内核「单击暂停」停掉）。与长按互斥：长按要求播放中。
  var tapArmed = false;
  var suppressTapClick = false;
  setTimeout(function () {
    if (art.video && art.video.paused && !art.playing) tapArmed = true;
  }, 800);
  art.template.$player.addEventListener("pointerdown", function (e) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    var t = e.target;
    if (t && t.closest && t.closest(".art-bottom")) return;
    if (tapArmed && art.video && art.video.paused && !art.playing) {
      tapArmed = false;
      suppressTapClick = true;
      setTimeout(function () { suppressTapClick = false; }, 80);
      art.play();
    }
  }, true);
  art.template.$player.addEventListener("click", function (e) {
    if (suppressTapClick) { e.stopPropagation(); e.preventDefault(); }
  }, true);

  // 3.5) 长按画面抑制浏览器 contextmenu（ArtPlayer 的右键「播放速度/画面比例/统计信息」面板
  //      由 contextmenu 事件触发；移动端长按/桌面左键长按结束会误弹，按住期间拦截它。
  //      右键（button=2）不在此列：pointerdown 的 button!==0 分支已放行右键，菜单保留）
  var suppressCtxMenu = false;
  art.template.$player.addEventListener("contextmenu", function (e) {
    if (suppressCtxMenu) {
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation(); // 阻断同节点 ArtPlayer 的弹面板
    }
  }, true);

  // 4) 桌面端（移动端官方 gesture 自带左右滑 seek）：
  //    · 长按画面 600ms → 3x 快进（官方 fastForward 仅移动端生效，桌面端自定义实现）
  //    · 按住画面左右拖动 → 拖动进度条 seek（移动超过阈值即取消长按快进）
  var IS_MOBILE = /Mobi|Android|iPhone|iPad|iPod|HarmonyOS/i.test(navigator.userAgent || "");
  var holdTimer = null;
  var holdOn = false;
  var holdBase = 1;
  var suppressClick = false; // 长按结束的这次 click 要拦截，避免松手触发内核「单击暂停」
  var drag = null; // {startX, startTime, duration, width, lastT, seeking}
  var ctxClearTimer = null;

  function clearHold(withClickSuppress) {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    if (holdOn) {
      holdOn = false;
      if (withClickSuppress) {
        suppressClick = true;
        setTimeout(function () { suppressClick = false; }, 80);
      }
      art.playbackRate = holdBase;
      art.notice.show = "";
      syncSpeedBtn();
    }
  }
  // 拖动中（含滑出画面）持续更新进度条：document 级监听，切换视频 destroy 时移除避免叠加
  function onDragMove(e) {
    if (!drag || !drag.seeking || !art.video) return;
    var dx = e.clientX - drag.startX;
    var ratio = dx / drag.width;
    var nt = Math.min(Math.max(drag.startTime + ratio * drag.duration, 0), drag.duration - 0.1);
    if (Math.abs(nt - drag.lastT) > 0.05) {
      drag.lastT = nt;
      art.currentTime = nt;
    }
  }
  document.addEventListener("pointermove", onDragMove);
  art.on("destroy", function () { document.removeEventListener("pointermove", onDragMove); });
  function endDrag() {
    drag = null;
  }
  // contextmenu 抑制在松开一段时间后解除（长按松开瞬间仍可能触发）
  function releaseCtxSuppress() {
    if (ctxClearTimer) clearTimeout(ctxClearTimer);
    ctxClearTimer = setTimeout(function () { suppressCtxMenu = false; }, 250);
  }
  art.template.$player.addEventListener("pointerdown", function (e) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    var t = e.target;
    if (t && t.closest && t.closest(".art-bottom")) return; // 控制条/进度条区域不触发
    if (art.isLock) return;
    try { if (e.target.setPointerCapture) e.target.setPointerCapture(e.pointerId); } catch (_) {} // 拖出画面后 pointerup 仍派发给画面
    suppressCtxMenu = true; // 按住期间不弹 contextmenu
    if (IS_MOBILE) return; // 移动端：只做 contextmenu 抑制，seek/长按走官方 gesture
    var d = art.duration || 0;
    if (d > 0) {
      drag = { startX: e.clientX, startTime: art.currentTime || 0, duration: d, width: art.template.$player.clientWidth || 1, lastT: -1, seeking: false };
    }
    if (art.playing && !art.paused) {
      holdBase = art.playbackRate || 1;
      holdTimer = setTimeout(function () {
        holdOn = true;
        art.playbackRate = 3;
        art.notice.show = "3x 快进中，松开恢复";
        syncSpeedBtn();
      }, 600);
    }
  });
  art.template.$player.addEventListener("pointermove", function (e) {
    if (!drag || drag.seeking) return;
    if (Math.abs(e.clientX - drag.startX) < 10) return; // 拖动阈值
    // 进入拖动 seek：取消尚未触发或已触发的长按快进
    drag.seeking = true;
    clearHold(true);
    suppressCtxMenu = true; // 拖动中仍按住，继续抑制
  });
  art.template.$player.addEventListener("pointerup", function (e) {
    if (drag && drag.seeking) {
      var dx = e.clientX - drag.startX;
      var ratio = dx / drag.width;
      var nt = Math.min(Math.max(drag.startTime + ratio * drag.duration, 0), drag.duration - 0.1);
      if (art.video) art.currentTime = nt; // 结束定格在最终位置
    }
    clearHold(true);
    endDrag();
    releaseCtxSuppress();
  });
  art.template.$player.addEventListener("pointercancel", function () {
    clearHold(true);
    endDrag();
    releaseCtxSuppress();
  });
  art.template.$player.addEventListener("pointerleave", function () {
    // 按住滑出画面时继续拖动（pointerup 在外部仍能收到，不必在 leave 就提前结束 seek）
    if (drag && drag.seeking) return;
    clearHold(true);
    endDrag();
    releaseCtxSuppress();
  });
  // 捕获阶段拦截长按结束的 click，防止内核「单击暂停」在松手时误触发
  art.template.$player.addEventListener("click", function (e) {
    if (suppressClick) { e.stopPropagation(); e.preventDefault(); }
  }, true);
}