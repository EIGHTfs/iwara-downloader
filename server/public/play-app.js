// 播放页逻辑（从 play.html 内联 script 抽出）
// 播放地址短链 /{id}、artplayer 实例、播放列表、封面切换
"use strict";

// ═══ 播放地址：/{id} ═══
// 需求：地址栏应只显示短链形式 http://nas.local:28463/lwpDY67t95gnCK，而不是含 play.html#id= 的长链 http://nas.local:28463/play.html#id=lwpDY67t95gnCK
// 【原代码】#id= / ?id= / play.html#id=
// 【改为】pathname 第一段就是 id；旧链接 replaceState 成 /{id}。切视频 pushState，不整页刷新。
function getIdFromPath() {
  var m = (location.pathname || "").match(/^\/([A-Za-z0-9_-]{4,64})$/);
  return m ? m[1] : "";
}
function getIdFromHash() {
  var h = location.hash || "";
  var m = h.match(/[#&]id=([^&]*)/);
  return m ? decodeURIComponent(m[1]).trim() : "";
}
function getIdFromQuery() {
  var q = location.search || "";
  var m = q.match(/[?&]id=([^&]*)/);
  return m ? decodeURIComponent(m[1]).trim() : "";
}
function playUrl(vid) {
  return "/" + encodeURIComponent(vid);
}
function setPlayUrl(newId, replace) {
  if (!newId) return;
  var url = playUrl(newId);
  if (replace) history.replaceState(null, "", url);
  else if (location.pathname !== url) history.pushState(null, "", url);
}

// ═══ 页面状态 ═══
var id = getIdFromPath() || getIdFromHash() || getIdFromQuery();
var $ = function (s) { return document.querySelector(s); };
var PAGE_SIZE = 20;
var art = null;
var allVideos = [];
var displayedCount = 0;
var loadingVideo = false; // 防止并发加载

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function dur(n) {
  n = Number(n) || 0;
  return Math.floor(n / 60) + ":" + String(Math.floor(n % 60)).padStart(2, "0");
}
function themeColor() {
  return getComputedStyle(document.documentElement).getPropertyValue("--primary").trim() || "#2563eb";
}

// ═══ 主题切换按钮 ═══
function applyThemeBtn() {
  var night = document.documentElement.getAttribute("data-theme") === "night";
  var btn = $("#themeBtn");
  if (btn) btn.textContent = night ? "☀ 白天" : "🌙 夜间";
}
function initTheme() {
  applyThemeBtn();
  var themeBtn = $("#themeBtn");
  if (themeBtn) {
    themeBtn.onclick = function () {
      var night = document.documentElement.getAttribute("data-theme") === "night";
      var next = night ? "day" : "night";
      if (next === "night") document.documentElement.setAttribute("data-theme", "night");
      else document.documentElement.removeAttribute("data-theme");
      try { localStorage.setItem("gbmd-theme", next); } catch (_) {}
      applyThemeBtn();
      if (window.__art) window.__art.theme = themeColor();
    };
  }
}

// ═══ 无 id → 取列表第一个（仅真的没带 ?id= 也没 #id=）═══
function initNoId() {
  fetch("/api/index").then(function (r) { return r.json(); }).then(function (j) {
    var map = (j && j.videos && typeof j.videos === "object") ? j.videos : {};
    var ids = Object.keys(map);
    if (!ids.length) { $("#title").textContent = "没有可播放的视频"; return; }
    ids.sort(function (a, b) {
      return String((map[b] || {}).createdAt || "").localeCompare(String((map[a] || {}).createdAt || ""));
    });
    location.replace("/" + encodeURIComponent(ids[0]));
  }).catch(function () { $("#title").textContent = "加载列表失败"; });
}

// ═══ 初始化播放器（artplayer 实例）═══
// 控制条自动隐藏从默认 3 秒延长到 8 秒（太短容易误以为没有进度条）
if (typeof Artplayer !== "undefined") Artplayer.CONTROL_HIDE_TIME = 8000;
function artOptions(info, poster) {
  return {
    container: "#player",
    url: "/api/play?id=" + encodeURIComponent(id),
    type: (info.ext || "").replace(/^\./, "") || "mp4",
    poster: poster || "",
    theme: themeColor(),
    lang: "zh-cn",
    volume: 0.7,
    autoplay: true,
    muted: false,
    autoSize: false,
    autoMini: false,
    playbackRate: true,
    aspectRatio: true,
    screenshot: true,
    setting: true,
    hotkey: true,
    pip: true,
    fullscreen: true,
    fullscreenWeb: true,
    miniProgressBar: true,
    playsInline: true,
    mutex: true,
    fastForward: true,
    gesture: true,
    moreVideoAttr: { playsInline: true }
  };
}
function initPlayer(info, poster) {
  if (!info.hasFile) {
    $("#err").textContent = info.partial
      ? "正在下载中，已写入 0 字节，等几秒再刷新"
      : "没有可播放的视频文件";
    return;
  }
  if (art) { try { art.destroy(false); } catch (_) {} art = null; }
  art = new Artplayer(artOptions(info, poster));
  window.__art = art;
  try {
    if (art.video) { art.video.removeAttribute("crossorigin"); art.video.crossOrigin = null; }
  } catch (_) {}
  // ═══ 播放器交互增强（B 站式）：倍速按钮 + 桌面长按 3x 快进，实现见 play-enhance.js ═══
  // 失败不影响播放，增强是锦上添花
  try { if (typeof enhancePlayer === "function") enhancePlayer(art); } catch (_) {}
  art.on("error", function (err) {
    $("#err").textContent = (err && err.message) || "播放失败";
  });
  if (info.partial) {
    $("#err").textContent = "边下边播：进度条只到已写入部分，拖到后面会回到已缓存处。下完刷新看全片。";
    art.on("video:seeking", function () {
      var v = art.video;
      if (!v || !isFinite(v.duration) || v.duration <= 0) return;
      if (v.currentTime > v.duration - 0.25) v.currentTime = Math.max(0, v.duration - 0.5);
    });
  }
}

// ═══ 播放列表 ═══
function catalogVideos(j) {
  var map = (j && j.videos && typeof j.videos === "object") ? j.videos : {};
  return Object.keys(map).map(function (vid) {
    var e = map[vid] || {};
    return { id: vid, title: e.title || vid, name: e.name || e.username || "", duration: e.duration || 0, fileId: e.fileId || "", createdAt: e.createdAt || "" };
  }).sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });
}

// 2026-09-04：播放封面 URL 稳定，不再加 Date.now()。
// 【原代码】thumbUrl / refreshCurrentThumb 每次 &t=时间戳，强迫浏览器丢掉上一张。
// 【改为】播放时刷新封面变错；刷新后恢复——查明根因
// 【思路】&t= 本意防缓存，结果把 play-info 刚覆盖的错图立刻显示；F5 无 t 又变回旧图。各页只用 /api/thumb?id=
function thumbUrl(vid) {
  return "/api/thumb?id=" + encodeURIComponent(vid);
}

function bindPlaylistThumbRetry(img, vid) {
  var url = thumbUrl(vid);
  img.onerror = function () {
    var n = Number(this.dataset.try || 0) + 1;
    this.dataset.try = String(n);
    var el = this;
    var wait = n < 8 ? 400 * n : 2000;
    setTimeout(function () {
      el.style.visibility = "visible";
      el.style.display = "";
      el.src = url + "&r=" + Date.now();
    }, wait);
  };
  img.onload = function () {
    this.style.visibility = "visible";
    this.style.display = "";
    this.dataset.try = "0";
  };
}

function renderPlaylist(clear) {
  var container = $("#playlist");
  var countEl = $("#listCount");
  var loadingEl = $("#loadingMore");
  if (clear) { container.innerHTML = ""; displayedCount = 0; }
  if (!allVideos.length) {
    container.innerHTML = '<div class="sidebar-empty">索引里还没有其它视频</div>';
    countEl.textContent = "";
    loadingEl.style.display = "none";
    return;
  }
  var start = displayedCount;
  var end = Math.min(start + PAGE_SIZE, allVideos.length);
  for (var i = start; i < end; i++) {
    var v = allVideos[i];
    var item = document.createElement("div");
    item.className = "playlist-item" + (v.id === id ? " active" : "");
    // 首次加载用普通 URL（浏览器缓存），切换视频后用时间戳刷新
    var src = v.id ? "/api/thumb?id=" + encodeURIComponent(v.id) : "";
    item.innerHTML =
      (src ? '<img class="thumb" data-vid="' + esc(v.id) + '" src="' + esc(src) + '" alt="" loading="lazy">' : '<div class="thumb"></div>') +
      '<div class="info">' +
        '<div class="title" title="' + esc(v.title) + '">' + esc(v.title) + '</div>' +
        '<div class="meta">' + esc(v.name) + (v.duration ? " · " + dur(v.duration) : "") + '</div>' +
      '</div>';
    item.onclick = (function (vid) {
      return function () { if (vid !== id) { setPlayUrl(vid, false); loadVideo(vid); } };
    })(v.id);
    var imgEl = item.querySelector("img.thumb[data-vid]");
    if (imgEl) bindPlaylistThumbRetry(imgEl, v.id);
    container.appendChild(item);
  }
  displayedCount = end;
  countEl.textContent = allVideos.length + " 个";
  if (end < allVideos.length) {
    loadingEl.style.display = "block";
    loadingEl.textContent = "加载更多（还剩 " + (allVideos.length - end) + "）";
  } else {
    loadingEl.style.display = "none";
  }
}

// 刷新当前视频的封面缩略图（列表里的 + poster）
function refreshCurrentThumb() {
  // 2026-09-04：换 src 前清 hidden。修复刷新后封面丢失
  // 【原代码】onerror 设 visibility=hidden，refreshCurrentThumb 只改 src，hidden 不恢复。
  // 【思路】第一次 404/304 空图把图藏死后，即使后面 JPEG 200 也看不见。
  var activeImg = document.querySelector(".playlist-item.active .thumb[data-vid]");
  var url = thumbUrl(id);
  if (activeImg) {
    activeImg.style.visibility = "visible";
    if (activeImg.src.indexOf(url) < 0) activeImg.src = url;
  }
  if (art) art.poster = url;
}

function bindLazyLoad() {
  var list = $("#playlist");
  var more = $("#loadingMore");
  more.onclick = function () { renderPlaylist(false); };
  list.addEventListener("scroll", function () {
    if (displayedCount >= allVideos.length) return;
    if (list.scrollTop + list.clientHeight >= list.scrollHeight - 40) renderPlaylist(false);
  });
}

// ═══ 播放信息渲染（标题/作者/标签/元信息共用）═══
function renderVideoMeta(j) {
  document.title = (j.title || id) + " · 本地播放";
  $("#title").textContent = j.title || id;
  renderAuthor(j);
  var tags = Array.isArray(j.tags) ? j.tags : [];
  $("#tags").innerHTML = tags.map(function (t) { return "<span>" + esc(t.id || t) + "</span>"; }).join("");
  var extra = [];
  if (j.duration) extra.push("时长 " + dur(j.duration));
  if (j.createdAt) extra.push("上传 " + String(j.createdAt).slice(0, 10));
  extra.push("id " + id);
  $("#extra").textContent = extra.join(" · ");
}
function renderAuthor(j) {
  j = j || {};
  var name = esc(j.name || j.username || "");
  var link = j.username
    ? '<a href="https://www.iwara.tv/profile/' + encodeURIComponent(j.username) + '" target="_blank" rel="noopener">' + name + '</a>'
    : name;
  var img = "";
  if (j.avatar && /^\/avatar\/[0-9a-f-]+\/[0-9a-f-]+\.jpg$/i.test(j.avatar)) {
    img = '<img class="author-avatar" src="' + esc(j.avatar) + '" alt="" width="28" height="28" onerror="this.style.display=\'none\'">';
  }
  $("#author").innerHTML = img + link;
}

// ═══ 切换视频：拉取 play-info 并更新播放器/页面 ═══
function loadVideo(newId) {
  if (!newId || loadingVideo) return;
  loadingVideo = true;
  id = newId;
  // 清空旧状态
  $("#title").textContent = "加载中…";
  $("#author").textContent = "";
  $("#tags").innerHTML = "";
  $("#extra").textContent = "";
  $("#err").textContent = "";
  // 更新 active 状态
  var items = document.querySelectorAll(".playlist-item");
  for (var i = 0; i < items.length; i++) {
    var img = items[i].querySelector(".thumb[data-vid]");
    var vid = img ? img.getAttribute("data-vid") : "";
    items[i].className = "playlist-item" + (vid === id ? " active" : "");
  }

  fetch("/api/play-info?id=" + encodeURIComponent(id))
    .then(function (r) { return r.json(); })
    .then(function (j) {
      loadingVideo = false;
      if (!j) return;
      if (!j.ok) throw new Error(j.error || "读取失败");
      renderVideoMeta(j);
      initPlayer(j, thumbUrl(id));
      // 【原代码】setTimeout(refreshCurrentThumb, 500/2000) 等抽帧后强刷。
      // 【改为】已有封面不覆盖，不必强刷。
    })
    .catch(function (e) {
      loadingVideo = false;
      $("#title").textContent = "无法播放";
      $("#err").textContent = e.message || String(e);
    });
}

// ═══ 首次启动：并行加载 play-info 和索引、前进后退、退出清理 ═══
function initPage() {
  initTheme();
  // 前进/后退：/{id}
  window.addEventListener("popstate", function () {
    var newId = getIdFromPath() || getIdFromHash() || getIdFromQuery();
    if (newId && newId !== id) loadVideo(newId);
  });

  // 并行加载 play-info 和 index
  var playInfoDone = false;
  var indexDone = false;
  function tryInit() {
    if (playInfoDone && indexDone) bindLazyLoad();
  }

  fetch("/api/play-info?id=" + encodeURIComponent(id))
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (!j) return;
      if (!j.ok) throw new Error(j.error || "读取失败");
      renderVideoMeta(j);
      initPlayer(j, thumbUrl(id));
      playInfoDone = true;
      tryInit();
    })
    .catch(function (e) {
      $("#title").textContent = "无法播放";
      $("#err").textContent = e.message || String(e);
      playInfoDone = true;
      tryInit();
    });

  fetch("/api/index").then(function (r) { return r.json(); }).then(function (j) {
    if (!j || !j.ok) return;
    allVideos = catalogVideos(j);
    renderPlaylist(true);
    indexDone = true;
    tryInit();
  }).catch(function () {
    $("#playlist").innerHTML = '<div class="sidebar-empty">播放列表加载失败</div>';
    indexDone = true;
    tryInit();
  });

  window.addEventListener("beforeunload", function () {
    if (art) { try { art.destroy(false); } catch (_) {} }
  });
}

// 启动分支：无 id → 跳到列表第一个；否则正常初始化页面
if (id && location.pathname !== playUrl(id)) setPlayUrl(id, true);
if (!id) initNoId();
else initPage();