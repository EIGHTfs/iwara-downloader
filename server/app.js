// ============================================================
// iwara-downloader-server - HTTP 入口（零依赖，参考 gbmd 重构模式）
// P1：路由按域拆到 server/routes/*.js，本文件只做装配 + 鉴权门 + 静态 + 启动。
// 保留：登录鉴权、设置、账号检测、视频搜索/列表、下载任务（direct/aria2 双后端 +
//       CDN 子域轮换）、本地索引/播放、封面/头像、数据备份、批量重命名、油猴脚本。
// 移除：无（原功能全保留，API 1:1）。
// ============================================================
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const urlMod = require("url");
const os = require("os");

const appLog = require("./framework/app-log");
// iwara 特有高频轮询端点静默（封面缓存与播放页轮询，避免日志刷屏）
appLog.install({ quietApis: ["/api/thumb", "/api/play", "/api/play-info"] });
const cfg = require("./config");
const auth = require("./framework/auth");
// 会话持久化到 json/sessions.json，cookie 名沿用 session（兼容既有前端与已登录用户）
auth.init({ sessionFile: require("./framework/json-dir").jsonFile("sessions.json"), cookieName: "session" });
auth.startCleanup();
const iwaraApi = require("./lib/iwara-api");
const downloader = require("./lib/downloader");
const search = require("./lib/search-cache");
const searchDateRange = require("./framework/search-date-range.cjs");
const dataBackup = require("./lib/data-backup");
const autoUpdate = require("./lib/auto-update");
const videoIndex = require("./lib/video-index");
const renameFiles = require("./lib/rename-files");
const deviceCheck = require("./lib/device-check");
const thumbCache = require("./lib/thumb-cache.cjs");
const profileIndex = require("./lib/profile-index");

const { sendJson, readBody, parseCredentialText } = require("./framework/http-utils");
const { isDeniedBrowseDir, isSystemJunkName } = require("./framework/path-safe");

const PUBLIC_DIR = path.join(__dirname, "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
  ".m4v": "video/mp4",
  ".m3u8": "application/vnd.apple.mpegurl",
  ".m3u": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
  ".flv": "video/x-flv",
  ".mpd": "application/dash+xml"
};

// ---------- 命令行：设置密码 / 端口 ----------
if (process.argv.includes("--set-password")) {
  const idx = process.argv.indexOf("--set-password");
  const pwd = process.argv[idx + 1];
  if (!pwd) { console.error('用法: node app.js --set-password "你的密码"'); process.exit(1); }
  cfg.setPassword(pwd);
  console.log("密码已设置（scrypt 哈希存入 server/config.json）");
  process.exit(0);
}
let CLI_PORT = null;
{
  const idx = process.argv.indexOf("--port");
  if (idx >= 0 && process.argv[idx + 1]) CLI_PORT = parseInt(process.argv[idx + 1], 10);
}

// ---------- 工具 ----------
// 本地 Range 播放。「没下载完的part文件我希望也能部分播放」
// AI 思路：未下完时 Content-Range 的 total 必须是已写入字节，不能报预计完整体积。
function streamLocalVideo(req, res, filePath, opts) {
  let st;
  try { st = fs.statSync(filePath); } catch (_) { res.writeHead(404); res.end("Not Found"); return; }
  const probe = String(filePath).replace(/\.part$/i, "");
  const ext = path.extname(probe).toLowerCase();
  const type = MIME[ext] || "video/mp4";
  const available = st.size;
  const wanted = Number(opts && opts.expected) || 0;
  const namedPart = /\.part$/i.test(filePath);
  const growing = wanted > 0 && available > 0 && available < wanted;
  const partial = !!(opts && opts.partial) || namedPart || growing;
  const total = partial ? available : (wanted > available ? wanted : available);
  const range = String(req.headers.range || "");
  const m = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (m) {
    let start = m[1] ? parseInt(m[1], 10) : 0;
    if (available <= 0) {
      res.writeHead(404); res.end("Not Found"); return;
    }
    if (start >= available) {
      const keep = Math.min(available, 256 * 1024);
      start = Math.max(0, available - keep);
    }
    let end = m[2] ? parseInt(m[2], 10) : available - 1;
    if (end >= available) end = available - 1;
    if (start > end) start = 0;
    res.writeHead(206, {
      "Content-Type": type,
      "Content-Range": "bytes " + start + "-" + end + "/" + total,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      "Cache-Control": "no-store",
      "X-Playback-Partial": partial ? "1" : "0"
    });
    if (req.method === "HEAD") { res.end(); return; }
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, {
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    "Content-Length": available,
    "Cache-Control": "no-store",
    "X-Playback-Partial": partial ? "1" : "0"
  });
  if (req.method === "HEAD") { res.end(); return; }
  fs.createReadStream(filePath).pipe(res);
}

function playHint(id) {
  const it = ((downloader.getTask().items || []).find((x) => x.id === id)) || {};
  return {
    savePath: it.savePath || "",
    expected: it.total || 0,
    title: it.title || "",
    author: it.author || "",
    file: it.file || ""
  };
}

function setSessionCookie(res, token) {
  const cfgNow = cfg.readConfig();
  const maxAge = (cfgNow.sessionHours || 72) * 3600;
  res.setHeader("Set-Cookie", `${auth.cookieName()}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`);
}

function requireAuth(req) {
  const c = cfg.readConfig();
  if (!c.passwordHash) return true;
  return auth.isValidSession(auth.extractToken(req));
}

function publicSettings(c) {
  const { passwordHash, passwordSalt, iwaraCookie, iwaraToken, iwaraAccessToken, aria2Token, ...safe } = c;
  return Object.assign({}, safe, {
    hasCookie: !!(iwaraCookie && String(iwaraCookie).trim()),
    hasToken: !!(iwaraToken && String(iwaraToken).trim()),
    hasAria2Token: !!(aria2Token && String(aria2Token).trim())
  });
}

function injectAssetVersion(html, publicDir) {
  // 「固化skill 不要求用户强刷网页，而是升级页面版本」
  return String(html).replace(
    /(<(?:link|script)\b[^>]*(?:href|src)=["'])([^"']+\.(?:css|js))(\?[^"']*)?(["'][^>]*>)/gi,
    function (_, pre, url, query, post) {
      if (/^(https?:)?\/\//i.test(url) || url.indexOf("/vendor/") >= 0) return pre + url + (query || "") + post;
      var rel = url.replace(/^\//, "");
      var file = path.join(publicDir, rel);
      var v = "";
      try {
        if (fs.existsSync(file)) v = String(fs.statSync(file).mtimeMs | 0);
      } catch (_) {}
      if (!v) return pre + url + (query || "") + post;
      var q = String(query || "");
      if (/[?&]v=/.test(q)) q = q.replace(/([?&])v=[^&]*/, "$1v=" + v);
      else q = (q ? q + "&" : "?") + "v=" + v;
      return pre + url + q + post;
    }
  );
}

function serveStatic(req, res, pathname) {
  let filePath = path.join(PUBLIC_DIR, pathname === "/" ? "index.html" : pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end("Forbidden"); return; }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end("Not Found"); return; }
    const ext = path.extname(filePath).toLowerCase();
    const headers = { "Content-Type": MIME[ext] || "application/octet-stream" };
    if (ext === ".html" || ext === ".js" || ext === ".css") headers["Cache-Control"] = "no-cache, no-store, must-revalidate";
    if (ext === ".ico" || ext === ".png") headers["Cache-Control"] = "public, max-age=86400";
    if (req.method === "HEAD") { res.writeHead(200, headers); res.end(); return; }
    if (ext === ".html") {
      const html = injectAssetVersion(fs.readFileSync(filePath, "utf8"), PUBLIC_DIR);
      headers["Content-Length"] = Buffer.byteLength(html);
      res.writeHead(200, headers);
      return res.end(html);
    }
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  });
}

// ---------- 路由装配 ----------
const publicRoutes = [];
const routes = [];
const routePublic = (method, p, handler) => publicRoutes.push({ method, p, handler });
const route = (method, p, handler) => routes.push({ method, p, handler });

const api = {
  route, routePublic,
  sendJson, readBody, parseCredentialText,
  setSessionCookie, requireAuth, publicSettings,
  streamLocalVideo, playHint, serveStatic,
  cfg, auth, iwaraApi, downloader, search, searchDateRange, dataBackup, autoUpdate,
  videoIndex, renameFiles, deviceCheck, thumbCache, profileIndex,
  fs, path, os,
  isDeniedBrowseDir, isSystemJunkName
};

require("./routes/auth")(api);
require("./routes/settings")(api);
require("./routes/account")(api);
require("./routes/videos")(api);
require("./routes/search")(api);
require("./routes/data")(api);
require("./routes/index")(api);
require("./routes/browse")(api);
require("./routes/play")(api);
require("./routes/download")(api);
require("./routes/rename")(api);
require("./routes/auto-update")(api);

// ---------- 路由分发 ----------
// method 支持字符串 / 数组 / "*"；path 支持精确字符串 / 正则（如 /avatar/ 前缀、/{id} 短链）
function matchMethod(ruleMethod, method) {
  if (ruleMethod === "*") return true;
  const list = Array.isArray(ruleMethod) ? ruleMethod : [ruleMethod];
  return list.indexOf(method) >= 0;
}
function matchPath(rulePath, pathname) {
  if (rulePath instanceof RegExp) return rulePath.test(pathname);
  return rulePath === pathname;
}
function match(list, method, pathname) {
  for (const r of list) {
    if (matchMethod(r.method, method) && matchPath(r.p, pathname)) return r.handler;
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const parsed = urlMod.parse(req.url, true);
  const pathname = parsed.pathname;
  const method = req.method;

  try {
    if (appLog.shouldLogApi(method, pathname)) appLog.apiLine(method, pathname);
    // ---- 油猴脚本下载（免鉴权，手机浏览器直接打开即触发 Tampermonkey 安装）----
    if (method === "GET" && (pathname === "/userscript" || pathname === "/userscript.user.js" || pathname === "/iwara-cred-fetch.user.js")) {
      const scriptCandidates = [
        path.join(__dirname, "..", "scripts", "iwara-cred-fetch.user.js"),
        path.join(process.cwd(), "..", "scripts", "iwara-cred-fetch.user.js"),
        path.join(process.cwd(), "scripts", "iwara-cred-fetch.user.js")
      ];
      const scriptPath = scriptCandidates.find((p) => fs.existsSync(p));
      if (!scriptPath) return sendJson(res, 404, { ok: false, error: "脚本不存在" });
      fs.readFile(scriptPath, (err, data) => {
        if (err) return sendJson(res, 404, { ok: false, error: "脚本不存在" });
        res.writeHead(200, {
          "Content-Type": "text/javascript; charset=utf-8",
          "Content-Disposition": "inline; filename=iwara-cred-fetch.user.js",
          "Cache-Control": "no-store"
        });
        res.end(data);
      });
      return;
    }
    // ---- 公开路由（登录/登出/状态/本地播放/封面/头像/sidecar）----
    const pub = match(publicRoutes, method, pathname);
    if (pub) return await pub(req, res, parsed);
    // ---- 需鉴权 ----
    if (pathname.startsWith("/api/") && !requireAuth(req)) {
      return sendJson(res, 401, { ok: false, error: "未登录" });
    }
    // ---- 业务路由（/api/*）----
    const h = match(routes, method, pathname);
    if (h) return await h(req, res, parsed);
    // ---- 播放短链 /{id} ----
    // 地址栏不要 play.html#id=；单段路径且像视频 id、PUBLIC 里没有同名文件 → 吐 play.html。
    // /api、/app.js、/login.html 不碰（正则不含 / 与 .）。
    if ((method === "GET" || method === "HEAD") && /^\/[A-Za-z0-9_-]{4,64}$/.test(pathname || "")) {
      const asFile = path.join(PUBLIC_DIR, pathname.slice(1));
      let isFile = false;
      try { isFile = fs.existsSync(asFile) && fs.statSync(asFile).isFile(); } catch (_) { isFile = false; }
      if (!isFile) return serveStatic(req, res, "/play.html");
    }
    // ---- 静态 ----
    // 首页（下载/设置）仍要登录；play.html 免登录，只播本机下载目录
    if ((method === "GET" || method === "HEAD") && (pathname === "/" || pathname === "/index.html")) {
      if (!requireAuth(req)) {
        res.writeHead(302, { Location: "/login.html?next=" + encodeURIComponent("/" + (parsed.search || "")) });
        res.end();
        return;
      }
    }
    if (method === "GET" || method === "HEAD") return serveStatic(req, res, pathname);
    return sendJson(res, 405, { ok: false, error: "方法不允许" });
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: String(e.message || e) });
  }
});

// ---------- 启动 ----------
(async function start() {
  // 端口优先级：--port 命令行 > PORT 环境变量 > config.json；被占用自动换随机端口
  let preferred = CLI_PORT || (process.env.PORT ? parseInt(process.env.PORT, 10) : null) || cfg.readConfig().port || 8643;
  const finalPort = await new Promise((resolve) => {
    const net = require("net");
    const srv = net.createServer();
    const tryListen = (port) => {
      srv.once("error", () => {
        const rnd = 20000 + Math.floor(Math.random() * 10000);
        tryListen(rnd);
      });
      srv.listen(port, () => {
        const p = srv.address().port;
        srv.close(() => resolve(p));
      });
    };
    tryListen(preferred);
  });

  const cfgNow = cfg.readConfig();
  cfgNow.port = finalPort;
  cfg.writeConfig(cfgNow);

  // 会话已在模块加载时由 auth.init() 从 json/sessions.json 恢复，此处无需再加载
  downloader.restorePendingTask();
  search.restorePendingQuery();

  // 自动更新：监控代码变更 → 防抖重启（config autoUpdate.enabled 控制，默认关）
  autoUpdate.start(cfgNow.autoUpdate || { enabled: false }, async () => {
    // 重启回调：任务状态已持久化，下次启动自动恢复
  }, (msg) => {
    // 状态回调：内部 _log 已打印
  });

  server.listen(finalPort, "0.0.0.0", () => {
    console.log("==============================================");
    console.log("iwara-downloader-server 已启动");
    console.log(`  本机访问: http://127.0.0.1:${finalPort}`);
    console.log(`  局域网访问: http://<本机IP>:${finalPort}`);
    if (!cfg.hasPassword()) console.log('  ⚠️ 未设置密码！可运行: node app.js --set-password "你的密码"');
    console.log("==============================================");
    // 封面后台扫完抽帧，前台只读 thumbs/。不挡 listen。
    if (cfgNow.downloadPath) thumbCache.warmupAll(cfgNow.downloadPath);
  });
})();
