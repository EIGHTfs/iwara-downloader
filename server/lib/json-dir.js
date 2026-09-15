// 运行态 JSON 目录：仓库根 json/（不是 server/json/）
// 运行态 json 只放服务端 json 文件夹（含除这两个外的其它运行态 json）
// config.json是例外本来就应该在server文件夹
// userdata-manifest.json 也在 json/
"use strict";

const fs = require("fs");
const path = require("path");

const SERVER_DIR = process.env.GBMD_DATA_DIR || path.join(__dirname, "..");
const JSON_DIR = path.join(SERVER_DIR, "..", "json");

function ensureJsonDir() {
  fs.mkdirSync(JSON_DIR, { recursive: true });
}

function jsonFile(name) {
  return path.join(JSON_DIR, name);
}

function migrateRuntimeJson(name) {
  ensureJsonDir();
  const dest = jsonFile(name);
  if (fs.existsSync(dest)) return dest;
  const legacy = [
    path.join(SERVER_DIR, name),
    path.join(SERVER_DIR, "json", name),
    path.join(SERVER_DIR, "..", name)
  ];
  for (const src of legacy) {
    if (!src || src === dest || !fs.existsSync(src)) continue;
    try { fs.renameSync(src, dest); return dest; } catch (_) {
      try { fs.copyFileSync(src, dest); fs.unlinkSync(src); return dest; } catch (_) {}
    }
  }
  return dest;
}

module.exports = { SERVER_DIR, JSON_DIR, jsonFile, ensureJsonDir, migrateRuntimeJson };
