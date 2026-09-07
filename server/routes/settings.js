// ============================================================
// iwara-downloader - 路由：设置（读/写 /api/settings + aria2 同机检测）
// P1 从 app.js 拆分。原逻辑 1:1 搬运（API/UX 不变）。
// ============================================================
"use strict";

module.exports = function register(api) {
  const { route, sendJson, readBody, cfg, parseCredentialText, publicSettings, deviceCheck, thumbCache } = api;

  // GET /api/aria2-device（需鉴权）
  route("GET", "/api/aria2-device", async (req, res, parsed) => {
    const c = cfg.readConfig();
    // 优先用 query.path（设置页还没保存时看输入框里的值），否则用配置里的 aria2Path
    const pathStr = parsed.query.path !== undefined ? String(parsed.query.path) : c.aria2Path;
    const same = await deviceCheck.aria2SameDevice(pathStr);
    return sendJson(res, 200, { ok: true, same, path: pathStr || "" });
  });

  // GET /api/settings（需鉴权）
  route("GET", "/api/settings", (req, res) => {
    return sendJson(res, 200, { ok: true, settings: publicSettings(cfg.readConfig()) });
  });

  // POST /api/settings（需鉴权）
  route("POST", "/api/settings", async (req, res) => {
    const body = await readBody(req);
    const c = cfg.readConfig();
    // 兼容油猴脚本自动复制的组合文本（多行 Cookie=.../Token=.../AccessToken=...）
    if (typeof body.iwaraCookie === "string") {
      const parsed = parseCredentialText(body.iwaraCookie);
      if (parsed) {
        if (parsed.cookie) body.iwaraCookie = parsed.cookie;
        if (parsed.token) { body.iwaraToken = parsed.token; delete body.token; }
        if (parsed.accessToken) body.iwaraAccessToken = parsed.accessToken;
      }
    }
    const allowed = ["iwaraCookie", "iwaraToken", "iwaraAccessToken", "downloadBackend", "concurrency", "aria2Path", "aria2Token", "downloadPath", "fileNameTemplate", "useAuthorSubdir", "showLikedInSearch", "autoLike", "autoFollow", "sessionHours", "port", "checkDownloadLink", "iwaraCfgIp", "aria2Dns", "downloadToggles", "playPublic"];
    const oldDownloadPath = c.downloadPath;
    for (const k of allowed) {
      if (body[k] === undefined) continue;
      if ((k === "iwaraCookie" || k === "iwaraToken" || k === "iwaraAccessToken" || k === "aria2Token") && String(body[k]).trim() === "") continue;
      if (k === "downloadToggles") {
        c[k] = cfg.normalizeDownloadToggles(body[k]);
        continue;
      }
      if (k === "showLikedInSearch" || k === "autoLike" || k === "autoFollow" || k === "useAuthorSubdir" || k === "checkDownloadLink") {
        c[k] = body[k] === true || body[k] === "true" || body[k] === 1 || body[k] === "1";
        continue;
      }
      if (k === "fileNameTemplate") {
        const t = String(body[k] || "").trim().replace(/\.(mp4|webm|mov|mkv|m4v)$/i, "");
        if (!cfg.templateHasId(t)) {
          return sendJson(res, 400, { ok: false, error: "文件名模板必须含 {ID}，封面和 json 靠这个 id 对视频" });
        }
        c[k] = t;
        continue;
      }
      c[k] = body[k];
    }
    cfg.writeConfig(c);
    if (c.downloadPath && String(c.downloadPath) !== String(oldDownloadPath)) {
      thumbCache.warmupAll(c.downloadPath);
    }
    return sendJson(res, 200, { ok: true, settings: publicSettings(cfg.readConfig()), parsedFromText: !!parseCredentialText(typeof body.iwaraCookie === "string" ? body.iwaraCookie : "") });
  });
};
