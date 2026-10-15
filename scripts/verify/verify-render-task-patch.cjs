// 计划验证：app.js 的 renderTask 接入模板通用 patchList 后——两次 /api/task 渲染
// 验证行复用（DOM 节点不重建）、增量更新、差集删除、partial-refresh 缺失时兜底路径
// 运行：NODE_PATH=<.pwviewer/node_modules> tool/node/bin/node test/verify-render-task-patch.cjs
"use strict";
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

(async () => {
  let pass = 0, fail = 0;
  const check = (name, ok, detail) => {
    ok ? pass++ : fail++;
    console.log((ok ? "  ✓ " : "  ✗ ") + name + (detail ? "  [" + detail + "]" : ""));
  };

  const appJs = fs.readFileSync(path.join(__dirname, "..", "server", "public", "app.js"), "utf8")
    .replace(/\ninit\(\);\s*$/, "\n// init 由测试手动驱动");
  const prJs = fs.readFileSync(path.join(__dirname, "..", "server", "public", "partial-refresh.js"), "utf8");

  // 内联 <script> 注入（与真实浏览器 script 语义一致：var/function 进 window 全局）。
  // 不用 win.eval —— jsdom 的 eval 作用域与 <script> 不同，跨文件找不到函数。
  const dom = new JSDOM(`<!DOCTYPE html><html><body>
    <script>${prJs}</script>
    <script>${appJs}</script>
    <span id="taskState"></span>
    <div id="speedHud" style="display:none"></div>
    <div id="progressFill"></div>
    <div id="taskMeta"></div>
    <div id="taskList"></div>
    <button id="pauseBtn"></button><button id="resumeBtn"></button><button id="stopBtn"></button>
    <button id="retryBtn"></button><button id="clearFailBtn"></button><button id="clearDoneBtn"></button>
  </body></html>`, { runScripts: "dangerously", url: "http://127.0.0.1:8643/" });
  const { window } = dom;

  const list = window.document.getElementById("taskList");
  const mkTask = (items) => ({
    status: "running", backend: "direct", totalSpeed: 1000, items,
  });
  const mkItem = (id, state, progress, title) => ({ id, state, progress, title, file: title, doneBytes: progress * 1000, total: 100000, author: "作者" + id });

  // 第一轮：2 项（downloading + done）
  window.renderTask(mkTask([mkItem("v1", "downloading", 30, "视频一"), mkItem("v2", "done", 100, "视频二")]));
  const rows1 = list.querySelectorAll("[data-task-id]");
  check("首轮 2 行", rows1.length === 2, "got " + rows1.length);
  const rowV1 = list.querySelector('[data-task-id="v1"]');
  const v1NameNode = rowV1.querySelector(".item-name").firstChild;
  check("v1 行存在且名称正确", rowV1.querySelector(".item-name").textContent.indexOf("视频一") >= 0);

  // 第二轮：v1 进度 30→60、v2 删除、v3 新增
  window.renderTask(mkTask([mkItem("v1", "downloading", 60, "视频一"), mkItem("v3", "done", 100, "视频三")]));
  const rows2 = list.querySelectorAll("[data-task-id]");
  check("第二轮 2 行（v2 删除）", rows2.length === 2, "got " + rows2.length);
  const rowV1b = list.querySelector('[data-task-id="v1"]');
  check("v1 行节点复用", rowV1b === rowV1, "same=" + (rowV1b === rowV1));
  check("v1 名称文本节点未重建", rowV1b.querySelector(".item-name").firstChild === v1NameNode);
  check("v1 进度更新到 60%", rowV1b.querySelector(".row-bar-fill").style.width === "60%");
  check("v2 已移除", !list.querySelector('[data-task-id="v2"]'));
  check("v3 已新增", !!list.querySelector('[data-task-id="v3"]'));
  check("任务状态文本", window.document.getElementById("taskState").textContent === "下载中");

  // 第三轮：partial-refresh 缺失 → 兜底路径（把 window.partialRefresh 置空后重载逻辑）
  window.partialRefresh = undefined;
  // 模拟 app.js 里兜底分支：直接调用 renderTask（内部检测 pr 缺失走手写增量）
  window.renderTask(mkTask([mkItem("v1", "downloading", 70, "视频一")]));
  const rows3 = list.querySelectorAll("[data-task-id]");
  check("兜底路径（无 partialRefresh）行数 1", rows3.length === 1, "got " + rows3.length);
  check("兜底路径 v1 节点仍复用", list.querySelector('[data-task-id="v1"]') === rowV1b);
  check("兜底路径进度 70%", list.querySelector('[data-task-id="v1"] .row-bar-fill').style.width === "70%");

  console.log("\n结果: " + pass + " 通过 / " + fail + " 失败");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("ERR", e); process.exit(1); });
