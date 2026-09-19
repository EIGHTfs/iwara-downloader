// 播放器交互增强（B 站式）：倍速按钮 + 桌面端长按 3x 快进
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

  // 2) 桌面端长按画面 3x 快进（官方 fastForward 仅移动端生效，桌面端自定义实现）
  var IS_MOBILE = /Mobi|Android|iPhone|iPad|iPod|HarmonyOS/i.test(navigator.userAgent || "");
  if (IS_MOBILE) return;
  var holdTimer = null;
  var holdOn = false;
  var holdBase = 1;
  var suppressClick = false; // 长按结束的这次 click 要拦截，避免松手触发内核「单击暂停」
  function clearHold() {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    if (holdOn) {
      holdOn = false;
      suppressClick = true;
      setTimeout(function () { suppressClick = false; }, 80);
      art.playbackRate = holdBase;
      art.notice.show = "";
      syncSpeedBtn();
    }
  }
  art.template.$player.addEventListener("pointerdown", function (e) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    var t = e.target;
    if (t && t.closest && t.closest(".art-bottom")) return; // 控制条/进度条区域不触发
    if (!art.playing || art.isLock) return;
    holdBase = art.playbackRate || 1;
    holdTimer = setTimeout(function () {
      holdOn = true;
      art.playbackRate = 3;
      art.notice.show = "3x 快进中，松开恢复";
      syncSpeedBtn();
    }, 600);
  });
  art.template.$player.addEventListener("pointerup", clearHold);
  art.template.$player.addEventListener("pointercancel", clearHold);
  art.template.$player.addEventListener("pointerleave", clearHold);
  // 捕获阶段拦截长按结束的 click，防止内核「单击暂停」在松手时误触发
  art.template.$player.addEventListener("click", function (e) {
    if (suppressClick) { e.stopPropagation(); e.preventDefault(); }
  }, true);
}
