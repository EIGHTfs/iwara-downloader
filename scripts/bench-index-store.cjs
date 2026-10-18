#!/usr/bin/env node
// ============================================================
// 索引存储后端性能对比：JSONL（整文件重写） vs SQLite（行级增量）（2026-10-18 新增）
//
// 为什么要有这个脚本：换存储后端时，**正确性通过不代表性能变好**。
//   实测教训：第一版 index-store 每次写都回库读整份行（最大 base 71,842 行）算差异，
//   结果比直接重写 JSONL 还慢 2.4 倍；加了行级差异缓存后才反过来。
//   ⇒ 以后动存储层，先跑这个脚本，别靠推理。
//
// 测四件事：
//   ① 启动加载 load()        —— 全量读 + 建三段 Map（两种后端对比）
//   ② 单游戏增量写（改 1 条）—— 核心收益点：JSONL 重写整个游戏文件，SQLite 只动 1 行
//   ③ 全库增量写（各改 1 条）—— rebuild / 批量收尾场景
//   ④ 落盘体积
//
// 两种数据来源（二选一）：
//   --dir <json/index>                    用真实索引（会先复制到临时工作目录，源目录只读）
//   --synthetic <记录数> [--bases <个数>]  生成合成数据（任何机器可跑，用于后端对比）
//
// 用法：
//   node scripts/bench-index-store.cjs --synthetic 250000 --bases 12 --iters 5
//   node scripts/bench-index-store.cjs --dir <json/index> --iters 5
//
// 读数的正确姿势：写入耗时看 **min 与 p50**（自动 checkpoint 会让个别次偶发变慢），
//   不要只看 avg —— avg 会被 checkpoint 尖峰带偏。
//
// 退出码：0 成功 / 1 参数或执行错误
// ============================================================
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const jsonlStore = require("../server/lib/jsonl-store");
const indexStore = require("../server/lib/index-store");
// ⚠ 不要在这里 require hash-index：它在**模块加载期**就解析 GBMD_JSON_DIR，
//   顶部 require 会让它指向项目自己的 json/index（空），load() 测出来只有 1–2ms，假的。
//   见 runLoad()：设好环境变量 + 清缓存后再 require。

const USAGE = [
  "用法：",
  "  node scripts/bench-index-store.cjs --synthetic <记录数> [--bases 12] [--iters 5]   # 合成数据",
  "  node scripts/bench-index-store.cjs --dir <json/index> [--iters 5]                  # 真实索引",
  "",
  "  --dir       真实索引目录（只读，会复制到临时工作目录再跑）",
  "  --synthetic 生成多少条记录（与 --dir 二选一）",
  "  --bases     合成数据分成几个 base（缺省 12，模拟「一游戏一文件」）",
  "  --work      工作目录（缺省 os.tmpdir 下临时目录，跑完自动清理）",
  "  --iters     每项重复次数（缺省 5）"
].join("\n");

function parseArgs(argv) {
  const out = { iters: 5, bases: 12 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") out.dir = argv[++i];
    else if (a === "--synthetic") out.synthetic = Math.max(1, parseInt(argv[++i], 10) || 0);
    else if (a === "--bases") out.bases = Math.max(1, parseInt(argv[++i], 10) || 12);
    else if (a === "--work") out.work = argv[++i];
    else if (a === "--iters") out.iters = Math.max(1, parseInt(argv[++i], 10) || 5);
    else if (a === "-h" || a === "--help") out.help = true;
  }
  return out;
}

function ms(t0) { return Number(process.hrtime.bigint() - t0) / 1e6; }

function fmt(n) {
  if (n == null || Number.isNaN(n)) return "-";
  if (n >= 1000) return (n / 1000).toFixed(2) + "s";
  if (n >= 10) return n.toFixed(1) + "ms";
  return n.toFixed(2) + "ms";
}

function fmtMB(bytes) { return (bytes / 1048576).toFixed(1) + "MB"; }

/** 百分位（样本少时退化到最近值） */
function pct(samples, p) {
  const s = samples.slice().sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[i];
}

/** 重复执行一组，返回分布（min / p50 / avg / max） */
function timeIt(iters, fn) {
  const samples = [];
  for (let i = 0; i < iters; i++) {
    const t0 = process.hrtime.bigint();
    fn(i);
    samples.push(ms(t0));
  }
  const sum = samples.reduce((a, b) => a + b, 0);
  return {
    n: iters, min: Math.min.apply(null, samples), max: Math.max.apply(null, samples),
    p50: pct(samples, 50), avg: sum / samples.length
  };
}

function fmtDist(d) {
  return "min " + fmt(d.min) + " / p50 " + fmt(d.p50) + " / avg " + fmt(d.avg) + " / max " + fmt(d.max);
}

/** 合成一条记录（形态与真实索引一致：gb/local/name 三段 + 中等体积值） */
function synthRecords(baseIdx, count, out) {
  for (let i = 0; i < count; i++) {
    const h = (baseIdx.toString(16) + i.toString(16)).padStart(32, "0").slice(0, 32);
    const modId = String(100000 + baseIdx * 1000 + (i % 500));
    out.push({ t: "gb", k: h, v: { modId, modName: "Mod " + modId, author: "author" + (i % 40), game: "Game" + baseIdx, url: "https://gamebanana.com/mods/" + modId, fileName: "file_" + i + ".zip", gbMd5: h } });
    out.push({ t: "local", k: h, v: { modId, modDir: "<ROOT>/Game" + baseIdx + "/Mods/" + modId, file: "file_" + i + ".zip", hash: h, gbMd5: h, kind: "file" } });
    out.push({ t: "name", k: "file_" + i + ".zip", v: { modId, modName: "Mod " + modId, game: "Game" + baseIdx, fileName: "file_" + i + ".zip", kind: "file" } });
  }
}

/**
 * 准备数据：真实目录复制，或生成合成数据。
 *   ⚠ 只返回 base 名与**条数**，不在内存里留记录 —— 否则大 base 规模（几十万条）直接 OOM
 *   （实测 750k 条时把 V8 默认堆吃爆）。记录一律「用到哪个 base 才读哪个」。
 */
function prepareData(opts, workRoot) {
  const indexDir = path.join(workRoot, "index");
  fs.mkdirSync(indexDir, { recursive: true });
  const counts = new Map();

  if (opts.synthetic) {
    const per = Math.ceil(opts.synthetic / opts.bases);
    for (let b = 0; b < opts.bases; b++) {
      const recs = [];
      synthRecords(b, per, recs);
      const base = "Game" + b;
      jsonlStore.writeIndexAtomic(path.join(indexDir, base), { game: base, schema: 2 }, recs);
      counts.set(base, recs.length);
      recs.length = 0; // 及时释放，别把上一个 base 留着
    }
    return { indexDir, bases: [...counts.keys()], counts, source: "合成数据" };
  }

  const files = fs.readdirSync(opts.dir).filter((f) => f.endsWith(".jsonl") || f.endsWith(".json"));
  for (const f of files) fs.copyFileSync(path.join(opts.dir, f), path.join(indexDir, f));
  const bases = files.map((f) => f.replace(/\.jsonl?$/, "")).sort();
  for (const b of bases) {
    const r = jsonlStore.readIndex(path.join(indexDir, b));
    counts.set(b, Array.isArray(r.records) ? r.records.length : 0);
  }
  return { indexDir, bases, counts, source: "真实索引" };
}

/** 读单个 base 的记录（流式使用，用完即弃） */
function readBase(indexDir, base) {
  const r = jsonlStore.readIndex(path.join(indexDir, base));
  return Array.isArray(r.records) ? r.records : [];
}

/** 一次完整 load()：走生产同一个函数（读全部 base + 建三段 Map）
 *  必须先设 GBMD_JSON_DIR、再清缓存、才 require —— hash-index 在加载期就固化索引目录。
 */
function runLoad(indexDir) {
  const oldEnv = process.env.GBMD_JSON_DIR;
  process.env.GBMD_JSON_DIR = path.dirname(indexDir);
  const modPath = require.resolve("../server/lib/hash-index.js");
  delete require.cache[modPath];
  delete require.cache[require.resolve("../server/lib/index-store.js")];
  delete require.cache[require.resolve("../server/lib/jsonl-store.js")];
  try {
    const hi = require(modPath);
    hi.load();
    return hi.status();
  } finally {
    delete require.cache[modPath];
    if (oldEnv === undefined) delete process.env.GBMD_JSON_DIR;
    else process.env.GBMD_JSON_DIR = oldEnv;
  }
}

/** 改其中一条（模拟一次真实增量：某个文件的 hash/size 变了） */
function mutate(records) {
  const out = records.slice();
  const i = Math.floor(out.length / 2);
  out[i] = Object.assign({}, out[i], { v: Object.assign({}, out[i].v, { _benchTouched: Date.now() }) });
  return out;
}

function fileSize(p) { try { return fs.statSync(p).size; } catch (_) { return 0; } }

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || (!opts.dir && !opts.synthetic)) {
    process.stdout.write(USAGE + "\n");
    return opts.help ? 0 : 1;
  }
  if (opts.dir && !fs.existsSync(path.resolve(opts.dir))) {
    process.stdout.write("✗ 目录不存在：" + path.resolve(opts.dir) + "\n");
    return 1;
  }
  const probe = indexStore.probe();
  if (!probe.ok) {
    process.stdout.write("✗ " + probe.reason + "\n");
    return 1;
  }

  const workRoot = opts.work ? path.resolve(opts.work) : fs.mkdtempSync(path.join(os.tmpdir(), "idxbench-"));
  const cleanup = !opts.work;
  try {
    if (opts.dir) opts.dir = path.resolve(opts.dir);
    const data = prepareData(opts, workRoot);
    const { indexDir, bases, counts } = data;
    let totalRecords = 0;
    let jsonlBytes = 0;
    for (const b of bases) {
      totalRecords += counts.get(b);
      jsonlBytes += fileSize(path.join(indexDir, b + ".jsonl"));
    }
    let bigBase = bases[0];
    for (const b of bases) if (counts.get(b) > counts.get(bigBase)) bigBase = b;

    process.stdout.write("== 索引后端性能对比：JSONL vs SQLite ==\n");
    process.stdout.write("  数据来源: " + data.source + "\n");
    process.stdout.write("  规模    : " + bases.length + " 个 base / " + totalRecords + " 条 / jsonl " + fmtMB(jsonlBytes) + "\n");
    process.stdout.write("  最大 base: " + bigBase + "（" + counts.get(bigBase) + " 条）\n");
    process.stdout.write("  重复次数: " + opts.iters + "\n\n");

    // ① 启动加载
    const loadJsonl = timeIt(opts.iters, () => { runLoad(indexDir); });
    for (const b of bases) indexStore.writeIndexAtomic(path.join(indexDir, b), { game: b, schema: 2 }, readBase(indexDir, b));
    indexStore.closeDb();
    const loadSqlite = timeIt(opts.iters, () => { runLoad(indexDir); });
    indexStore.closeDb();

    // ② 单游戏增量写（只改 1 条）
    const bigTouched = mutate(readBase(indexDir, bigBase));
    const bigBasePath = path.join(indexDir, bigBase);
    const wJsonl = timeIt(opts.iters, () => {
      jsonlStore.writeIndexAtomic(bigBasePath, { game: bigBase, schema: 2 }, bigTouched);
    });
    const bigJsonlBytes = fileSize(bigBasePath + ".jsonl");
    const wSqlite = timeIt(opts.iters, () => {
      indexStore.writeIndexAtomic(bigBasePath, { game: bigBase, schema: 2 }, bigTouched);
    });
    indexStore.closeDb();

    // ③ 全库增量写（每 base 改 1 条）
    //   逐 base「读+改（不计时）→ 计时写 → 丢弃」，峰值只占一个 base 的内存；
    //   若把全部 base 的记录与副本都攥在手里，几十万条规模会直接 OOM（实测 750k 条爆堆）。
    const timeAllBases = (writeFn) => {
      const samples = [];
      for (let i = 0; i < opts.iters; i++) {
        let total = 0;
        for (const b of bases) {
          const touched = mutate(readBase(indexDir, b));
          const t0 = process.hrtime.bigint();
          writeFn(b, touched);
          total += ms(t0);
        }
        samples.push(total);
      }
      const sum = samples.reduce((a, b) => a + b, 0);
      return { n: opts.iters, min: Math.min.apply(null, samples), max: Math.max.apply(null, samples), p50: pct(samples, 50), avg: sum / samples.length };
    };
    const allJsonl = timeAllBases((b, touched) => {
      jsonlStore.writeIndexAtomic(path.join(indexDir, b), { game: b, schema: 2 }, touched);
    });
    const allSqlite = timeAllBases((b, touched) => {
      indexStore.writeIndexAtomic(path.join(indexDir, b), { game: b, schema: 2 }, touched);
    });
    indexStore.closeDb();

    // ④ 体积
    const dbSize = fileSize(indexStore.dbPathOf(indexDir));
    const walSize = fileSize(indexStore.dbPathOf(indexDir) + "-wal");
    let jsonlTotal = 0;
    for (const f of fs.readdirSync(indexDir)) if (f.endsWith(".jsonl")) jsonlTotal += fileSize(path.join(indexDir, f));

    const times = (a, b) => (b > 0 ? (a / b).toFixed(2) + "×" : "-");
    process.stdout.write("① 启动加载 load()（读全部 base + 建三段 Map）\n");
    process.stdout.write("   JSONL : " + fmtDist(loadJsonl) + "\n");
    process.stdout.write("   SQLite: " + fmtDist(loadSqlite) + "\n");
    process.stdout.write("   结论  : 载入速度比 = " + times(loadJsonl.p50, loadSqlite.p50) + "（>1 表示 SQLite 更快；两种后端都要全量读，预期接近）\n\n");

    process.stdout.write("② 单游戏增量写（" + bigBase + " / " + counts.get(bigBase) + " 条 / 只改 1 条）\n");
    process.stdout.write("   JSONL : " + fmtDist(wJsonl) + "   每次写 " + fmtMB(bigJsonlBytes) + "\n");
    process.stdout.write("   SQLite: " + fmtDist(wSqlite) + "   每次只 UPSERT 1 行\n");
    process.stdout.write("   结论  : p50 比 = " + times(wJsonl.p50, wSqlite.p50) + "\n\n");

    process.stdout.write("③ 全库增量写（" + bases.length + " 个 base，各改 1 条）\n");
    process.stdout.write("   JSONL : " + fmtDist(allJsonl) + "\n");
    process.stdout.write("   SQLite: " + fmtDist(allSqlite) + "\n");
    process.stdout.write("   结论  : p50 比 = " + times(allJsonl.p50, allSqlite.p50) + "\n\n");

    process.stdout.write("④ 落盘体积\n");
    process.stdout.write("   JSONL 合计: " + fmtMB(jsonlTotal) + "\n");
    process.stdout.write("   SQLite    : " + fmtMB(dbSize) + "（另有 WAL " + fmtMB(walSize) + "，会自动 checkpoint）\n");
    process.stdout.write("\n读法提示：写入看 min/p50；avg 会被 WAL 自动 checkpoint 的尖峰带偏。\n");
    return 0;
  } finally {
    indexStore.closeDb();
    if (cleanup) {
      try { fs.rmSync(workRoot, { recursive: true, force: true }); } catch (_) {}
    } else {
      process.stdout.write("\n（工作目录保留：" + workRoot + "）\n");
    }
  }
}

process.exitCode = main();
