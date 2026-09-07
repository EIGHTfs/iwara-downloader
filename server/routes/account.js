// ============================================================
// iwara-downloader - 路由：账号（检测 / 明文凭证回传 / 关注列表）
// P1 从 app.js 拆分。原逻辑 1:1 搬运（API/UX 不变）。
// R2 铁律：/api/cred 明文回传（油猴「注入登录态到浏览器」用，需登录，仅局域网场景）
// ============================================================
"use strict";

module.exports = function register(api) {
  const { route, sendJson, cfg, iwaraApi } = api;

  // GET /api/account-check（需鉴权；油猴 / 设置页共用）
  route("GET", "/api/account-check", async (req, res) => {
    const c = cfg.readConfig();
    const cookie = String(c.iwaraCookie || "");
    const cookieItems = cookie ? cookie.split(";").map((s) => s.trim()).filter(Boolean) : [];
    const cred = {
      hasCookie: !!cookie.trim(),
      cookieChars: cookie.length,
      cookieItems: cookieItems.length,
      hasCfClearance: /(?:^|;\s*)cf_clearance=/.test(cookie),
      hasToken: !!(c.iwaraToken && String(c.iwaraToken).trim()),
      hasAccessToken: !!(c.iwaraAccessToken && String(c.iwaraAccessToken).trim())
    };
    if (!c.iwaraCookie && !c.iwaraToken) {
      return sendJson(res, 200, { ok: true, cookieSet: false, checked: false, message: "未配置 Cookie / Token", cred });
    }
    const r = await iwaraApi.checkLogin();
    return sendJson(res, 200, Object.assign({ cookieSet: !!(c.iwaraCookie || c.iwaraToken), checked: true, cred }, r));
  });

  // GET /api/cred（需鉴权；明文直传）
  route("GET", "/api/cred", (req, res) => {
    const c = cfg.readConfig();
    return sendJson(res, 200, {
      ok: true,
      cookie: String(c.iwaraCookie || ""),
      token: String(c.iwaraToken || ""),
      accessToken: String(c.iwaraAccessToken || "")
    });
  });

  // GET /api/following（需鉴权）
  route("GET", "/api/following", async (req, res, parsed) => {
    try {
      const all = parsed.query.all === "1";
      const force = parsed.query.refresh === "1";
      const r = all
        ? await iwaraApi.listFollowing(force)
        : await iwaraApi.listFollowingPage(parsed.query.page || 0, parsed.query.limit || 50);
      return sendJson(res, 200, {
        ok: true,
        count: r.count || r.following.length,
        me: r.me,
        following: r.following,
        page: r.page,
        limit: r.limit,
        synced: r.synced,
        added: r.added,
        fetchedPages: r.fetchedPages
      });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: String(e.message || e) });
    }
  });
};
