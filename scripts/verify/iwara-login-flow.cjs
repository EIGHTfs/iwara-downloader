// ============================================================
// test/iwara-login-flow.cjs —— 无头浏览器登录 iwara，刷新服务器凭证（Token/cf_clearance）
//
// 用途：服务器上的 iwara 凭证会过期（refresh_token 约 30 天），且 Cloudflare 会对
//   「非浏览器请求」发 JS 挑战（cf_clearance 与生成它的浏览器 UA/IP 绑定）。本脚本用
//   真实 chromium 走一遍：过 CF 挑战 → 登录 iwara → 抓 localStorage 的 Token/AccessToken
//   + cookies（含 cf_clearance）→ POST /api/settings 推给服务器（连浏览器 UA 一起），
//   最后用 /api/account-check 实测登录态。
//
// 为什么必须直连 CF IP：本机 DNS 被污染（api.iwara.tv 解析到不可达地址），
//   chromium 用 --host-resolver-rules 直接映射到 Cloudflare 边缘 IP，绕开解析。
//
// 用法（所有参数走环境变量；本脚本不含任何账号/密码/令牌）：
//   IWARA_SERVER=http://<host>:<port> \     服务器地址（必填）
//   IWARA_USER=<iwara 用户名或邮箱> \        （必填）
//   IWARA_PWD=<iwara 登录密码> \             （必填）
//   IWARA_SRV_PWD=<服务器访问密码> \         （必填）
//   node test/iwara-login-flow.cjs
//
// 可选环境变量：
//   CF_RULES      host-resolver-rules（默认内置下表；CF 边缘 IP 会变，失效时改这里）
//   IWARA_UA      浏览器 UA（默认 Chrome/131；cf_clearance 与 UA 绑定，改动后需重新登录）
//   PW_HOME       pwviewer 目录（含 node_modules/playwright 与 browsers/）；默认自 __dirname 向上探测
//   PW_CHROME     chromium 可执行文件；默认扫描 <PW_HOME>/browsers/chromium-*/
//   PW_LIBS       chromium 动态库目录（LD_LIBRARY_PATH）
//   PW_FONTS      fonts.conf 路径（中文渲染）
//   OUT_DIR       截图目录（默认 /tmp/iwara-login-shots）
//
// 退出码：0 成功；2 缺参数/未取到 token（看截图）；1 异常
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");

// ---------- 环境探测（不硬编码本机路径；默认从 __dirname 向上找 pwviewer） ----------
function findPwHome() {
  const cands = [];
  if (process.env.PW_HOME) cands.push(process.env.PW_HOME);
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    dir = path.resolve(dir, "..");
    cands.push(path.join(dir, "pwviewer"));
  }
  for (const p of cands) {
    if (p && fs.existsSync(path.join(p, "node_modules", "playwright"))) return p;
  }
  return "";
}
function findChrome(pwHome) {
  if (process.env.PW_CHROME) return process.env.PW_CHROME;
  const base = path.join(pwHome, "browsers");
  if (!fs.existsSync(base)) return "";
  const dirs = fs.readdirSync(base).filter((d) => /^chromium/.test(d)).sort().reverse();
  const subs = ["chrome-linux64/chrome", "chrome-linux/chrome", "chrome-linux/headless_shell"];
  for (const d of dirs) for (const s of subs) {
    const p = path.join(base, d, s);
    if (fs.existsSync(p)) return p;
  }
  return "";
}
function firstExisting(list) {
  for (const p of list) if (p && fs.existsSync(p)) return p;
  return "";
}

const PW_HOME = findPwHome();
const CHROME = PW_HOME ? findChrome(PW_HOME) : (process.env.PW_CHROME || "");
const LIBS = process.env.PW_LIBS || (PW_HOME ? firstExisting([path.join(PW_HOME, "..", "pwviewer-libs")]) : "");
const FONTS = process.env.PW_FONTS || (PW_HOME ? firstExisting([path.join(PW_HOME, "..", "fonts", "fonts.conf")]) : "");

// playwright：优先常规 require（若设了 NODE_PATH），否则用探测到的 pwviewer/node_modules
let chromium = null;
try { chromium = require("playwright").chromium; }
catch (_) {
  try { chromium = require(path.join(PW_HOME, "node_modules", "playwright")).chromium; } catch (_) { chromium = null; }
}

// ---------- 必填参数（不提供任何默认账号/密码/服务地址） ----------
const SRV = process.env.IWARA_SERVER || "";
const USER = process.env.IWARA_USER || "";
const PASS = process.env.IWARA_PWD || "";
const SRV_PWD = process.env.IWARA_SRV_PWD || "";
const OUT = process.env.OUT_DIR || "/tmp/iwara-login-shots";

// Cloudflare 边缘 IP 映射（公开 IP，非隐私；CF 换 IP 时用 CF_RULES 覆盖）
const RULES = process.env.CF_RULES ||
  "MAP www.iwara.tv 172.66.170.170, MAP iwara.tv 172.66.170.170, MAP ecchi.iwara.tv 172.66.170.170, MAP api.iwara.tv 104.26.12.12";
const UA = process.env.IWARA_UA ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const missing = [["IWARA_SERVER", SRV], ["IWARA_USER", USER], ["IWARA_PWD", PASS], ["IWARA_SRV_PWD", SRV_PWD]]
  .filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error("缺少必填环境变量：" + missing.join(", "));
  console.error("用法：IWARA_SERVER=http://<host>:<port> IWARA_USER=<用户名或邮箱> IWARA_PWD=<iware 密码> IWARA_SRV_PWD=<服务器访问密码> node test/iwara-login-flow.cjs");
  process.exit(2);
}
if (!chromium) { console.error("未找到 playwright（设 PW_HOME 指向含 node_modules/playwright 的目录，或设 NODE_PATH）"); process.exit(2); }
if (!CHROME) { console.error("未找到 chromium 可执行文件（设 PW_CHROME）"); process.exit(2); }

// 服务器请求辅助
function srvReq(method, p, body, headers) {
  return new Promise((r) => {
    const data = body ? JSON.stringify(body) : null;
    const h = Object.assign({}, headers || {});
    if (data) { h["Content-Type"] = "application/json"; h["Content-Length"] = Buffer.byteLength(data); }
    const u = new URL(SRV);
    const q = http.request({ host: u.hostname, port: u.port || 80, path: p, method, headers: h }, (res) => {
      const c = []; res.on("data", (x) => c.push(x));
      res.on("end", () => r({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c).toString("utf8") }));
    });
    q.on("error", (e) => r({ status: 0, error: e.message }));
    q.setTimeout(20000, () => { q.destroy(); r({ status: 0, error: "timeout" }); });
    if (data) q.write(data);
    q.end();
  });
}

// 等 Cloudflare 挑战过去（标题不再是 "Just a moment"）
async function waitChallenge(page, maxSeconds) {
  const t0 = Date.now();
  while ((Date.now() - t0) / 1000 < maxSeconds) {
    let t = ""; try { t = await page.title(); } catch (_) {}
    if (!/just a moment|attention required/i.test(t)) { console.log("  挑战已过：" + JSON.stringify(t).slice(0, 60)); return true; }
    await page.waitForTimeout(2500);
  }
  return false;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  console.log("PW_HOME=" + PW_HOME + "  CHROME=" + CHROME + "  SERVER=" + SRV);

  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled", "--host-resolver-rules=" + RULES],
    env: Object.assign({}, process.env, LIBS ? { LD_LIBRARY_PATH: LIBS } : {}, FONTS ? { FONTCONFIG_FILE: FONTS } : {})
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN", timezoneId: "Asia/Shanghai", userAgent: UA });
  const page = await ctx.newPage();

  console.log("① 打开首页（过 CF 挑战）…");
  await page.goto("https://www.iwara.tv/", { waitUntil: "domcontentloaded", timeout: 45000 }).catch((e) => console.log("  goto: " + String(e).slice(0, 80)));
  await waitChallenge(page, 30);
  await page.screenshot({ path: path.join(OUT, "1-home.png") }).catch(() => {});

  console.log("② 打开登录页…");
  await page.goto("https://www.iwara.tv/login", { waitUntil: "domcontentloaded", timeout: 45000 }).catch((e) => console.log("  goto: " + String(e).slice(0, 80)));
  await waitChallenge(page, 25);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(OUT, "2-login.png") }).catch(() => {});
  const fields = await page.$$eval("input", (els) => els.map((e) => ({ type: e.type, name: e.name }))).catch(() => []);
  console.log("  表单字段：" + JSON.stringify(fields).slice(0, 200));

  console.log("③ 填写并提交（登录字段名 email + password；页面另有 name=query 的搜索框，勿选错）…");
  const uSel = "input[name='email']";
  const pSel = "input[name='password']";
  try {
    await page.fill(uSel, USER, { timeout: 15000 });
    await page.fill(pSel, PASS, { timeout: 8000 });
    await page.screenshot({ path: path.join(OUT, "3-filled.png") }).catch(() => {});
    await page.press(pSel, "Enter");   // 密码框回车提交，避开搜索按钮
  } catch (e) { console.log("  填表/提交异常：" + String(e).slice(0, 140)); }
  await page.waitForTimeout(10000);
  await page.screenshot({ path: path.join(OUT, "4-after-login.png") }).catch(() => {});
  console.log("  登录后 url=" + page.url() + "  title=" + JSON.stringify(await page.title().catch(() => "")).slice(0, 60));

  console.log("④ 读取凭证（只报长度，不打印明文）…");
  const lsKeys = await page.evaluate(() => { const o = {}; for (const k of Object.keys(localStorage)) o[k] = String(localStorage.getItem(k) || "").length; return o; }).catch(() => ({}));
  const tok = await page.evaluate(() => localStorage.getItem("token") || "").catch(() => "");
  const atk = await page.evaluate(() => localStorage.getItem("accessToken") || "").catch(() => "");
  const ua = await page.evaluate(() => navigator.userAgent).catch(() => UA);
  const ck = await ctx.cookies().catch(() => []);
  const cookieText = ck.map((c) => c.name + "=" + c.value).join("; ");
  const hasCf = ck.some((c) => c.name === "cf_clearance");
  console.log("  localStorage：" + JSON.stringify(lsKeys).slice(0, 160));
  console.log("  token 长度=" + tok.length + "  accessToken 长度=" + atk.length + "  cookie 数=" + ck.length + "  cf_clearance=" + (hasCf ? "✅" : "❌"));

  if (!tok) { console.log("❌ 未取到 token（登录失败或需验证码）→ 看截图：" + OUT); await browser.close(); process.exit(2); }

  console.log("⑤ 登录服务器并回传凭证（含浏览器 UA）…");
  const lg = await srvReq("POST", "/api/login", { password: SRV_PWD });
  const m = String((lg.headers && lg.headers["set-cookie"] || [])[0] || "").match(/^([^=]+)=([^;]+)/);
  const sess = m ? m[0] : "";
  console.log("  服务器登录 HTTP " + lg.status + "  session=" + (m ? m[1] : "(无)"));
  const credText = ["Cookie=" + cookieText, "Token=" + tok, "AccessToken=" + atk].join("\n");
  const push = await srvReq("POST", "/api/settings", { iwaraCookie: credText, iwaraUA: ua }, { Cookie: sess });
  console.log("  推送 HTTP " + push.status + "  " + String(push.body).slice(0, 90));

  await page.waitForTimeout(1500);
  const chk = await srvReq("GET", "/api/account-check", null, { Cookie: sess });
  console.log("⑥ 账号检测 HTTP " + chk.status);
  console.log(String(chk.body).slice(0, 420));

  let ok = false;
  try { ok = !!JSON.parse(chk.body).loggedIn; } catch (_) {}
  console.log(ok ? "\n✅ 凭证刷新成功（loggedIn=true）" : "\n⚠️ 凭证已写入但检测未通过（见上方 JSON）");
  await browser.close();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("FATAL: " + String(e).slice(0, 300)); process.exit(1); });
