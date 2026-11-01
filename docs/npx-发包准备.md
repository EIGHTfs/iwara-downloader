# npx 发包准备（iwara-downloader）

> 只调研、未改代码。**通用部分（入口 / 零依赖 / server 自足 / 工具探测 / 缺口清单①～⑦ / assemble 方案对比与推荐）与
> `gamebanana-mods-downloader/docs/npx-发包准备.md` 完全一致，本文只写差异。** 两份文档的相同段落请对照那份。

## 一、与 gbmd 的差异（实测）

| 项 | iwara 的实际情况 |
|---|---|
| 端口 | `server/config.js:28` 默认 **8643**（gbmd 是 8642） |
| 配置文件 | 有 **`config.example.json`**（不是 `config.json`）⇒ 首次运行要生成 `config.json` 到数据目录，不能写进包 |
| `server/` 规模 | **117 文件 / 1.1 MB**（gbmd 116 / 1 MB） |
| 入口与装配 | `boot.cjs` / `lib/cjs-bootstrap.cjs` / `update/auto-update.js` / `tool/tool-detect.js` 与 gbmd **逐字相同**（md5 一致） |
| `json/` | **空目录**（0 文件）⇒ 无需进包 |
| `mapping/` | **不存在**（gbmd 有 6 文件 84 KB） |
| `crx/` | 不存在 |
| 顶层 `tool/` | 3 文件 **12 KB**：`README.md` + `ffmpeg`(4 KB) + `ffprobe`(4 KB) —— **都是 wrapper 脚本，不是二进制** |
| 运行时工具依赖 | `server/lib/thumb-cache.cjs:84-94` 用 `detectTool("ffmpeg", {toolDirs:[<root>/tool]})` 找 ffmpeg；**探测顺序 环境变量 → 项目 tool/ → 系统 PATH**，找不到降级（缩略图功能不可用但不崩） |
| **README 相对链接** | 图片 7 / 链接 10 / 其中**相对路径 15 个** ← **三个项目里最多**，npm 页面上会大量裂图/404，④的工作量比另两个大 |
| `test/` | 13 文件 308 KB |

## 二、`files` 白名单（逐条）

**进包**：

| 路径 | 文件数 | 大小 | 为什么必须进 |
|---|---|---|---|
| `server/**` | 117 | 1.1 MB | 全部运行时代码（含 `public/` 前端、`tool/tool-detect.js` 工具探测、`update/` 自更新、`auth/`） |
| `README.md` | 1 | 24 KB | npm 页面展示 |
| `start.sh` / `start-*.sh` / `start-windows*.bat` | 6 | ~20 KB | 源码运行用；可忽略体积 |
| `tool/README.md` + `tool/ffmpeg` + `tool/ffprobe` | 3 | **12 KB** | **是 wrapper 脚本（各 4 KB），不是二进制** ⇒ 体积可忽略；`tool-detect.js` 会优先看它们。**注意**：它们的可执行位（`X_OK`）在 npm 安装后可能丢失，`tool-detect.js` 已有 `X_OK` 校验 ⇒ 丢位时自动降级到系统 ffmpeg（不会崩） |

**不进包**：

| 路径 | 文件数 | 大小 | 为什么 |
|---|---|---|---|
| **`assemble.json`** | 1 | 12 KB | 用户硬要求；**但 iwara 与 gbmd 一样有 brand 依赖** ⇒ **需要方案 b**（见下） |
| `test/**` | 13 | 308 KB | 测试，运行不需要 |
| `docs/**` | 13 | 752 KB | 设计文档 |
| `scripts/**` | 17 | 232 KB | 开发期工具（bench / migrate / verify / userscript） |
| `config.example.json` 之外的用户 `config.json` | — | — | 用户配置，绝不能进包 |

## 三、`assemble.json`：与 gbmd 同一问题，同样推荐方案 b

`server/config/brand.js` 与 gbmd **逐字相同**（md5 `a7cbb144`），同样读 `../assemble.json` 的 `brand` 段，
同样在缺失时返回 `null` ⇒ 同样会让 `@brand:logo@` / `@brand:displayTitle@` 等**纯文本形态**的字面量显示在页面上。

`brand` 段实测内容（`assemble.json`）：

```json
{ "title": "iwara-downloader", "logo": "iwara-logo.png", "icon": "favicon.png",
  "displayTitle": "Iwara<br>Video<br>Downloader" }
```

⇒ 方案 b（`prepublishOnly` 生成 `brand.json`，`brand.js` 优先读它、缺失回落 `assemble.json`）**同样适用**，
且因为 `brand.js` 与 gbmd 逐字相同，**这份改动可以按 md5 原样复制到 gbmd**（省一半工作）。

## 四、README 链接是这份文档里最重的活

相对路径 **15 个**（gbmd 1、gallery 1）。npm 页面上这些全部 404/裂图。
建议批量改写为 `https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<path>`，
并在发布前用 `npm pack --dry-run` + 直接打开 npm 页面各看一次（**不能只靠 grep 数**，要真的渲染）。

## 五、共享与风险

- **共享**：`boot.cjs`/`cjs-bootstrap.cjs`/`brand.js`/`update/auto-update.js`/`tool/tool-detect.js` 与 gbmd **逐字相同** ⇒ 可按 md5 批量同步；`app.js` 已分化，各自改。
- **iwara 特有风险**：**ffmpeg wrapper 的可执行位在 npm 安装后可能丢失**（npm 保留 755 但不保证），`tool-detect.js` 的 `X_OK` 校验会降级到系统 ffmpeg —— 若目标机器也没有 ffmpeg，**缩略图功能静默不可用**。建议首次运行时把"ffmpeg 未找到 → 缩略图不可用"写进日志（而不是完全静默）。
- 其余风险（数据目录、端口冲突、`node:sqlite` 版本要求、升级丢数据）见 gbmd 文档 §六，同样适用。

## 六、发布顺序建议

**排在 gbmd 之后**（gbmd 与它逐字相同的文件更多，先改 gbmd 可顺带验证批量同步）；
两处额外工作量：README 15 个链接、ffmpeg 降级的日志提示。
