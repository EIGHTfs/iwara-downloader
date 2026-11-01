#!/usr/bin/env node
"use strict";

// ============================================================
// scripts/prepublish-guard.js —— 发布前「静态清单」核对（由 prepublishOnly 调用）
//
// 为什么是静态的（不跑 npm pack）：
//   npm publish 的 prepublishOnly 跑在子进程里，此时再调 npm pack 产物不会按
//   --pack-destination 落盘（甚至不产出）→ 发布被"打包失败"卡死。实测踩过。
//   因此：门禁只做**按 files 白名单推算**的静态核对；真实产物核对另用
//   scripts/verify-pack.sh（手动跑）。
//
// 判据：
//   ① 遍历 files 白名单（支持 "!排除"），得到会进包的文件集合
//   ② 命中禁止模式（.env / 运行期配置 / 测试 / 文档 / 缓存 / 上传 / sourcemap / 中间产物）即失败
//   ③ 必需文件缺失即失败
// ============================================================

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const files = Array.isArray(pkg.files) ? pkg.files : [];

/** 递归列出目录下所有文件（相对路径，POSIX 分隔符） */
function walk(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, out);
    else out.push(path.relative(ROOT, abs).split(path.sep).join("/"));
  }
  return out;
}

/** 把 files 条目（含 !排除）展开成"会进包"的文件集合 */
function expand() {
  const include = new Set();
  const exclude = [];
  for (const raw of files) {
    const entry = String(raw).trim();
    if (!entry) continue;
    if (entry.startsWith("!")) { exclude.push(entry.slice(1)); continue; }
    const abs = path.join(ROOT, entry);
    if (!fs.existsSync(abs)) continue;
    const st = fs.statSync(abs);
    if (st.isDirectory()) walk(abs).forEach((f) => include.add(f));
    else include.add(path.relative(ROOT, abs).split(path.sep).join("/"));
  }
  for (const p of exclude) {
    for (const f of Array.from(include)) {
      if (f === p || f.startsWith(`${p.replace(/\/$/, "")}/`)) include.delete(f);
    }
  }
  // 白名单之外 npm 总会带上的元信息文件
  for (const always of ["package.json", "README.md", "LICENSE"]) {
    if (fs.existsSync(path.join(ROOT, always))) include.add(always);
  }
  return Array.from(include).sort();
}

const FORBIDDEN = [
  [/(^|\/)\.env(\..*)?$/, "环境变量文件（部署配置，可能含凭据）"],
  [/(^|\/)server\/config\.json$/, "运行期配置（含密码哈希），应落数据根"],
  [/(^|\/)config\.local\./, "本地私配置"],
  [/(^|\/)test(s)?\//, "测试代码"],
  [/(^|\/)docs?\//, "文档目录（README 之外）"],
  [/(^|\/)(cache|cache-[^/]+|uploads|logs)\//, "运行期缓存/上传/日志"],
  [/\.map$/, "sourcemap"],
  [/\.tgz$/, "打包中间产物"],
  [/\.pid$/, "PID 文件"],
  [/(^|\/)(crx|mapping)\//, "浏览器扩展与映射数据（非运行必需）"],
];

const REQUIRED = [
  "package.json",
  "README.md",
  "LICENSE",
  `bin/${pkg.name}.js`,
  "server/boot.cjs",
  "server/app.js",
];

const included = expand();
const problems = [];

for (const f of included) {
  for (const [re, why] of FORBIDDEN) {
    if (re.test(f)) problems.push(`不该进包：${f}（${why}）`);
  }
}
for (const r of REQUIRED) {
  if (!included.includes(r)) problems.push(`缺少必需文件：${r}`);
}
if (files.some((f) => [".", "./", "*", "**"].includes(String(f).trim()))) {
  problems.push("files 里出现整目录放行（. / ./ / *）—— 会把目录内残留一起发出去");
}

console.log(`── 发布前静态清单核对：${pkg.name}@${pkg.version} ──`);
console.log(`   会进包的文件：${included.length} 个`);

if (problems.length) {
  for (const p of problems) console.log(`   ✗ ${p}`);
  console.log("✗ 核对未通过：修正 package.json 的 files 或把文件移出包目录后重试");
  process.exit(1);
}
console.log("   ✓ 静态核对通过（实物核对请另跑 scripts/verify-pack.sh）");
