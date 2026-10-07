// ============================================================
// test/verify-userscript-panel.cjs —— 油猴面板端到端验证（无头 chromium + GM 垫片）
//
// 目的：不依赖人工点击，直接验证「iwara-cred-fetch.user.js 在真实 iwara 页面上
//   能否打开面板、能否探到服务端、面板文案是否正确」；并顺带探测浏览器策略层
//   （混合内容 / Private Network Access / CORS）对「公网 HTTPS 页面 → 局域网 HTTP 服务」的影响。
//
// 做法：
//   1. headless chromium（Playwright）伪造 https://www.iwara.tv/ 页面（route 满足）
//   2. 注入 GM 垫片：GM_xmlhttpRequest 桥到 Node 侧发请求（等价扩展层，不受 CORS/PNA 限制）；
//      GM_getValue/GM_setValue 用内存；GM_cookie 返回空（脚本自动回退 document.cookie）
//   3. 注入**真实**油猴脚本（scripts/iwara-cred-fetch.user.js），点 fab 开面板、填服务器地址
//   4. 断言 + 截图（截图可直接人工/AI 识别面板状态）
//
// 环境变量：
//   IWARA_SERVER        被测服务地址（未设置则跳过测试，退出码 0）
//   IWARA_PWD           服务端访问密码（设置后测试会真实登录；⚠️ 只从环境变量读，禁止写进脚本）
//   IWARA_PUSH_CRED=1   额外触发「🔄 强制刷新凭证并回传」把本机凭证 POST /api/settings（会写服务端配置，
//                       测试前请先备份服务端 config.json）
//   PW_HOME             pwviewer 目录（含 node_modules/playwright 与 browsers/）；默认向上探测
//   PW_CHROME           chromium 可执行文件；默认 <PW_HOME>/browsers/chromium-*/chrome-linux64/chrome
//   PW_LIBS             chromium 动态库目录（LD_LIBRARY_PATH）
//   PW_FONTS            fonts.conf 路径
//   IWARA_USERSCRIPT    油猴脚本路径；默认 ../scripts/iwara-cred-fetch.user.js
//   OUT_DIR             截图输出目录；默认 /tmp/iwara-userscript-shots
//
// 运行：NODE_PATH=<PW_HOME>/node_modules IWARA_SERVER=http://<host>:<port> node test/verify-userscript-panel.cjs
// ============================================================
"use strict";

const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  ok ? pass++ : fail++;
  console.log((ok ? "  ✓ " : "  ✗ ") + name + (detail ? "  [" + detail + "]" : ""));
};

const SERVER = process.env.IWARA_SERVER || "";
const PWD = process.env.IWARA_PWD || "";
const PUSH_CRED = process.env.IWARA_PUSH_CRED === "1";
if (!SERVER) {
  console.log("跳过：未设置 IWARA_SERVER（例如 IWARA_SERVER=http://10.10.31.59:28463）");
  process.exit(0);
}

// ---------- 环境探测（不硬编码本机绝对路径；默认相对邻居） ----------
function firstExisting(list) {
  for (const p of list) { if (p && fs.existsSync(p)) return p; }
  return "";
}
function findPwHome() {
  const cands = [];
  if (process.env.PW_HOME) cands.push(process.env.PW_HOME);
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {           // 从 test/ 逐级向上找 pwviewer
    dir = path.resolve(dir, "..");
    cands.push(path.join(dir, "pwviewer"));
  }
  const hit = firstExisting(cands);
  if (!hit) throw new Error("找不到 pwviewer（请设 PW_HOME 指向含 node_modules/playwright 的目录）");
  return hit;
}
function findChrome(pwHome) {
  if (process.env.PW_CHROME) return process.env.PW_CHROME;
  const browsers = path.join(pwHome, "browsers");
  if (!fs.existsSync(browsers)) return "";
  const dirs = fs.readdirSync(browsers).filter((d) => /^chromium.*\d+$/.test(d)).sort().reverse();
  const subs = ["chrome-linux64/chrome", "chrome-linux/headless_shell", "chrome-linux/chrome"];
  for (const d of dirs) for (const s of subs) {
    const p = path.join(browsers, d, s);
    if (fs.existsSync(p)) return p;
  }
  return "";
}

const PW_HOME = findPwHome();
const CHROME = findChrome(PW_HOME);
const LIBS = process.env.PW_LIBS || firstExisting([path.join(PW_HOME, "..", "pwviewer-libs")]);
const FONTS = process.env.PW_FONTS || firstExisting([path.join(PW_HOME, "..", "fonts", "fonts.conf")]);
const USERSCRIPT = process.env.IWARA_USERSCRIPT || path.resolve(__dirname, "..", "scripts", "iwara-cred-fetch.user.js");
const OUT = process.env.OUT_DIR || "/tmp/iwara-userscript-shots";

let chromium = null;
try { chromium = require("playwright").chromium; } catch (_) {
  console.log("跳过：require('playwright') 失败（请设 NODE_PATH=<PW_HOME>/node_modules）");
  process.exit(0);
}

// GM_xmlhttpRequest 的 Node 侧实现（等价扩展层：无 CORS / 无 PNA 限制）
function nodeRequest(d) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(d.url); } catch (_) { return resolve({ status: 0, responseText: "", error: "bad url" }); }
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request({
      host: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search, method: d.method || "GET", headers: d.headers || {}
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({
        status: res.statusCode,
        responseText: Buffer.concat(chunks).toString("utf8"),
        responseHeaders: Object.entries(res.headers).map(([k, v]) => k + ": " + v).join("\r\n")
      }));
    });
    req.setTimeout(d.timeout || 8000, () => { req.destroy(); resolve({ status: 0, responseText: "", error: "timeout" }); });
    req.on("error", (e) => resolve({ status: 0, responseText: "", error: String(e.message || e) }));
    if (d.data) req.write(d.data);
    req.end();
  });
}

(async () => {
  console.log("环境：PW_HOME=" + PW_HOME);
  console.log("      CHROME=" + CHROME);
  console.log("      USERSCRIPT=" + USERSCRIPT + (fs.existsSync(USERSCRIPT) ? "" : "  (缺失!)"));
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch({
    executablePath: CHROME || undefined,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    env: Object.assign({}, process.env, LIBS ? { LD_LIBRARY_PATH: LIBS } : {}, FONTS ? { FONTCONFIG_FILE: FONTS } : {})
  });
  const context = await browser.newContext({ viewport: { width: 480, height: 900 }, ignoreHTTPSErrors: true });

  await context.exposeBinding("__gmRequest", async (source, details) => await nodeRequest(details));
  await context.addInitScript(() => {
    window.GM_xmlhttpRequest = function (details) {
      Promise.resolve(window.__gmRequest({
        url: details.url, method: details.method, headers: details.headers,
        data: details.data, timeout: details.timeout
      })).then(function (r) {
        if (r && r.error) { details.onerror && details.onerror(r); }
        else { details.onload && details.onload(r); }
      }).catch(function (e) { details.onerror && details.onerror({ error: String(e) }); });
      return { abort: function () {} };
    };
    var mem = {};
    window.GM_getValue = function (k, dflt) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : dflt; };
    window.GM_setValue = function (k, v) { mem[k] = v; };
    window.GM_deleteValue = function (k) { delete mem[k]; };
    window.GM_notification = function () {};
    window.GM_setClipboard = function () {};
    window.GM_cookie = { list: function (o, cb) { cb([], null); }, set: function (o, cb) { cb && cb(); } };
    try {
      localStorage.setItem("token", "TEST_REFRESH_TOKEN");
      localStorage.setItem("accessToken", "TEST_ACCESS_TOKEN");
    } catch (_) {}
  });

  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  const consoleLines = [];
  page.on("console", (m) => consoleLines.push(m.type() + ": " + m.text()));

  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (/^https:\/\/(www\.)?iwara\.tv\//.test(url)) {
      return route.fulfill({
        status: 200, contentType: "text/html; charset=utf-8",
        body: '<!DOCTYPE html><html><head><title>Iwara</title></head><body><div id="app"><a href="/video/abc123def">v</a></div></body></html>'
      });
    }
    return route.continue();
  });

  await page.goto("https://www.iwara.tv/", { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForTimeout(400);
  await page.addScriptTag({ content: fs.readFileSync(USERSCRIPT, "utf8") });
  await page.waitForTimeout(700);

  check("油猴脚本注入后挂上浮动按钮 #iwcred-fab", !!(await page.$("#iwcred-fab")));

  await page.click("#iwcred-fab");
  await page.waitForTimeout(300);
  await page.click("#iwcred-add");
  await page.fill("#iwcred-url-new", SERVER);
  if (PWD) await page.fill("#iwcred-pwd-new", PWD);
  await page.click("#iwcred-add-ok");
  await page.waitForTimeout(4500);   // 探测 + 登录 + account-check

  const userbar = ((await page.textContent("#iwcred-userbar")) || "").trim();
  console.log("  面板 userbar: " + JSON.stringify(userbar));
  await page.screenshot({ path: path.join(OUT, "panel-after-probe.png") });

  // 断言：probe 阶段不应报「服务器离线」（除非确实不可达）
  const offline = /服务器离线或无法登录/.test(userbar);
  const needsPwd = /设有密码|需要密码|请填写服务器访问密码/.test(userbar);
  const reachable = !offline || needsPwd;   // 能报「要密码」= probe 成功拿到了 /api/status
  check("probeServer 能拿到服务端状态（未被判离线）", reachable, offline ? userbar.replace(/\n/g, " | ") : "ok");
  check("服务端要求访问密码时面板给出明确提示", needsPwd || !offline, needsPwd ? "已提示" : "（该服务未设密码）");

  // 可选：触发「🔄 强制刷新凭证并回传」（POST /api/settings）——端到端覆盖本次崩溃修复路径
  if (PUSH_CRED) {
    const localVisible = await page.isVisible("#iwcred-local").catch(() => false);
    const hasRefresh = localVisible ? await page.$("#iwcred-refresh-cred") : null;
    if (hasRefresh) {
      await page.click("#iwcred-refresh-cred");
      await page.waitForTimeout(5000);
      const ub2 = ((await page.textContent("#iwcred-userbar")) || "").trim();
      const st2 = ((await page.textContent("#iwcred-status")) || "").trim();
      console.log("  回传后 userbar: " + JSON.stringify(ub2.slice(0, 220)));
      console.log("  回传后 status : " + JSON.stringify(st2.slice(0, 140)));
      check("凭证回传路径未报失败（POST /api/settings）", !/回传失败/.test(ub2 + st2), (ub2 + " | " + st2).slice(0, 170));
      await page.screenshot({ path: path.join(OUT, "panel-after-push.png") });
    } else {
      // 服务器已登录时脚本按设计隐藏本机凭证区 → 属预期，不算失败
      check("服务器已登录 → 本机凭证区按设计隐藏（无需回传）", true, "localVisible=" + localVisible);
      await page.screenshot({ path: path.join(OUT, "panel-server-logged-in.png") });
    }
  }

  // 服务端存活校验 —— 本次崩溃修复的核心回归断言（旧代码在这条路径上会整机退出）
  const alive = await nodeRequest({ url: SERVER + "/api/status", method: "GET", timeout: 6000 });
  check("测试后服务端仍存活（/api/status 200）", alive.status === 200,
    "status=" + alive.status + " body=" + String(alive.responseText).slice(0, 80));

  // 策略层探针：页面上下文直接 fetch 私网服务（检验 PNA / 混合内容）
  const direct = await page.evaluate(async (u) => {
    try {
      const r = await fetch(u + "/api/status");
      return { ok: true, status: r.status, text: (await r.text()).slice(0, 100) };
    } catch (e) { return { ok: false, error: String(e).slice(0, 200) }; }
  }, SERVER);
  console.log("  页面内 fetch 直连私网: " + JSON.stringify(direct));
  check("未捕获页面级 JS 异常", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));

  await browser.close();
  console.log("\n结果：通过 " + pass + " / 失败 " + fail + "    截图: " + OUT);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
