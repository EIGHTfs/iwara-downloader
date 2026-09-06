// ============================================================
// iwara-downloader - 路径安全（B1 修复，参照 gbmd utils/path-safe.js）
// downloadRoots：收集可浏览/下载根（config downloadPath + aria2Path 本地前缀）
// isWithinRoots：abs 是否在某根内（resolve + startsWith，防目录穿越/越权浏览）
// isBrowsableDir：browse 白名单收敛（祖先 + 根 + 后代放行，其余 403）
// ============================================================
"use strict";

const path = require("path");

// iwara 的下载根：config.json 的 downloadPath（direct 后端本机路径；
// aria2 后端路径在 aria2 机器上，本机 browse 不适用——只收敛 direct 场景）
function downloadRoots(cfg) {
  const c = cfg.readConfig();
  const roots = [];
  const dp = String(c.downloadPath || "").trim();
  if (dp) roots.push(dp);
  return roots;
}

function isWithinRoots(target, roots) {
  const abs = path.resolve(String(target || ""));
  return (roots || []).some((r) => {
    const rr = path.resolve(String(r || ""));
    return abs === rr || abs.startsWith(rr + path.sep);
  });
}

// dir 是否在「下载根 + 祖先 + 后代」可浏览范围（B1：browse 收敛到下载根分支）。
// 祖先放行：前端从 "/" 起步下钻到下载根；后代放行：在下载根内继续下钻选子目录。
// 其余分支（/etc、/home 等与下载无关）一律不列、不可进。
// 用 path.relative 判祖先/后代：相对结果非空且不以 ".." 开头即成立。规避 abs + path.sep
// 在 abs="/"（根目录）时拼出 "//" 的边界错误（gbmd 原实现同样有此问题）。
function isBrowsableDir(dir, roots) {
  const list = roots || [];
  if (!list.length) return true; // 无任何下载根时无法收敛，不限制
  const abs = path.resolve(String(dir || ""));
  return list.some((r) => {
    const rr = path.resolve(String(r || ""));
    if (abs === rr) return true;
    const relToRoot = path.relative(abs, rr);
    if (relToRoot !== "" && !relToRoot.startsWith("..") && !path.isAbsolute(relToRoot)) return true;
    const relFromRoot = path.relative(rr, abs);
    return relFromRoot !== "" && !relFromRoot.startsWith("..") && !path.isAbsolute(relFromRoot);
  });
}

module.exports = { downloadRoots, isWithinRoots, isBrowsableDir };
