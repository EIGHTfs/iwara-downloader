// ============================================================
// iwara-downloader - 路由：认证（项目专属部分）
// 登录 / 登出 / 状态 / 改密已上移到框架层（framework/routes-auth.js），
// 本项目只保留自己的端点，避免与框架版重复实现导致行为漂移。
// ============================================================
"use strict";

module.exports = function register(api) {
  const { route, sendJson, readBody, cfg } = api;

  // POST /api/token（需鉴权）——单独保存 iwaraToken（配合油猴凭证获取器推送）
  route("POST", "/api/token", async (req, res) => {
    const body = await readBody(req);
    if (body.iwaraToken === undefined) return sendJson(res, { ok: false, error: "缺 iwaraToken" }, 400);
    const c = cfg.readConfig();
    c.iwaraToken = String(body.iwaraToken).trim();
    cfg.writeConfig(c);
    return sendJson(res, { ok: true }, 200);
  });
};
