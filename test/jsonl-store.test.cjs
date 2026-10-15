// test/jsonl-store.test.cjs —— 2026-10-15 新增
// JSONL 索引存储层 + 一次性迁移脚本的单测。
//
// 纪律：全部在 os.tmpdir() 的临时目录里造数据，不碰项目 json/、不联网、不依赖任何 npm 包。
// 覆盖面：解析容错 → 追加（O(1) 语义 + 粘行防护）→ 原子写 → 回收站 → 迁移（预演/执行/幂等）
//         → 两个 profile 的「新旧等价」深度比对 → iwara 只迁总表（sidecar 不动）。
const { makeLog, loggedTest } = require("./helpers/test-log.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// 同一份测试在两个位置跑：
//   组装后的项目里 → test/…，库在 server/lib/、脚本在 scripts/
//   模板仓库里     → templates/_downloader/test/…，库在 templates/js/server/lib/、脚本在 templates/tools/
// 两条候选路径都试，避免因布局差异跑不起来。
function pick(...cands) {
  for (const p of cands) {
    try { if (fs.existsSync(p)) return require(p); } catch (_) {}
  }
  throw new Error("找不到模块：" + cands.join(" | "));
}
const store = pick(
  path.join(__dirname, "..", "server", "lib", "jsonl-store.js"),
  path.join(__dirname, "..", "..", "js", "server", "lib", "jsonl-store.js")
);
const mig = pick(
  path.join(__dirname, "..", "scripts", "migrate-json-index-to-jsonl.cjs"),
  path.join(__dirname, "..", "..", "tools", "migrate-json-index-to-jsonl.cjs")
);

const log = makeLog("jsonl-store");

/** 建临时目录跑用例，结束后整棵删掉（测试零残留） */
function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jsonl-store-"));
  try { return fn(dir); } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

loggedTest(log, "parseJsonl：meta/记录分离，坏行计数跳过，兼容 BOM/CRLF/末行无换行", () => {
  const text = "\uFEFF{\"_\":\"meta\",\"game\":\"G\"}\r\n"
    + "{\"t\":\"gb\",\"k\":\"a\",\"v\":{\"n\":1}}\r\n"
    + "{这不是JSON}\r\n"
    + "{\"t\":\"name\",\"k\":\"b\",\"v\":2}";     // 末行没有换行
  const p = store.parseJsonl(text);
  assert.deepEqual(p.meta, { game: "G" });
  assert.equal(p.records.length, 2);
  assert.deepEqual(p.records[0], { t: "gb", k: "a", v: { n: 1 } });
  assert.equal(p.records[1].k, "b");
  assert.equal(p.badLines, 1, "坏行应计数且不中断解析");
  // 空文本 / 只有 meta
  assert.deepEqual(store.parseJsonl(""), { meta: {}, records: [], badLines: 0 });
  assert.equal(store.parseJsonl("{\"_\":\"meta\"}").records.length, 0);
});

loggedTest(log, "stringifyJsonl：往返一致，末行带换行，空数据得空串，缺 t/k 的记录被跳过", () => {
  const recs = [{ t: "gb", k: "a", v: { n: 1 } }, { t: "local", k: "b", v: "x" }];
  const text = store.stringifyJsonl({ game: "G", schema: 2 }, recs);
  assert.ok(text.endsWith("\n"), "最后一行必须有换行，否则追加会粘行");
  const back = store.parseJsonl(text);
  assert.deepEqual(back.records, recs);
  assert.deepEqual(back.meta, { game: "G", schema: 2 });
  assert.equal(store.stringifyJsonl({}, []), "");
  assert.equal(store.parseJsonl(store.stringifyJsonl({}, [{ t: "gb", k: "a" }])).records.length, 0, "缺 v 的记录应被跳过");
});

loggedTest(log, "mapOf：同段同键 last-wins（与整文件重写语义一致），段之间互不干扰", () => {
  const m = store.mapOf([
    { t: "gb", k: "a", v: 1 },
    { t: "gb", k: "a", v: 2 },      // 后写覆盖
    { t: "local", k: "a", v: 9 }    // 另一段，同名不冲突
  ], "gb");
  assert.equal(m.get("a"), 2);
  assert.equal(m.size, 1);
});

loggedTest(log, "readIndex：双读优先级 .jsonl > .json > none", () => {
  withTmp((dir) => {
    const base = path.join(dir, "Foo");
    assert.equal(store.readIndex(base).format, "none");
    // 只有旧格式
    fs.writeFileSync(base + ".json", JSON.stringify({ game: "Foo", gb: { a: 1 } }));
    const r1 = store.readIndex(base);
    assert.equal(r1.format, "json");
    assert.equal(r1.json.game, "Foo");
    assert.equal(r1.records.length, 0);
    // 两种都在 ⇒ 以 .jsonl 为准
    fs.writeFileSync(base + ".jsonl", store.stringifyJsonl({ game: "Foo" }, [{ t: "gb", k: "a", v: 1 }]));
    const r2 = store.readIndex(base);
    assert.equal(r2.format, "jsonl");
    assert.equal(store.mapOf(r2.records, "gb").get("a"), 1);
  });
});

loggedTest(log, "appendRecords：新建补 meta、追加不动旧内容、末尾缺换行自动补齐（防粘行）", () => {
  withTmp((dir) => {
    const base = path.join(dir, "Foo");
    const created = store.appendRecords(base, [{ t: "gb", k: "a", v: 1 }], { game: "Foo", schema: 2 });
    assert.ok(created.ok && created.created, "首次追加应建文件");
    let p = store.parseJsonl(fs.readFileSync(base + ".jsonl", "utf8"));
    assert.deepEqual(p.meta, { game: "Foo", schema: 2 });
    assert.equal(p.records.length, 1);

    // 手工把文件末尾换行去掉，再追加 —— 必须自动补 \n，否则两条会挤成一行
    fs.writeFileSync(base + ".jsonl", "{\"t\":\"gb\",\"k\":\"x\",\"v\":1}");
    const r = store.appendRecords(base, [{ t: "gb", k: "y", v: 2 }]);
    assert.ok(r.ok && r.created === false);
    p = store.parseJsonl(fs.readFileSync(base + ".jsonl", "utf8"));
    assert.equal(p.records.length, 2, "补换行后应是两条记录");
    assert.equal(p.badLines, 0, "不应产生坏行");
    assert.deepEqual(store.mapOf(p.records, "gb").get("y"), 2);
  });
});

loggedTest(log, "writeIndexAtomic：全量覆盖写、不留 .tmp 残留", () => {
  withTmp((dir) => {
    const base = path.join(dir, "Foo");
    store.appendRecords(base, [{ t: "gb", k: "old", v: 1 }], { game: "Foo" });
    const w = store.writeIndexAtomic(base, { game: "Foo" }, [{ t: "gb", k: "new", v: 2 }]);
    assert.ok(w.ok && w.bytes > 0);
    const p = store.readIndex(base);
    assert.equal(store.mapOf(p.records, "gb").has("old"), false, "覆盖写应替换旧内容");
    assert.equal(store.mapOf(p.records, "gb").get("new"), 2);
    assert.equal(fs.existsSync(base + ".jsonl.tmp"), false, "原子写的临时文件不应残留");
  });
});

loggedTest(log, "moveToTrash：是移动到回收站（可还原），不是删除", () => {
  withTmp((dir) => {
    const f = path.join(dir, "legacy.json");
    fs.writeFileSync(f, "{}");
    const mv = store.moveToTrash(f, path.join(dir, ".trash"));
    assert.ok(mv.ok, "移动应成功");
    assert.equal(fs.existsSync(f), false, "原位置应已不存在");
    assert.ok(fs.existsSync(mv.dest), "回收站里应能找到（可还原）");
  });
});

loggedTest(log, "migrateDir：预演不动盘；执行后旧文件进 .trash；已有 .jsonl 时不覆盖（幂等）", () => {
  withTmp((dir) => {
    const legacy = JSON.stringify({ game: "A", gb: { h1: { n: 1 } }, local: {}, name: {} });
    fs.writeFileSync(path.join(dir, "A.json"), legacy);
    const split = (obj) => mig.PROFILES.gbmd.split(obj);

    // ① 预演
    const dry = store.migrateDir({ dir, dryRun: true, match: mig.PROFILES.gbmd.match, split });
    assert.equal(dry.scanned, 1);
    assert.equal(dry.converted, 0);
    assert.equal(fs.existsSync(path.join(dir, "A.jsonl")), false, "预演不得写盘");
    assert.equal(fs.existsSync(path.join(dir, "A.json")), true, "预演不得动旧文件");

    // ② 执行
    const run1 = store.migrateDir({ dir, dryRun: false, match: mig.PROFILES.gbmd.match, split });
    assert.equal(run1.converted, 1);
    assert.equal(run1.failed, 0);
    assert.ok(fs.existsSync(path.join(dir, "A.jsonl")));
    assert.equal(fs.existsSync(path.join(dir, "A.json")), false, "旧文件应已移走");
    assert.equal(fs.readdirSync(path.join(dir, ".trash")).length, 1, "旧文件应进回收站（可恢复）");
    const before = fs.readFileSync(path.join(dir, "A.jsonl"), "utf8");

    // ③ 幂等：旧文件再次出现（例如回滚后重跑）时，已有 .jsonl 必须原样保留、不被覆盖
    fs.writeFileSync(path.join(dir, "A.json"), legacy);
    const run2 = store.migrateDir({ dir, dryRun: false, match: mig.PROFILES.gbmd.match, split });
    assert.equal(run2.converted, 0);
    assert.equal(run2.skipped, 1, "已有 .jsonl ⇒ 跳过");
    assert.equal(fs.readFileSync(path.join(dir, "A.jsonl"), "utf8"), before, ".jsonl 内容不得被覆盖");
    assert.equal(fs.existsSync(path.join(dir, "A.json")), true, "被跳过的旧文件保持原位");
  });
});

loggedTest(log, "gbmd profile：三段索引迁移后与原 JSON 逐键逐值等价（Map 深度比对）", () => {
  withTmp((dir) => {
    const legacy = {
      game: "Genshin Impact",
      gb: { h1: { modId: "1", fileName: "a.zip" }, h2: { modId: "2", fileName: "b.zip" } },
      local: { h1: { modDir: "/x/a", file: "a.zip", kind: "file" } },
      name: { "a.zip": { modId: "1" }, "b.zip": { modId: "2" } }
    };
    fs.writeFileSync(path.join(dir, "Genshin Impact.json"), JSON.stringify(legacy));

    // full 校验：连回拼对象都要等价（稳定序列化比对）
    const r = mig.run({ dir, profile: "gbmd", dryRun: false, verify: "full" });
    assert.ok(r.ok, "迁移应成功: " + JSON.stringify(r.errors));
    assert.equal(r.converted, 1);
    assert.equal(r.badLines, 0);

    const idx = store.readIndex(path.join(dir, "Genshin Impact"));
    assert.equal(idx.format, "jsonl");
    assert.equal(idx.meta.game, "Genshin Impact");
    for (const sec of ["gb", "local", "name"]) {
      const got = store.mapOf(idx.records, sec);
      const want = new Map(Object.entries(legacy[sec]));
      assert.deepEqual([...got.entries()].sort(), [...want.entries()].sort(), sec + " 段应逐键逐值一致");
    }
  });
});

loggedTest(log, "iwara profile：只迁总表（sidecar 不动），扁平与包裹两种形态都正确", () => {
  withTmp((dir) => {
    const flat = { vid1: { title: "T1", username: "u1" }, vid2: { title: "T2" } };
    fs.writeFileSync(path.join(dir, "iwara-index.json"), JSON.stringify(flat));
    fs.writeFileSync(path.join(dir, "vid1.json"), JSON.stringify({ vid1: flat.vid1 }));   // sidecar
    fs.writeFileSync(path.join(dir, "video-file.json"), "{}");                            // 其它 json 也不该被迁

    const r = mig.run({ dir, profile: "iwara", dryRun: false, verify: "full" });
    assert.ok(r.ok, "迁移应成功: " + JSON.stringify(r.errors));
    assert.equal(r.scanned, 1, "只应扫描到总表一个文件");
    assert.equal(r.converted, 1);

    assert.ok(fs.existsSync(path.join(dir, "vid1.json")), "sidecar 必须保持 .json 不动");
    assert.ok(fs.existsSync(path.join(dir, "video-file.json")), "非总表的 json 不得被迁移");
    const idx = store.readIndex(path.join(dir, "iwara-index"));
    assert.equal(idx.format, "jsonl");
    const map = store.mapOf(idx.records, "video");
    assert.deepEqual([...map.keys()].sort(), ["vid1", "vid2"]);
    assert.equal(map.get("vid1").title, "T1");

    // 包裹形态 {videos:{...}} 也要能正确拆合
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "jsonl-store-w-"));
    try {
      fs.writeFileSync(path.join(dir2, "iwara-index.json"), JSON.stringify({ schema: "iwara-index/1", videos: flat }));
      const r2 = mig.run({ dir: dir2, profile: "iwara", dryRun: false, verify: "full" });
      assert.ok(r2.ok, "包裹形态迁移应成功: " + JSON.stringify(r2.errors));
      const idx2 = store.readIndex(path.join(dir2, "iwara-index"));
      assert.equal(idx2.meta.shape, "wrapped");
      assert.equal(store.mapOf(idx2.records, "video").size, 2);
    } finally { try { fs.rmSync(dir2, { recursive: true, force: true }); } catch (_) {} }
  });
});

loggedTest(log, "run：缺参数/未知 profile 时安全返回（不抛错，供启动流程直接调用）", () => {
  const bad = mig.run({ dir: "/tmp", profile: "nope" });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /未知 profile/);
  const noDir = mig.run({ profile: "gbmd" });
  assert.equal(noDir.ok, false);
  assert.match(noDir.error, /缺少 --dir/);
  // 目录不存在：不抛错，报失败并说明
  const missing = mig.run({ dir: "/tmp/definitely-not-a-dir-" + Date.now(), profile: "gbmd", dryRun: true });
  assert.equal(missing.ok, false);
});
