// ============================================================
// iwara-downloader - 路由：本地视频索引（列表 / sidecar / 扫描 / 导入导出）
// P1 从 app.js 拆分。原逻辑 1:1 搬运（API/UX 不变）。
// ============================================================
"use strict";

module.exports = function register(api) {
  const { route, routePublic, sendJson, readBody, cfg, videoIndex, thumbCache } = api;

  // GET /api/index-sidecar（公开；aria2 拉取本机生成的 sidecar JSON，短链带 HMAC，不走登录 cookie）
  routePublic("GET", "/api/index-sidecar", (req, res, parsed) => {
    const id = String(parsed.query.id || "").trim();
    const k = String(parsed.query.k || "").trim();
    const buf = videoIndex.readFetchableSidecar(id, k);
    if (!buf) return sendJson(res, 404, { ok: false, error: "not found" });
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": "inline; filename=\"" + id.replace(/[^\w.-]+/g, "_") + ".json\"",
      "Cache-Control": "no-store",
      "Content-Length": buf.length
    });
    return res.end(buf);
  });

  // GET /api/index（公开；本地播放列表，免登录只读 config.downloadPath 本机文件）
  routePublic("GET", "/api/index", (req, res) => {
    const c = cfg.readConfig();
    const catalog = videoIndex.listCatalog(c.downloadPath);
    const videos = catalog && catalog.videos ? catalog.videos : {};
    const miss = [];
    for (const [vid, e] of Object.entries(videos)) {
      if (!vid || !e || !e.fileId) continue;
      if (thumbCache.hasThumb(vid)) continue;
      miss.push({ id: vid, fileId: e.fileId, thumbnail: e.thumbnail });
      if (miss.length >= 80) break;
    }
    if (miss.length) thumbCache.prefetchOfficialFromList(miss);
    return sendJson(res, 200, Object.assign({ ok: true }, catalog));
  });

  // GET /api/index/export（需鉴权）
  route("GET", "/api/index/export", (req, res) => {
    const c = cfg.readConfig();
    const buf = videoIndex.catalogFileBuffer(c.downloadPath);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="iwara-index-${new Date().toISOString().slice(0, 10)}.json"`);
    return res.end(buf);
  });

  // POST /api/index/import（需鉴权）
  route("POST", "/api/index/import", async (req, res) => {
    const c = cfg.readConfig();
    const body = await readBody(req, 64 * 1024 * 1024);
    const payload = body && (body.videos || body.items || body.dump || body);
    try {
      return sendJson(res, 200, videoIndex.importPayload(c.downloadPath, payload));
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: "导入失败: " + (e && e.message || e) });
    }
  });

  // POST /api/index/scan（需鉴权）
  route("POST", "/api/index/scan", (req, res) => {
    const c = cfg.readConfig();
    try {
      return sendJson(res, 200, videoIndex.scanDownloadDir(c.downloadPath));
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: "扫描失败: " + (e && e.message || e) });
    }
  });
};
