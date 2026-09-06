// utils/html.js —— HTML 文本转义（P2 去重，参照 gbmd utils/html.js）
"use strict";

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

module.exports = { escapeHtml };