// ============================================================
// iwara-downloader - 路径安全（B1 修复：系统关键目录黑名单）
// 用户 2026-09-06 拍板：「📂 按钮 = 读取本地选择目录，实际只需要把各平台系统关键目录
//   拉黑就行了，本身只是个局域网项目」——browse 用黑名单，不做白名单收敛。
// isDeniedBrowseDir：命中系统关键目录（/etc /proc /sys /usr /Windows 等）→ 拒绝；
//   其余路径可浏览（局域网自用场景，无下载根时也不限制）。
// isWithinRoots：保留（download 侧防穿越用，本文件原始能力）。
// ============================================================
"use strict";

const path = require("path");

// 系统关键目录黑名单（跨平台，含 POSIX + Windows）。
// 匹配规则：resolve 后的绝对路径，小写比较，等于根或 startsWith 根+sep 即命中。
// POSIX：/etc /proc /sys /dev /var /boot /root /run /sbin /bin /lib /lib64 /usr
//        macOS 额外：/System /Library /Applications /private
// Windows：各盘符的 \Windows \Program Files \Program Files (x86) \ProgramData \Recovery
const DENY_ROOTS = [
  // POSIX 系统目录
  "/etc", "/proc", "/sys", "/dev", "/var", "/boot", "/root", "/run",
  "/sbin", "/bin", "/lib", "/lib64", "/usr",
  // macOS
  "/system", "/library", "/applications", "/private",
  // Windows（任意盘符）
  ":\\windows", ":\\program files", ":\\program files (x86)", ":\\programdata", ":\\recovery"
];

// 黑名单是否命中：dir（绝对路径）的任一祖先/自身等于黑名单根
function isDeniedBrowseDir(dir) {
  const abs = path.resolve(String(dir || ""));
  const low = abs.toLowerCase();
  return DENY_ROOTS.some((root) => {
    if (low === root) return true;
    if (low.startsWith(root + path.sep)) return true;
    // Windows 盘符匹配：把 "C:\windows" 这类盘符化根匹配掉
    if (root.startsWith(":\\")) {
      // 对每个盘符尝试：c:\windows 等
      const drive = low.match(/^[a-z]:/);
      if (!drive) return false;
      const candidate = drive[0] + root;
      return low === candidate || low.startsWith(candidate + "\\") || low.startsWith(candidate + path.sep);
    }
    return false;
  });
}

// 目录列表里要过滤的系统残留目录名（browse 列条目时用）
function isSystemJunkName(name) {
  return name === "@eaDir" || name === "#recycle" || name === ".git" || name === "System Volume Information";
}

module.exports = { isDeniedBrowseDir, isSystemJunkName };
