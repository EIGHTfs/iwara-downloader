// ============================================================
// iwara-downloader - 路由：本地播放（封面 / 播放信息 / 视频流 / 头像）
// 短链 /{id} 留在 app.js 装配层（依赖 PUBLIC_DIR 且命中 isFile 需 fallthrough 到静态）。
// P1 从 app.js 拆分。原逻辑 1:1 搬运（API/UX 不变）。
// 特别注意：封面 404 空 body + image/jpeg，播放只读本地封面等「血泪修复」全部保留。
// ============================================================
"use strict";

module.exports = function register(api) {
  const {
    route, routePublic, sendJson, cfg, videoIndex, thumbCache, profileIndex,
    streamLocalVideo, playHint, requireAuth, path, fs
  } = api;

  // GET/HEAD /api/thumb（公开；列表/播放只读本地 thumbs/<id>.jpg，缺图入队下次有图）
  routePublic(["GET", "HEAD"], "/api/thumb", (req, res, parsed) => {
    const id = String(parsed.query.id || "").trim();
    const fileId = String(parsed.query.file || "").trim();
    const n = String(parsed.query.n || "0");
    let img = id ? thumbCache.readThumb(id) : null;
    if (!img && id) {
      let fid = fileId;
      let tn = n;
      if (!fid) {
        const ent = videoIndex.readEntry(id);
        if (ent && ent.fileId) {
          fid = String(ent.fileId);
          tn = ent.thumbnail != null ? ent.thumbnail : tn;
        }
      }
      if (fid) thumbCache.enqueueOfficialThumb(id, fid, tn);
    }
    if (!img || !img.buf) {
      // 缺封面不要回 JSON：<img> 收到 application/json 会 onerror 藏掉；404 空 body 浏览器当缺图
      res.writeHead(404, { "Content-Type": "image/jpeg", "Content-Length": 0, "Cache-Control": "no-store" });
      return res.end();
    }
    // GET 始终带 JPEG body（不 304）：no-cache + 304 时部分浏览器没存上一次 JPEG，空 body 画不出图
    const etag = img.size != null && img.mtimeMs != null
      ? '"' + String(img.size) + "-" + String(Math.floor(img.mtimeMs)) + '"'
      : '"' + String(img.buf.length) + '"';
    if (req.method === "HEAD") {
      const inm = String(req.headers["if-none-match"] || "");
      if (inm && inm === etag) {
        res.writeHead(304, { ETag: etag, "Cache-Control": "no-cache" });
        return res.end();
      }
    }
    const headers = {
      "Content-Type": img.contentType || "image/jpeg",
      "Content-Length": img.buf.length,
      "Cache-Control": "no-store",
      ETag: etag
    };
    if (img.mtimeMs) headers["Last-Modified"] = new Date(img.mtimeMs).toUTCString();
    res.writeHead(200, headers);
    return res.end(req.method === "HEAD" ? undefined : img.buf);
  });

  // GET /api/play-info（公开含 playPublic 检查）
  route("GET", "/api/play-info", (req, res, parsed) => {
    const id = String(parsed.query.id || "").trim();
    if (!id) return sendJson(res, 400, { ok: false, error: "缺 id" });
    // playPublic=true（默认）免登录播放；false 时需登录；未设密码 = 始终公开
    { const _c = cfg.readConfig(); if (!_c.playPublic && _c.passwordHash && !requireAuth(req)) return sendJson(res, 401, { ok: false, error: "未登录" }); }
    const c = cfg.readConfig();
    const hint = playHint(id);
    const found = videoIndex.findPlayable(c.downloadPath, id, hint.savePath);
    if (!found && !hint.savePath) return sendJson(res, 404, { ok: false, error: "下载目录里没有这个视频" });
    const e = (found && found.entry) || {};
    // 播放只读已有封面，不再覆盖（避免错图）
    if (found && found.file && id && !thumbCache.hasThumb(id)) {
      thumbCache.ensureFromInfo(id, e, found.file).catch(function () {});
    }
    const size = (found && found.size) || 0;
    const expected = hint.expected || size;
    const growing = expected > 0 && size > 0 && size < expected;
    const partial = !!(found && found.partial) || growing;
    return sendJson(res, 200, {
      ok: true,
      id,
      hasFile: !!(found && found.file) && size > 0,
      partial,
      name: e.name || hint.author || "",
      username: e.username || "",
      avatar: (function () {
        // 头像只认项目根 avatar/<uuid>/<uuid>.jpg，不是下载目录、不是 thumbs
        const prof = profileIndex.readEntry(e.username || "");
        const rel = (prof && prof.avatar) || "";
        return rel && profileIndex.avatarExists(rel) ? rel : "";
      })(),
      title: e.title || hint.title || hint.file || id,
      fileId: e.fileId || "",
      duration: e.duration || 0,
      tags: e.tags || [],
      createdAt: e.createdAt || "",
      size,
      expected,
      ext: found && found.file ? path.extname(String(found.file).replace(/\.part$/i, "")).toLowerCase() : ""
    });
  });

  // GET/HEAD /api/play（公开含 playPublic 检查）
  routePublic(["GET", "HEAD"], "/api/play", (req, res, parsed) => {
    const id = String(parsed.query.id || "").trim();
    if (!id) return sendJson(res, 400, { ok: false, error: "缺 id" });
    { const _c = cfg.readConfig(); if (!_c.playPublic && _c.passwordHash && !requireAuth(req)) return sendJson(res, 401, { ok: false, error: "未登录" }); }
    const c = cfg.readConfig();
    const hint = playHint(id);
    const found = videoIndex.findPlayable(c.downloadPath, id, hint.savePath);
    if (!found || !found.file) return sendJson(res, 404, { ok: false, error: "本机下载目录没有这个视频文件" });
    const expected = hint.expected || found.size;
    const growing = expected > 0 && found.size > 0 && found.size < expected;
    return streamLocalVideo(req, res, found.file, { expected, partial: found.partial || growing });
  });

  // GET/HEAD /avatar/<uuid>/<uuid>.jpg（公开）
  routePublic(["GET", "HEAD"], /^\/avatar\//, (req, res, parsed) => {
    const pathname = String(parsed.pathname || "");
    const rel = pathname.slice("/avatar/".length);
    const m = rel.match(/^([0-9a-f-]{36})\/\1\.jpg$/i);
    if (!m) return sendJson(res, 404, { ok: false, error: "头像不存在" });
    const file = profileIndex.avatarFile(m[1]);
    if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end("Not Found"); return; }
    const st = fs.statSync(file);
    res.writeHead(200, {
      "Content-Type": "image/jpeg",
      "Content-Length": st.size,
      "Cache-Control": "public, max-age=86400"
    });
    if (req.method === "HEAD") { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });
};
