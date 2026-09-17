// test/helpers/test-log.cjs —— 测试基建助手（每个测试文件首行 require 它）
// 1) 应用 CJS 强制（cjs-bootstrap），使 server/*.js 可被 require
// 2) 提供日志：每个测试文件留一份 log 到 test/logs/<名>.log，记录每用例 PASS/FAIL
require("../../server/framework/cjs-bootstrap.cjs");

"use strict";
const fs = require("fs");
const path = require("path");
const { test } = require("node:test");

const LOG_DIR = path.join(__dirname, "..", "logs");
fs.mkdirSync(LOG_DIR, { recursive: true });

function makeLog(name) {
  const file = path.join(LOG_DIR, String(name).replace(/[^A-Za-z0-9_-]/g, "_") + ".log");
  const lines = [];
  lines.push("===== " + new Date().toISOString() + " =====");
  return {
    get file() { return file; },
    info(msg) { lines.push("[info] " + msg); },
    pass(name_, detail) { lines.push("[PASS] " + name_ + (detail ? " — " + detail : "")); },
    fail(name_, err) { lines.push("[FAIL] " + name_ + " — " + (err && err.message ? err.message : String(err))); },
    flush() { fs.appendFileSync(file, lines.join("\n") + "\n"); },
  };
}

function loggedTest(log, name, fn) {
  test(name, async (t) => {
    try {
      await fn(t);
      log.pass(name);
    } catch (err) {
      log.fail(name, err);
      throw err;
    } finally {
      log.flush();
    }
  });
}

module.exports = { makeLog, loggedTest, LOG_DIR };
