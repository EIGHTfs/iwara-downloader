#!/usr/bin/env node
"use strict";

// ============================================================
// bin/iwara-downloader.js —— npm 包的命令入口（CLI 契约层）
//
// 这一层只做四件事，别的都不做：
//   ① 解析参数（--port / --data-dir / --help / --version）
//   ② 把数据目录定成**绝对路径**并写进环境变量（服务层据此落 config/日志/上传）
//   ③ 判断"是否被直接执行"（require.main === module）——被 require 时只导出、不启动
//   ④ 交给服务入口（server/boot.cjs；它保持"前台进程"语义，不 daemon 化）
//
// 为什么不在这里做进程管理（PID/后台/日志轮转）：那是 start.sh 的职责。
//   分层的收益：同一份代码能被 npx（前台）、systemd、nohup、start.sh（后台）四种方式启动。
// ============================================================

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const APP_NAME = "iwara-downloader";
const DEFAULT_DATA_DIR = path.join(os.homedir(), `.${APP_NAME}`);

function usage() {
  const lines = [
    `${APP_NAME} —— 在浏览器里浏览 / 下载 iwara.tv 上的视频与图集`,
    "",
    "用法:",
    `  npx ${APP_NAME} [选项]`,
    "",
    "选项:",
    "  --port <n>        监听端口（默认取配置，其次 28463）",
    "  --data-dir <dir>  数据目录（任务状态 / 配置 / 日志 / 上传都放这里）",
    "  -h, --help        显示本帮助",
    "  -v, --version     显示版本号",
    "",
    "数据目录优先级: --data-dir > 环境变量 DATA_DIR > ~/." + APP_NAME,
    "",
    "后台运行（PID / 日志轮转 / status 健康检查）请用包内的 start.sh：",
    "  ./start.sh start | status | restart | stop",
  ];
  console.log(lines.join("\n"));
}

/**
 * 解析命令行参数。
 * 只认两个带值的长选项与 -h/-v；不引第三方参数解析库（零依赖是本项目的硬约束）。
 * 支持 `--port 8080` 与 `--port=8080` 两种写法（npx 传参时后者更常见）。
 * @param {string[]} argv
 * @returns {{port?:number, dataDir?:string, help?:boolean, version?:boolean}}
 */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = String(argv[i]);
    if (a === "-h" || a === "--help") { out.help = true; continue; }
    if (a === "-v" || a === "--version") { out.version = true; continue; }
    if (a === "--port" || a.startsWith("--port=")) {
      const v = a === "--port" ? argv[(i += 1)] : a.slice("--port=".length);
      if (v === undefined || v === "") throw new Error("--port 缺少取值");
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0 || n > 65535) throw new Error(`--port 取值非法：${v}`);
      out.port = n;
      continue;
    }
    if (a === "--data-dir" || a.startsWith("--data-dir=")) {
      const v = a === "--data-dir" ? argv[(i += 1)] : a.slice("--data-dir=".length);
      if (v === undefined || v === "") throw new Error("--data-dir 缺少取值");
      out.dataDir = v;
      continue;
    }
    throw new Error(`未知参数：${a}（用 --help 查看用法）`);
  }
  return out;
}

/**
 * 数据目录：显式参数 > DATA_DIR > ~/.<app>
 * 为什么必须解析成绝对路径：服务层写的是 path.resolve(数据根, 相对值)，
 *   传绝对路径时 resolve(任意, '/abs') === '/abs'，落点才不会被"包目录"带偏。
 * @param {string|undefined} explicit
 * @returns {string}
 */
function resolveDataDir(explicit) {
  const raw = explicit || process.env.DATA_DIR || DEFAULT_DATA_DIR;
  return path.resolve(raw);
}

/** 是否被直接执行（被 require 时只导出函数，不启动服务） */
function isDirectInvocation() {
  return require.main === module;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); return; }
  if (args.version) { console.log(require("../package.json").version); return; }

  const dataDir = resolveDataDir(args.dataDir);
  // DATA_DIR 在本项目的语义是「server 目录」（见 server/store/json-dir.js）：
  //   传 <数据根>/server，配置才会落到 <数据根>/server/config.json、json 落 <数据根>/json
  const serverDir = path.join(dataDir, "server");
  fs.mkdirSync(serverDir, { recursive: true });
  process.env.DATA_DIR = serverDir;
  if (args.port) process.env.PORT = String(args.port);

  // 启动前把落点打出来：排查"数据写到哪了"时这是第一手证据
  console.log(`数据目录: ${dataDir}`);
  console.log(`端口: ${args.port || process.env.PORT || "取配置/默认"}`);

  // 服务入口：它保持"前台进程"语义（监听、优雅退出），不在这里 daemon 化
  require("../server/boot.cjs");
}

if (isDirectInvocation()) {
  try {
    main();
  } catch (e) {
    console.error(`启动失败：${(e && e.message) || e}`);
    process.exit(1);
  }
}

module.exports = { parseArgs, resolveDataDir, isDirectInvocation, usage };
