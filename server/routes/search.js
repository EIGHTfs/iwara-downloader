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
  // 返回前按本地点赞/关注状态合并 results：官方列表接口 liked/following 恒 false，
  // 下载自动收藏成功后会写 like_state，前端轮询到这里就能刷新出「已赞」badge
  route("GET", "/api/search-status", (req, res) => {
    const t = search.getQueryTask(true); // true = 合并 liked/following
    if (t && Array.isArray(t.results)) t.results = search.mergeLikedState(t.results);
    return sendJson(res, 200, { ok: true, task: t });
  });
  route("POST", "/api/search/stop", (req, res) => sendJson(res, 200, search.stopSearch()));
  route("GET", "/api/search/cache", (req, res) => {
    const cache = search.getCache();
    if (cache && Array.isArray(cache.results)) cache.results = search.mergeLikedState(cache.results);
    return sendJson(res, 200, { ok: true, cache });
  });
  route("POST", "/api/search/clear", (req, res) => sendJson(res, 200, search.clearCache()));

  route("POST", "/api/search/import", async (req, res) => {
    const body = await readBody(req);
    // 接受四种形态（与导出端同口径）：
    //   ① {records:"<json|jsonl 文本>"}  ② {json:"<文本>"}  ③ 直接 POST 文本（整体不是合法 JSON 时 readBody 回传原文）
    //   ④ 旧形态 {records:[…]} / {results:[…]}
    let raw = body && (body.records !== undefined ? body.records : body.json);
    if (raw === undefined && typeof body === "string") raw = body;
    const parsed = typeof raw === "string" ? jsonlStore.parseAnyJson(raw) : raw;
    const records = jsonlStore.pickRecordArray(parsed);
    if (!records) return sendJson(res, 400, { ok: false, error: "找不到记录数组（支持 JSONL 导出文件、JSON 数组、{results:[…]}）" });
    return sendJson(res, 200, search.importCache(records));
  });

  route("POST", "/api/search/save", async (req, res) => {
    const body = await readBody(req);
    const results = Array.isArray(body && body.results) ? body.results : [];
    return sendJson(res, 200, search.saveRecords(results));
  });

  route("GET", "/api/search/export", (req, res) => {
    const cache = search.exportCache();
    // 搜索记录导出 = JSONL（一行 meta + 一行一条），与索引导出同口径：产出与消费同一格式
    const results = (cache && Array.isArray(cache.results)) ? cache.results : (Array.isArray(cache) ? cache : null);
    const head = { _: "meta", schema: 2, kind: "search-records" };
    if (cache && !Array.isArray(cache)) {
      for (const k of ["startDate", "endDate", "contentFilter", "queryTime", "count", "updatedAt"]) {
        if (cache[k] !== undefined) head[k] = cache[k];
      }
    }
    const lines = [JSON.stringify(head)];
    if (results) for (const rec of results) lines.push(JSON.stringify(rec));
    else lines.push(JSON.stringify(cache));   // 形状未知时整份放进一行，绝不丢数据
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="iwara-search-records-${new Date().toISOString().slice(0, 10)}.jsonl"`);
    return res.end(lines.join("\n") + "\n");
  });
};
