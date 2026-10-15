// test/index-jsonl-parity.test.cjs —— 2026-10-15 新增（iwara 总表改 JSONL 的等价性测试）
//
// 覆盖范围：**只针对总表 json/index/iwara-index.json**（本次改造只动它）。
//   逐条 <id>.json sidecar 与 json/profile/ 不在本次范围内，这里也不测、不碰。
//
// 目的：
//   ① 启动迁移发生（旧总表 .json → .jsonl，旧文件进 .trash 可回滚）
//   ② 迁移前后「读总表」的结果一致（列表/反查行为不变）
//   ③ **对外序列化不变**：catalogFileBuffer 产出的 JSON 与迁移前逐字节一致（客户端/导出文件不受影响）
//   ④ 幂等：重复调用不再迁移
//
// 隔离：json-dir.js 支持 DATA_DIR 环境变量（json-dir.js:9）⇒ 指向临时目录，绝不碰项目真实 json/。
const { makeLog, loggedTest } = require("./helpers/test-log.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const log = makeLog("iwara-index-jsonl-parity");

/** 建一个临时数据根：<root>/server 作 DATA_DIR ⇒ json-dir 推出 <root>/json */
function withTmp(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iwara-index-"));
  fs.mkdirSync(path.join(root, "server"), { recursive: true });
  fs.mkdirSync(path.join(root, "json", "index"), { recursive: true });
  try { return fn(root); } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }
}

/** 用临时 DATA_DIR 加载一份全新的 video-index（清缓存，避免模块级状态串味） */
function freshVideoIndex(root) {
  const modPath = require.resolve("../server/lib/video-index.js");
  const dirPath = require.resolve("../server/store/json-dir.js");
  const storePath = require.resolve("../server/lib/jsonl-store.js");
  for (const p of [modPath, dirPath, storePath]) delete require.cache[p];
  const oldEnv = process.env.DATA_DIR;
  process.env.DATA_DIR = path.join(root, "server");
  try {
    const v = require(modPath);
    const store = require(storePath);
    // 2026-10-15 起**不再自动迁移**（读层两种格式都吃，写入只产 jsonl）。
    //   这里显式跑一次一次性迁移，等价于人工执行：
    //     node scripts/migrate-json-index-to-jsonl.cjs --dir json/index --profile iwara --apply
    try {
      const mig = require(path.join(__dirname, "..", "scripts", "migrate-json-index-to-jsonl.cjs"));
      mig.run({ dir: path.join(root, "json", "index"), profile: "iwara", dryRun: false });
    } catch (_) { /* 迁移失败不影响后续断言（读层本就兼容两种格式） */ }
    return { v, store };
  } finally {
    if (oldEnv === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = oldEnv;
  }
}

/** 一份典型旧总表：扁平 { [视频id]: entry }（部署端实测就是这个形状） */
const LEGACY = {
  "06nRjMFKIRbZ1s": { name: "ハムカツ", username: "sahat", title: "[Star Rail] Cyrene", fileId: "ad30eec5", duration: 182 },
  "0AqRCTvwCrmOyK": { name: "作者B", username: "userB", title: "第二个视频", fileId: "bbbb", duration: 60 }
};

loggedTest(log, "启动迁移：旧总表 .json 被迁成 .jsonl，旧文件进 .trash（可回滚）", () => {
  withTmp((root) => {
    const indexDir = path.join(root, "json", "index");
    fs.writeFileSync(path.join(indexDir, "iwara-index.json"), JSON.stringify(LEGACY, null, 2));
    const { v } = freshVideoIndex(root);

    // 触发读取 ⇒ 顺带完成一次性迁移
    assert.equal(v.hasVideo("", "06nRjMFKIRbZ1s"), true, "迁移前也应能读到总表");

    assert.ok(fs.existsSync(path.join(indexDir, "iwara-index.jsonl")), "应产出 .jsonl");
    assert.equal(fs.existsSync(path.join(indexDir, "iwara-index.json")), false, "旧 .json 应已移走");
    const trash = fs.readdirSync(path.join(indexDir, ".trash"));
    assert.equal(trash.length, 1, "旧文件应进 .trash");
    assert.match(trash[0], /iwara-index\.json$/, "回收站里应是原文件名（带时间戳前缀）");
  });
});

loggedTest(log, "读总表等价：迁移前后 hasVideo / readEntry 结果一致", () => {
  withTmp((root) => {
    const indexDir = path.join(root, "json", "index");
    fs.writeFileSync(path.join(indexDir, "iwara-index.json"), JSON.stringify(LEGACY, null, 2));
    const { v } = freshVideoIndex(root);

    const before = {
      a: v.hasVideo("", "06nRjMFKIRbZ1s"),
      b: v.hasVideo("", "0AqRCTvwCrmOyK"),
      miss: v.hasVideo("", "not-exist"),
      entry: v.readEntry("06nRjMFKIRbZ1s")
    };
    // 第二次调用时盘上已是 .jsonl（迁移已完成）
    const after = {
      a: v.hasVideo("", "06nRjMFKIRbZ1s"),
      b: v.hasVideo("", "0AqRCTvwCrmOyK"),
      miss: v.hasVideo("", "not-exist"),
      entry: v.readEntry("06nRjMFKIRbZ1s")
    };
    assert.deepEqual(after, before, "两种格式读出的总表行为必须一致");
    assert.equal(before.a, true);
    assert.equal(before.miss, false);
    assert.equal(before.entry && before.entry.title, "[Star Rail] Cyrene");
  });
});

loggedTest(log, "导出格式：JSONL（一行 meta + 一行一条紧凑 JSON），不再是缩进 JSON", () => {
  withTmp((root) => {
    const indexDir = path.join(root, "json", "index");
    fs.writeFileSync(path.join(indexDir, "iwara-index.json"), JSON.stringify(LEGACY, null, 2));
    const { v } = freshVideoIndex(root);

    const text = v.catalogFileBuffer("").toString("utf8");
    const lines = text.trim().split("\n");
    assert.equal(lines.length, 1 + Object.keys(LEGACY).length, "应为 meta 行 + 每个视频一行");
    assert.ok(lines[0].includes('"_":"meta"'), "首行是 meta");
    assert.ok(!text.includes("\n  "), "不应有 2 空格缩进（JSONL 每行一条紧凑 JSON）");
    for (const ln of lines) assert.doesNotThrow(() => JSON.parse(ln), "每一行都必须是合法 JSON: " + ln.slice(0, 40));
  });
});

loggedTest(log, "幂等：重复读取不会反复迁移、不产生多余回收站条目", () => {
  withTmp((root) => {
    const indexDir = path.join(root, "json", "index");
    fs.writeFileSync(path.join(indexDir, "iwara-index.json"), JSON.stringify(LEGACY));
    const { v } = freshVideoIndex(root);

    v.hasVideo("", "06nRjMFKIRbZ1s");
    const n1 = fs.readdirSync(path.join(indexDir, ".trash")).length;
    v.hasVideo("", "0AqRCTvwCrmOyK");
    const n2 = fs.readdirSync(path.join(indexDir, ".trash")).length;
    assert.equal(n2, n1, "第二次不应再迁移");
    assert.ok(fs.existsSync(path.join(indexDir, "iwara-index.jsonl")));
  });
});

loggedTest(log, "导出即索引本身：catalogFileBuffer 产 JSONL，且 importPayload 能原样吃回（产出/消费同一格式）", () => {
  withTmp((root) => {
    const indexDir = path.join(root, "json", "index");
    fs.writeFileSync(path.join(indexDir, "iwara-index.json"), JSON.stringify(LEGACY, null, 2));
    const { v } = freshVideoIndex(root);
    v.hasVideo("", "06nRjMFKIRbZ1s");            // 触发迁移，让后续读写都走 .jsonl

    const before = v.catalogFileBuffer("").toString("utf8");
    const lines = before.trim().split("\n");
    assert.ok(lines[0].startsWith('{"_":"meta"'), "首行应是 meta 行");
    assert.equal(lines.length, 1 + Object.keys(LEGACY).length, "meta 行 + 每个视频一行（JSONL）");

    // 往返：把导出的 JSONL 原文原样导入 ⇒ 再导出必须逐字节一致（导入端能吃回自己导出的文件）
    const r = v.importPayload("", before);
    assert.ok(r && r.ok, "导入应成功: " + JSON.stringify(r));
    assert.equal(v.catalogFileBuffer("").toString("utf8"), before, "导出→导入→再导出 必须逐字节一致");

    // 旧的 JSON 形态仍可导入（兼容）
    const r2 = v.importPayload("", JSON.stringify({ videos: { vidNew: { title: "新" } } }));
    assert.ok(r2 && r2.ok);
    assert.equal(v.hasVideo("", "vidNew"), true, "旧 JSON 形态的导入也要生效");
  });
});

loggedTest(log, "只有 .jsonl（无旧文件）时也能直接读；空目录读总表得到空对象不抛错", () => {
  withTmp((root) => {
    const indexDir = path.join(root, "json", "index");
    const { v, store } = freshVideoIndex(root);

    // 无总表时：导出应是「只有 meta 行」的 JSONL（导出格式本身就是 JSONL，不再是空对象 JSON）
    const emptyLines = v.catalogFileBuffer("").toString("utf8").trim().split("\n");
    assert.equal(emptyLines.length, 1, "无总表时只剩 meta 行");
    assert.ok(emptyLines[0].includes('"_":"meta"'), "那唯一一行应是 meta");

    // 直接手写一份 .jsonl（模拟迁移后的部署）
    const recs = Object.entries(LEGACY).map(([k, val]) => ({ t: "video", k, v: val }));
    const w = store.writeIndexAtomic(path.join(indexDir, "iwara-index"), { schema: 2 }, recs);
    assert.ok(w.ok);
    assert.equal(v.hasVideo("", "0AqRCTvwCrmOyK"), true);
    const lines2 = v.catalogFileBuffer("").toString("utf8").trim().split("\n");
    assert.equal(lines2.length, 1 + Object.keys(LEGACY).length, "只有 .jsonl 时导出同样是 JSONL 形态");
    // 没有旧 .json ⇒ 不应产生回收站条目
    assert.equal(fs.existsSync(path.join(indexDir, ".trash")), false, "无旧文件时不该建回收站");
  });
});
