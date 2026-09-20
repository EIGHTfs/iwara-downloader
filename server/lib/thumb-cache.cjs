// 封面缓存：按视频 id 落到项目目录 server/thumbs/<id>.jpg
// 封面由后台扫描抽帧、前台直接读取；打开视频页时全部封面已就绪
// 实现：启动后后台扫下载目录，tool/ffmpeg 抽 1s 处一帧写入 thumbs/。
//   /api/thumb 只读已有 jpg，请求路径不抽帧。下载完成时顺手补一张。
"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const crypto = require("crypto");
const api = require("./iwara-api");
const jsonDir = require("../store/json-dir.js");

// 数据目录统一由框架层 json-dir 提供（env DATA_DIR 重定向），本文件不再自行读环境变量
const DATA_DIR = jsonDir.SERVER_DIR;
const PROJECT_ROOT = path.join(__dirname, "..", "..");
const THUMB_DIR = path.join(DATA_DIR, "thumbs"); //userdata-manifest.json dir server/thumbs .jpg 本机封面缓存 thumbs/<id>.jpg
const inflight = new Map();

function safeId(id) {
  const v = String(id || "").trim();
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(v)) return "";
  return v;
}

function thumbPath(id) {
  const vid = safeId(id);
  if (!vid) return "";
  return path.join(THUMB_DIR, vid + ".jpg");
}

function isJpegFile(p) {
  try {
    const fd = fs.openSync(p, "r");
    const b = Buffer.alloc(3);
    fs.readSync(fd, b, 0, 3, 0);
    fs.closeSync(fd);
    return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  } catch (_) { return false; }
}

const IWARA_PLACEHOLDER_MD5 = "a244c06f2a6369b23a5e18c9a2cb2a1b";
function isPlaceholderFile(p) {
  try {
    const st = fs.statSync(p);
    if (st.size !== 4824) return false;
    const buf = fs.readFileSync(p);
    return crypto.createHash("md5").update(buf).digest("hex") === IWARA_PLACEHOLDER_MD5;
  } catch (_) { return false; }
}

function hasThumb(id) {
  const p = thumbPath(id);
  if (!p) return false;
  try {
    if (!fs.existsSync(p) || fs.statSync(p).size <= 32 || !isJpegFile(p)) return false;
    // 占位图不算有封面，允许官方重拉覆盖
    if (isPlaceholderFile(p)) return false;
    return true;
  } catch (_) { return false; }
}

function readThumb(id) {
  const p = thumbPath(id);
  if (!p || !hasThumb(id)) return null;
  try {
    const st = fs.statSync(p);
    return { buf: fs.readFileSync(p), contentType: "image/jpeg", path: p, mtimeMs: st.mtimeMs, size: st.size };
  } catch (_) { return null; }
}

function writeThumb(id, buf, origin) {
  const p = thumbPath(id);
  if (!p || !buf || !buf.length) return null;
  if (api.isIwaraPlaceholder(buf)) return null;
  fs.mkdirSync(THUMB_DIR, { recursive: true });
  const tmp = p + ".part";
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, p);
  return p;
}

function findFfmpeg() {
  // 【原代码】只找系统 /usr/bin/ffmpeg。【改为】工具在项目 tool/ 目录保存一份（如 ffmpeg）
  // 【思路】优先项目 tool/ffmpeg 包装脚本（自带 ffmpeg-lib），换机系统没有 mediasrv 也能抽帧
  const cands = [
    process.env.FFMPEG || "",
    path.join(PROJECT_ROOT, "tool", "ffmpeg"),
    path.join(DATA_DIR, "..", "tool", "ffmpeg"),
    "/usr/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/opt/bin/ffmpeg",
    "ffmpeg"
  ];
  for (const p of cands) {
    if (!p) continue;
    if (p === "ffmpeg") return p;
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return "";
}

function extractFrame(videoPath, outPath) {
  const bin = findFfmpeg();
  if (!bin || !videoPath || !fs.existsSync(videoPath)) {
    return Promise.resolve(false);
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  // 临时文件必须是 .jpg（群晖 4.1 不认 xxx.jpg.part.jpg）；项目 tool/ffmpeg 是 mediasrv 8.1
  const tmp = outPath.replace(/\.jpg$/i, "") + ".tmp.jpg";
  const args = [
    "-hide_banner", "-loglevel", "error",
    "-ss", "1",
    "-i", videoPath,
    "-frames:v", "1",
    "-vf", "scale=320:-2",
    "-q:v", "4",
    "-y", tmp
  ];
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (c) => { err += c; });
    const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch (_) {} }, 20000);
    child.on("close", (code) => {
      clearTimeout(t);
      try {
        if (code === 0 && fs.existsSync(tmp) && fs.statSync(tmp).size > 32 && isJpegFile(tmp)) {
          fs.renameSync(tmp, outPath);
          try {
            const id = path.basename(outPath, ".jpg");
          } catch (_) {}
          return resolve(true);
        }
      } catch (_) {}
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
      if (err) console.error("[thumb] ffmpeg:", String(err).slice(0, 200));
      resolve(false);
    });
    child.on("error", () => {
      clearTimeout(t);
      resolve(false);
    });
  });
}

function fileIdOf(info) {
  if (!info) return "";
  if (info.file && info.file.id) return String(info.file.id);
  if (info.raw && info.raw.file && info.raw.file.id) return String(info.raw.file.id);
  if (info.fileId) return String(info.fileId);
  return "";
}

// ════════════════════════════════════════════════════════════════
// 进度条图片预览：雪碧图（N 帧拼一张 <id>-thumb.jpg）+ WebVTT（<id>-thumb.vtt）
// 配套前端 artplayer-plugin-vtt-thumbnail（server/public/vendor/，官方插件本地化）。
// 与封面（thumbs/<id>.jpg 单帧）独立：-thumb.jpg/-thumb.vtt 是预览产物，不参与封面索引。
// ════════════════════════════════════════════════════════════════

function spritePath(id) {
  const vid = safeId(id);
  if (!vid) return "";
  return path.join(THUMB_DIR, vid + "-thumb.jpg");
}
function spriteVttPath(id) {
  const vid = safeId(id);
  if (!vid) return "";
  return path.join(THUMB_DIR, vid + "-thumb.vtt");
}

function spriteExists(id) {
  const p = spritePath(id);
  const v = spriteVttPath(id);
  if (!p || !v) return false;
  try {
    return fs.existsSync(p) && fs.statSync(p).size > 32 && isJpegFile(p) && fs.existsSync(v) && fs.statSync(v).size > 20;
  } catch (_) { return false; }
}

function readSprite(id) {
  const p = spritePath(id);
  if (!p || !spriteExists(id)) return null;
  try {
    const st = fs.statSync(p);
    return { buf: fs.readFileSync(p), contentType: "image/jpeg", mtimeMs: st.mtimeMs, size: st.size, path: p };
  } catch (_) { return null; }
}

function readSpriteVtt(id) {
  const p = spriteVttPath(id);
  if (!p || !spriteExists(id)) return null;
  try {
    const st = fs.statSync(p);
    return { buf: fs.readFileSync(p), contentType: "text/vtt", mtimeMs: st.mtimeMs, size: st.size };
  } catch (_) { return null; }
}

function ffprobeVideoSize(bin, videoPath) {
  // 用 tool/ffprobe（无则退化：不探测，生成时 scale 自动保持比例）
  const probe = path.join(PROJECT_ROOT, "tool", "ffprobe");
  const use = (probe && fs.existsSync(probe)) ? probe : "";
  return new Promise((resolve) => {
    if (!use || !videoPath) return resolve({ w: 0, h: 0 });
    const child = spawn(use, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=s=x:p=0", videoPath], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (c) => { out += c; });
    const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch (_) {} }, 8000);
    child.on("close", (code) => {
      clearTimeout(t);
      const m = String(out).trim().match(/^(\d+)x(\d+)$/);
      resolve(m ? { w: Number(m[1]), h: Number(m[2]) } : { w: 0, h: 0 });
    });
    child.on("error", () => { clearTimeout(t); resolve({ w: 0, h: 0 }); });
  });
}

// 计划④：抽 N 帧拼雪碧图 + 写 VTT。
// N = clamp(round(duration/30), 4, 16)；≤5s → 1 帧；帧时间 = 时长/N × (i+0.5)，
// 坐标 (i%col)*w, (i/col|0)*h, w, h 与实际 tile 布局严格一致（VTT 与图同参生成，不漂移）。
function extractSprite(videoPath, outPath, durationSec) {
  const bin = findFfmpeg();
  if (!bin || !videoPath || !fs.existsSync(videoPath)) return Promise.resolve(false);
  const dur = Number(durationSec) || 0;
  if (dur <= 0) return Promise.resolve(false);
  const N = dur <= 5 ? 1 : Math.max(4, Math.min(16, Math.round(dur / 30)));
  const col = Math.min(4, Math.ceil(Math.sqrt(N)));
  const row = Math.ceil(N / col);
  const w = 160; // 每帧宽固定 160（vtt-thumbnail 示例同款；分辨率自适应入后续清单）
  const interval = dur / N;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const tmp = outPath.replace(/\.jpg$/i, "") + ".tmp.jpg";
  // 先探测原视频宽高 → 按比例算每帧高（保证 VTT 的 h 与雪碧图实际帧高一致）
  return ffprobeVideoSize(bin, videoPath).then((size) => {
    const h = (size && size.w > 0)
      ? Math.max(2, Math.round((w * size.h) / size.w) & ~1) // 保持偶数（yuv420 要求）
      : 90;
    // 抽 N 个时间点（fps=1/interval 输出第 i 帧≈ t=(i+0.5)*interval）→ scale → tile 拼图
    const args = [
      "-hide_banner", "-loglevel", "error",
      "-i", videoPath,
      "-vf", "fps=1/" + interval + ",scale=" + w + ":-2,tile=" + col + "x" + row,
      "-frames:v", "1",
      "-f", "mjpeg", // 裁剪版 ffmpeg 无法从 .tmp.jpg 扩展名推断 muxer，显式指定
      "-q:v", "4",
      "-y", tmp
    ];
    return new Promise((resolve) => {
      const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      child.stderr.on("data", (c) => { err += c; });
      const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch (_) {} }, 60000);
      child.on("close", (code) => {
        clearTimeout(t);
        try {
          if (code === 0 && fs.existsSync(tmp) && fs.statSync(tmp).size > 32 && isJpegFile(tmp)) {
            fs.renameSync(tmp, outPath);
            // 写 VTT：与上图同参生成，坐标 (i%col)*w, (i/col|0)*h
            const vttPath = outPath.replace(/\.jpg$/i, "") + ".vtt";
            const spriteUrl = "/api/thumbnail-sprite?id=" + encodeURIComponent(path.basename(outPath, "-thumb.jpg"));
            const lines = ["WEBVTT", ""];
            for (let i = 0; i < N; i++) {
              const t0 = i * interval, t1 = (i + 1) * interval;
              const x = (i % col) * w, y = Math.floor(i / col) * h;
              lines.push(vttTime(t0) + " --> " + vttTime(t1));
              lines.push(spriteUrl + "#xywh=" + x + "," + y + "," + w + "," + h);
              lines.push("");
            }
            fs.writeFileSync(vttPath, lines.join("\n"), "utf8");
            return resolve(true);
          }
        } catch (_) {}
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
        if (err) console.error("[thumb] sprite:", String(err).slice(0, 300));
        resolve(false);
      });
      child.on("error", () => { clearTimeout(t); try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {} resolve(false); });
    });
  });
}

function vttTime(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return (hh < 10 ? "0" : "") + hh + ":" + (mm < 10 ? "0" : "") + mm + ":" + (ss < 10 ? "0" : "") + ss.toFixed(3);
}

const spriteInflight = new Map();
// 生成雪碧图（inflight 去重 + 已存在短路）；返回 Promise<boolean>
function generateSprite(id, videoPath, durationSec) {
  const vid = safeId(id);
  if (!vid || !videoPath || !fs.existsSync(videoPath)) return Promise.resolve(false);
  if (spriteExists(vid)) return Promise.resolve(true);
  if (spriteInflight.has(vid)) return spriteInflight.get(vid);
  const job = extractSprite(videoPath, spritePath(vid), durationSec)
    .catch((e) => { console.error("[thumb] sprite gen", vid, e && e.message || e); return false; })
    .finally(() => spriteInflight.delete(vid));
  spriteInflight.set(vid, job);
  return job;
}function thumbIndexOf(info) {
  if (!info) return 0;
  const n = info.thumbnail != null ? info.thumbnail
    : (info.raw && info.raw.thumbnail);
  return Number.isFinite(Number(n)) ? Number(n) : 0;
}

async function resolveThumbMeta(id, fileId, n) {
  let fid = String(fileId || "").trim();
  let idx = Number.isFinite(Number(n)) ? Number(n) : null;
  // 封面不进视频索引。缺 fileId/序号就现查官方 /video/:id（只要这两个字段）。
  if (!fid || idx == null) {
    try {
      const meta = await api.getThumbMeta(id);
      if (meta) {
        if (!fid) fid = String(meta.fileId || "");
        if (idx == null && Number.isFinite(Number(meta.thumbnail))) idx = Number(meta.thumbnail);
      }
    } catch (_) {}
  }
  if (idx == null) idx = 0;
  return { fileId: fid, n: idx };
}

async function fetchRemote(id, fileId, n) {
  const vid = safeId(id);
  const meta = await resolveThumbMeta(vid, fileId, n);
  const fid = meta.fileId;
  if (!vid || !fid) return null;
  const img = await api.fetchThumbnail(fid, meta.n);
  if (!img || !img.buf || !img.buf.length) return null;
  writeThumb(vid, img.buf, "official");
  return { buf: img.buf, contentType: img.contentType || "image/jpeg", mtimeMs: Date.now(), size: img.buf.length };
}

// 2026-09-04：搜索/下载时把官方封面落到 thumbs/<id>.jpg。
// 搜索/下载时从官方取封面并按本地规范保存、优先于本地生成；视频播放从本地取（含在线取后存本地）
// 【思路】规范=server/thumbs/<id>.jpg。已有文件跳过（低负载）。队列并发 2。
const officialQueue = [];
const officialQueued = new Set();
let officialActive = 0;
const OFFICIAL_CONC = 2;

function saveOfficialThumb(id, fileId, n) {
  const vid = safeId(id);
  if (!vid) return Promise.resolve(null);
  // 已有封面不覆盖（播放页正确图不能被另一次官方/抽帧改掉）
  if (hasThumb(vid)) return Promise.resolve(readThumb(vid));
  if (inflight.has(vid)) return inflight.get(vid);
  const job = fetchRemote(vid, fileId, n).catch((e) => {
    console.error("[thumb] official", vid, e && e.message || e);
    return null;
  }).finally(() => inflight.delete(vid));
  inflight.set(vid, job);
  return job;
}

function pumpOfficialQueue() {
  while (officialActive < OFFICIAL_CONC && officialQueue.length) {
    const it = officialQueue.shift();
    officialQueued.delete(it.id);
    officialActive++;
    saveOfficialThumb(it.id, it.fileId, it.n).finally(() => {
      officialActive--;
      pumpOfficialQueue();
    });
  }
}

function enqueueOfficialThumb(id, fileId, n) {
  const vid = safeId(id);
  const fid = String(fileId || "").trim();
  if (!vid || !fid) return;
  if (hasThumb(vid) || inflight.has(vid) || officialQueued.has(vid)) return;
  officialQueued.add(vid);
  officialQueue.push({ id: vid, fileId: fid, n: n });
  pumpOfficialQueue();
}

function prefetchOfficialFromList(list) {
  const arr = Array.isArray(list) ? list : [];
  let n = 0;
  for (const v of arr) {
    if (!v) continue;
    const vid = safeId(v.id || v.modId);
    if (!vid || hasThumb(vid)) continue;
    const fid = (v.file && v.file.id) || v.fileId || "";
    enqueueOfficialThumb(vid, fid, v.thumbnail);
    n++;
    if (n >= 40) break; // 低负载：导入一次最多入队 40 张
  }
}

function ensureThumb(id, opts) {
  const vid = safeId(id);
  if (!vid) return Promise.resolve(null);
  const hit = readThumb(vid);
  if (hit) return Promise.resolve(hit);
  if (inflight.has(vid)) return inflight.get(vid);
  const job = (async () => {
    const o = opts || {};
    const out = thumbPath(vid);
    // 封面文件名 thumbs/<id>.jpg 就是索引，不写进视频索引。
    // 没带 fileId 也走 fetchRemote：resolveThumbMeta 现查官方 /video/:id 拿 fileId+序号。
    const remote = await fetchRemote(vid, o.fileId, o.n);
    if (remote) return remote;
    if (o.filePath && await extractFrame(o.filePath, out)) return readThumb(vid);
    return null;
  })().catch((e) => {
    console.error("[thumb] ensure", vid, e && e.message || e);
    return null;
  }).finally(() => inflight.delete(vid));
  inflight.set(vid, job);
  return job;
}

// 2026-09-03 视频文件不存在则不生成封面图
// 最简逻辑：filePath 不存在 → 跳过；已存在 → 抽帧覆盖
function ensureFromInfo(id, info, filePath) {
  const vid = safeId(id);
  if (!vid) return Promise.resolve(null);
  const fp = filePath || "";
  if (!fp) return Promise.resolve(null);
  // 检查视频文件是否存在
  try {
    if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) return Promise.resolve(null);
  } catch (_) { return Promise.resolve(null); }
  // 2026-09-04：播放页不得覆盖已有封面。
  // 【原代码】每次 play-info 都 ensureFromInfo → fetchRemote/extractFrame 覆盖 thumbs/<id>.jpg。
  // 【改为】播放时刷新封面会变错；每次 HTML 封面独立，刷新后恢复——查明根因
  // 【思路】模拟：GET 官方/抽帧图 15351 → 打 /api/play-info → 1 秒内文件变成另一张 4824。
  //   play.html 又在 500ms/2000ms 用 &t= 强刷，把刚覆盖的错图显示出来。F5 若赶上覆盖前缓存就会「刷新又对」。
  //   已有 jpg 只读；缺图才官方优先、再抽帧。
  if (hasThumb(vid)) return Promise.resolve(readThumb(vid));
  if (inflight.has(vid)) return inflight.get(vid);
  const job = (async () => {
    const out = thumbPath(vid);
    const fid = fileIdOf(info);
    if (fid) {
      const remote = await fetchRemote(vid, fid, thumbIndexOf(info));
      if (remote) return remote;
    }
    if (await extractFrame(fp, out)) return readThumb(vid);
    return null;
  })().catch((e) => {
    console.error("[thumb] ensureFromInfo", vid, e && e.message || e);
    return null;
  }).finally(() => inflight.delete(vid));
  inflight.set(vid, job);
  return job;
}

function localSrc(id) {
  const vid = safeId(id);
  return vid ? "/api/thumb?id=" + encodeURIComponent(vid) : "";
}

function listCached() {
  try {
    if (!fs.existsSync(THUMB_DIR)) return [];
    return fs.readdirSync(THUMB_DIR)
      .filter((n) => n.endsWith(".jpg") && !n.endsWith(".tmp.jpg") && !n.endsWith(".part.jpg")
        && !n.endsWith("-thumb.jpg")) // 计划④：雪碧图不是封面，不参与封面索引/清理
      .map((n) => n.slice(0, -4));
  } catch (_) { return []; }
}

function pruneUnknownThumbs(known) {
  const keep = known instanceof Set ? known : new Set(known || []);
  for (const id of listCached()) {
    if (keep.has(id)) continue;
    try { fs.unlinkSync(thumbPath(id)); } catch (_) {}
  }
}

let warmupPromise = null;
let warmupRoot = "";
let warmupDone = false;

function warmupAll(root) {
  const r = String(root || "");
  if (!r) return Promise.resolve({ total: 0, cached: 0 });
  // 同一路径正在扫：复用；扫完后再调（改设置/又下了新片）就再扫一轮
  if (warmupPromise && warmupRoot === r && !warmupDone) return warmupPromise;
  warmupRoot = r;
  warmupDone = false;
  warmupPromise = (async () => {
    const videoIndex = require("./video-index");
    // id 只来自 json 索引：sidecar `{ "<id>": { title, fileId, ... } }` 与 iwara-index.json 的 key
    try { videoIndex.scanDownloadDir(r); } catch (e) {
      console.error("[thumb] scan index", e && e.message || e);
    }
    const catalog = videoIndex.listCatalog(r);
    const videos = (catalog && catalog.videos) || {};
    const ids = Object.keys(videos).filter((vid) => !!safeId(vid));
    pruneUnknownThumbs(ids);
    const missing = ids.filter((vid) => !hasThumb(vid));
    const CONC = 2;
    for (let i = 0; i < missing.length; i += CONC) {
      const batch = missing.slice(i, i + CONC);
      await Promise.all(batch.map(async (vid) => {
        const entry = videos[vid] || {};
        const found = videoIndex.findPlayable(r, vid);
        // warmup 也官方优先，缺官方再抽本地视频帧
        return ensureThumb(vid, {
          fileId: entry.fileId || (found && found.entry && found.entry.fileId) || "",
          filePath: found && found.file || ""
        });
      }));
    }
    const cached = listCached().length;
    warmupDone = true;
    console.log("[thumb] warmup done " + cached + " 张 / " + ids.length + " 个索引 → " + THUMB_DIR);
    return { total: ids.length, cached };
  })().catch((e) => {
    console.error("[thumb] warmup", e && e.message || e);
    warmupPromise = null;
    warmupRoot = "";
    warmupDone = false;
    return { total: 0, cached: 0 };
  });
  return warmupPromise;
}

function warmupReady() { return warmupPromise || Promise.resolve({ total: 0, cached: 0 }); }

module.exports = {
  THUMB_DIR, safeId, thumbPath, hasThumb, readThumb, writeThumb,
  ensureThumb, ensureFromInfo, fileIdOf, thumbIndexOf, localSrc,
  extractFrame, listCached, warmupAll, warmupReady,
  saveOfficialThumb, enqueueOfficialThumb, prefetchOfficialFromList,
  spritePath, spriteVttPath, spriteExists, readSprite, readSpriteVtt, generateSprite,
  extractSprite, vttTime
};
