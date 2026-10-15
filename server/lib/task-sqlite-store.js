// ============================================================
// 下载任务列表的 SQLite 存储后端（Node 内置 node:sqlite，零依赖）
//
// 对外接口与通用写入器 server/store/state-store.js 的 createThrottledWriter 完全一致：
//   save() / flush() / cancel() / stats / _hasPending()
// 因此调用方（server/lib/download-task-store.js）可以在「探测可用性」之后直接二选一，
// 上层 downloader.js 的 saveTask()/flushTask() 一行都不用改。
//
// 为什么加这个后端（2026-10-15 实测）：
//   · 部署端 json/download_task.json 峰值 3.6 万项 / 34.3MB（见 routes/download.js 注释），
//     任一条状态变化都触发「整份 stringify + 写盘 + rename」，节流窗口内主线程被占满。
//   · SQLite 实测（Node v22.23.3）：点查 0.012ms、单条 UPDATE 0.377ms、DELETE 0.991ms。
//   · 但 SQLite 的**全量载入并不更快**（70k 条单事务插入 300ms ≈ JSONL 读+解析 285ms）
//     ⇒ 收益只来自「行级增量写」，所以本模块的关键是**只写变化的行**。
//
// 怎么做到「只写变化的行」：
//   落盘前把当前状态与上一份缓存做**扁平字段逐项比较**（items / resultsMap 的元素都是扁平标量，
//   约 12 个字段 × 1.3 万行 ≈ 1–2ms），只有变化的行才序列化并 UPSERT，消失的行才 DELETE；
//   绝不做整份 stringify —— 那正是当前代价的来源。
//
// 表结构（每行存该元素的 JSON 文本，保持与旧 JSON 逐字段等价，不做字段拆解）：
//   task_meta(k TEXT PRIMARY KEY, v TEXT)          顶层标量/数组字段（items、resultsMap 除外）
//   task_items(idx INTEGER PRIMARY KEY, v TEXT)    items[] 按下标
//   task_results(idx INTEGER PRIMARY KEY, v TEXT)  resultsMap 按下标
//
// 依赖纪律：只用 Node 内置模块。require("node:sqlite") 一律**延迟**执行 —— 顶层 require
//   会让低版本 Node（实测 v20.19.5 / v14.21.1 都没有该内置模块）在加载本文件时就抛错。
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");

// 探测结果缓存：进程内只试一次（require 结果按模块名缓存，这里再缓存"可用/不可用"布尔值）
let _probe = null;

/**
 * 运行期探测内置 node:sqlite 是否可用（低版本 Node 没有该内置模块）。
 * @returns {{ok: boolean, reason?: string, version?: string}}
 */
function probe() {
  if (_probe) return _probe;
  try {
    const sqlite = require("node:sqlite");
    if (!sqlite || typeof sqlite.DatabaseSync !== "function") {
      _probe = { ok: false, reason: "node:sqlite 缺少 DatabaseSync" };
      return _probe;
    }
    _probe = { ok: true, version: process.version };
  } catch (e) {
    _probe = { ok: false, reason: (e && e.code) || (e && e.message) || String(e) };
  }
  return _probe;
}

/** 供调用方判断是否启用 SQLite 后端 */
function isAvailable() {
  return probe().ok;
}

/** 打开数据库（含建表与 WAL），失败抛错由调用方回落 */
function open(dbPath) {
  const { DatabaseSync } = require("node:sqlite");
  if (typeof ensureDirOf === "function") ensureDirOf(dbPath);
  const db = new DatabaseSync(dbPath);
  // WAL：读写不互相阻塞；注意会额外产生 -wal / -shm 两个侧车文件，
  //   备份/导出前必须 wal_checkpoint(TRUNCATE)，否则可能拿到半截数据。
  try { db.exec("PRAGMA journal_mode=WAL"); } catch (_) {}
  // synchronous=NORMAL：WAL 下的标准推荐组合。
  //   为什么敢用：任务列表是**临时状态**（一批下完全部销毁），崩溃时最多丢最后几秒进度，
  //   不会损坏库；换来的是每次提交不再强制 fsync（实测一次提交从 ~25ms 降到个位数）。
  try { db.exec("PRAGMA synchronous=NORMAL"); } catch (_) {}
  db.exec(
    "CREATE TABLE IF NOT EXISTS task_meta (k TEXT PRIMARY KEY, v TEXT);" +
    "CREATE TABLE IF NOT EXISTS task_items (idx INTEGER PRIMARY KEY, v TEXT);" +
    "CREATE TABLE IF NOT EXISTS task_results (idx INTEGER PRIMARY KEY, v TEXT);"
  );
  return db;
}

function ensureDirOf(filePath) {
  const dir = path.dirname(filePath);
  if (dir) fs.mkdirSync(dir, { recursive: true });
}

/**
 * 扁平逐项比较：对象字段全为标量时是纯值比较（快）；遇到嵌套对象退化为序列化比较（少见）。
 * @returns {boolean} 是否等价
 */
function sameFlat(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    const va = a[k];
    const vb = b[k];
    if (va === vb) continue;
    if (va && vb && typeof va === "object" && typeof vb === "object") {
      if (JSON.stringify(va) !== JSON.stringify(vb)) return false;
      continue;
    }
    return false;
  }
  return true;
}

/**
 * 读取整份任务。
 * 读优先级（2026-10-15 定）：**旧 download_task.json 优先** ——
 *   存在 json 说明还有一批按旧格式记录的下载没跑完，此时以它为准；
 *   等那批跑完、列表被销毁（json 随之消失）之后，才轮到 SQLite 库。
 *   这样升级不需要迁移脚本，也不会丢正在跑的那批。
 * @param {string} dbPath
 * @param {string} jsonPath
 * @returns {object|null}
 */
function loadTask(dbPath, jsonPath) {
  if (jsonPath && fs.existsSync(jsonPath)) {
    try {
      return JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    } catch (_) {
      // json 损坏 ⇒ 继续尝试库
    }
  }
  if (dbPath && fs.existsSync(dbPath)) {
    try {
      const db = open(dbPath);
      try {
        const metaRows = db.prepare("SELECT k, v FROM task_meta").all();
        const itemRows = db.prepare("SELECT idx, v FROM task_items ORDER BY idx").all();
        const resRows = db.prepare("SELECT idx, v FROM task_results ORDER BY idx").all();
        if (!metaRows.length && !itemRows.length && !resRows.length) {
          // 空库（刚建表还没写过）⇒ 当作没有，继续回落 json
        } else {
          const out = {};
          for (const r of metaRows) {
            try { out[r.k] = JSON.parse(r.v); } catch (_) {}
          }
          const items = [];
          for (const r of itemRows) {
            try { items[Number(r.idx)] = JSON.parse(r.v); } catch (_) {}
          }
          const results = {};
          for (const r of resRows) {
            try { results[Number(r.idx)] = JSON.parse(r.v); } catch (_) {}
          }
          out.items = items;
          out.resultsMap = results;
          return out;
        }
      } finally {
        try { db.close(); } catch (_) {}
      }
    } catch (_) {
      // 库损坏/打不开 ⇒ 当作没有数据
    }
  }
  return null;
}

/**
 * 清空存储（任务被清掉时用）：删 db 与两个侧车文件，并删旧 json。
 * 与旧实现一致（旧实现是直接 unlinkSync 任务 json）。
 */
function dropStore(dbPath, jsonPath) {
  for (const p of [dbPath, dbPath + "-wal", dbPath + "-shm"]) {
    try { fs.unlinkSync(p); } catch (_) {}
  }
  if (jsonPath) { try { fs.unlinkSync(jsonPath); } catch (_) {} }
}

/** 把快照拆成三部分：顶层字段（除 items/resultsMap）、items、resultsMap */
function splitSnapshot(snapshot) {
  const meta = {};
  for (const k of Object.keys(snapshot)) {
    if (k === "items" || k === "resultsMap") continue;
    meta[k] = snapshot[k];
  }
  return {
    meta,
    items: Array.isArray(snapshot.items) ? snapshot.items : [],
    resultsMap: (snapshot.resultsMap && typeof snapshot.resultsMap === "object") ? snapshot.resultsMap : {}
  };
}

/** 预编译全部语句（热路径零解析开销） */
function prepareStatements(db) {
  return {
    upMeta: db.prepare("INSERT INTO task_meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v"),
    upItem: db.prepare("INSERT INTO task_items(idx, v) VALUES(?, ?) ON CONFLICT(idx) DO UPDATE SET v=excluded.v"),
    upRes: db.prepare("INSERT INTO task_results(idx, v) VALUES(?, ?) ON CONFLICT(idx) DO UPDATE SET v=excluded.v"),
    delMeta: db.prepare("DELETE FROM task_meta WHERE k = ?"),
    delItem: db.prepare("DELETE FROM task_items WHERE idx = ?"),
    delRes: db.prepare("DELETE FROM task_results WHERE idx = ?")
  };
}

/** 顶层字段：逐键比较，只写变化的键（缓存存值的深拷贝 —— 顶层字段都是小体积） */
function diffMeta(st, meta, cache) {
  let rows = 0;
  for (const k of Object.keys(meta)) {
    if (!(k in cache) || !sameFlat(meta[k], cache[k])) {
      st.upMeta.run(k, JSON.stringify(meta[k]));
      rows++;
      cache[k] = JSON.parse(JSON.stringify(meta[k] === undefined ? null : meta[k]));
    }
  }
  for (const k of Object.keys(cache)) if (!(k in meta)) { st.delMeta.run(k); rows++; delete cache[k]; }
  return rows;
}

/**
 * 按下标集合的行级差异：只 UPSERT 变化的行、DELETE 消失的行。
 * ⚠ 缓存必须是**值的浅拷贝**，不能存引用：调用方会就地改 `items[i].exists` 这类扁平字段，
 *   存引用时「上一份」与「当前」指向同一对象 ⇒ 比较永远相等 ⇒ 变化检测静默失效（改了不写）。
 * @param {object} st 语句集
 * @param {object} upStmt 变化行的 UPSERT 语句
 * @param {object} delStmt 消失行的 DELETE 语句
 * @param {object|Array} values 当前值（数组 = items；下标键对象 = resultsMap）
 * @param {object} cache 上一份缓存（下标键对象，存的是值拷贝）
 * @param {boolean} isArray values 是否为数组
 * @returns {number} 写入（含删除）的行数
 */
function diffByIndex(st, upStmt, delStmt, values, cache, isArray) {
  let rows = 0;
  const keys = isArray ? Array.from({ length: values.length }, (_, i) => String(i)) : Object.keys(values);
  for (const k of keys) {
    const cur = values[k];
    const old = cache[k];
    if (old === undefined || !sameFlat(cur, old)) {
      upStmt.run(Number(k), JSON.stringify(cur));
      rows++;
      cache[k] = (cur && typeof cur === "object") ? Object.assign({}, cur) : cur;
    }
  }
  for (const k of Object.keys(cache)) {
    const gone = isArray ? Number(k) >= values.length : values[k] === undefined;
    if (gone) { delStmt.run(Number(k)); rows++; delete cache[k]; }
  }
  return rows;
}

/** 清空三张表（任务被清掉时用；保留库文件，下次写入仍可用） */
function clearTables(db) {
  db.exec("BEGIN IMMEDIATE; DELETE FROM task_meta; DELETE FROM task_items; DELETE FROM task_results; COMMIT;");
}

/** 在一个事务里把快照按行级差异落库，返回写入行数（缓存对象就地更新） */
function applySnapshot(db, parts, caches) {
  const st = prepareStatements(db);
  let rows = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    rows += diffMeta(st, parts.meta, caches.meta);
    rows += diffByIndex(st, st.upItem, st.delItem, parts.items, caches.items, true);
    rows += diffByIndex(st, st.upRes, st.delRes, parts.resultsMap, caches.results, false);
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch (_) {}
    throw e;
  }
  return rows;
}

/**
 * 创建 SQLite 任务写入器（接口与 createThrottledWriter 一致）。
 * @param {{filePath:string, jsonPath?:string, ensureDir?:function, getState:function,
 *          buildSnapshot?:function, throttleMs?:number, log?:function, onWrite?:function}} opts
 * @returns {{save:function, flush:function, cancel:function, stats:object, _hasPending:function, mode:string, close:function}}
 */
function createSqliteTaskWriter(opts) {
  const o = opts || {};
  const dbPath = o.filePath;
  const jsonPath = o.jsonPath || null;
  const throttleMs = Number(o.throttleMs) > 0 ? Number(o.throttleMs) : 500;
  const log = typeof o.log === "function" ? o.log : () => {};
  const stats = { saves: 0, writes: 0, coalesced: 0, errors: 0, prunedKeys: 0, rowsWritten: 0, fallbackJson: 0 };

  let db = null;
  let timer = null;
  let dirty = false;
  // 上一份状态缓存（用于行级差异比较）：meta 的每个键、items 与 results 都按**下标键**存值拷贝
  let prevMeta = {};
  let prevItems = {};
  let prevResults = {};

  function ensureDb() {
    if (db) return db;
    if (typeof o.ensureDir === "function") { try { o.ensureDir(); } catch (_) {} }
    db = open(dbPath);
    return db;
  }

  /** 把「没有变化的旧 json」也写一份（SQLite 写失败时的兜底，避免队列丢失） */
  function writeJsonFallback(snapshot) {
    try {
      ensureDirOf(jsonPath);
      const tmp = jsonPath + ".tmp-" + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), "utf8");
      fs.renameSync(tmp, jsonPath);
      stats.fallbackJson++;
      return true;
    } catch (e) {
      log("[task-sqlite] 回落写 JSON 也失败：" + ((e && e.message) || e));
      return false;
    }
  }

  function doWrite() {
    const raw = typeof o.getState === "function" ? o.getState() : null;
    const built = typeof o.buildSnapshot === "function" ? o.buildSnapshot(raw) : { snapshot: raw, pruned: 0 };
    if (built.pruned) stats.prunedKeys += built.pruned;
    const snapshot = built.snapshot;

    if (!snapshot) {
      // 任务被清空：清表并重置差异缓存
      try {
        clearTables(ensureDb());
        prevMeta = {}; prevItems = {}; prevResults = {};
        stats.writes++;
      } catch (e) {
        stats.errors++;
        log("[task-sqlite] 清空失败：" + ((e && e.message) || e));
      }
      return;
    }

    try {
      const caches = { meta: prevMeta, items: prevItems, results: prevResults };
      const rows = applySnapshot(ensureDb(), splitSnapshot(snapshot), caches);
      stats.writes++;
      stats.rowsWritten += rows;
      if (typeof o.onWrite === "function") { try { o.onWrite(rows); } catch (_) {} }
    } catch (e) {
      // 关键兜底：SQLite 写失败时把整份快照写回 JSON，绝不静默丢队列
      stats.errors++;
      log("[task-sqlite] SQLite 写入失败，回落 JSON：" + ((e && e.message) || e));
      if (jsonPath) writeJsonFallback(snapshot);
    }
  }

  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!dirty) return false;
    dirty = false;
    doWrite();
    return true;
  }

  function save() {
    stats.saves++;
    dirty = true;
    if (timer) { stats.coalesced++; return; }
    timer = setTimeout(() => { timer = null; flush(); }, throttleMs);
    if (timer.unref) timer.unref();
  }

  function cancel() {
    if (timer) { clearTimeout(timer); timer = null; }
    dirty = false;
  }

  return {
    save, flush, cancel, stats,
    _hasPending: () => dirty,
    mode: "sqlite",
    close: () => { try { if (db) db.close(); } catch (_) {} db = null; }
  };
}

module.exports = { probe, isAvailable, createSqliteTaskWriter, loadTask, dropStore, open, sameFlat };
