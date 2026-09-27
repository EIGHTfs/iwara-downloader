// 品牌配置读取（2026-09-28 简化）：从项目根 assemble.json 的 brand 段读取，
// 不再生成/读取 server/public/brand.json——品牌是清单的一部分（清单即唯一真相）。
//
// 下游 app.js 用法：
//   const { readBrand } = require("./config/brand");
//   const brandConf = readBrand(__dirname);   // __dirname = server/，项目根 = 上一级
//   ... createFragmentAssembler({ ..., brand: brandConf })
"use strict";

const fs = require("fs");
const path = require("path");

/**
 * 从项目根 assemble.json 的 brand 段读取品牌配置。
 * @param {string} serverDir 调用方所在目录（server/）；项目根 = 其上一级
 * @returns {object|null} brand 段；清单缺失 / 无 brand 段 / 解析失败 → null
 */
function readBrand(serverDir) {
  try {
    const manifestPath = path.join(serverDir, "..", "assemble.json");
    if (!fs.existsSync(manifestPath)) return null;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return (manifest && manifest.brand) || null;
  } catch (_) {
    return null;
  }
}

module.exports = { readBrand };