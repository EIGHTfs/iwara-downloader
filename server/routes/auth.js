// ============================================================
// iwara-downloader - 路由：认证（登录 / 登出 / 改密 / token）
// P1 从 app.js 拆分。登录/登出/状态为公开路由，改密/token 需鉴权。
// 原逻辑 1:1 搬运（API/UX 不变）；B3 旧密码校验在 P5 做。
// ============================================================
"use strict";

module.exports = function register(api) {
  const { route, routePublic, sendJson, readBody, cfg, auth, setSessionCookie } = api;

  // POST /api/login（公开）
  routePublic("POST", "/api/login", async (req, res) => {
    const body = await readBody(req);
    const c = cfg.readConfig();
    if (!c.passwordHash) {
      const token = auth.createSession(c.sessionHours || 72);
      setSessionCookie(res, token);
      return sendJson(res, 200, { ok: true, noPassword: true, message: "未设置访问密码，可直接使用" });
    }
    if (cfg.verifyPassword(body.password || "", c.passwordHash, c.passwordSalt)) {
      const token = auth.createSession(c.sessionHours || 72);
      setSessionCookie(res, token);
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 401, { ok: false, error: "密码错误" });
  });

  // POST /api/logout（公开）
  routePublic("POST", "/api/logout", async (req, res) => {
    auth.destroySession(auth.extractToken(req));
    res.setHeader("Set-Cookie", "session=; Path=/; HttpOnly; Max-Age=0");
    return sendJson(res, 200, { ok: true });
  });

  // GET /api/status（公开，任意方法）
  routePublic("*", "/api/status", (req, res) => {
    const c = cfg.readConfig();
    return sendJson(res, 200, { ok: true, needsSetup: !c.passwordHash, needsAuth: !!c.passwordHash, port: c.port || 8643 });
  });

  // POST /api/change-password（需鉴权）
  route("POST", "/api/change-password", async (req, res) => {
    const body = await readBody(req);
    if (!body.password || String(body.password).length < 4) {
      return sendJson(res, 400, { ok: false, error: "密码至少 4 位" });
    }
    cfg.setPassword(body.password);
    return sendJson(res, 200, { ok: true });
  });

  // POST /api/token（需鉴权）——单独保存 iwaraToken（配合油猴凭证获取器推送）
  route("POST", "/api/token", async (req, res) => {
    const body = await readBody(req);
    if (body.iwaraToken === undefined) return sendJson(res, 400, { ok: false, error: "缺 iwaraToken" });
    const c = cfg.readConfig();
    c.iwaraToken = String(body.iwaraToken).trim();
    cfg.writeConfig(c);
    return sendJson(res, 200, { ok: true });
  });
};
