#!/usr/bin/env bash
# ============================================================
# scripts/shot-screenshots.sh —— 宣传图重截（含打码），元素选择**固化在此**
#
# 为什么单独成脚本：宣传图要「看得出在下载、看不出下的具体是什么」，涉及一组元素选择器；
#   每次现推容易漏（实测踩过：漏了标题/作者，真实内容原样露出）。
#
# 用法（参数化，不硬编码地址/密码）：
#   IWARA_BASE=http://<主机>:<端口> IWARA_PWD=<访问密码> bash scripts/shot-screenshots.sh
#   IWARA_OUT=/tmp/shots bash scripts/shot-screenshots.sh      # 指定输出目录
#   bash scripts/shot-screenshots.sh --redact-blur 10           # 追加参数透传给 page-shot.mjs
#
# 打码范围（保留可读性）：
#   · 缩略图                      → --redact-images
#   · 视频标题                    → .item-name
#   · 作者 / 元信息               → .meta、.name
#   · 搜索结果标题                → .result-item .name、.browse-item .name
#   · 兜底文本                    → iwara 域名 / /volume 路径 / 「来自」/ 视频与图片扩展名
#   · 保留（不打码）              → 进度条、状态徽章、tab、顶栏品牌
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

BASE="${IWARA_BASE:?请设置 IWARA_BASE（例如 http://<主机>:<端口>）}"
PASS="${IWARA_PWD:?请设置 IWARA_PWD（访问密码）}"
OUT="${IWARA_OUT:-$(mktemp -d)/iwara-shots}"
mkdir -p "$OUT"

REDACT_CSS=".row-thumb, .item-name, .meta, .name, .result-item .name, .browse-item .name"
REDACT_TEXT='iwara\.tv|/volume|来自|\.(mp4|mkv|webm|jpg|jpeg|png|gif|webp)'
REDACT_EXCLUDE=".brand-block, .brand-logo, .logo, .tab, .badge, .row-bar, .row-bar-fill"

# 一次只截一个标签页：多标签串跑容易在登录跳转后抓不到 .tab（实测踩过）
for tab in download progress search settings; do
  echo "── 截图 $tab ──"
  node scripts/page-shot.mjs \
    --base "$BASE" --password "$PASS" \
    --theme dark --tabs "$tab" --no-full \
    --redact "$REDACT_CSS" \
    --redact-text "$REDACT_TEXT" \
    --redact-images --redact-exclude "$REDACT_EXCLUDE" \
    --out "$OUT" "$@"
done

echo "截图目录: $OUT"
