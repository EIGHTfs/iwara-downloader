// ============================================================
// JSONL 索引存储（框架层 · 通用，单一实现）
//
// 复用方（各下游项目的索引层，业务语义留在项目侧）：
//   1. gamebanana-mods-downloader —— server/lib/hash-index.js（每游戏一文件的 gb/local/name 三段 map）
//   2. iwara-downloader          —— server/lib/video-index.js（总表 iwara-index.json 的扁平 map）
//
// 为什么存在（实测驱动，2026-10-15）：
//   索引此前是「整文件 JSON，缩进 2 空格」。游戏索引单文件可达 26.6MB / 71,749 条，
//   而每新增一个 mod 都要 JSON.stringify(整棵树, null, 2) 再全量写回 —— 实测 stringify 171.6ms，
//   加写盘每次落盘约 220–320ms；这是随「条目数」线性增长、且每次 ingest 都付一遍的代价。
//   JSONL 把「追加一条」变成常数级（追加一行），体积也顺带降约 13%（去掉缩进）。
//
// 格式约定（与业务无关的两段式）：
//   首行   {"_":"meta", ...项目自定义元信息}             ← 恰好一行，可选
//   数据行 {"t":"<段名>","k":"<键>","v":<值>}            ← 每行一条记录
//   · 同一「段+键」多次出现 ⇒ 后写覆盖先写（last-wins），语义等价于「整文件重写」
//   · 容忍坏行：解析时跳过并计数（badLines），不因一行损坏丢掉整个索引
//   · 段名（t）由项目定义：gbmd 用 gb/local/name，iwara 用 video
//
// 设计取舍：
//   · 只做「通用读写 + 迁移驱动」，不碰业务拆/合（由调用方传 split/join 回调）
//   · 所有函数接受「文件基路径」（不含后缀），内部自动在 .jsonl / .json 之间选择：
//       读 —— .jsonl 优先，缺则回落 .json；写 —— 只写 .jsonl
//   · 不依赖任何 npm 包（项目零依赖约束），只用 node 内置 fs/path
//
// 用法：
//   const store = require("./jsonl-store");
//   const r = store.readIndex("/x/json/index/Foo");        // 双读
//   if (r.format === "jsonl") { const m = store.mapOf(r.records, "gb"); }
//   else { /* r.json 是旧 JSON 对象，按项目旧逻辑解析 */ }
//   store.appendRecords("/x/json/index/Foo", [{ t: "gb", k: "…", v: {…} }]);
//   store.writeIndexAtomic("/x/json/index/Foo", { game: "Foo" }, records);   // 全量重写/压缩
//   store.migrateDir({ dir, match, split, dryRun: true });                    // 一次性迁移
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");

const META_FIELD = "_";
const META_VALUE = "meta";
const JSONL_EXT = ".jsonl";
const JSON_EXT = ".json";

/** 由「文件基路径」推导两种候选路径（基路径不含扩展名） */
function indexPaths(fileBase) {
  const base = String(fileBase || "");
  // 允许调用方误传带扩展名的路径：统一去掉，避免出现 Foo.json.jsonl
  const stripped = base.endsWith(JSONL_EXT) ? base.slice(0, -JSONL_EXT.length)
    : base.endsWith(JSON_EXT) ? base.slice(0, -JSON_EXT.length)
    : base;
  return { base: stripped, jsonl: stripped + JSONL_EXT, json: stripped + JSON_EXT };
}

/**
 * 解析 JSONL 文本 → { meta, records, badLines }
 *   · meta 是首行 {"_":"meta",...} 去掉标识字段后的对象（无则 {}）
 *   · records 是 [{t,k,v}]，保持文件出现顺序（last-wins 交给 mapOf 处理）
 *   · 坏行（JSON 语法错 / 既不是 meta 也不是 {t,k,v}）计入 badLines 并跳过
 */
function parseJsonl(text) {
  const out = { meta: {}, records: [], badLines: 0 };
  if (!text) return out;
  // 去掉 BOM；CRLF 统一成 LF，避免 \r 混进字段值
  const body = String(text).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (_) { out.badLines++; continue; }
    if (!obj || typeof obj !== "object") { out.badLines++; continue; }
    if (obj[META_FIELD] === META_VALUE) {
      const meta = Object.assign({}, obj);
      delete meta[META_FIELD];
      out.meta = meta;
      continue;
    }
    if (typeof obj.t === "string" && typeof obj.k === "string" && "v" in obj) {
      out.records.push({ t: obj.t, k: obj.k, v: obj.v });
      continue;
    }
    out.badLines++;
  }
  return out;
}

/** 把 meta + records 序列化成 JSONL 文本（meta 为空则不写首行；每条一行、以 \n 结尾） */
function stringifyJsonl(meta, records) {
  const lines = [];
  if (meta && typeof meta === "object" && Object.keys(meta).length) {
    lines.push(JSON.stringify(Object.assign({ [META_FIELD]: META_VALUE }, meta)));
  }
  for (const r of records || []) {
    if (!r || typeof r.t !== "string" || typeof r.k !== "string") continue;
    lines.push(JSON.stringify({ t: r.t, k: r.k, v: r.v }));
  }
  return lines.length ? lines.join("\n") + "\n" : "";
}

/**
 * 双读：.jsonl 优先，缺则回落 .json。
 * @returns {{format:"jsonl"|"json"|"none", file:string, meta:object, records:Array, badLines:number, json:object|null, bytes:number}}
 *   format=jsonl ⇒ 用 meta/records（配 mapOf 取段）
 *   format=json  ⇒ json 是解析后的旧对象，交给调用方按旧逻辑处理
 */
function readIndex(fileBase) {
  const p = indexPaths(fileBase);
  const none = { format: "none", file: "", meta: {}, records: [], badLines: 0, json: null, bytes: 0 };
  try {
    const stat = fs.statSync(p.jsonl);
    const text = fs.readFileSync(p.jsonl, "utf8");
    const parsed = parseJsonl(text);
    return {
      format: "jsonl", file: p.jsonl, meta: parsed.meta, records: parsed.records,
      badLines: parsed.badLines, json: null, bytes: stat.size
    };
  } catch (_) { /* 没有 .jsonl，继续看 .json */ }
  try {
    const stat = fs.statSync(p.json);
    const text = fs.readFileSync(p.json, "utf8");
    return {
      format: "json", file: p.json, meta: {}, records: [], badLines: 0,
      json: JSON.parse(text), bytes: stat.size
    };
  } catch (_) { return none; }
}

/**
 * 记录数组 → Map（last-wins：同键后出现的覆盖先出现的）
 * 与「整文件重写」语义一致，是双读过渡期的等价性关键。
 */
function mapOf(records, section) {
  const map = new Map();
  for (const r of records || []) {
    if (!r || r.t !== section) continue;
    map.set(r.k, r.v);
  }
  return map;
}

/** 文件是否以 \n 结尾（追加前要保证，否则两条记录会挤在同一行） */
function endsWithNewline(file) {
  try {
    const size = fs.statSync(file).size;
    if (size === 0) return true;
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(1);
      fs.readSync(fd, buf, 0, 1, size - 1);
      return buf[0] === 10;
    } finally { fs.closeSync(fd); }
  } catch (_) { return true; }
}

/**
 * 追加记录（O(1) 行追加，不解析、不重写已有内容）—— 这是本模块存在的核心理由。
 *   · 目标文件不存在时，先补写 meta 行（若给了 meta）
 *   · 已有内容不以 \n 结尾时先补一个 \n，防止记录粘行
 * @param {string} fileBase 文件基路径
 * @param {Array} records [{t,k,v}] 或单条 {t,k,v}
 * @param {object} [meta] 仅新建文件时写入
 * @returns {{ok:boolean, appended:number, created:boolean, file:string, error?:string}}
 */
function appendRecords(fileBase, records, meta) {
  const p = indexPaths(fileBase);
  const list = Array.isArray(records) ? records : (records ? [records] : []);
  try {
    fs.mkdirSync(path.dirname(p.jsonl), { recursive: true });
    const existed = fs.existsSync(p.jsonl);
    const chunks = [];
    if (!existed && meta && Object.keys(meta).length) {
      chunks.push(JSON.stringify(Object.assign({ [META_FIELD]: META_VALUE }, meta)) + "\n");
    }
    for (const r of list) {
      if (!r || typeof r.t !== "string" || typeof r.k !== "string") continue;
      chunks.push(JSON.stringify({ t: r.t, k: r.k, v: r.v }) + "\n");
    }
    if (!chunks.length) return { ok: true, appended: 0, created: !existed, file: p.jsonl };
    let body = chunks.join("");
    // 已有文件末尾缺换行 ⇒ 前面补一个，保证新记录独占一行
    if (existed && !endsWithNewline(p.jsonl)) body = "\n" + body;
    fs.appendFileSync(p.jsonl, body);
    return { ok: true, appended: list.length, created: !existed, file: p.jsonl };
  } catch (e) {
    return { ok: false, appended: 0, created: false, file: p.jsonl, error: String((e && e.message) || e) };
  }
}

/**
 * 全量原子重写 .jsonl（tmp + rename）—— 用于两种场合：
 *   1. 压缩：追加久了会有同键重复行，用调用方手上的 Map 生成去重后的 records 覆盖写
 *   2. 迁移/重建：把一份完整数据一次性落成 jsonl
 * 先写临时文件再 rename ⇒ 进程中断不会留下半截索引（读者要么看到旧的、要么看到新的）。
 */
function writeIndexAtomic(fileBase, meta, records) {
  const p = indexPaths(fileBase);
  const tmp = p.jsonl + ".tmp";
  try {
    fs.mkdirSync(path.dirname(p.jsonl), { recursive: true });
    fs.writeFileSync(tmp, stringifyJsonl(meta, records), "utf8");
    fs.renameSync(tmp, p.jsonl);
    return { ok: true, file: p.jsonl, bytes: fs.statSync(p.jsonl).size };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    return { ok: false, file: p.jsonl, error: String((e && e.message) || e) };
  }
}

/** 把文件移进回收站（同卷 rename，秒级、可恢复；不直接删） */
function moveToTrash(file, trashDir) {
  try {
    fs.mkdirSync(trashDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = path.join(trashDir, stamp + "-" + path.basename(file));
    fs.renameSync(file, dest);
    return { ok: true, dest };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * 一次性迁移驱动：把目录里的旧 JSON 索引逐个转成 JSONL。
 *   业务语义由调用方通过两个回调提供：
 *     match(fileName)  → 该文件是否要迁移
 *     split(obj)       → { meta, records }：旧 JSON 对象怎么拆成记录
 *     verify(meta, records, obj) → 可选，回拼比对是否等价（推荐传，转换后立即自校验）
 * 纪律（与项目既有约定一致）：
 *   · dryRun 默认 true，只出计划不动盘
 *   · 幂等：目标 .jsonl 已存在则跳过，绝不覆盖
 *   · 转换后立刻回读校验（记录数一致；给了 join 则逐键 deepEqual），校验不过不删旧文件
 *   · 旧文件移入 trashDir（可恢复），而不是删除
 * @returns {{ok:boolean, scanned:number, converted:number, skipped:number, failed:number, badLines:number, plan:Array, errors:Array}}
 */
function migrateDir(opts) {
  const o = opts || {};
  const dir = o.dir;
  const dryRun = o.dryRun !== false;            // 默认预演
  const trashDir = o.trashDir || path.join(dir, ".trash");
  const match = typeof o.match === "function" ? o.match : ((n) => n.endsWith(JSON_EXT));
  const split = o.split;
  // 自校验回调：verify(meta, records, 原始对象) → 是否等价。
  //   默认只比「记录数一致」（轻量，适合大文件）；传了它就做深度等价比对（推荐小文件/关键索引用）。
  const verify = typeof o.verify === "function" ? o.verify : null;
  const onFile = typeof o.onFile === "function" ? o.onFile : null;
  const out = { ok: true, scanned: 0, converted: 0, skipped: 0, failed: 0, badLines: 0, plan: [], errors: [] };

  if (!dir) { out.ok = false; out.errors.push("缺少 dir"); return out; }
  if (typeof split !== "function") { out.ok = false; out.errors.push("缺少 split 回调"); return out; }

  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) {
    out.ok = false; out.errors.push("读目录失败: " + String((e && e.message) || e)); return out;
  }

  for (const name of names) {
    if (!match(name)) continue;
    out.scanned++;
    const src = path.join(dir, name);
    const target = path.join(dir, name.slice(0, -JSON_EXT.length) + JSONL_EXT);
    try { if (!fs.statSync(src).isFile()) continue; } catch (_) { continue; }

    if (fs.existsSync(target)) {           // 幂等：已有 jsonl 就不动
      out.skipped++;
      out.plan.push({ file: name, action: "skip", reason: "目标 .jsonl 已存在" });
      continue;
    }

    let obj, parts;
    try {
      obj = JSON.parse(fs.readFileSync(src, "utf8"));
      parts = split(obj, name) || {};
    } catch (e) {
      out.failed++;
      out.errors.push(name + ": 解析/拆分失败 " + String((e && e.message) || e));
      continue;
    }
    const records = Array.isArray(parts.records) ? parts.records : [];
    out.plan.push({ file: name, action: dryRun ? "plan" : "convert", records: records.length });
    if (dryRun) { if (onFile) onFile(out.plan[out.plan.length - 1]); continue; }

    // ① 写 jsonl
    const w = writeIndexAtomic(target, parts.meta || {}, records);
    if (!w.ok) {
      out.failed++; out.errors.push(name + ": 写 jsonl 失败 " + w.error); continue;
    }
    // ② 回读校验：记录数必须一致；给了 join 就再比对象
    const back = readIndex(target);
    const sameCount = back.records.length === records.length;
    let sameObj = true;
    if (verify && sameCount) {
      try { sameObj = verify(back.meta, back.records, obj) === true; } catch (_) { sameObj = false; }
    }
    out.badLines += back.badLines;
    if (!sameCount || !sameObj) {
      out.failed++;
      out.errors.push(name + ": 转换校验不通过（记录数一致=" + sameCount + " 对象一致=" + sameObj + "），旧文件保留");
      continue;
    }
    // ③ 旧文件进回收站（可恢复）
    const mv = moveToTrash(src, trashDir);
    if (!mv.ok) {
      out.failed++; out.errors.push(name + ": 写成功但旧文件入回收站失败 " + mv.error); continue;
    }
    out.converted++;
    if (onFile) onFile(out.plan[out.plan.length - 1]);
  }
  return out;
}

/**
 * 把「可能是 JSON，也可能是 JSONL」的文本解析出来（导入接口用）。
 *   先按整体 JSON 解析（兼容旧的导出文件）；失败再按 JSONL 逐行解析（跳过空行、坏行、meta 行）。
 *   用途：索引导出成 JSONL 之后，导入端必须能原样吃回去 —— 产出与消费同一格式。
 * @returns {any|null} 解析结果；整体 JSON 原样返回；JSONL 返回「数据行数组」；都不成立返回 null
 */
function parseAnyJson(text) {
  const s = String(text == null ? "" : text).trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch (_) { /* 不是整体 JSON，继续按 JSONL 试 */ }
  const out = [];
  for (const raw of s.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (_) { continue; }   // 坏行跳过，不因一行废掉整份导入
    if (obj && typeof obj === "object" && obj[META_FIELD] === META_VALUE) continue;  // meta 行不是数据
    out.push(obj);
  }
  return out.length ? out : null;
}

/**
 * 从「JSON 或 JSONL 的解析结果」里取出记录数组 —— 导入端与导出端同口径的取数助手。
 *   · 本身就是数组 → 原样返回
 *   · {results:[…]} / {records:[…]} / {items:[…]} → 取该字段
 *   · 其它 → null（调用方据此报「找不到记录数组」）
 * 为什么需要它：导出统一成 JSONL（一行一条 + 一行 meta）之后，导入端必须能吃回
 * 自己导出的文件；旧 JSON 文件（数组或包裹对象）也要继续能导入。
 * @param {any} v parseAnyJson / JSON.parse 的结果
 * @param {string[]} [keys] 自定义包裹字段名（默认 results/records/items）
 * @returns {Array|null}
 */
function pickRecordArray(v, keys) {
  if (Array.isArray(v)) return v;
  if (!v || typeof v !== "object") return null;
  const ks = (Array.isArray(keys) && keys.length) ? keys : ["results", "records", "items"];
  for (const k of ks) if (Array.isArray(v[k])) return v[k];
  return null;
}

module.exports = {
  indexPaths,
  parseJsonl,
  stringifyJsonl,
  parseAnyJson,
  pickRecordArray,
  readIndex,
  mapOf,
  appendRecords,
  writeIndexAtomic,
  moveToTrash,
  migrateDir
};
