// ============================================================
// 索引 JSON → JSONL 一次性迁移脚本（框架层 · 通用驱动 + 每项目 profile）
//
// 为什么存在：
//   下游项目的索引要从「整文件 JSON」迁到 JSONL（追加 O(1)、体积更小、坏行不致命）。
//   迁移本身是高副作用操作，本脚本把四条纪律固化进代码，避免每次靠人记：
//     ① 独立可跑：既能当 CLI 用（人工预演/执行），也能被启动流程 require 调用
//     ② 默认预演：不加 --apply 只出计划、绝不动盘（先看清单再决定）
//     ③ 幂等：目标 .jsonl 已存在就跳过，绝不覆盖已有新格式
//     ④ 可回滚：旧 .json 移入 <dir>/.trash/<时间戳>-<原名>（同卷 rename，可原样还原）
//   启动侧调用：require("../scripts/migrate-json-index-to-jsonl.cjs").run({...})
//   迁移失败只告警不阻塞启动 —— 索引读层同时兼容新旧两种格式，缺迁移也能跑。
//
// profile（业务语义只在这里；通用读写/校验全在 server/lib/jsonl-store.js）：
//   gbmd  —— json/index/<游戏名>.json = {game, gb:{}, local:{}, name:{}} 三段 map
//   iwara —— json/index/iwara-index.json = {<视频id>: entry} 扁平 map（或 {videos:{...}} 包裹形态）
//            只迁总表：逐条 <id>.json sidecar 与 json/profile/ 一律不动
//
// 用法：
//   node scripts/migrate-json-index-to-jsonl.cjs --dir <json/index> --profile gbmd             # 预演
//   node scripts/migrate-json-index-to-jsonl.cjs --dir <json/index> --profile gbmd --apply     # 执行
//   node scripts/migrate-json-index-to-jsonl.cjs --dir <json/index> --profile iwara --apply --verify full
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");

// 定位通用存储层：组装后脚本在 <项目>/scripts/、库在 <项目>/server/lib/；
// 在模板仓库内直接跑时库还在 templates/js/server/lib/。两条相对路径都试，避免因布局差异跑不起来。
function requireStore() {
  const candidates = [
    path.join(__dirname, "..", "server", "lib", "jsonl-store.js"),
    path.join(__dirname, "..", "js", "server", "lib", "jsonl-store.js")
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return require(p); } catch (_) {}
  }
  throw new Error("找不到 jsonl-store.js（试过：" + candidates.join(" | ") + "）");
}

/**
 * 稳定序列化：对象键排序后递归输出，用于「新旧等价」深度比对。
 * 为什么不用 JSON.stringify 直比：它受键顺序影响，键序不同会被误判成不等价。
 */
function stableJson(v) {
  if (Array.isArray(v)) return "[" + v.map(stableJson).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stableJson(v[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}

// ---------- profile：gbmd ----------
const GBMD_SECTIONS = ["gb", "local", "name"];

/** gbmd：{game, gb, local, name} → 记录（三个段各展开成若干条 {t,k,v}） */
function gbmdSplit(obj) {
  const src = obj && typeof obj === "object" ? obj : {};
  const meta = { schema: 2 };
  const records = [];
  for (const sec of GBMD_SECTIONS) {
    const m = src[sec];
    if (!m || typeof m !== "object") continue;
    for (const k of Object.keys(m)) records.push({ t: sec, k, v: m[k] });
  }
  // 段以外的顶层键（如 game）进 meta，回拼时原样还原
  for (const k of Object.keys(src)) {
    if (GBMD_SECTIONS.indexOf(k) >= 0) continue;
    meta[k] = src[k];
  }
  return { meta, records };
}

/** gbmd：记录 → 原对象（用于 --verify full 的等价性比对） */
function gbmdJoin(meta, records) {
  const out = {};
  for (const k of Object.keys(meta || {})) { if (k !== "schema") out[k] = meta[k]; }
  for (const sec of GBMD_SECTIONS) out[sec] = {};
  for (const r of records || []) { if (out[r.t]) out[r.t][r.k] = r.v; }
  return out;
}

// ---------- profile：iwara ----------
/** iwara：判定旧总表形态 —— 包裹形态 {videos:{...}} 或扁平形态 {id: entry} */
function iwaraShape(obj) {
  const v = obj && obj.videos;
  if (v && typeof v === "object" && !Array.isArray(v)) return "wrapped";
  return "flat";
}

/** iwara：总表 → 记录（一条 = 一个视频） */
function iwaraSplit(obj) {
  const src = obj && typeof obj === "object" ? obj : {};
  const shape = iwaraShape(src);
  const map = shape === "wrapped" ? src.videos : src;
  const meta = { schema: 2, shape };
  if (shape === "wrapped") {
    for (const k of Object.keys(src)) {
      if (k === "videos") continue;
      // 旧总表自己也可能有 schema 字段（实测 {"schema":"iwara-index/1",videos:{…}}）⇒ 撞名会让
      // 「存储层版本号」覆盖掉业务字段、回拼时丢字段。这里改名保存，join 时还原。
      if (k === "schema") { meta.legacySchema = src[k]; continue; }
      meta[k] = src[k];
    }
  }
  const records = [];
  for (const k of Object.keys(map || {})) records.push({ t: "video", k, v: map[k] });
  return { meta, records };
}

/** iwara：记录 → 原总表对象（用于 --verify full） */
function iwaraJoin(meta, records) {
  const map = {};
  for (const r of records || []) { if (r.t === "video") map[r.k] = r.v; }
  if (meta && meta.shape === "wrapped") {
    const out = {};
    for (const k of Object.keys(meta)) {
      if (k === "schema" || k === "shape" || k === "legacySchema") continue;
      out[k] = meta[k];
    }
    if ("legacySchema" in meta) out.schema = meta.legacySchema;   // 还原旧总表自带的 schema 字段
    out.videos = map;
    return out;
  }
  return map;
}

/** 各项目的 profile：match 决定「哪些文件迁」，split/join 决定「怎么拆合」 */
const PROFILES = {
  gbmd: {
    match: (name) => name.endsWith(".json"),   // json/index/<游戏名>.json（.trash 是目录，不会被当文件处理）
    split: gbmdSplit,
    join: gbmdJoin
  },
  iwara: {
    // 只迁总表：逐条 <id>.json sidecar 保持旧格式不动（对外按单文件服务，改了没有收益反而增风险）
    match: (name) => name === "iwara-index.json",
    split: iwaraSplit,
    join: iwaraJoin
  }
};

/**
 * 执行迁移（CLI 与启动流程共用入口）。
 * @param {object} o
 * @param {string} o.dir        索引目录（如 <项目>/json/index）
 * @param {"gbmd"|"iwara"} o.profile
 * @param {boolean} [o.dryRun]  默认 true（只出计划）
 * @param {"count"|"full"} [o.verify] 默认 count（只比记录数）；full 额外做对象等价比对
 * @param {string} [o.trashDir] 回收站目录（默认 <dir>/.trash）
 * @param {function} [o.onFile] 每条目回调（用于边迁边打日志）
 * @returns {{ok:boolean, profile:string, dir:string, dryRun:boolean, verify:string, ...统计}}
 */
function run(o) {
  const opts = o || {};
  const profileName = String(opts.profile || "");
  const profile = PROFILES[profileName];
  const dryRun = opts.dryRun !== false;
  const verifyMode = opts.verify === "full" ? "full" : "count";
  const head = {
    ok: false, profile: profileName, dir: opts.dir || "", dryRun, verify: verifyMode
  };
  if (!profile) return Object.assign(head, { error: "未知 profile：" + profileName + "（可用：gbmd | iwara）" });
  if (!opts.dir) return Object.assign(head, { error: "缺少 --dir" });
  let store;
  try { store = requireStore(); } catch (e) {
    return Object.assign(head, { error: String((e && e.message) || e) });
  }
  let res;
  try {
    res = store.migrateDir({
      dir: opts.dir,
      dryRun,
      trashDir: opts.trashDir || path.join(opts.dir, ".trash"),
      match: profile.match,
      split: profile.split,
      onFile: opts.onFile,
      // 只在 full 模式下给校验回调：大索引做深比对要额外拼一次整树，按需开启
      verify: verifyMode === "full"
        ? (meta, records, original) => stableJson(profile.join(meta, records)) === stableJson(original)
        : null
    });
  } catch (e) {
    return Object.assign(head, { error: String((e && e.message) || e) });
  }
  return Object.assign(head, res, { ok: res.ok !== false && res.failed === 0 });
}

// ---------- CLI ----------
function parseArgs(argv) {
  const a = { apply: false, json: false, verify: "count" };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--dir") a.dir = argv[++i];
    else if (t === "--profile") a.profile = argv[++i];
    else if (t === "--trash") a.trashDir = argv[++i];
    else if (t === "--verify") a.verify = argv[++i];
    else if (t === "--apply") a.apply = true;
    else if (t === "--json") a.json = true;
    else if (t === "--help" || t === "-h") a.help = true;
  }
  return a;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help || !a.dir || !a.profile) {
    console.log([
      "索引 JSON → JSONL 迁移（默认预演，--apply 才写盘）",
      "",
      "用法:",
      "  node scripts/migrate-json-index-to-jsonl.cjs --dir <json/index> --profile gbmd|iwara [--apply] [--verify full] [--json]",
      "",
      "参数:",
      "  --dir <路径>       索引目录（必填）",
      "  --profile <名>     gbmd | iwara（必填）",
      "  --apply            真正写盘（缺省=只预演）",
      "  --verify count|full  转换后自校验级别（缺省 count=只比记录数）",
      "  --trash <路径>     旧文件回收站目录（缺省 <dir>/.trash）",
      "  --json             以 JSON 输出结果"
    ].join("\n"));
    process.exitCode = a.help ? 0 : 1;
    return;
  }
  const r = run({
    dir: a.dir, profile: a.profile, dryRun: !a.apply, verify: a.verify, trashDir: a.trashDir,
    onFile: a.json ? null : (p) => {
      console.log("  " + (p.action === "skip" ? "跳过" : p.action === "plan" ? "计划" : "转换") + "  " + p.file +
        (p.records != null ? "（" + p.records + " 条）" : "") + (p.reason ? "  ← " + p.reason : ""));
    }
  });
  if (a.json) console.log(JSON.stringify(r, null, 2));
  else {
    console.log("");
    console.log("  目录: " + r.dir);
    console.log("  模式: " + (r.dryRun ? "预演（未写盘）" : "执行") + "   自校验: " + r.verify);
    console.log("  扫描 " + (r.scanned || 0) + " 个文件｜转换 " + (r.converted || 0) + "｜跳过 " + (r.skipped || 0) + "｜失败 " + (r.failed || 0));
    if (r.error) console.log("  错误: " + r.error);
    for (const e of r.errors || []) console.log("  ! " + e);
  }
  process.exitCode = r.ok ? 0 : 1;
}

if (require.main === module) main();

module.exports = { run, PROFILES, stableJson, gbmdSplit, gbmdJoin, iwaraSplit, iwaraJoin, iwaraShape };
