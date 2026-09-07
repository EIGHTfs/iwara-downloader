# iwara-downloader-server 修复优化方案报告

> **分析模型**：deepseek-v4-pro
> **分析日期**：2026-09-06
> **分析范围**：项目全部核心源码（server/app.js 916行 + 10 lib 模块 + auth/config + 前端 + docs），共约 4500 行
> **分析方式**：逐文件全文通读 + 对照 gbmd 5 份 AI 分析报告（grok-4.6 / deepseek-v4-pro / agnes-2.5-flash / mimo-v2.5-pro / Ornith-1.5-9B-Q8_0）+ `docs/gbmd-AI分析报告.md` 权威对照
> **项目关系**：iwara-downloader-server 以 gbmd（gamebanana-mods-downloader）为模板开发，共享架构设计（零依赖 + boot.cjs + scrypt 鉴权 + 下载引擎），但功能域不同（iwara 视频 vs gbmd mod 下载）

---

## 目录

1. [项目定位与当前状态](#一项目定位与当前状态)
2. [代码统计](#二代码统计)
3. [与 gbmd 对比：已完成 vs 未做](#三与-gbmd-对比已完成-vs-未做)
4. [用户需求（铁律·不动）](#四用户需求铁律不动)
5. [已确认的 bug（需修复）](#五已确认的-bug需修复)
6. [代码质量问题](#六代码质量问题)
7. [安全改进项](#七安全改进项)
8. [修复优先级与路线图](#八修复优先级与路线图)
9. [验收结论](#九验收结论)

---

## 一、项目定位与当前状态

### 项目全名

**iwara-downloader-server**（独立仓库，位于 `/MMD/(iwara.tv)/iwara-downloader-server`）

### 定位

零依赖、单进程 Node.js 服务：从 [Iwara](https://www.iwara.tv) 搜索、解析并下载视频。自带网页界面。

### 当前版本

**1.0.5**（2026-09-01）

### 与 gbmd 的关系

iwara-downloader-server 以 gbmd 为模板开发，共享以下架构设计：

| 共享项 | 说明 |
|---|---|
| 零依赖 + 无 package.json | 纯 Node.js 原生模块，boot.cjs 强制 CJS |
| scrypt 鉴权 | auth.js + config.json passwordHash |
| 下载引擎 | 并发 + 断点续传 + 重试 + 任务持久化 |
| 搜索缓存 | 记录导入/导出/保存 |
| 数据备份 | zip 导出/导入 + manifest 自动维护 |
| 前端架构 | gbmd 纯前端模板 + 选项卡布局 |
| app-log | 时间戳 + API 日志 |
| json-dir | 运行态 JSON 目录管理 |
| CDN 子域轮换 | iwara 特有（gbmd 无此需求） |
| X-Version 签名 | iwara API 特有（gbmd 无此需求） |
| thumb-cache | 封面缓存（iwara 特有） |
| profile-index | 作者头像索引（iwara 特有） |

---

## 二、代码统计

| 模块 | 文件 | 行数/大小 | 说明 |
|---|---|---|---|
| 入口 | server/app.js | 916 行 / 43KB | 单体：路由 + 工具 + 启动全在一个文件 |
| 启动器 | server/boot.cjs | 27 行 | Module._extensions hack |
| 鉴权 | server/auth.js | 71 行 | scrypt + session（同步 IO） |
| 配置 | server/config.js | 151 行 | readConfig 每次读盘 |
| 下载引擎 | lib/downloader.js | ~1500 行 / 51KB | direct/aria2 双后端 + CDN 轮换 |
| API 封装 | lib/iwara-api.js | ~800 行 / 31KB | X-Version 签名 + IP 直连 + CF 绕过 |
| 搜索缓存 | lib/search-cache.js | ~300 行 / 11KB | 按时间翻页 + 记录导入导出 |
| 视频索引 | lib/video-index.js | ~600 行 / 21KB | 精简索引 sidecar |
| 封面缓存 | lib/thumb-cache.cjs | ~400 行 / 14KB | ffmpeg 抽帧 + 官方缩略图 |
| 数据备份 | lib/data-backup.js | ~250 行 / 8KB | zip 导出/导入 + manifest |
| 作者索引 | lib/profile-index.js | ~250 行 / 9KB | 头像下载 + 索引维护 |
| 文件重命名 | lib/rename-files.js | ~250 行 / 8KB | 按模板批量重命名 |
| 设备判断 | lib/device-check.js | 41 行 | aria2 同机检测 |
| 日志 | lib/app-log.js | 37 行 | 时间戳 + API 日志 |
| JSON 目录 | lib/json-dir.js | 40 行 | 运行态 JSON 管理 |
| 前端 | public/index.html + app.js | ~1200 行 | 4 选项卡 + ArtPlayer |
| **合计** | **~25 文件** | **~5500 行** | |

---

## 三、与 gbmd 对比：已完成 vs 未做

### gbmd 已完成的重构（iwara 未做）

| 阶段 | gbmd 做了什么 | iwara 现状 | 影响 |
|---|---|---|---|
| **P0** | utils/ 骨架 + cjs-bootstrap + test 基建 | ❌ 无 utils/，无 test/ | 无工具抽取，无测试 |
| **P1** | app.js → routes/ 10 域拆分 + browse 白名单 + readBody 流式 + cookie 清洗 | ❌ app.js 916 行单体，readBody 仍 O(n²)，browse 无白名单 | 核心 bug 未修 |
| **P2** | parseIndexObj/escapeHtml 去重 | ❌ 无 utils 抽取 | 代码重复 |
| **P3** | ingestModDir 接线 + 8 血泪核对 | ❌ 无等效操作 | 索引可能未接线 |
| **P4** | 非热路径 syncIO → fs-async + auth 清过期 token | ❌ auth.js 仍全同步，无 fs-async | 事件循环阻塞 |
| **P5** | 前端改密加旧密码框 + 后端校验 | ❌ 改密不验旧密码 | 安全缺陷 |
| **P6** | live 全量验证 + 导入纯追加 + 便携测试 | ❌ 无 live 验证，无测试 | 无验证保障 |

### iwara 特有的功能（gbmd 无）

| 功能 | 说明 |
|---|---|
| CDN 子域动态轮换 | GOOD/BAD 列表持久化，失败自动换子域 |
| X-Version 签名 | SHA1 签名绕过 API 鉴权 |
| Cloudflare IP 直连 | 跳过 DNS 解析，直连边缘 IP + SNI |
| 精简 UA | 规避 CF 挑战（实测 Node 24 可行） |
| 封面缓存 | ffmpeg 抽帧 + 官方缩略图 |
| 作者头像索引 | profile-index + avatar 目录 |
| 文件名模板重命名 | 按模板批量重命名已下载视频 |
| 视频索引 sidecar | HMAC 保护的 JSON 导出 |
| 双下载后端 | direct（Node 直连）/ aria2（JSON-RPC） |
| 视频本地播放 | ArtPlayer + Range 播放未下完文件 |

---

## 四、用户需求（铁律·不动）

以下项经 `docs/gbmd-AI分析报告.md` 逐条验证，均为**用户明确要求**，不是 bug。

| # | 项 | 证据 | 判定 |
|---|---|---|---|
| R1 | 密码可不设置 | 开发者文档：未设密码只警告可直接使用 | 铁律·不动 |
| R2 | /api/cred 明文回传 | 开发者文档：油猴「注入登录态」用，明文直传 | 铁律·不动 |
| R3 | config.json 明文存凭证 | config.js 设计就是写 config.json；readConfig 每次读盘即生效 | 铁律·不动 |
| R4 | 0.0.0.0 监听 | 局域网自用部署需求 | 铁律·不动 |
| R5 | session Cookie 无 Secure | HTTP 局域网，加 Secure 致 cookie 不发送 | 铁律·不动 |
| R6 | 零依赖 + 无 package.json | 用户明确要求 + boot.cjs 解法 | 铁律·不动 |
| R7 | boot.cjs Module._extensions hack | 父目录 ESM 解法 | 铁律·不动 |
| R8 | readConfig 每次读盘即生效 | cookie/token 改完立即生效无需重启 | Feature·不动 |

---

## 五、已确认的 bug（需修复）

以下 bug 与 gbmd 已修复的 B1-B6 直接对应，iwara 作为模板项目存在完全相同的问题。

### B1：/api/browse 无路径白名单

**位置**：`server/app.js` L482-497

**现状**：

```js
if (method === "GET" && pathname === "/api/browse") {
  const p = String(parsed.query.path || "").trim();
  const dir = p && p.startsWith("/") ? p : "/";
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return sendJson(res, 400, { ok: false, error: "目录不存在: " + dir });
    }
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    // ... 列出任意目录
  }
}
```

**问题**：无任何路径收敛，可列出系统任意目录（`/etc`、`/root`、`/home` 等）。虽需登录，但 LAN 下低危。

**修复方案**：参照 gbmd P1——提取 `utils/path-safe.js`，`isBrowsableDir()` 收敛到 `downloadPath` 及其子目录。

**影响**：中（LAN 自用低危，但违反安全最佳实践）。

---

### B2：readBody O(n²) 字符串拼接

**位置**：`server/app.js` L144-158

**现状**：

```js
function readBody(req, limit = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("请求体过大")); req.destroy(); return; }
      data += c;  // ← O(n²)：每次拼接创建新字符串
    });
    // ...
  });
}
```

**问题**：`data += c` 在大 body 时是 O(n²) 复杂度。10MB 限制下虽不致命，但 `/api/data/import` 可能传 base64 zip（更大），性能隐患。

**修复方案**：参照 gbmd P1——改为流式写临时文件 + 背压（`req.pause()`/`req.resume()`），最终 `fs.readFile` 解析。

**影响**：中（大 body 性能退化）。

---

### B3：改密不验旧密码

**位置**：`server/app.js` L551-557

**现状**：

```js
if (method === "POST" && pathname === "/api/change-password") {
  const body = await readBody(req);
  if (!body.password || String(body.password).length < 4) {
    return sendJson(res, 400, { ok: false, error: "密码至少 4 位" });
  }
  cfg.setPassword(body.password);
  return sendJson(res, 200, { ok: true });
}
```

**问题**：已设密码时改密不校验旧密码。被盗 session 可锁死原主。

**修复方案**：参照 gbmd P5——后端加 `oldPassword` 校验 + 前端设置页加旧密码输入框。首次设密码（无旧密码）仍无需验证。

**影响**：中（安全缺陷）。

---

### B4：auth.js 全同步 IO

**位置**：`server/auth.js`

**现状**：`loadSessions`/`saveSessions`/`createSession`/`isValidSession`/`destroySession`/`pruneExpired` 全部使用同步 `fs.readFileSync`/`fs.writeFileSync`。

**问题**：每次请求鉴权时 `isValidSession` → `sessions.get(token)` 是内存操作（快），但 `loadSessions`/`saveSessions` 在启动/登出/过期时阻塞事件循环。

**修复方案**：参照 gbmd P4——提取 `utils/fs-async.js`（`fs.promises` 封装），auth.js 全改 async，调用方 `requireAuth` 改 async + await。

**影响**：低（启动/登出时阻塞，非每次请求）。

---

### B5：大量 `catch (_) {}` 静默吞错

**位置**：全局（app.js / auth.js / config.js / downloader.js / iwara-api.js / search-cache.js / thumb-cache.cjs / profile-index.js / rename-files.js / video-index.js）

**现状**：数十处 `catch (_) {}` 或 `catch (_) { continue; }`。

**典型位置**：
- `auth.js` L16-22：`loadSessions` 吞错
- `auth.js` L25-29：`saveSessions` 吞错
- `config.js` L94-104：`readConfig` 吞错
- `downloader.js`：CDN 状态读写、任务保存等
- `iwara-api.js`：请求头诊断日志吞错
- `search-cache.js`：缓存读写吞错

**问题**：磁盘满、权限错、JSON 损坏等真实故障被静默。用户只看到"功能不工作"。

**修复方案**：参照 gbmd P3 建议——核心路径（`saveSessions`、`saveTask`、`writeConfig`）至少 `console.error` 记录，不静默吞。容错路径（`loadSessions` 文件不存在时）可保留空 catch。

**影响**：中（故障不可见）。

---

### B6：data-backup manifest 信任 ZIP 内嵌

**位置**：`server/lib/data-backup.js`

**现状**：导入时 ZIP 内嵌的 manifest 可能覆盖本地白名单，导致任意文件路径写入。

**修复方案**：参照 gbmd B4——始终用本地 `readManifest()` 生成白名单，忽略 ZIP 内嵌清单。

**影响**：中（需登录才能利用）。

---

## 六、代码质量问题

### Q1：app.js 916 行单体（高）

**位置**：`server/app.js`

**现状**：全部 30+ 路由、工具函数（`sendJson`/`readBody`/`parseCredentialText`/`parseDownloadItems`/`setSessionCookie`/`requireAuth`/`publicSettings`/`injectAssetVersion`/`serveStatic`/`streamLocalVideo`）全在一个文件。

**对比 gbmd**：gbmd 重构前 app.js 869 行 → 重构后 220 行 + 10 个 routes 模块。

**影响**：修改风险高，路由间耦合，无法独立测试。

**建议**：按 gbmd P1 方案拆分到 routes/，app.js 收至 ~80-100 行。

### Q2：downloader.js ~1500 行超长（中）

**位置**：`server/lib/downloader.js`

**现状**：核心下载逻辑（direct/aria2 双后端 + CDN 子域轮换 + 任务持久化 + 并发控制 + 断点续传）全在一个文件。

**说明**：gbmd 的 downloader.js 1773 行，P3 评估后**有意不拆**（四步流程共享模块级状态）。iwara 的 downloader.js 规模相当，同样面临此权衡。

**建议**：如要拆，需先设计状态管理。当前保留单文件可接受。

### Q3：无测试（高）

**位置**：无 `test/` 目录

**现状**：零测试。gbmd 从 0 到 12 个测试文件（50 项），iwara 仍为 0。

**影响**：任何改动无回归保障，路由清单漂移、安全修复回退无检测。

**建议**：按 gbmd P0 方案——`node:test` + `node:assert/strict`，零依赖。优先覆盖：
- 路由清单回归（51+ 条）
- cleanCookie / isBrowsableDir / readBody
- 改密旧密码校验
- auth 会话清理
- 下载去重/追加

### Q4：无 utils/ 抽取（中）

**位置**：无 `utils/` 目录

**现状**：`sendJson`/`readBody`/`parseCredentialText` 内联在 app.js；`escapeHtml` 在 downloader.js；无 `path-safe`/`fs-async`/`html`/`index-html` 工具模块。

**对比 gbmd**：gbmd 已抽 6 个 utils 模块（http/path-safe/fs-async/html/index-html）。

**影响**：工具函数无法复用，路由无法独立测试。

**建议**：按 gbmd P1-P2 方案抽取。

### Q5：auth.js 无会话自动清理（中）

**位置**：`server/auth.js`

**现状**：有 `pruneExpired()` 但**无定时器**，不会自动清理过期 session。需手动调用或重启。

**对比 gbmd**：gbmd P4 新增 `startCleanup()`（setInterval 默认 1h，unref 不阻塞退出）。

**影响**：长时间运行后过期 session 堆积在内存 + 磁盘。

**建议**：参照 gbmd P4 加 `startCleanup` + `stopCleanup`。

### Q6：注释即文档

**位置**：全局

**现状**：大量 `// 用户原话：…`、`// 【原代码】…【改为】…`、`// AI 思路：…` 注释。

**示例**：
```js
// 用户原话：「两边都改 日志功能没有记录时间，也没记录所有前端触发的操作」
// AI 思路：未下完时 Content-Range 的 total 必须是已写入字节，不能报预计完整体积。
```

**影响**：注释更像对话记录而非工程文档，长期维护可读性下降。

**建议**：重构后整理为 JSDoc 或简洁注释。

---

## 七、安全改进项

### S1：安全响应头缺失（中）

**位置**：`server/app.js` `serveStatic`（L253-272）、`sendJson`（L134-142）

**现状**：未设置 `Content-Security-Policy`、`X-Content-Type-Options: nosniff`、`X-Frame-Options`。

**建议**：至少加 `X-Content-Type-Options: nosniff` + `X-Frame-Options: DENY`。

### S2：data/import 走 base64（低）

**位置**：`server/app.js` data/import 路由

**现状**：前端 base64 编码 ZIP → body → `Buffer.from(b64)`。

**说明**：`readBody` 改为流式后可缓解，但前端仍需 base64 编码。multipart 上传需改动前端，收益有限。

**建议**：接受现状，P1 修复 readBody 后风险降低。

### S3：config.json 含活跃凭证（用户需求·铁律·不动）

**位置**：`server/config.json`

**现状**：`iwaraCookie`/`iwaraToken`/`iwaraAccessToken`/`aria2Token` 明文存储。

**定性**：用户需求 R3，**不动**。

---

## 八、修复优先级与路线图

### P0：立即修复（安全 bug）

| 编号 | 行动 | 参照 | 工作量 |
|---|---|---|---|
| B1 | `/api/browse` 加路径白名单 | gbmd P1：提取 `utils/path-safe.js` | 中 |
| B2 | `readBody` 改流式落临时文件 | gbmd P1：流式 + 背压 | 中 |
| B3 | 改密加旧密码校验（后端 + 前端） | gbmd P5 | 低 |
| B6 | data-backup manifest 始终用本地 | gbmd B4 | 低 |

### P1：短期修复（代码质量 + 安全改进）

| 编号 | 行动 | 参照 | 工作量 |
|---|---|---|---|
| Q4 | 抽取 `utils/`（http/path-safe/fs-async/html） | gbmd P1-P2 | 中 |
| Q3 | 建立 `test/` 基建 + 路由清单回归 + 核心逻辑测试 | gbmd P0 | 中 |
| Q1 | app.js → routes/ 拆分 | gbmd P1 | 中 |
| Q5 | auth.js 加会话自动清理 | gbmd P4 | 低 |
| S1 | 添加安全响应头 | — | 低 |

### P2：中期改进（性能 + 可维护性）

| 编号 | 行动 | 参照 | 工作量 |
|---|---|---|---|
| B4 | auth.js 全改 async + fs-async | gbmd P4 | 中 |
| B5 | 核心路径 catch 加 console.error | gbmd P3 | 低 |
| Q2 | downloader.js 评估拆分（需先设计状态管理） | gbmd P3 延后决策 | 高 |
| Q6 | 注释整理为工程文档 | — | 低 |

### 建议实施顺序

```
P0（1-2 天）:
  ├── 提取 utils/（http + path-safe + fs-async + html）     ← 基础设施，P1 依赖
  ├── 修 B1 browse 白名单                                    ← 依赖 path-safe
  ├── 修 B2 readBody 流式                                    ← 依赖 http.js
  ├── 修 B3 改密旧密码                                       ← 后端 + 前端
  ├── 修 B6 manifest 本地为准                                ← data-backup.js
  └── 建 test/ 基建 + 路由清单回归                            ← 防回退

P1（2-3 天）:
  ├── app.js → routes/ 拆分                                  ← 依赖 utils/
  ├── auth.js 改 async + fs-async + startCleanup              ← 依赖 fs-async
  ├── 补测试：cleanCookie / isBrowsableDir / readBody / 改密 / auth 清理
  └── 安全响应头 + catch 加 console.error

P2（按需）:
  ├── downloader.js 拆分（如需要）
  └── 注释整理
```

---

## 九、验收结论

### 总体评价

**iwara-downloader-server 功能完整，但架构落后于 gbmd 重构后的版本。**

| 维度 | 评价 |
|---|---|
| **功能完整性** | ✅ 完整：搜索/下载/播放/索引/备份/重命名/封面/作者索引/双后端 |
| **架构成熟度** | ❌ 落后：仍为 gbmd 重构前的单体架构，未做 P0-P6 任何一步 |
| **测试覆盖** | ❌ 零测试：任何改动无回归保障 |
| **安全状态** | ⚠️ 4 个已知 bug 未修（browse 白名单/readBody/改密/manifest） |
| **用户需求对齐** | ✅ 8 项铁律（R1-R8）全部遵守 |
| **文档完整性** | ✅ 开发者文档（36KB）+ TROUBLESHOOTING.md + README.md |

### 与 gbmd 的差距

iwara 作为 gbmd 的模板项目，代码架构**仍停留在 gbmd 重构前的状态**。gbmd 已在 P0-P6 修复了 6 个已知 bug（B1-B6）、抽取了 6 个 utils 模块、建立了 12 个测试文件（50 项）、将 app.js 从 869 行瘦身到 220 行。这些改进 iwara 全部未做。

**建议**：参照 gbmd 的后端重构方案（`docs/gbmd-后端重构方案-20260905.md`），按 P0→P1→P2 顺序逐阶段修复。每阶段结束服务可跑 + 测试全绿 + 提交。

### 不足项定性

| 类别 | 数量 | 说明 |
|---|---|---|
| **已确认 bug（需修）** | 6 | B1-B6，与 gbmd 完全对应 |
| **代码质量（需改进）** | 6 | Q1-Q6，与 gbmd 重构前状态一致 |
| **安全改进（非 bug）** | 2 | S1-S2，低优先级 |
| **用户需求（不动）** | 8 | R1-R8，铁律 |

---

> **署名**：deepseek-v4-pro
> **分析日期**：2026-09-06
> **分析范围**：项目全部核心源码（server 14 文件 + 前端 + docs + TROUBLESHOOTING + README）
> **对照权威**：gbmd 5 份 AI 分析报告 + `docs/gbmd-AI分析报告.md`（R1-R9 铁律 + B1-B6 bug）+ `docs/gbmd-后端重构方案-20260905.md`（P0-P6 路线图）+ `docs/gbmd-重构进度.md`（P0-P5 完成）
> **声明**：本报告基于静态代码审查 + 对照 gbmd 已完成的重构成果。所有不足项均标注文件与行号，可逐条复核。已标注哪些是用户需求（不动）、哪些是已知 bug（需修）、哪些是代码质量改进项。
