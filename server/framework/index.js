// ============================================================
// 框架统一出口
// ============================================================
"use strict";

const { createConfig } = require("./config-loader");
const { createServer, DEFAULT_MIME, createFragmentAssembler } = require("./app");
const { createRoute, groupRoutes } = require("./route-factory");
const { sendJson, readBody, parseCredentialText, cleanCookie } = require("./http-utils");
const fsAsync = require("./fs-async");
const htmlUtils = require("./html-utils");
const appLog = require("./app-log");
const jsonDir = require("./json-dir");
const auth = require("./auth");
const routesAuth = require("./routes-auth");
const { createBackup } = require("./data-backup");
const { createAutoUpdate } = require("./auto-update");
const markerManifest = require("./marker-manifest");
const pathSafe = require("./path-safe");

module.exports = {
  // 核心
  createConfig,
  createServer,
  createRoute,
  groupRoutes,
  createBackup,
  createAutoUpdate,
  createFragmentAssembler,
  markerManifest,
  DEFAULT_MIME,

  // 工具
  sendJson,
  readBody,
  parseCredentialText,
  cleanCookie,

  // 模块
  fsAsync,
  htmlUtils,
  appLog,
  jsonDir,
  auth,
  routesAuth,
  pathSafe,
};
