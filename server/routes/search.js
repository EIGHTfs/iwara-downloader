// ============================================================
// iwara-downloader - 路由：搜索（按时间搜索 / 搜索记录导入导出）
// P1 从 app.js 拆分。原逻辑 1:1 搬运（API/UX 不变）。
// ============================================================
"use strict";

module.exports = function register(api) {
  const { route, sendJson, readBody, search, searchDateRange } = api;

  // POST /api/search（需鉴权）- 按时间搜索
  route("POST", "/api/search", async (req, res) => {
    const body = await readBody(req);
    const range = searchDateRange.resolveRange(body.startDate, body.endDate);
    if (!range.ok) return sendJson(res, 400, { ok: false, error: range.error });
    const contentFilter = Array.isArray(body.contentFilter) && body.contentFilter.length ? body.contentFilter : ["normal", "nsfw"];
    try {
      const t = await search.startSearchTask({
        startDate: range.startDate,
        endDate: range.endDate,
        contentFilter,
        startTs: range.startTs,
        endTs: range.endTs,
        user: String(body.user || "")
      });
      return sendJson(res, 200, { ok: true, started: true, task: t });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message || String(e) });
    }
  });

  // 搜索状态 / 停止 / 缓存 / 清空 / 导入 / 保存 / 导出
  route("GET", "/api/search-status", (req, res) => sendJson(res, 200, { ok: true, task: search.getQueryTask() }));
  route("POST", "/api/search/stop", (req, res) => sendJson(res, 200, search.stopSearch()));
  route("GET", "/api/search/cache", (req, res) => sendJson(res, 200, { ok: true, cache: search.getCache() }));
  route("POST", "/api/search/clear", (req, res) => sendJson(res, 200, search.clearCache()));

  route("POST", "/api/search/import", async (req, res) => {
    const body = await readBody(req);
    let records = body && body.records;
    if (typeof records === "string") {
      try { records = JSON.parse(records); } catch (_) { return sendJson(res, 400, { ok: false, error: "JSON 解析失败，请上传正确的搜索记录数组" }); }
    }
    if (body && body.json && !records) {
      try { records = JSON.parse(body.json); } catch (_) { return sendJson(res, 400, { ok: false, error: "JSON 解析失败，请上传正确的搜索记录数组" }); }
    }
    return sendJson(res, 200, search.importCache(records));
  });

  route("POST", "/api/search/save", async (req, res) => {
    const body = await readBody(req);
    const results = Array.isArray(body && body.results) ? body.results : [];
    return sendJson(res, 200, search.saveRecords(results));
  });

  route("GET", "/api/search/export", (req, res) => {
    const cache = search.exportCache();
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="iwara-search-records-${new Date().toISOString().slice(0, 10)}.json"`);
    return res.end(JSON.stringify(cache, null, 2));
  });
};
