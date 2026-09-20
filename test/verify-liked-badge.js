// iwara-downloader 前端 liked badge 渲染验证（jsdom 执行真实 app.js）
// 用法: NODE_PATH=<jsdom所在node_modules> node verify-liked-badge.js <app.js 路径 | 默认 ../server/public/app.js>
// 依赖: jsdom（仅在验证环境 .pwviewer/node_modules，项目零依赖不入库）
// 覆盖: 装配后 index.html → 真实 app.js → /api/liked-state 真实链路 → resultItemHtml 四态 badge
// 原理: stub fetch 的 /api/liked-state 返回测试数据，走 init→ensureLikedMeta→refreshLikedMeta
//       真实赋值链路，再验证 video 行「❤️ 已赞」/ user 行「已关注」渲染（官方接口 liked 恒 false，
//       靠本地 liked_state 兜底——本脚本即验证该兜底）。
const fs = require("fs");
const { JSDOM } = require("jsdom");
const BASE = "http://127.0.0.1:8643";

async function main() {
  const r = await fetch(BASE + "/");
  const html = await r.text();
  console.log("index.html 装配后字节:", html.length);

  const dom = new JSDOM(html, { url: BASE + "/", runScripts: "dangerously", pretendToBeVisual: true });
  const win = dom.window;
  win.fetch = (url, opts) => {
    if (String(url).includes("/api/liked-state")) {
      return Promise.resolve({ ok: true, status: 200, json: () => ({ ok: true, liked: ["TESTLIKE01"], followed: [{ userId: "TESTAUTHOR1" }] }) });
    }
    return fetch(BASE + url, Object.assign({}, opts)).then((res) => ({ ok: res.ok, status: res.status, json: () => res.json() }));
  };

  const appjs = fs.readFileSync(process.argv[2] || "../server/public/app.js", "utf8");
  win.eval(appjs + "\n;window.__E = { renderOne: resultItemHtml, meta: () => ({ liked: Array.from(likedMeta.liked), followed: Array.from(likedMeta.followed) }) };");
  await new Promise((res) => setTimeout(res, 1500)); // 等 init() 的 ensureLikedMeta 完成

  const E = win.__E;
  const meta = E.meta();
  console.log("likedMeta 实际:", JSON.stringify(meta));
  const of = (ok, label) => { console.log((ok ? "✓ " : "✗ ") + label); return ok; };
  const checks = [
    of(meta.liked.includes("TESTLIKE01"), "likedMeta 已拉取 TESTLIKE01"),
    // 已赞视频 → 显示 badge
    of(E.renderOne({ _kind: "video", id: "TESTLIKE01", title: "已赞视频", createdAt: "", user: { id: "X", name: "x" }, rating: "normal" }).includes("❤️ 已赞"), "已赞视频显示 ❤️ 已赞"),
    // 未赞视频 → 不显示
    of(!E.renderOne({ _kind: "video", id: "TESTNOTLIKE", title: "未赞视频", createdAt: "", user: { id: "Y", name: "y" }, rating: "normal" }).includes("❤️ 已赞"), "未赞视频不误显示"),
    // 已关注作者 → 显示
    of(E.renderOne({ _kind: "user", id: "TESTAUTHOR1", username: "TESTAUTHOR1", name: "赏花人" }).includes("已关注"), "已关注作者显示已关注"),
    // 未关注作者 → 不显示
    of(!E.renderOne({ _kind: "user", id: "OTHER", username: "OTHER", name: "路人" }).includes("已关注"), "未关注作者不误显示")
  ];
  const fail = checks.some((c) => !c);
  console.log(fail ? "✗ liked badge 验证失败" : "✓ liked badge 验证全部通过");
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error("验证脚本异常:", e.message); process.exit(2); });