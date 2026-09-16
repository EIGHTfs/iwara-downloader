// 自动更新（项目实例）：从 framework 引入工厂，只在这里传项目参数。
// 框架实现见 ../framework/auto-update.js（createAutoUpdate），本文件不再重复框架代码。
"use strict";

const { createAutoUpdate } = require("../framework/auto-update.js");

module.exports = createAutoUpdate({
  projectName: "iwara-downloader",
  defaultRepo: "EIGHTfs/iwara-downloader",
  // iwara 特有运行态数据（github 模式绝不覆盖）
  extraExclude: [
    "json/cdn_hosts_state.json",
    "json/following_cache.json",
    "json/index",
    "json/profile",
  ],
  // 前端框架文件（index.html / style.css 含 @frag 指令）：改由组装器热更新，不重启服务
  extraWatchExclude: ["index.html", "public/index.html", "style.css", "public/style.css"],
});
