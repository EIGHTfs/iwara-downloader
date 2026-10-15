// 计划②验证：searchResults 局部 badge 更新（updateLikedBadges）——不重建整表、只改变化行
// 运行：NODE_PATH=<.pwviewer/node_modules> tool/node/bin/node test/verify-update-badges.cjs
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

  // 加载真实 app.js（浏览器脚本）。去掉末尾 init() 自动执行（避免依赖整页 DOM），
  // 函数定义保留（script 语义进 window 全局），测试手动驱动目标函数。
  const appJs = fs.readFileSync(path.join(__dirname, "..", "server", "public", "app.js"), "utf8")
    .replace(/\ninit\(\);\s*$/, "\n// init 由测试手动驱动");

  // 用 <script> 内联注入（与真实浏览器 script 语义一致：var/function 进 window 全局）。
  // 不要用 win.eval —— jsdom 的 eval 作用域与 <script> 不同，跨文件会找不到函数
  // （此前 win.eval 出现 "initPlayTools is not defined" 假象，内联 script 方式则全部可见）。
  const dom = new JSDOM(`<!DOCTYPE html><html><head></head><body>
    <button id="themeBtn"></button>
    <div id="searchResultList">
      <div class="result-item" data-vid="AAA111">
        <input type="checkbox" data-id="AAA111">
        <div class="name"><b>视频A</b> <span class="badge normal">普通</span><div class="meta">authorA</div></div>
      </div>
      <div class="result-item" data-vid="BBB222">
        <input type="checkbox" data-id="BBB222">
        <div class="name"><b>视频B</b> <span class="badge normal">普通</span> <span class="badge liked" data-liked-badge>❤️ 已赞</span><div class="meta">authorB</div></div>
      </div>
    </div>
    <script>${appJs}</script>
    <script>
      // 同 window 后续 <script> 共享全局词法环境：能读写首个 script 的 let 绑定（searchResults/settings）。
      // 测试通过驱动函数触发 updateLikedBadges，避免 win.xxx 赋值不达 let 绑定。
      window.__badgeDrv = function (list, showFlag) {
        searchResults = list || [];
        settings = { showLikedInSearch: showFlag !== false };
        updateLikedBadges();
        return true;
      };
      window.__badgeState = function () {
        var out = {};
        document.querySelectorAll('.result-item[data-vid]').forEach(function (row) {
          out[row.getAttribute('data-vid')] = !!row.querySelector('.badge.liked[data-liked-badge]');
        });
        return out;
      };
    </script>
  </body></html>`, {
    runScripts: "dangerously",
    url: "http://127.0.0.1:8643/",
    pretendToBeVisual: true,
    beforeParse(win) {
      // localStorage shim（jsdom 需显式开启 url 才自带；这里兜底）
      if (!win.localStorage) {
        const store = {};
        win.localStorage = {
          getItem: (k) => (k in store ? store[k] : null),
          setItem: (k, v) => { store[k] = String(v); },
          removeItem: (k) => { delete store[k]; }
        };
      }
    }
  });
  const win = dom.window;
  // app.js 已通过内联 <script> 注入（见上方模板），函数进 window 全局
  await new Promise(r => setTimeout(r, 100));

  check("app.js 加载无异常（updateLikedBadges 全局可见）", typeof win.updateLikedBadges === "function", typeof win.updateLikedBadges);

  // 场景 1：AAA111 变为 liked → 该行出现 badge；BBB222 变为未赞 → 该行 badge 消失
  win.__badgeDrv([
    { id: "AAA111", title: "视频A", liked: true },
    { id: "BBB222", title: "视频B", liked: false }
  ], true);
  const rowA = win.document.querySelector('.result-item[data-vid="AAA111"]');
  const rowB = win.document.querySelector('.result-item[data-vid="BBB222"]');
  const badgeA = rowA.querySelector(".badge.liked[data-liked-badge]");
  const badgeB = rowB.querySelector(".badge.liked[data-liked-badge]");
  check("AAA111 未赞→已赞：行内出现 badge", !!badgeA, badgeA ? badgeA.textContent : "(无)");
  check("BBB222 已赞→未赞：行内 badge 消失", !badgeB, badgeB ? "(仍在)" : "(已移除)");
  check("整表未被重建（box 内仍只有 2 行）", win.document.querySelectorAll("#searchResultList .result-item").length === 2,
    win.document.querySelectorAll("#searchResultList .result-item").length + " 行");
  check("AAA111 标题仍在（未误伤其它节点）", rowA.querySelector(".name b").textContent === "视频A", rowA.querySelector(".name b").textContent);
  check("BBB222 meta 仍在", !!rowB.querySelector(".meta"), rowB.querySelector(".meta").textContent);

  // 场景 2：showLikedInSearch=false 时强制隐藏
  win.__badgeDrv([{ id: "AAA111", title: "视频A", liked: true }], false);
  const badgeA2 = win.document.querySelector('.result-item[data-vid="AAA111"] .badge.liked[data-liked-badge]');
  check("showLikedInSearch=false 时 badge 不显示", !badgeA2);

  // 场景 3：空 results 不报错
  win.__badgeDrv([], true);
  check("空 results 调用不报错", true, "(无异常)");

  console.log("\n结果: " + fail + " 失败 / " + pass + " 通过");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("TOP", e); process.exit(1); });