// 播放页交互录屏脚本：驱动播放页做一轮交互演示，逐帧截图 + 记录 DOM 状态，
// 供 ffmpeg 合成动图（APNG/GIF）查看实际渲染效果。
// 与 play-test.cjs 分工：play-test 做断言验证（通过/失败），本脚本做可视化演示（每关键状态保帧）。
//
// 覆盖交互：倍速按钮循环 / 长按画面 3x 快进 / 长按期间右键不弹设置面板 /
//           左右拖动进度条 seek / 排序维度互斥切换 / 正倒序方向切换 /
//           文件夹分组折叠展开 / 自动连播切下一个
//
// 运行环境变量（node 需能 require("playwright")）：
//   IWARA_REC_CHROME   无头 chromium 可执行文件路径（必填）
//   IWARA_REC_LIBS     chromium 动态库路径（LD_LIBRARY_PATH；可选，不设则继承外部）
//   IWARA_REC_BASE     被测服务地址，默认 http://127.0.0.1:8643
//   IWARA_REC_ID       起始视频 id，默认 waaa111（测试数据之一；建议 >120s 长视频，
//                      否则视频中途自然播完会提前触发自动连播、打断排序/折叠演示段）
//   IWARA_REC_COOKIE   登录会话 cookie 值（服务已设访问密码时必填；未设密码可留空）
//   IWARA_REC_OUT      帧输出目录，默认 /tmp/play-rec-frames
//
// 合成动图（ffmpeg，帧号从 001 起）：
//   APNG  ffmpeg -framerate 4 -i frame-%03d.png -loop 0 out.apng
//   GIF   ffmpeg -framerate 4 -i frame-%03d.png -vf "scale=1024:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse" out.gif
"use strict";
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const CHROME = process.env.IWARA_REC_CHROME || "";
const LIB = process.env.IWARA_REC_LIBS || "";
const BASE = (process.env.IWARA_REC_BASE || "http://127.0.0.1:8643").replace(/\/$/, "");
const VID = process.env.IWARA_REC_ID || "waaa111";
const COOKIE = process.env.IWARA_REC_COOKIE || "";
const OUT = process.env.IWARA_REC_OUT || "/tmp/play-rec-frames";
const HOST = BASE.replace(/^https?:\/\//, "").replace(/:\d+$/, "");
if (!CHROME) {
  console.error("缺少 IWARA_REC_CHROME（无头 chromium 路径），示例：");
  console.error("  IWARA_REC_CHROME=/path/to/chrome-headless-shell " + __filename);
  process.exit(2);
}
// 输出目录安全守卫：只允许清空目录名含 play-rec-frames 的目录，防止误删任意路径
if (fs.existsSync(OUT)) {
  if (!/play-rec-frames/.test(OUT)) throw new Error("输出目录名不含 play-rec-frames，拒绝删除：" + OUT);
  fs.rmSync(OUT, { recursive: true });
}
fs.mkdirSync(OUT, { recursive: true });

let n = 0;
const stateLog = [];
const grab = async (page) => {
  n += 1;
  // 每帧同时记 DOM 状态：无图床模型只能读日志，用状态序列判断画面是否真的变化
  const s = await page.evaluate(() => {
    const q = (sel) => { const e = document.querySelector(sel); return e ? e.textContent.trim() : null; };
    return {
      speed: q(".art-speed-btn"),
      dir: q("#sortDirBtn"),
      active: document.querySelector('.sort-seg-btn.active') ? document.querySelector('.sort-seg-btn.active').dataset.sort : null,
      rate: window.__art ? window.__art.playbackRate : null,
      cur: window.__art ? +window.__art.currentTime.toFixed(2) : null,
      dur: window.__art ? +window.__art.duration.toFixed(2) : null,
      playing: window.__art ? window.__art.playing : null,
      menu: document.querySelector(".art-video-player") ? document.querySelector(".art-video-player").classList.contains("art-contextmenu-show") : null,
      items: [...document.querySelectorAll(".playlist-item .title")].slice(0, 3).map(e => e.textContent),
      folded: document.querySelector(".playlist-group-header") ? document.querySelector(".playlist-group-header").classList.contains("collapsed") : null,
      path: location.pathname
    };
  });
  stateLog.push({ f: n, ...s });
  await page.screenshot({ path: path.join(OUT, "frame-" + String(n).padStart(3, "0") + ".png") });
};
const holdFrames = async (page, times, gapMs) => {
  for (let i = 0; i < times; i++) { await grab(page); if (i < times - 1) await page.waitForTimeout(gapMs); }
};

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu", "--autoplay-policy=no-user-gesture-required"],
    env: LIB ? { ...process.env, LD_LIBRARY_PATH: LIB } : process.env,
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  if (COOKIE) await ctx.addCookies([{ name: "iwara_session", value: COOKIE, domain: HOST, path: "/" }]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("[pageerror]", e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) console.error("[console]", m.text().slice(0, 120)); });

  await page.goto(BASE + "/" + VID, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForSelector(".art-controls", { timeout: 15000 });
  await page.waitForFunction(() => window.__art && window.__art.playing, null, { timeout: 15000 });
  await page.waitForTimeout(1000);

  // 1) 初始：视频画面 + 控制条 + 倍速按钮 + 播放列表
  await holdFrames(page, 3, 250);

  // 2) 倍速按钮点击循环：1x → 1.25x → 1.5x → 2x → 3x
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => { const b = document.querySelector(".art-speed-btn"); if (b) b.click(); });
    await page.waitForTimeout(250);
    await holdFrames(page, 2, 200);
  }
  // 回 1x
  await page.evaluate(() => { window.__art.playbackRate = 1; });
  await page.waitForTimeout(250);
  await holdFrames(page, 2, 200);

  // 3) 长按画面快进 3x（按住期间截图，显示 3x）
  await page.evaluate(() => { const a = window.__art; if (!a.playing) { a.currentTime = 0; a.play(); } });
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    document.querySelector(".art-video-player").dispatchEvent(new PointerEvent("pointerdown", { pointerType: "mouse", button: 0, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(800);
  await holdFrames(page, 3, 200);
  // 4) 长按期间派发右键 contextmenu：面板不弹
  await page.evaluate(() => {
    document.querySelector(".art-video").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(300);
  await holdFrames(page, 2, 200);
  await page.evaluate(() => {
    document.querySelector(".art-video-player").dispatchEvent(new PointerEvent("pointerup", { pointerType: "mouse", button: 0, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(300);
  await holdFrames(page, 2, 200);

  // 5) 拖动进度条（向右拖 1/3 画面宽度 → 定格在松手处）
  // 时长刻意压在 600ms 内：截图本身耗时长，pointerdown→pointerup 超过 600ms 会被长按计时误判为快进
  await page.evaluate(() => {
    const v = document.querySelector(".art-video");
    const r = document.querySelector(".art-video-player").getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    v.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "mouse", button: 0, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    const v = document.querySelector(".art-video");
    const r = document.querySelector(".art-video-player").getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    v.dispatchEvent(new PointerEvent("pointermove", { pointerType: "mouse", button: 0, clientX: cx + r.width / 3, clientY: cy, bubbles: true, cancelable: true }));
    v.dispatchEvent(new PointerEvent("pointermove", { pointerType: "mouse", button: 0, clientX: cx + r.width / 2.5, clientY: cy, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(150);
  await holdFrames(page, 1);
  await page.evaluate(() => {
    const v = document.querySelector(".art-video");
    const r = document.querySelector(".art-video-player").getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    // 定格位置与最后一次 move 一致（拖动松手定格在松手处）
    v.dispatchEvent(new PointerEvent("pointerup", { pointerType: "mouse", button: 0, clientX: cx + r.width / 2.5, clientY: cy, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(300);
  await holdFrames(page, 2, 200);

  // 6) 排序维度：时间 → 名称
  await page.evaluate(() => document.querySelector('.sort-seg-btn[data-sort="name"]').click());
  await page.waitForTimeout(300);
  await holdFrames(page, 2, 200);
  // 7) 方向：倒序 → 正序
  await page.evaluate(() => document.querySelector("#sortDirBtn").click());
  await page.waitForTimeout(300);
  await holdFrames(page, 2, 200);
  // 8) 分组折叠 → 展开
  await page.evaluate(() => { const h = document.querySelector(".playlist-group-header"); if (h) h.click(); });
  await page.waitForTimeout(300);
  await holdFrames(page, 2, 200);
  await page.evaluate(() => { const h = document.querySelector(".playlist-group-header"); if (h) h.click(); });
  await page.waitForTimeout(250);
  await holdFrames(page, 2, 200);
  // 恢复时间排序
  await page.evaluate(() => { document.querySelector('.sort-seg-btn[data-sort="time"]').click(); });
  await page.waitForTimeout(250);
  await holdFrames(page, 2, 200);

  // 9) 自动连播：跳到接近末尾 → ended → 自动切下一个
  await page.evaluate(() => { const a = window.__art; a.currentTime = a.duration - 2; });
  await page.waitForTimeout(500);
  await holdFrames(page, 2, 200);
  await page.waitForFunction((vid) => location.pathname !== "/" + vid, VID, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(600);
  await holdFrames(page, 3, 200);

  await browser.close();
  fs.writeFileSync(path.join(OUT, "states.json"), JSON.stringify(stateLog, null, 1));
  console.log("帧数:", n, "输出:", OUT);
  console.log("── 每帧状态（f=帧号 speed=倍速按钮文字 rate=实际倍速 dir=方向 sort=排序维度 cur/dur=进度 play=播放中 menu=右键面板开 fold=组折叠 items=列表前3）──");
  for (const s of stateLog) {
    console.log(
      "f" + String(s.f).padStart(2, "0") +
      " | speed=" + String(s.speed).padEnd(4) +
      " rate=" + String(s.rate).padEnd(4) +
      " dir=" + (s.dir || "").padEnd(6) +
      " sort=" + String(s.active).padEnd(4) +
      " cur=" + String(s.cur).padStart(5) + "/" + String(s.dur).padStart(5) +
      " play=" + String(s.playing) +
      " menu=" + String(s.menu) +
      " fold=" + String(s.folded) +
      " | " + (s.items || []).join(" / ")
    );
  }
  process.exit(0);
})().catch(e => { console.error("RECORD FAIL:", e.message); process.exit(1); });
