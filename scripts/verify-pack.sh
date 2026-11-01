#!/usr/bin/env bash
# ============================================================
# scripts/prepublish-guard.sh —— 发布前「实物清单」核对（由 prepublishOnly 调用）
#
# 为什么要有它：package.json 的 files 是白名单，但「整目录放行」会把目录里的运行期残留
#   一并带进包（实测踩过：server/config.json 含密码哈希、项目根 .env 属部署配置、
#   test/ 与 fixtures 与源码一样大）。只看 files 字段是看不出来的，
#   必须对**真实打出来的 tgz** 做一次清单核对。
#
# 判定：出现任一禁止项或缺少必需项 ⇒ 退出码非 0，npm publish 随之中止。
# 本脚本自身不在 files 白名单里，不会进包。
# ============================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# --no-dry-run + 清掉继承的 dry-run 变量：npm publish --dry-run 会把 npm_config_dry_run
#   传给子进程，导致这里的 npm pack 也 dry-run、不产出 tgz。
env -u npm_config_dry_run -u npm_config_dry_run_only -u NPM_CONFIG_DRY_RUN \
  npm pack --pack-destination "$TMP" --no-dry-run >/dev/null 2>&1 || {
  echo "✗ 打包失败（npm pack）"; exit 1; }

TGZ="$(ls "$TMP"/*.tgz 2>/dev/null | head -n 1)"
[ -n "$TGZ" ] || { echo "✗ 未产出 tgz"; exit 1; }
LIST="$(tar -tzf "$TGZ")"
TOTAL="$(printf '%s\n' "$LIST" | wc -l | tr -d ' ')"

echo "── 发布前实物清单核对：$(basename "$TGZ") ──"
echo "   条目数：$TOTAL   体积：$(du -h "$TGZ" | cut -f1)"

# ---------- 禁止项 ----------
FORBIDDEN=(
  '\.env'
  'package/server/config\.json'
  '^package/test/'
  '^package/docs/'
  '^package/(crx|mapping|json)/'
  '^package/tool/'
  '^package/scripts/'
  '\.map$'
  '\.tgz$'
  '\.pid$'
)
bad=0
for pat in "${FORBIDDEN[@]}"; do
  hit="$(printf '%s\n' "$LIST" | grep -E "$pat" | head -n 3)"
  if [ -n "$hit" ]; then
    echo "   ✗ 不该进包（$pat）："
    printf '%s\n' "$hit" | sed 's/^/       /'
    bad=1
  fi
done

# ---------- 必需项 ----------
REQUIRED=(
  'package/package.json'
  'package/bin/iwara-downloader.js'
  'package/server/boot.cjs'
  'package/server/app.js'
  'package/start.sh'
  'package/README.md'
  'package/LICENSE'
)
for f in "${REQUIRED[@]}"; do
  if ! printf '%s\n' "$LIST" | grep -qx "$f"; then
    echo "   ✗ 缺少必需文件：$f"
    bad=1
  fi
done

if [ "$bad" -ne 0 ]; then
  echo "✗ 清单核对未通过：修正 package.json 的 files 后重试"
  exit 1
fi
echo "   ✓ 清单核对通过：$TOTAL 个条目"
