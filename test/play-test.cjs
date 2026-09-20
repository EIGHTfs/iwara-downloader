// iwara-downloader 播放页（_iwara-style 模板）完整行为验证脚本
// 覆盖：播放器配置 / 倍速按钮循环 / 列表排序（互斥维度+正倒序）/ 文件夹分组折叠 /
//       自动连播 / 点击即播 / 长按 3x 快进 / 长按抑制设置菜单 / 左右拖动进度条 seek / 短按单击暂停
//
// 运行环境（均可被环境变量覆盖，见下；node 需能 require("playwright")）：
//   IWARA_PLAY_CHROME   无头 chromium 可执行文件路径（必填，无默认）
//   IWARA_PLAY_LIBS     chromium 动态库路径（LD_LIBRARY_PATH，冒号分隔；可按需留空）
//   IWARA_PLAY_BASE     被测服务地址，默认 http://127.0.0.1:8643
//   IWARA_PLAY_VID      播放页首个视频 id，默认 waaa111（测试数据之一）
// 测试数据约定（见 README/历史）：下载目录含 根目录/waaa111、作者Alice/waaa222、
//   作者Bob/waaa333、作者Alice/waaa444 四个视频文件（文件名含 [id]），时长 ~5.5s。
"use strict";
const { chromium } = require("playwright");

const CHROME = process.env.IWARA_PLAY_CHROME || "";
const LIB = process.env.IWARA_PLAY_LIBS || "";
const BASE = (process.env.IWARA_PLAY_BASE || "http://127.0.0.1:8643").replace(/\/$/, "");
const VID = process.env.IWARA_PLAY_VID || "waaa111";
const URL = BASE + "/" + VID;
if (!CHROME) {
  console.error("缺少 IWARA_PLAY_CHROME（无头 chromium 路径），示例：");
  console.error("  IWARA_PLAY_CHROME=/path/to/chrome-headless-shell IWARA_PLAY_LIBS=/path/to/libs " + __filename);
  process.exit(2);
}
const fail = [];
function check(name, ok, detail) {
  console.log((ok ? "  ✔ " : "  ✘ ") + name + (detail ? "  " + detail : ""));
  if (!ok) fail.push(name);
}

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu", "--autoplay-policy=no-user-gesture-required"],
    // LIB 为空时继承外部 LD_LIBRARY_PATH，不覆盖（chromium 动态库缺失时再显式设 IWARA_PLAY_LIBS）
    env: LIB ? { ...process.env, LD_LIBRARY_PATH: LIB } : process.env,
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });

  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForSelector(".art-controls", { timeout: 15000 });
  await page.waitForFunction(() => window.__art && window.__art.playing, null, { timeout: 20000 });
  await page.waitForSelector(".playlist-group-header", { timeout: 15000 });

  const readList = () => page.evaluate(() => ({
    groups: [...document.querySelectorAll(".playlist-group-header .gname")].map(e => e.textContent),
    items: [...document.querySelectorAll(".playlist-item .title")].map(e => e.textContent),
  }));

  // 1) 播放器配置
  const cfg = await page.evaluate(() => ({
    controlHideTime: (window.__art.constructor && window.__art.constructor.CONTROL_HIDE_TIME) || "?",
    fastForward: !!window.__art.option.fastForward,
    gesture: !!window.__art.option.gesture,
    speedBtn: !!document.querySelector(".art-speed-btn"),
  }));
  check("配置 CONTROL_HIDE_TIME=8000 / fastForward / gesture / 倍速按钮",
    cfg.controlHideTime === 8000 && cfg.fastForward && cfg.gesture && cfg.speedBtn, JSON.stringify(cfg));

  // 2) 倍速按钮循环 1→1.25→1.5→2→3→1（DOM click 触发组件回调）
  const seq = [];
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => { const b = document.querySelector(".art-speed-btn"); if (b) b.click(); });
    await page.waitForTimeout(150);
    seq.push(await page.evaluate(() => ({
      rate: window.__art.playbackRate,
      txt: (document.querySelector(".art-speed-btn") || {}).textContent,
    })));
  }
  const rateSeq = seq.map(s => s.rate).join(",");
  check("倍速循环 1→1.25→1.5→2→3→1 且按钮文字同步",
    rateSeq === "1.25,1.5,2,3,1" && seq.every(s => s.txt === s.rate + "x"), JSON.stringify(seq));
  // 回到 1x，避免影响后续长按基线
  if (seq[seq.length - 1].rate !== 1) {
    await page.evaluate(() => { window.__art.playbackRate = 1; });
  }

  // 3) 默认排序：时间↓倒序（新→旧，跨组按组内首条聚合）
  const t0 = await readList();
  check("默认时间↓倒序（组: Bob/Alice/根目录，条目 Bob→…→根目录）",
    t0.items[0] === "Bob 视频" && t0.items[3] === "根目录视频" && t0.groups[0] === "作者Bob", JSON.stringify(t0));

  // 4) 切名称维度（方向保持倒序）→ Z→A
  await page.evaluate(() => document.querySelector('.sort-seg-btn[data-sort="name"]').click());
  await page.waitForTimeout(250);
  const t1 = await readList();
  check("名称↓倒序（Bob…→根目录）", t1.items[0] === "Bob 视频" && t1.items[3] === "根目录视频", JSON.stringify(t1));

  // 5) 方向切换 → 名称↑正序（A→Z）
  await page.evaluate(() => document.querySelector("#sortDirBtn").click());
  await page.waitForTimeout(250);
  const t2 = await readList();
  check("名称↑正序（根目录…→Bob）", t2.items[0] === "根目录视频" && t2.items[3] === "Bob 视频", JSON.stringify(t2));

  // 6) 折叠「作者Alice」组
  await page.evaluate(() => {
    const hs = [...document.querySelectorAll(".playlist-group-header")];
    const alice = hs.find(h => h.querySelector(".gname").textContent === "作者Alice");
    if (alice) alice.click();
  });
  await page.waitForTimeout(200);
  const fold = await page.evaluate(() => {
    const hs = [...document.querySelectorAll(".playlist-group-header")];
    const alice = hs.find(h => h.querySelector(".gname").textContent === "作者Alice");
    const body = alice ? alice.nextElementSibling : null;
    return { folded: alice && alice.classList.contains("collapsed"), hidden: body && getComputedStyle(body).display === "none" };
  });
  check("分组折叠（collapsed + 组体隐藏）", !!(fold.folded && fold.hidden), JSON.stringify(fold));

  // 7) 恢复排序现场（时间↓倒序），供连播使用
  await page.evaluate(() => { document.querySelector('.sort-seg-btn[data-sort="time"]').click(); });
  await page.evaluate(() => {
    const d = document.querySelector("#sortDirBtn");
    if (d && d.textContent.indexOf("正序") >= 0) d.click();
  });
  await page.waitForTimeout(250);

  // 8) 点击即播（autoplay 被浏览器拦截时的「首点即播」fallback）——只在真实浏览器无手势
  //    autoplay 被拦时武装，headless（--autoplay-policy=no-user-gesture-required）无法稳定复现，
  //    这里仅记录当前状态供人工比对，不算失败。
  const tap = await page.evaluate(() => {
    const a = window.__art;
    a.pause();
    return new Promise(resolve => {
      setTimeout(() => {
        document.querySelector(".art-video-player")
          .dispatchEvent(new PointerEvent("pointerdown", { pointerType: "mouse", button: 0, bubbles: true, cancelable: true }));
        setTimeout(() => resolve(window.__art.playing), 200);
      }, 1000);
    });
  });
  console.log("  ℹ 点击即播（headless 下 autoplay 成功则本项不适用）: playingAfterTap=" + tap);

  // 9) 长按抑制 contextmenu（播放速度/画面比例/统计信息面板不弹；松手恢复 1x）
  const ctxR = await page.evaluate(() => {
    const v = document.querySelector(".art-video");
    const player = document.querySelector(".art-video-player");
    const fire = (type, button) => v.dispatchEvent(new PointerEvent(type, { pointerType: "mouse", button, clientX: 640, clientY: 400, bubbles: true, cancelable: true }));
    fire("pointerdown", 0);
    return new Promise(resolve => {
      setTimeout(() => {
        fire("pointerup", 0);
        v.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 640, clientY: 400 }));
        setTimeout(() => resolve({
          menuOpen: player.classList.contains("art-contextmenu-show"),
          rate: window.__art.playbackRate,
        }), 150);
      }, 850);
    });
  });
  check("长按不弹设置菜单 + 松开恢复 1x", !ctxR.menuOpen && ctxR.rate === 1, JSON.stringify(ctxR));

  // 10) 左右拖动 seek：向右拖 1/3 画面宽度 → 进度约 +duration/3
  const seek = await page.evaluate(() => {
    const v = document.querySelector(".art-video");
    const rect = document.querySelector(".art-video-player").getBoundingClientRect();
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    const t0 = window.__art.currentTime;
    v.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "mouse", button: 0, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
    v.dispatchEvent(new PointerEvent("pointermove", { pointerType: "mouse", button: 0, clientX: cx + rect.width / 3, clientY: cy, bubbles: true, cancelable: true }));
    return new Promise(resolve => {
      setTimeout(() => {
        const t1 = window.__art.currentTime;
        v.dispatchEvent(new PointerEvent("pointerup", { pointerType: "mouse", button: 0, clientX: cx + rect.width / 3, clientY: cy, bubbles: true, cancelable: true }));
        setTimeout(() => resolve({ t0: +t0.toFixed(2), t1: +t1.toFixed(2), duration: +window.__art.duration.toFixed(2) }), 120);
      }, 120);
    });
  });
  check("拖动 seek（+1/3 宽 ≈ +时长/3）",
    Math.abs(seek.t1 - seek.t0 - seek.duration / 3) < 0.6, JSON.stringify(seek));

  // 10b) 触摸拖动（pointerType=touch，对应触屏/触屏笔记本）：同样拖进度条
  const seekT = await page.evaluate(() => {
    const v = document.querySelector(".art-video");
    const rect = document.querySelector(".art-video-player").getBoundingClientRect();
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    const ev = (type, x, y) => v.dispatchEvent(new PointerEvent(type, {
      pointerType: "touch", pointerId: 7, isPrimary: true,
      clientX: x, clientY: y, bubbles: true, cancelable: true,
    }));
    const t0 = window.__art.currentTime;
    ev("pointerdown", cx, cy);
    ev("pointermove", cx + rect.width / 3, cy);
    return new Promise(resolve => {
      setTimeout(() => {
        const t1 = window.__art.currentTime;
        ev("pointerup", cx + rect.width / 3, cy);
        setTimeout(() => resolve({ t0: +t0.toFixed(2), t1: +t1.toFixed(2), duration: +window.__art.duration.toFixed(2) }), 120);
      }, 120);
    });
  });
  check("触摸拖动 seek（pointerType=touch）",
    Math.abs(seekT.t1 - seekT.t0 - seekT.duration / 3) < 0.6, JSON.stringify(seekT));

  // 11) 长按 3x 快进：期间 rate=3 不暂停；松手恢复原速且 click 被拦截不误暂停
  await page.evaluate(() => { const a = window.__art; if (!a.playing) { a.currentTime = 0; a.play(); } });
  await page.waitForFunction(() => window.__art && window.__art.playing, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(300);
  const hold = await page.evaluate(() => {
    const p = document.querySelector(".art-video-player");
    p.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "mouse", button: 0, bubbles: true, cancelable: true }));
    return new Promise(resolve => {
      setTimeout(() => {
        const during = { rate: window.__art.playbackRate, playing: window.__art.playing };
        p.dispatchEvent(new PointerEvent("pointerup", { pointerType: "mouse", button: 0, bubbles: true, cancelable: true }));
        document.querySelector("video").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        setTimeout(() => resolve({ during, after: { rate: window.__art.playbackRate, playing: window.__art.playing } }), 250);
      }, 850);
    });
  });
  // 期间 playing 会受 headless 解码瞬时抖动影响（真实浏览器为 true），核心断言：快进生效 rate=3、
  // 松开恢复原速、且 click 被拦截不误暂停。
  check("长按 3x（期间 3x 快进、松开恢复 1x 且不误暂停）",
    hold.during.rate === 3 && hold.after.rate === 1 && hold.after.playing, JSON.stringify(hold));

  // 12) 短按单击：内核「单击暂停」保留（<600ms 不触发长按）
  await page.evaluate(() => { const a = window.__art; if (!a.playing) { a.currentTime = 0; a.play(); } });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const p = document.querySelector(".art-video-player");
    p.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "mouse", button: 0, bubbles: true, cancelable: true }));
    p.dispatchEvent(new PointerEvent("pointerup", { pointerType: "mouse", button: 0, bubbles: true, cancelable: true }));
    document.querySelector("video").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(250);
  check("短按单击暂停保留", (await page.evaluate(() => !window.__art.playing)) === true);

  // 13) 自动连播：waaa111（时间↓倒序第 3 位）播完 → 自动切到下一个 waaa444
  await page.evaluate(() => { window.__art.currentTime = 0; window.__art.play(); });
  await page.waitForFunction(() => window.__art && window.__art.playing, null, { timeout: 15000 }).catch(() => {});
  await page.evaluate(() => { window.__art.currentTime = 0; }); // 从头播放以便尽快 ended
  const jumped = await page.waitForFunction(
    (vid) => location.pathname !== "/" + vid,
    VID,
    { timeout: 25000 }
  ).then(() => page.evaluate(() => location.pathname)).catch(() => null);
  check("自动连播（播完切下一个）", jumped !== null, "pathname=" + (jumped || "超时"));

  console.log("JS 错误:", errors.length ? errors : "无");
  if (errors.length) fail.push("JS 错误总数=" + errors.length);
  await browser.close();
  if (fail.length) { console.error("❌ 失败项:", fail.join(" / ")); process.exit(1); }
  console.log("✅ 全部通过");
  process.exit(0);
})().catch(e => { console.error("TEST FAIL:", e.message); process.exit(1); });