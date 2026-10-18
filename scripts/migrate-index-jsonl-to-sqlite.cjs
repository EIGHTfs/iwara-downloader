#!/usr/bin/env node
// ============================================================
// 索引 JSONL → SQLite 一次性迁移（2026-10-18 新增，模板下发件）
//
// 背景：索引按「一游戏一文件」存放，增量收尾要重写整个游戏文件
//   （最大单文件 21.7MB / 71,750 条，实测单条增删 ≈391ms、收尾期写盘 121MB/s）。
//   换成库后只 UPSERT 变化的行。**与 json/index 的 JSON→JSONL 迁移同理：不自动跑**，
//   由人工执行一次；读层双读（库优先、回落 .jsonl/.json），没迁移的部署照样能用。
//
// 用法（全部参数化，脚本内不写具体路径）：
//   node scripts/migrate-index-jsonl-to-sqlite.cjs --dir <json/index>                    # 预演（默认，不写库）
//   node scripts/migrate-index-jsonl-to-sqlite.cjs --dir <json/index> --apply            # 真迁移
//   node scripts/migrate-index-jsonl-to-sqlite.cjs --dir <json/index> --verify           # 迁移后校验
//   node scripts/migrate-index-jsonl-to-sqlite.cjs --dir <json/index> --base iwara-index --apply
//
// --base 的用途：同一目录里可能混着**非索引文件**（如 iwara 的逐条 <id>.json sidecar）。
//   不加 --base 会把它们也当索引进 plan（迁出 0 条、白跑一趟），必须显式限定。
//
// 退出码：0 成功 / 1 参数或执行错误 / 2 校验不一致
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const jsonlStore = require("../server/lib/jsonl-store");
const indexStore = require("../server/lib/index-store");

const USAGE = [
  "用法：",
  "  node scripts/migrate-index-jsonl-to-sqlite.cjs --dir <json/index>            # 预演（默认）",
  "  node scripts/migrate-index-jsonl-to-sqlite.cjs --dir <json/index> --apply    # 真迁移",
  "  node scripts/migrate-index-jsonl-to-sqlite.cjs --dir <json/index> --verify   # 迁移后校验",
  "",
  "  --dir    索引目录（其下 .jsonl / .json），必填",
  "  --base   只处理指定 base（可重复）；目录里混有非索引文件时必须用它",
  "  --apply  真正写入 SQLite（缺省只预演，不写任何东西）",
  "  --verify 比对「库」与「文件」的逐 base 内容指纹；一致退出 0，不一致退出 2"
].join("\n");

function parseArgs(argv) {
  const out = { apply: false, verify: false, bases: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") out.dir = argv[++i];
    else if (a === "--base") out.bases.push(argv[++i]);
    else if (a === "--apply") out.apply = true;
    else if (a === "--verify") out.verify = true;
    else if (a === "-h" || a === "--help") out.help = true;
  }
  return out;
}

/** 记录 → 指纹（排序后逐条序列化，与字段顺序无关；用于「库 vs 文件」内容比对） */
function recordsFingerprint(records) {
  const lines = (records || [])
    .map((r) => JSON.stringify([String(r.t), String(r.k), r.v]))
    .sort();
  return crypto.createHash("sha256").update(lines.join("\n")).digest("hex");
}

/**
 * 扫目录里的索引文件名 → base 列表（去后缀）。
 *   目录里可能混着非索引文件（iwara 的逐条 <id>.json sidecar）⇒ 支持 --base 显式限定。
 */
function listFileBases(dir, only) {
  const all = fs.readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl") || f.endsWith(".json"))
    .map((f) => f.replace(/\.jsonl?$/, ""))
    .sort();
  if (!only || !only.length) return all;
  const want = new Set(only.map((x) => String(x).replace(/\.jsonl?$/, "")));
  return all.filter((b) => want.has(b));
}

/** 校验模式：库 vs 文件逐 base 比内容指纹 */
function runVerify(dir, bases) {
  let bad = 0;
  process.stdout.write("索引库 vs 文件 内容校验（" + bases.length + " 个 base）\n");
  for (const base of bases) {
    const fromFile = jsonlStore.readIndex(path.join(dir, base));
    const fromDb = indexStore.readIndex(path.join(dir, base));
    if (fromDb.format !== "sqlite") {
      process.stdout.write("  ✗ " + base + "：库里没有该 base 的行\n");
      bad++;
      continue;
    }
    const same = recordsFingerprint(fromFile.records) === recordsFingerprint(fromDb.records)
      && fromFile.records.length === fromDb.records.length;
    if (!same) {
      process.stdout.write("  ✗ " + base + "：文件 " + fromFile.records.length + " 条 / 库 " + fromDb.records.length + " 条\n");
      bad++;
    }
  }
  process.stdout.write(bad === 0
    ? "  ✅ 全部一致（" + bases.length + " 个 base 逐条相同）\n"
    : "  ❌ " + bad + " 个 base 不一致\n");
  return bad === 0 ? 0 : 2;
}

/**
 * 读出每个 base 的记录，准备迁移。
 *   ⚠ plan 里必须存**记录数组本身**。曾误存 r.records.length（条数）⇒ apply 时把数字当记录传，
 *   报 "(records || []) is not iterable"；而条数为 0 的那些（sidecar）因为 (0 || []) 恰好是 []
 *   反而"成功"，于是现象变成「N 个成功 1 个失败」，极具误导性。
 */
function buildPlan(dir, bases) {
  const plan = [];
  let skipped = 0;
  let totalRecords = 0;
  for (const base of bases) {
    const r = jsonlStore.readIndex(path.join(dir, base));
    if (r.format === "none") {
      skipped++;
      continue;
    }
    const records = Array.isArray(r.records) ? r.records : [];
    totalRecords += records.length;
    plan.push({ base, format: r.format, records, meta: r.meta || {} });
  }
  return { plan, skipped, totalRecords };
}

/** 真迁移：逐 base 写库，逐 base 报结果 */
function runApply(dir, plan) {
  let ok = 0;
  let failed = 0;
  for (const p of plan) {
    if (!Array.isArray(p.records)) {
      failed++;
      process.stdout.write("  ✗ " + p.base + " 记录不是数组（内部错误，已跳过）\n");
      continue;
    }
    const w = indexStore.writeIndexAtomic(path.join(dir, p.base), p.meta, p.records);
    if (w && w.ok) ok++;
    else {
      failed++;
      process.stdout.write("  ✗ " + p.base + " 写入失败：" + JSON.stringify(w) + "\n");
    }
  }
  indexStore.closeDb();
  return { ok, failed };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.dir) {
    process.stdout.write(USAGE + "\n");
    return opts.help ? 0 : 1;
  }
  const dir = path.resolve(opts.dir);
  if (!fs.existsSync(dir)) {
    process.stdout.write("✗ 目录不存在：" + dir + "\n");
    return 1;
  }

  const probe = indexStore.probe();
  if (!probe.ok) {
    process.stdout.write("✗ " + probe.reason + "\n");
    return 1;
  }

  const bases = listFileBases(dir, opts.bases);
  if (!bases.length) {
    const hint = opts.bases.length ? " / --base " + opts.bases.join(",") : "";
    process.stdout.write("（没有匹配的索引文件：" + dir + hint + "）\n");
    return 0;
  }
  if (opts.verify) return runVerify(dir, bases);

  const { plan, skipped, totalRecords } = buildPlan(dir, bases);
  process.stdout.write((opts.apply ? "开始迁移" : "预演（不改动任何文件/库；加 --apply 才真写）") + "\n");
  process.stdout.write("  索引目录: " + dir + "\n");
  process.stdout.write("  库文件  : " + indexStore.dbPathOf(dir) + "\n");
  process.stdout.write("  base 数 : " + plan.length + "（跳过 " + skipped + " 个无法解析的）\n");
  process.stdout.write("  记录总数: " + totalRecords + "\n");

  if (!opts.apply) {
    for (const p of plan.slice(0, 20)) {
      process.stdout.write("  · " + p.base + " → " + p.records.length + " 条（源格式 " + p.format + "）\n");
    }
    if (plan.length > 20) process.stdout.write("  · … 其余 " + (plan.length - 20) + " 个 base 略\n");
    process.stdout.write("预演结束：未写入任何数据。\n");
    return 0;
  }

  const { ok, failed } = runApply(dir, plan);
  process.stdout.write("迁移完成：成功 " + ok + " 个 base，失败 " + failed + " 个\n");
  process.stdout.write("  ⚠ 文件未被删除（.jsonl/.json 原样保留，可回退）；确认无误后可自行归档。\n");
  return failed === 0 ? 0 : 1;
}

process.exitCode = main();
