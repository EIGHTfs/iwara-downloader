// ============================================================
// iwara-downloader - 路由：本机目录浏览（设置页「📂 读取本地选择」下载路径）
// P1 从 app.js 拆分 + B1 修复。
// 用户 2026-09-06 拍板：「实际只需要把各平台系统关键目录拉黑就行了，本身只是个局域网项目」
// → 黑名单制：命中系统关键目录（/etc /proc /sys /usr /Windows 等）403，其余放行。
// ============================================================
"use strict";

module.exports = function register(api) {
  const { route, sendJson, fs, path, isDeniedBrowseDir, isSystemJunkName } = api;

  // GET /api/browse（需鉴权）
  route("GET", "/api/browse", (req, res, parsed) => {
    const p = String(parsed.query.path || "").trim();
    const dir = p && p.startsWith("/") ? p : "/";
    // B1：系统关键目录黑名单
    if (isDeniedBrowseDir(dir)) {
      return sendJson(res, 403, { ok: false, error: "系统目录不可浏览" });
    }
    try {
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        return sendJson(res, 400, { ok: false, error: "目录不存在: " + dir });
      }
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory() && !isSystemJunkName(e.name))
        .map((e) => e.name)
        .sort();
      return sendJson(res, 200, { ok: true, path: dir, parent: dir === "/" ? null : path.dirname(dir), dirs });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message || String(e) });
    }
  });
};
