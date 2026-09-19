// ============================================================
// iwara-downloader-server - 配置管理
// 参考 gbmd 的 config 设计：config.json 自动初始化、GBMD_DATA_DIR 重定向
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// 数据目录：Electron 打包后经 GBMD_DATA_DIR 重定向，默认本项目 server/
const jsonDir = require("./store/json-dir.js");
const DATA_DIR = jsonDir.SERVER_DIR;
// config.json 例外：留在 server/（配置文件属于服务端资产，不随 json/ 运行态数据迁移）
const CONFIG_FILE = path.join(DATA_DIR, "config.json"); //userdata-manifest.json file server/config.json 服务配置（例外留在 server/）
(function restoreConfigFromJsonDir() {
  const misplaced = jsonDir.jsonFile("config.json");
  try {
    if (!fs.existsSync(CONFIG_FILE) && fs.existsSync(misplaced)) {
      fs.renameSync(misplaced, CONFIG_FILE);
    } else if (fs.existsSync(CONFIG_FILE) && fs.existsSync(misplaced)) {
      fs.unlinkSync(misplaced);
    }
  } catch (_) {}
})();

const DEFAULT_CONFIG = {
  port: 8643,
  // Iwara 登录 refresh_token（从浏览器 localStorage 的 token 复制）
  iwaraToken: "",
  // 完整 Cookie（含 cf_clearance；可空，IP 直连 + 精简 UA 时 API 层通常不依赖）
  iwaraCookie: "",
  // access_token（由 refresh_token POST /user/token 刷新，关注列表等需登录接口用）
  iwaraAccessToken: "",
  // Cloudflare 边缘 IP（api.iwara.tv 泛解析后的直连目标；从配置读取，不写死在代码里）
  iwaraCfgIp: "104.26.12.12",
  // aria2 解析 *.iwara.tv 用的 DNS（群晖 DNS Server 套件；留空 = 不传 dns-server，走 aria2 系统 DNS）
  aria2Dns: "",
  // 下载后端：direct（Node 直连） | aria2
  downloadBackend: "direct",
  // 直连下载并发数
  concurrency: 3,
  // Aria2 RPC
  aria2Path: "http://127.0.0.1:6800/jsonrpc",
  aria2Token: "",
  // 下载根目录（视频将存到 <root>/<作者>/<文件名>）
  downloadPath: "",
  // 文件名模板（学油猴脚本 downloadPath.ts 的变量替代，可自定义）：
  //   支持 {TITLE} {ALIAS} {ID} {AUTHOR} {QUALITY} {UPLOADTIME} {NOWTIME}
  //   例：Iwara_-_{TITLE}_[{ID}]_[{QUALITY}]  （不要写 .mp4）
  //   模板里的 "/" 是目录分隔：写 {AUTHOR}/Iwara_-_{TITLE}_[{ID}] 即按作者分目录；
  //   不写则直接存下载根目录（原先独立的「作者子目录」开关已并入模板）
  //   必须含 {ID}：封面 thumbs/<id>.jpg、sidecar json、视频文件都靠网址里的 id 对上
  fileNameTemplate: "Iwara_-_{TITLE}_[{ID}]_[{QUALITY}]",
  // 搜索结果标注已点赞（列表带 ❤️）
  showLikedInSearch: true,
  // 下载时自动点赞 / 关注作者（需已登录 Iwara）
  autoLike: false,
  autoFollow: false,
  // 访问密码（scrypt 哈希，空 = 不设密码）
  passwordSalt: "",
  passwordHash: "",
  sessionHours: 72,
  // 网盘链接探测（预留，后续版本启用）
  checkDownloadLink: false,
  playPublic: true,
  downloadToggles: { video: true, json: true },
  // 自动更新：watch=监控文件变更重启 / git=定时 git pull / github=定时从 GitHub 拉取
  //   enabled=false 默认关。github 模式的仓库不在默认配置里写死：
  //   由 lib/auto-update.js 的 defaultRepo 提供，用户可在 config.json 覆盖 githubRepo
  autoUpdate: { enabled: false, mode: "watch", interval: 300, githubBranch: "main", githubToken: "" }
};

const DEFAULT_FILE_NAME_TEMPLATE = "Iwara_-_{TITLE}_[{ID}]_[{QUALITY}]";

function templateHasId(t) {
  return /\{ID\}/.test(String(t || ""));
}

function normalizeFileNameTemplate(raw) {
  let t = String(raw || "").trim().replace(/\.(mp4|webm|mov|mkv|m4v)$/i, "");
  // 模板可含 "/" 分段（如 {AUTHOR}/{TITLE}_[{ID}]），但拒绝绝对路径与 .. 分段：
  //   这类写法只可能是误输入或恶意构造，直接回落默认模板，不做静默改写。
  if (t.startsWith("/") || /(^|\/)\.\.(\/|$)/.test(t)) t = "";
  if (!t || !templateHasId(t)) t = DEFAULT_FILE_NAME_TEMPLATE;
  return t;
}

function normalizeDownloadToggles(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    video: src.video !== false,
    json: src.json !== false
  };
}

function readConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
      const merged = Object.assign({}, DEFAULT_CONFIG, data);
      merged.downloadToggles = normalizeDownloadToggles(data.downloadToggles);
      merged.fileNameTemplate = normalizeFileNameTemplate(merged.fileNameTemplate);
      return merged;
    }
  } catch (e) {
    console.error("[config] 读取失败，使用默认配置:", e && e.message);
  }
  const fallback = Object.assign({}, DEFAULT_CONFIG);
  fallback.downloadToggles = normalizeDownloadToggles(DEFAULT_CONFIG.downloadToggles);
  return fallback;
}

function writeConfig(obj) {
  jsonDir.ensureJsonDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(obj, null, 2), "utf8");
  return obj;
}

// ---------- 密码（scrypt，同 gbmd auth 方案） ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, hash, salt) {
  if (!hash || !salt) return true; // 未设置密码：视为通过
  try {
    const calc = crypto.scryptSync(String(password), salt, 64).toString("hex");
    return crypto.timingSafeEqual(Buffer.from(calc, "hex"), Buffer.from(hash, "hex"));
  } catch (_) {
    return false;
  }
}

function setPassword(password) {
  const cfg = readConfig();
  const { salt, hash } = hashPassword(password);
  cfg.passwordSalt = salt;
  cfg.passwordHash = hash;
  writeConfig(cfg);
  return true;
}

function hasPassword() {
  const cfg = readConfig();
  return !!(cfg.passwordHash && cfg.passwordSalt);
}

module.exports = {
  readConfig, writeConfig, hashPassword, verifyPassword, setPassword, hasPassword,
  normalizeDownloadToggles, normalizeFileNameTemplate, templateHasId,
  DEFAULT_FILE_NAME_TEMPLATE, DEFAULT_CONFIG, CONFIG_FILE
};