// ============================================================
// iwara-downloader - 路由：下载任务（提交 / 查询 / 控制）
// P1 从 app.js 拆分。原逻辑 1:1 搬运（API/UX 不变）。
// /api/download：唯一解析入口（parseDownloadItems）；/api/receive：油猴专用接收口。
// ============================================================
"use strict";

module.exports = function register(api) {
  const { route, sendJson, readBody, downloader, parseDownloadItems } = api;

  // GET /api/task（需鉴权）
  route("GET", "/api/task", (req, res) => sendJson(res, 200, { ok: true, task: downloader.getTask() }));

  // POST /api/download | /api/receive（需鉴权）
  route("POST", "/api/download", async (req, res, parsed) => {
    return handleDownload(req, res, parsed.pathname);
  });
  route("POST", "/api/receive", async (req, res, parsed) => {
    return handleDownload(req, res, parsed.pathname);
  });

  async function handleDownload(req, res, pathname) {
    const body = await readBody(req);
    if (pathname === "/api/receive") {
      // 支持 { items:[...] } / { url } / { urls:[...] } / { text:"每行一个链接" }，一律规整成 items
      let rawItems = body.items;
      if (!rawItems && typeof body.url === "string") rawItems = [body.url];
      if (!rawItems && Array.isArray(body.urls)) rawItems = body.urls;
      if (!rawItems && typeof body.text === "string") rawItems = body.text.split(/\r?\n/);
      if (typeof rawItems === "string") rawItems = [rawItems];
      body.items = rawItems;
    }
    const rawItems = body.items || [];
    if (!Array.isArray(rawItems) || rawItems.length === 0) return sendJson(res, 400, { ok: false, error: "无下载项" });
    // 兼容油猴脚本「发送到服务器」：支持字符串（完整 iwara.tv 链接或纯 ID）与对象两种形态
    const items = parseDownloadItems(rawItems);
    if (items.length === 0) return sendJson(res, 400, { ok: false, error: "无法识别下载项" });
    try {
      const r = await downloader.startDownloadTask(items);
      if (pathname === "/api/receive") return sendJson(res, 200, Object.assign({ ok: true }, r, { received: items.length }));
      return sendJson(res, 200, r);
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: String(e.message || e) });
    }
  }

  // 任务控制
  route("POST", "/api/task/pause", async (req, res) => {
    const body = await readBody(req);
    return sendJson(res, 200, { ok: true, status: await downloader.pauseTask(body && body.id) });
  });
  route("POST", "/api/task/resume", async (req, res) => {
    const body = await readBody(req);
    return sendJson(res, 200, { ok: true, status: await downloader.resumeTask(body && body.id) });
  });
  route("POST", "/api/task/stop", async (req, res) => {
    const body = await readBody(req);
    return sendJson(res, 200, { ok: true, status: await downloader.stopTask(body && body.id) });
  });
  route("POST", "/api/task/retry", async (req, res, parsed) => {
    const body = await readBody(req);
    const id = String((body && body.id) || parsed.query.id || "").trim();
    return sendJson(res, 200, { ok: true, retried: downloader.retryFailed(id) });
  });
  route("POST", "/api/task/remove-completed", (req, res) => sendJson(res, 200, downloader.removeCompleted()));
  route("POST", "/api/task/clear-failed", (req, res) => sendJson(res, 200, downloader.clearFailed()));
  route("POST", "/api/task/remove-item", async (req, res, parsed) => {
    const body = await readBody(req);
    const id = String((body && body.id) || parsed.query.id || "").trim();
    if (!id) return sendJson(res, 400, { ok: false, error: "缺 id" });
    return sendJson(res, 200, downloader.removeItem(id));
  });
};
