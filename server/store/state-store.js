// ============================================================
// 状态文件存储层（通用，零依赖）：原子替换 + 合并写
//
// 解决什么问题（2026-10-11 实测驱动，gbmd 下载任务）：
//   把「运行态状态」整份存进一个 JSON 文件时，常见两种写法都会出问题——
//     ① 每次状态变化就 `JSON.stringify(全量)` + `writeFileSync` 覆写 ⇒ 条目上万时单次 100ms+
//        同步阻塞主线程（实测 15.4MB 文件 stringify 128ms + 写盘 33ms，被每个子项回调各调一次）；
//     ② 非原子写：写一半崩溃/断电 ⇒ 留下半个 JSON，状态文件直接损坏、下次启动解析失败。
//
// 本模块给出两件可复用工具：
//   writeFileAtomic(filePath, text)          —— 临时文件 + rename 原子替换（同目录 rename 原子）
//   createThrottledWriter({...})             —— 脏标记 + 合并写（默认 500ms 一次）+ flush()/cancel()
//
// 使用判据（满足其一就该用本模块）：
//   · 状态文件单次序列化 ≥ 10ms，或条目数 ≥ 1e3
//   · 落盘点出现在热循环 / 每项回调里（先问「这一秒要写几次」）
//   · 文件是唯一状态源（删文件的操作必须同时 cancel() 未落盘的写，否则文件会"复活"）
//
// 下发：assemble.json 把本文件 → 项目 server/store/state-store.js（下游可选接入）。
// 项目侧通常再包一层：在 getState 里做业务净化（如清越界键），其余交给本模块。
// ============================================================
"use strict";

const fs = require("fs");

/**
 * 原子写文件：先写同目录临时文件，再 rename 覆盖目标（同目录 rename 是原子操作）。
 * 任何时刻目标文件要么是旧的完整内容、要么是新的完整内容，不会出现半个 JSON。
 * @param {string} filePath 目标路径
 * @param {string} text 内容
 */
function writeFileAtomic(filePath, text) {
  const tmp = filePath + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, text, "utf8");
  try {
    fs.renameSync(tmp, filePath);
  } catch (e) {
    // rename 失败（极端情况）→ 先清理临时文件再抛，避免残留
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
}

/**
 * 创建「脏标记 + 合并写」写入器。
 *   save()   —— 置脏并排程（throttleMs 内多次调用只落一次盘）；不阻塞调用方
 *   flush()  —— 立即落盘（关键节点：批次开始/结束/暂停/恢复/进程退出），无脏数据则什么都不做
 *   cancel() —— 取消未落盘的排程（删文件场景必用，否则节流窗口会把文件写回来）
 *   stats    —— { saves, writes, coalesced, errors } 供自检/日志
 * 定时器 unref()，不会阻止进程退出。
 *
 * @param {object} opts
 * @param {string} opts.filePath 目标文件
 * @param {() => any} opts.getState 取当前状态（返回 null 时写入 "null"，与 JSON.stringify 语义一致）
 * @param {() => void} [opts.ensureDir] 落盘前确保目录存在
 * @param {(state:any)=>{snapshot:any, pruned?:number}} [opts.buildSnapshot] 自定义快照（默认原样序列化）
 * @param {number} [opts.throttleMs=500] 合并写窗口
 * @param {(msg:string)=>void} [opts.log]
 */
function createThrottledWriter(opts) {
  const o = opts || {};
  const { filePath, getState } = o;
  if (!filePath || typeof getState !== "function") throw new Error("createThrottledWriter 需要 filePath 与 getState");
  const throttleMs = Number(o.throttleMs) > 0 ? Number(o.throttleMs) : 500;
  const log = o.log || (() => {});
  const stats = { saves: 0, writes: 0, coalesced: 0, errors: 0 };
  let timer = null;
  let dirty = false;

  function doWrite() {
    const raw = getState();
    const built = typeof o.buildSnapshot === "function" ? o.buildSnapshot(raw) : { snapshot: raw, pruned: 0 };
    if (built && built.pruned) stats.prunedKeys = (stats.prunedKeys || 0) + built.pruned;
    if (typeof o.ensureDir === "function") o.ensureDir();
    const text = JSON.stringify(built ? built.snapshot : raw, null, 2);
    // 2026-10-11：可选写盘回调（bytes, filePath）——项目侧可接自己的 IO 监测做归因；
    //   模板本身不依赖任何监测实现，回调抛错也不影响落盘。
    if (typeof o.onWrite === "function") { try { o.onWrite(Buffer.byteLength(text), filePath); } catch (_) {} }
    writeFileAtomic(filePath, text);
    stats.writes++;
  }

  /** 立即落盘（无脏数据则什么都不做），返回是否真的写了 */
  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!dirty) return false;
    dirty = false;
    try { doWrite(); return true; } catch (e) {
      stats.errors++;
      log("[state-store] 落盘失败：" + (e && e.message));
      return false;
    }
  }

  /** 标记脏 + 排程合并写 */
  function save() {
    stats.saves++;
    dirty = true;
    if (timer) { stats.coalesced++; return; }
    timer = setTimeout(() => { timer = null; flush(); }, throttleMs);
    if (timer.unref) timer.unref();
  }

  /** 取消未落盘的排程（删文件场景用） */
  function cancel() {
    if (timer) { clearTimeout(timer); timer = null; }
    dirty = false;
  }

  return { save, flush, cancel, stats, _hasPending: () => dirty };
}

module.exports = { writeFileAtomic, createThrottledWriter };
