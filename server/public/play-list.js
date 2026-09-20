// 播放页播放列表模块（从 play-app.js 拆分，play-app.js 超 400 行按职责拆分）
// 含：排序切换（时间/名称）、文件夹分组渲染（可折叠）、自动连播开关、状态持久化。
// 依赖 play-app.js 顶层全局（普通 script 共享 window）：PAGE_SIZE、id、allVideos、
//   displayedCount、esc、dur、$、setPlayUrl、loadVideo、bindPlaylistThumbRetry、art。
// 加载顺序：play-list.js 先于 play-app.js 加载；函数体运行时才引用上述全局，无顺序问题。
"use strict";

// 播放列表工具：排序维度（time=时间 / name=名称，互斥）+ 排序方向（desc=倒序 / asc=正序）
//   + 自动连播开关 + 分组折叠状态
var sortMode = "time";
var sortDir = "desc";
var autoNext = true;
var collapsedRels = {}; // rel -> true 表示该分组折叠
var playlistGroups = {}; // rel -> {header, body}：分组头缓存，跨增量加载复用
//   必须模块级：renderPlaylist(false) 增量加载时 container 不清空，若 groups 在函数内
//   重新初始化为空对象，每次加载更多都会重复 makeGroup 追加同名组头（「两个根目录」根因）。

// ═══ 播放列表数据 ═══
function catalogVideos(j) {
  var map = (j && j.videos && typeof j.videos === "object") ? j.videos : {};
  return Object.keys(map).map(function (vid) {
    var e = map[vid] || {};
    return { id: vid, title: e.title || vid, name: e.name || e.username || "", duration: e.duration || 0, fileId: e.fileId || "", createdAt: e.createdAt || "", rel: e.rel || "" };
  });
}
// 当前排序维度+方向下的完整列表（排序切换/连播取下一个都用它）
function sortedVideos() {
  var list = allVideos.slice();
  var cmp = (sortMode === "name")
    ? function (a, b) { return String(a.title || "").localeCompare(String(b.title || ""), "zh"); }
    : function (a, b) { return String(a.createdAt || "").localeCompare(String(b.createdAt || "")); };
  list.sort(function (a, b) { return sortDir === "asc" ? cmp(a, b) : cmp(b, a); });
  return list;
}
// 排序维度/方向/连播开关状态持久化
function loadPlayPrefs() {
  try {
    var s = localStorage.getItem("iwara-play-sort");
    if (s === "name" || s === "time") sortMode = s;
    var d = localStorage.getItem("iwara-play-sortdir");
    if (d === "asc" || d === "desc") sortDir = d;
    autoNext = localStorage.getItem("iwara-play-autonext") !== "0";
  } catch (_) {}
}
function savePlayPrefs() {
  try {
    localStorage.setItem("iwara-play-sort", sortMode);
    localStorage.setItem("iwara-play-sortdir", sortDir);
    localStorage.setItem("iwara-play-autonext", autoNext ? "1" : "0");
  } catch (_) {}
}

// ═══ 文件夹分组渲染 ═══
// 创建文件夹分组：组标题（可折叠）+ 组体容器
function makeGroup(container, rel) {
  var gname = rel || "根目录";
  var header = document.createElement("div");
  header.className = "playlist-group-header" + (collapsedRels[rel] ? " collapsed" : "");
  header.innerHTML = '<span class="arrow">▾</span><span class="gname">' + esc(gname) + '</span><span class="gcount"></span>';
  var body = document.createElement("div");
  body.className = "playlist-group-body";
  header.onclick = function () {
    collapsedRels[rel] = !collapsedRels[rel];
    header.classList.toggle("collapsed", collapsedRels[rel]);
    body.style.display = collapsedRels[rel] ? "none" : "";
  };
  container.appendChild(header);
  container.appendChild(body);
  return { header: header, body: body };
}

function renderPlaylist(clear) {
  var container = $("#playlist");
  var countEl = $("#listCount");
  var loadingEl = $("#loadingMore");
  if (clear) { container.innerHTML = ""; displayedCount = 0; playlistGroups = {}; }
  if (!allVideos.length) {
    container.innerHTML = '<div class="sidebar-empty">索引里还没有其它视频</div>';
    countEl.textContent = "";
    loadingEl.style.display = "none";
    return;
  }
  var list = sortedVideos();
  var start = displayedCount;
  var end = Math.min(start + PAGE_SIZE, list.length);
  // 先统计每组总条目数（不受分页影响）
  var counts = {};
  for (var c = 0; c < list.length; c++) {
    var cr = list[c].rel || "";
    counts[cr] = (counts[cr] || 0) + 1;
  }
  var groups = playlistGroups; // 复用已有组头（增量加载时不重复创建）
  var lastRel = null;
  for (var i = 0; i < end; i++) {
    var v = list[i];
    var rel = v.rel || "";
    if (rel !== lastRel) {
      lastRel = rel;
      if (!groups[rel]) groups[rel] = makeGroup(container, rel);
    }
    if (i < start) continue; // 增量加载：只渲染新增部分（组头上面已按需输出）
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
    groups[rel].body.appendChild(item);
  }
  for (var r in counts) {
    var g = groups[r];
    if (g) {
      var gc = g.header.querySelector(".gcount");
      if (gc) gc.textContent = counts[r] + " 个";
    }
  }
  displayedCount = end;
  countEl.textContent = list.length + " 个";
  if (end < list.length) {
    loadingEl.style.display = "block";
    loadingEl.textContent = "加载更多（还剩 " + (list.length - end) + "）";
  } else {
    loadingEl.style.display = "none";
  }
}

// 播放列表工具条：排序维度互斥按钮 + 正/倒序切换 + 自动连播开关（状态持久化）
function updateSortUI() {
  var seg = $("#sortSeg");
  if (seg) {
    var btns = seg.querySelectorAll(".sort-seg-btn");
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle("active", btns[i].getAttribute("data-sort") === sortMode);
    }
  }
  var dirBtn = $("#sortDirBtn");
  if (dirBtn) dirBtn.textContent = sortDir === "asc" ? "↑ 正序" : "↓ 倒序";
}
function initPlayTools() {
  loadPlayPrefs();
  var seg = $("#sortSeg");
  if (seg) {
    var btns = seg.querySelectorAll(".sort-seg-btn");
    for (var i = 0; i < btns.length; i++) {
      btns[i].onclick = function () {
        var mode = this.getAttribute("data-sort");
        if (mode !== sortMode) {
          sortMode = mode;
          savePlayPrefs();
          updateSortUI();
          renderPlaylist(true);
        }
      };
    }
  }
  var dirBtn = $("#sortDirBtn");
  if (dirBtn) {
    dirBtn.onclick = function () {
      sortDir = (sortDir === "desc") ? "asc" : "desc";
      savePlayPrefs();
      updateSortUI();
      renderPlaylist(true);
    };
  }
  var autoplayCb = $("#autoplayNext");
  if (autoplayCb) {
    autoplayCb.checked = autoNext;
    autoplayCb.onchange = function () {
      autoNext = autoplayCb.checked;
      savePlayPrefs();
    };
  }
  updateSortUI();
}