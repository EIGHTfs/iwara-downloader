// 模板通用局部刷新模块验证：partial-refresh.js 的 patchList/patchText/patchAttr
// 运行：NODE_PATH=<.pwviewer/node_modules> tool/node/bin/node test/verify-partial-refresh.cjs
// 覆盖：行复用不重建（DOM 节点引用不变）、增量更新、差集删除、新增行、key 特殊字符转义
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

  const prJs = fs.readFileSync(path.join(__dirname, "..", "server", "public", "partial-refresh.js"), "utf8");
  const dom = new JSDOM(`<!DOCTYPE html><html><body><div id="list"></div><div id="txt">旧值</div></body></html>`, { runScripts: "outside-only" });
  const { window } = dom;
  // 内联 script 注入（与真实浏览器语义一致）
  window.eval(prJs);
  const pr = window.partialRefresh;
  check("window.partialRefresh 挂载", !!(pr && pr.patchList && pr.patchText && pr.patchAttr));
  if (!pr) { console.log("FAIL: 模块未挂载"); process.exit(1); }

  const list = window.document.getElementById("list");
  const mk = (it) => { const r = window.document.createElement("div"); r.className = "row"; r.textContent = ""; return r; };
  // 业务侧用 patchText 原地更新（未变不动），与通用模块语义一致
  const render = (row, it) => { pr.patchText(row, it.name + ":" + it.pct + "%"); };

  // 第一轮：3 行
  pr.patchList(list, [
    { id: "a", name: "A", pct: 10 },
    { id: "b", name: "B", pct: 20 },
    { id: "c", name: "C", pct: 30 },
  ], { key: "task", createRow: mk, renderRow: render });
  const rows1 = list.querySelectorAll(".row");
  check("首轮创建 3 行", rows1.length === 3, "got " + rows1.length);
  check("行属性 data-task-id", rows1[0].getAttribute("data-task-id") === "a");

  const rowA1 = list.querySelector('[data-task-id="a"]');
  const textA1 = rowA1.textContent;

  // 第二轮：a 更新、b 删除、d 新增（复用 a 的 DOM 节点）
  pr.patchList(list, [
    { id: "a", name: "A", pct: 55 },
    { id: "d", name: "D", pct: 5 },
  ], { key: "task", createRow: mk, renderRow: render });
  const rows2 = list.querySelectorAll(".row");
  check("第二轮行数 2（b 差集删除）", rows2.length === 2, "got " + rows2.length);
  const rowA2 = list.querySelector('[data-task-id="a"]');
  check("a 行 DOM 节点复用（未重建）", rowA2 === rowA1, "same=" + (rowA2 === rowA1));
  check("a 行内容增量更新", rowA2.textContent === "A:55%", "got " + rowA2.textContent);
  check("d 行新增", !!list.querySelector('[data-task-id="d"]'));
  check("b 行已移除", !list.querySelector('[data-task-id="b"]'));

  // 第三轮：数据未变 → 文本节点原地更新不重写（nodeType 3 引用不变）
  const aTextNode = rowA2.firstChild;
  pr.patchList(list, [
    { id: "a", name: "A", pct: 55 },
    { id: "d", name: "D", pct: 5 },
  ], { key: "task", createRow: mk, renderRow: render });
  check("未变化时文本节点引用不变", rowA2.firstChild === aTextNode);

  // patchText / patchAttr
  const txt = window.document.getElementById("txt");
  const tn = txt.firstChild;
  pr.patchText(txt, "新值");
  check("patchText 更新", txt.textContent === "新值");
  pr.patchText(txt, "新值");
  check("patchText 同值不动（节点引用不变）", txt.firstChild === tn);
  const el = window.document.createElement("div");
  pr.patchAttr(el, "data-x", "1");
  pr.patchAttr(el, "data-x", "1");
  check("patchAttr 同值不重复写", el.getAttribute("data-x") === "1");

  // key 含特殊字符（CSS.escape 路径）
  const list2 = window.document.createElement("div");
  pr.patchList(list2, [{ id: 'we"ird/id', name: "X", pct: 1 }], { key: "task", createRow: mk, renderRow: render });
  check("key 含特殊字符可定位", list2.querySelector('[data-task-id="we\\"ird\\/id"]') !== null);

  console.log("\n结果: " + pass + " 通过 / " + fail + " 失败");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("ERR", e); process.exit(1); });
