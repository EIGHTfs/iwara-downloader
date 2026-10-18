// ============================================================
// index-store.js —— 索引存储层：SQLite 优先，JSONL / JSON 回落（2026-10-18 新增，模板下发件）
//
// 定位：**drop-in 替代 jsonl-store 的两个入口**，签名与返回结构完全一致：
//   readIndex(fileBase)                  → { format, file, meta, records, badLines, json, bytes }
//   writeIndexAtomic(fileBase, meta, records) → { ok, file }
// 调用方（hash-index.js / video-index.js）无需感知底层是库还是文件。
//
// 为什么值得换：索引按「一游戏一文件」存放，增量收尾要把**整个游戏文件**重写一遍
//   （最大单文件 21.7MB / 71,750 条，实测单条增删 ≈391ms，收尾期写盘 121MB/s）。
//   换成库后只 UPSERT 变化的行。
//
// 表结构（每行存该条记录的值 JSON，**保持与 jsonl 逐字段等价**，不做字段拆解）：
//   idx_meta(base TEXT PRIMARY KEY, v TEXT)                              每「基」的元信息
//   idx_rows(base TEXT, sec TEXT, k TEXT, v TEXT, PRIMARY KEY(base,sec,k)) 三段（gb/local/name）记录
//   base = 文件名去后缀（如游戏名），sec = 段名，k = 键
//
// 回落纪律（与 task-sqlite-store 同款）：
//   · node:sqlite 属实验性且需 Node ≥ 22.5 ⇒ **一律延迟 require + 运行期探测**
//   · 探测不到 → 全部走原 JSONL/JSON 路径，功能不降级
//   · 库写失败 → 自动回落写 JSONL，保证不丢数据
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const jsonlStore = require("./jsonl-store");

const DB_NAME = "index.db";

let probeCache = null; // { ok, lib, reason }
let opened = null;     // { db, dbPath, stmt... }

/** 运行期探测内置 node:sqlite（低版本 Node 加载本文件不报错） */
function probe() {
  if (probeCache) return { ok: probeCache.ok, reason: probeCache.reason };
  try {
    const lib = require("node:sqlite");
    probeCache = { ok: true, lib, reason: "" };
  } catch (e) {
    probeCache = {
      ok: false,
      lib: null,
      reason: "内置 node:sqlite 不可用（需 Node >= 22.5）：" + ((e && e.message) || e)
    };
  }
  return { ok: probeCache.ok, reason: probeCache.reason };
}

function isAvailable() {
  return probe().ok;
}

/** 索引目录 → 库文件路径 */
function dbPathOf(indexDir) {
  return path.join(indexDir, DB_NAME);
}

/** 打开（或复用）库连接，建表并准备好语句 */
function openDb(dbPath) {
  if (opened && opened.dbPath === dbPath) return opened;
  if (opened) {
    try { opened.db.close(); } catch (_) {}
    opened = null;
  }
  const { DatabaseSync } = probeCache.lib;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  // WAL + NORMAL：实测把单次事务提交从 47ms 压到 26–30ms（对索引这种高频小写很关键）
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec("CREATE TABLE IF NOT EXISTS idx_meta(base TEXT PRIMARY KEY, v TEXT NOT NULL)");
  db.exec(
    "CREATE TABLE IF NOT EXISTS idx_rows(" +
    "base TEXT NOT NULL, sec TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, " +
    "PRIMARY KEY(base, sec, k))"
  );
  opened = {
    db,
    dbPath,
    getMeta: db.prepare("SELECT v FROM idx_meta WHERE base = ?"),
    setMeta: db.prepare("INSERT INTO idx_meta(base, v) VALUES(?, ?) ON CONFLICT(base) DO UPDATE SET v = excluded.v"),
    rowsOf: db.prepare("SELECT sec, k, v FROM idx_rows WHERE base = ?"),
    bases: db.prepare("SELECT DISTINCT base FROM idx_rows"),
    countOf: db.prepare("SELECT COUNT(*) AS n FROM idx_rows WHERE base = ?"),
    up: db.prepare(
      "INSERT INTO idx_rows(base, sec, k, v) VALUES(?, ?, ?, ?) " +
      "ON CONFLICT(base, sec, k) DO UPDATE SET v = excluded.v"
    ),
    del: db.prepare("DELETE FROM idx_rows WHERE base = ? AND sec = ? AND k = ?"),
    delBase: db.prepare("DELETE FROM idx_rows WHERE base = ?")
  };
  return opened;
}

/** 记录数组 → sec → k → 值 JSON 文本（用文本比较，避免对象引用陷阱） */
function recordsToTree(records) {
  const tree = new Map();
  for (const r of records || []) {
    if (!r || !r.t || r.k === undefined) continue;
    const sec = String(r.t);
    if (!tree.has(sec)) tree.set(sec, new Map());
    tree.get(sec).set(String(r.k), JSON.stringify(r.v === undefined ? null : r.v));
  }
  return tree;
}

/** 库里的行 → sec → k → 值 JSON 文本 */
function dbTreeOf(stmt, stem) {
  const tree = new Map();
  for (const r of stmt.rowsOf.all(stem)) {
    if (!tree.has(r.sec)) tree.set(r.sec, new Map());
    tree.get(r.sec).set(r.k, r.v);
  }
  return tree;
}

/**
 * 读一个「基」（游戏 / 总表）的索引。
 *   库里有这个 base 的行 ⇒ 用库；否则回落 jsonlStore（.jsonl 优先、旧 .json 次之）。
 *   返回结构与 jsonl-store 完全一致，调用方不用分叉。
 */
function readIndex(fileBase) {
  if (probe().ok) {
    try {
      const stem = path.basename(fileBase);
      const s = openDb(dbPathOf(path.dirname(fileBase)));
      const rows = s.rowsOf.all(stem);
      if (rows.length) {
        const mv = s.getMeta.get(stem);
        let meta = {};
        try { meta = mv ? JSON.parse(mv.v) : {}; } catch (_) { meta = {}; }
        return {
          format: "sqlite",
          file: s.dbPath,
          meta,
          records: rows.map((r) => ({ t: r.sec, k: r.k, v: JSON.parse(r.v) })),
          badLines: 0,
          json: null,
          bytes: 0
        };
      }
    } catch (_) { /* 读库失败 ⇒ 回落文件 */ }
  }
  return jsonlStore.readIndex(fileBase);
}

/**
 * 全量写一个「基」：与库里现有行做**行级差异**，只 UPSERT 变化的行、DELETE 消失的行。
 *   库不可用或写失败 ⇒ 回落 jsonlStore.writeIndexAtomic（保证不丢数据）。
 * @returns {{ok:boolean, file?:string, inserted?:number, deleted?:number, fallback?:boolean, error?:string}}
 */
function writeIndexAtomic(fileBase, meta, records) {
  if (!probe().ok) return jsonlStore.writeIndexAtomic(fileBase, meta, records);
  try {
    const stem = path.basename(fileBase);
    const s = openDb(dbPathOf(path.dirname(fileBase)));
    const next = recordsToTree(records);
    const prev = dbTreeOf(s, stem);

    let inserted = 0;
    let deleted = 0;
    s.db.exec("BEGIN IMMEDIATE");
    try {
      for (const [sec, m] of next) {
        const oldSec = prev.get(sec);
        for (const [k, v] of m) {
          if (!oldSec || oldSec.get(k) !== v) {
            s.up.run(stem, sec, k, v);
            inserted++;
          }
        }
      }
      for (const [sec, m] of prev) {
        const newSec = next.get(sec);
        for (const k of m.keys()) {
          if (!newSec || !newSec.has(k)) {
            s.del.run(stem, sec, k);
            deleted++;
          }
        }
      }
      s.setMeta.run(stem, JSON.stringify(meta || {}));
      s.db.exec("COMMIT");
    } catch (e) {
      try { s.db.exec("ROLLBACK"); } catch (_) {}
      throw e;
    }
    return { ok: true, file: s.dbPath, inserted, deleted };
  } catch (e) {
    try {
      return Object.assign({ fallback: true }, jsonlStore.writeIndexAtomic(fileBase, meta, records));
    } catch (_) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }
}

/**
 * 列出索引里所有「基」（不含后缀）。
 *   库里有数据 ⇒ 用库的 base 列表；否则扫目录里的 .jsonl / .json 文件名。
 *   load() 用它决定要加载哪些游戏，避免库存在时还去读文件。
 */
function listBases(indexDir) {
  if (probe().ok && fs.existsSync(dbPathOf(indexDir))) {
    try {
      const s = openDb(dbPathOf(indexDir));
      const rows = s.bases.all();
      if (rows.length) return rows.map((r) => r.base).sort();
    } catch (_) { /* 回落扫目录 */ }
  }
  try {
    return fs.readdirSync(indexDir)
      .filter((f) => f.endsWith(".jsonl") || f.endsWith(".json"))
      .map((f) => f.replace(/\.jsonl?$/, ""))
      .sort();
  } catch (_) {
    return [];
  }
}

/** 删除某个「基」的全部行（重建/清理用） */
function dropBase(fileBase) {
  if (!probe().ok) return false;
  try {
    const stem = path.basename(fileBase);
    const s = openDb(dbPathOf(path.dirname(fileBase)));
    s.delBase.run(stem);
    s.setMeta.run(stem, "{}");
    return true;
  } catch (_) {
    return false;
  }
}

/** 库概况（启动日志 / 校验用）：每个 base 的行数 + 总行数 */
function stats(indexDir) {
  if (!probe().ok) return { available: false, reason: probe().reason, total: 0, bases: {} };
  const dbPath = dbPathOf(indexDir);
  if (!fs.existsSync(dbPath)) return { available: true, exists: false, total: 0, bases: {} };
  try {
    const s = openDb(dbPath);
    const bases = {};
    let total = 0;
    for (const r of s.bases.all()) {
      const n = s.countOf.get(r.base).n;
      bases[r.base] = n;
      total += n;
    }
    return { available: true, exists: true, file: dbPath, total, bases };
  } catch (e) {
    return { available: true, exists: true, error: String((e && e.message) || e), total: 0, bases: {} };
  }
}

/** 关掉当前连接（测试/迁移收尾用，避免文件句柄残留） */
function closeDb() {
  if (!opened) return;
  try { opened.db.close(); } catch (_) {}
  opened = null;
}

module.exports = {
  probe,
  isAvailable,
  dbPathOf,
  readIndex,
  writeIndexAtomic,
  listBases,
  dropBase,
  stats,
  closeDb
};
