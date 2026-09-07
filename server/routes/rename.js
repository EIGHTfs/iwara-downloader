// ============================================================
// iwara-downloader - 路由：批量重命名（参照 gbmd 合并文件夹）
// P1 从 app.js 拆分。原逻辑 1:1 搬运（API/UX 不变）。
// 错误记录硬约束：id 只来自 json 索引；默认 dry-run；批量禁止覆盖。
// ============================================================
"use strict";

module.exports = function register(api) {
  const { route, sendJson, readBody, renameFiles } = api;

  // POST /api/rename-files（需鉴权）
  route("POST", "/api/rename-files", async (req, res) => {
    const body = await readBody(req);
    const dryRun = body && body.dryRun === false ? false : true;
    const forceFrom = body && body.forceFrom ? String(body.forceFrom) : "";
    return sendJson(res, 200, renameFiles.executePlan(dryRun, { forceFrom }));
  });
};
