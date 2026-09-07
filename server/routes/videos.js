// ============================================================
// iwara-downloader - 路由：视频列表 / 单个视频解析
// P1 从 app.js 拆分。原逻辑 1:1 搬运（API/UX 不变）。
// ============================================================
"use strict";

module.exports = function register(api) {
  const { route, sendJson, iwaraApi } = api;

  // GET /api/videos（需鉴权）
  route("GET", "/api/videos", async (req, res, parsed) => {
    const q = {
      sort: String(parsed.query.sort || "date"),
      page: parseInt(parsed.query.page || "0", 10),
      limit: parseInt(parsed.query.limit || "20", 10),
      user: String(parsed.query.user || ""),
      search: String(parsed.query.search || ""),
      rating: String(parsed.query.rating || "all"),
      type: String(parsed.query.type || "videos"),
      subscribed: parsed.query.subscribed === "1"
    };
    try {
      const data = await iwaraApi.listVideos(q);
      return sendJson(res, 200, { ok: true, count: data.count, page: data.page, limit: data.limit, results: data.results });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: String(e.message || e), hint: String(e.message || "").startsWith("CF_CHALLENGE") ? "Cookie 未通过 Cloudflare 挑战：请在设置中更新（需含 cf_clearance）" : "" });
    }
  });

  // GET /api/video-info（需鉴权）- 解析单个视频（拿直链/文件名预览）
  route("GET", "/api/video-info", async (req, res, parsed) => {
    const id = String(parsed.query.id || "").trim();
    if (!id) return sendJson(res, 400, { ok: false, error: "缺 id" });
    try {
      const info = await iwaraApi.getVideoInfo(id);
      return sendJson(res, 200, { ok: true, ...info });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: String(e.message || e), hint: String(e.message || "").startsWith("CF_CHALLENGE") ? "Cookie 未通过 Cloudflare 挑战" : "" });
    }
  });
};
