// ============================================================
// iwara-downloader - 路由：用户数据备份/恢复（zip + userdata-manifest.json）
// P1 从 app.js 拆分。原逻辑 1:1 搬运（API/UX 不变）。
// ============================================================
"use strict";

module.exports = function register(api) {
  const { route, sendJson, readBody, dataBackup, iwaraApi, os, path, fs } = api;

  // GET /api/data/export（需鉴权）
  route("GET", "/api/data/export", async (req, res) => {
    try {
      const buf = await dataBackup.exportZip();
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="iwara-userdata-${new Date().toISOString().slice(0, 10)}.zip"`);
      return res.end(buf);
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: "备份失败: " + (e && e.message || e) });
    }
  });

  // POST /api/data/import（需鉴权）
  route("POST", "/api/data/import", async (req, res) => {
    const body = await readBody(req, 512 * 1024 * 1024);
    const b64 = body && (body.data || body.zip);
    if (!b64 || typeof b64 !== "string") return sendJson(res, 400, { ok: false, error: "缺少 zip 数据（data 字段，base64）" });
    let zipBuf;
    try { zipBuf = Buffer.from(b64, "base64"); }
    catch (e) { return sendJson(res, 400, { ok: false, error: "zip 数据解码失败" }); }
    const zipPath = path.join(os.tmpdir(), "iwara-upload-" + Date.now() + ".zip");
    fs.writeFileSync(zipPath, zipBuf);
    try {
      const r = await dataBackup.importZip(zipPath);
      // 导入会覆盖 config.json；必须立刻用新 Cookie/Token 打一次 Iwara 登录，不能只写盘。
      let login = null;
      try {
        login = await iwaraApi.checkLogin({ force: true });
      } catch (e) {
        login = { ok: false, loggedIn: false, error: String(e && e.message || e) };
      }
      return sendJson(res, 200, Object.assign({}, r, { login }));
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: "导入失败: " + (e && e.message || e) });
    } finally {
      try { fs.unlinkSync(zipPath); } catch (_) {}
    }
  });
};
