// ============================================================
// 路由：认证（/api/login、/api/logout、/api/change-password、/api/status）
//   ——框架层·通用
// 2026-09-18 新增：登录相关路由原先被当风格专属件，两个项目各写一份导致逻辑
//   漂移（remember 一处有、一处没有；改密验旧密码一处有、一处没有；
//   会话文件一处落 server/ 一处落 json/）。收敛到框架层，注入即用。
//   项目特有端点（如 iwara 的 /api/token）仍留在项目自己的路由里。
// ============================================================
"use strict";

// 进程启动时刻：本模块在装配阶段被 require（监听之前），取到的即进程启动时间
const STARTED_AT = Date.now();

/** 项目版本号：package.json 缺失（极简部署）时返回空串，不让状态查询因缺文件而 500 */
function appVersion() {
  try {
    return String(require("../../package.json").version || "");
  } catch (_) {
    return "";
  }
}

module.exports = function register(api) {
  const { route, routePublic, sendJson, readBody, cfg, auth, setSessionCookie } = api;

  // 会话有效期：勾选「记住此设备」签长会话（默认 720h/30 天），
  // 不勾沿用 config.sessionHours（默认 72h/3 天）。登录页默认勾选。
  function hoursFor(body) {
    const c = cfg.readConfig();
    const rememberHours = c.sessionRememberHours || 720;
    return body && body.remember ? rememberHours : (c.sessionHours || 72);
  }

  // POST /api/login —— 未设密码直接放行（仅提示）；已设密码校验哈希
  routePublic("POST", "/api/login", async (req, res) => {
    const body = await readBody(req);
    const c = cfg.readConfig();
    const hours = hoursFor(body);
    if (!c.passwordHash) {
      // 初次未设密码 → 只警告，直接视为登录成功（可正常使用）
      const { token } = auth.createSession({ hours });
      setSessionCookie(res, token, hours);
      // 2026-10-08：会话 token 一并回给调用方。脚本管理器（Tampermonkey/Violentmonkey）
      //   默认**隐藏响应头的 Set-Cookie**，油猴脚本拿不到会话就无法带 Cookie 访问受保护接口
      //   （SameSite=Lax 也导致跨站 XHR 不带 cookie）。浏览器端仍走 HttpOnly cookie，忽略此字段即可。
      return sendJson(res, { ok: true, noPassword: true, token, cookieName: auth.cookieName(), message: "未设置访问密码，可直接使用（建议尽快设置）" }, 200);
    }
    if (cfg.verifyPassword(body.password || "", c.passwordHash, c.passwordSalt)) {
      const { token } = auth.createSession({ hours });
      setSessionCookie(res, token, hours);
      // 2026-10-08：同上一并回传 token + cookie 名（供油猴脚本组装 Cookie 头）
      return sendJson(res, { ok: true, token, cookieName: auth.cookieName() }, 200);
    }
    return sendJson(res, { ok: false, error: "密码错误" }, 401);
  });

  // POST /api/logout
  routePublic("POST", "/api/logout", (req, res) => {
    auth.destroySession(auth.extractToken(req));
    res.setHeader("Set-Cookie", `${auth.cookieName()}=; Path=/; HttpOnly; Max-Age=0`);
    return sendJson(res, { ok: true }, 200);
  });

  // GET /api/status —— 前端据此决定跳登录页还是进主界面；启停脚本/监控也用它判活
  // 字段契约：ok / needsSetup（未设密码）/ needsAuth（密码已设置）/ authed（当前会话已登录）/ port
  //   + uptimeSec（进程已运行秒数）/ version（项目 package.json 的版本号，读不到时为空串）
  //   为什么放在 /api/status 而不另开健康端点：启停脚本与监控已经在看这个端点，
  //   追加字段零成本；另开端点只会多一个要被各下游实现的契约。
  // authed 必须由服务端按 session 判定——needsAuth 只是「密码已设置」，
  // 前端拿 needsAuth 当登录态会在设密码后恒判未登录（gallery 收藏「请先登录」事故根因）。
  routePublic("*", "/api/status", (req, res) => {
    const c = cfg.readConfig();
    // port 报「实际监听端口」，取自本次请求的 socket（localPort）——这是唯一不会骗人的来源。
    // 配置里的 port 只是默认值：用 --port / PORT 临时覆盖时它仍是旧值，
    // 只报配置值会让换端口的人误判服务跑在哪。取不到时回落配置值。
    const livePort = req && req.socket && req.socket.localPort;
    return sendJson(res, {
      ok: true,
      needsSetup: !c.passwordHash,
      needsAuth: !!c.passwordHash,
      authed: auth.isValidSession(auth.extractToken(req)),
      port: livePort || c.port || 8643,
      uptimeSec: Math.max(0, Math.floor((Date.now() - STARTED_AT) / 1000)),
      version: appVersion()
    }, 200);
  });

  // POST /api/change-password（需鉴权）
  // 已设密码时改密必须验旧密码（防被盗 session 锁死原主）；首次设置无需旧密码
  route("POST", "/api/change-password", async (req, res) => {
    const body = await readBody(req);
    if (!body.password || String(body.password).length < 4) {
      return sendJson(res, { ok: false, error: "密码至少 4 位" }, 400);
    }
    const c = cfg.readConfig();
    if (c.passwordHash && !cfg.verifyPassword(body.oldPassword || "", c.passwordHash, c.passwordSalt)) {
      return sendJson(res, { ok: false, error: "旧密码错误" }, 403);
    }
    cfg.setPassword(body.password);
    return sendJson(res, { ok: true }, 200);
  });
};
