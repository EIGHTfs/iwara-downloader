/* ============================================================
 * partial-refresh.js —— 通用「HTML 局部刷新」工具（模板框架层）
 *
 * 为什么存在：
 *   列表/状态类页面常见两种写法，都踩过坑：
 *   ① 整表 innerHTML 重建：轮询/操作后整个列表销毁重建 → 图片闪烁、
 *      滚动位置错乱、运行中行的测速状态丢失、点击事件随行失效需重新委托。
 *   ② 每处手写「找行/更新行/删旧行」：逻辑复制粘贴，各项目实现不一，
 *      改一处漏一处（gbmd 有指纹缓存、iwara 按 data-task-id 复用，口径不同）。
 *
 * 本模块把「按 key 复用行 + 增量更新 + 差集删除」收敛成一个函数：
 *   patchList(listEl, items, { key, createRow, renderRow, removeStale })
 * 以及两个单点小工具：
 *   patchText(el, value)     —— 文本节点原地更新（未变则不动，避免破坏子节点）
 *   patchAttr(el, name, v)   —— 属性原地更新（未变则不动）
 *
 * 依赖：无（纯 DOM 操作，零依赖）。浏览器全局挂 window.partialRefresh。
 * 新版页面若模块化可直接 import/require 导出对象。
 *
 * 用法示例（下载列表按行刷新，不整表重建）：
 *   const { patchList } = window.partialRefresh;
 *   patchList($("#taskList"), items, {
 *     key: "task",                 // → 行属性 data-task-id
 *     createRow: (it) => { ... 建骨架行 return row; },
 *     renderRow: (row, it) => { ... 只更新该行内容 },
 *   });
 * ============================================================ */
(function (global) {
  "use strict";

  /**
   * patchText —— 文本节点原地更新。
   * 未变化时不动（避免无谓的 DOM 写入）；el 为空直接返回。
   */
  function patchText(el, value) {
    if (!el) return;
    const v = String(value == null ? "" : value);
    if (el.firstChild && el.firstChild.nodeType === 3) {
      if (el.firstChild.textContent !== v) el.firstChild.textContent = v;
    } else {
      el.textContent = v;
    }
  }

  /**
   * patchAttr —— 属性原地更新（未变则不动）。
   * el 为空直接返回。
   */
  function patchAttr(el, name, value) {
    if (!el) return;
    const v = String(value == null ? "" : value);
    if (el.getAttribute(name) !== v) el.setAttribute(name, v);
  }

  /**
   * patchList —— 列表按 key 复用行：增量更新 + 差集删除，不整表重建。
   *
   * @param {HTMLElement} listEl   列表容器
   * @param {Array}       items    新数据数组（元素任意，renderRow 从元素取字段）
   * @param {object}      opts
   *   key        {string}  行标识属性名 → 行元素 data-<key>-id（默认 "patch"）
   *   getKey     {Function} (item) => string 可选，缺省用 item.id
   *   createRow  {Function} (item) => HTMLElement 新建行骨架（必须设置 data-<key>-id）
   *   renderRow  {Function} (row, item) => void 复用/新建行后调用，更新行内容
   *   removeStale{boolean}  缺省 true：删除不在 items 中的旧行
   *
   * @returns {{created:number, updated:number, removed:number}}
   */
  function patchList(listEl, items, opts) {
    const cfg = opts || {};
    const key = cfg.key || "patch";
    const attr = "data-" + key + "-id";
    const list = Array.isArray(items) ? items : [];
    const seen = new Set();
    let created = 0;
    let updated = 0;
    let removed = 0;

    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      const kid = cfg.getKey ? String(cfg.getKey(it)) : String((it && it.id) != null ? it.id : "");
      if (!kid) continue;
      seen.add(kid);
      let row = listEl.querySelector("[" + attr + '="' + cssEscape(kid) + '"]');
      if (!row) {
        if (typeof cfg.createRow !== "function") continue;
        row = cfg.createRow(it);
        if (!row || !(row.setAttribute && row.getAttribute)) continue;
        if (!row.getAttribute(attr)) row.setAttribute(attr, kid);
        listEl.appendChild(row);
        created++;
      } else {
        updated++;
      }
      if (typeof cfg.renderRow === "function") cfg.renderRow(row, it);
    }

    if (cfg.removeStale !== false) {
      const rows = listEl.querySelectorAll("[" + attr + "]");
      for (let i = 0; i < rows.length; i++) {
        if (!seen.has(rows[i].getAttribute(attr))) {
          rows[i].remove();
          removed++;
        }
      }
    }

    return { created: created, updated: updated, removed: removed };
  }

  /** CSS.escape 兼容（避免 key 含特殊字符时 querySelector 炸掉） */
  function cssEscape(s) {
    if (global.CSS && typeof global.CSS.escape === "function") return global.CSS.escape(s);
    return String(s).replace(/["\\]/g, "\\$&");
  }

  const api = { patchList: patchList, patchText: patchText, patchAttr: patchAttr, cssEscape: cssEscape };
  global.partialRefresh = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));