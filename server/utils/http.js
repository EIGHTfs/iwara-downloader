// ============================================================
// iwara-downloader - HTTP 工具（P0 从 app.js 抽出）
// sendJson：统一 JSON 响应
// readBody：流式读请求体（B2 修复：chunk 落临时文件 + 背压，不累积内存 O(n²) 拼接）
// parseCredentialText：油猴组合凭证文本（Cookie/Token/AccessToken 三字段，iwara 特有）
// ============================================================
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function readBody(req, limit = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const tmpPath = path.join(os.tmpdir(), "iwara-body-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(36).slice(2));
    const ws = fs.createWriteStream(tmpPath);
    let size = 0;
    let settled = false;
    let draining = false;
    const cleanup = () => fs.unlink(tmpPath, () => {});
    const fail = (err) => {
      if (settled) return;
      settled = true;
      ws.destroy();
      cleanup();
      reject(err);
    };
    ws.on("error", fail);
    req.on("data", (c) => {
      if (settled) return;
      size += c.length;
      if (size > limit) {
        settled = true;
        ws.destroy();
        cleanup();
        req.destroy();
        reject(new Error("请求体过大"));
        return;
      }
      const ok = ws.write(c);
      if (!ok && !draining) {
        draining = true;
        req.pause();
        ws.once("drain", () => { draining = false; req.resume(); });
      }
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      ws.end(() => {
        fs.readFile(tmpPath, "utf8", (err, data) => {
          cleanup();
          if (err) return reject(err);
          try { resolve(data ? JSON.parse(data) : {}); }
          catch (e) { reject(new Error("无效的 JSON")); }
        });
      });
    });
    req.on("error", fail);
  });
}

/**
 * 解析油猴脚本自动复制的组合凭证文本：
 *   Cookie=...\nToken=...\nAccessToken=...
 * 返回 { cookie, token, accessToken }（未命中的字段为 null）；
 * 若文本不含任何 "字段=" 行，返回 null（视为纯 Cookie 串）。
 */
function parseCredentialText(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const get = (key) => {
    const m = text.split(/\r?\n/).find((l) => l.startsWith(key + "="));
    if (!m) return null;
    return m.slice(key.length + 1).trim() || "";
  };
  const cookie = get("Cookie");
  const token = get("Token");
  const accessToken = get("AccessToken");
  const hit = /(^|\n)(Cookie|Token|AccessToken)=/.test("\n" + text);
  if (!hit) return null; // 不是组合文本
  return {
    cookie: cookie === null ? null : cookie,
    token: token === null ? null : token,
    accessToken: accessToken === null ? null : accessToken
  };
}

module.exports = { sendJson, readBody, parseCredentialText };
