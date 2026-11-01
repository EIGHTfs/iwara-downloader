// ============================================================
// 自动更新（通用包装层）：具体实现在 server/update/auto-update.js，
// 本文件只负责把项目参数接上，不重复实现更新逻辑。
// 项目参数从同目录的 auto-update-params.json 读取（独立文件，不占用 config.json）。
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");

const { createAutoUpdate } = require("../update/auto-update.js");

// 项目参数文件与本文件同目录（server/lib/auto-update-params.json）
let params = {};
const paramsPath = path.join(__dirname, "auto-update-params.json");
try {
  params = JSON.parse(fs.readFileSync(paramsPath, "utf8"));
} catch (_) {
  // 参数文件缺失（首次未配置）：用空参数，工厂默认值兜底
}

module.exports = createAutoUpdate({
  projectName: params.projectName || "",
  defaultRepo: params.defaultRepo || "",
  extraExclude: params.extraExclude || [],
  extraChmodScripts: params.extraChmodScripts || [],
});
