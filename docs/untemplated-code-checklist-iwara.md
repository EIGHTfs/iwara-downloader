# iwara 未模板化代码检查清单（2026-09-20）

判定基准：**模板化 = 该文件在 `assemble.json` 里声明了 `src→dst`（组装下发，模板改了自动同步）**。
未模板化 = 项目里存在但不在清单声明内的文件，按原因分五类。

- 模板真源：`dl-server-template/server/`（framework / templates / project/blueprint）
- 项目：`iwara-downloader/`
- 已核对日期：2026-09-20（残留清理 server/project、server/templates 之后；模板自动版本化已同步）

---

## A 类：模板有源、项目有副本、清单漏声明（组装不同步）

| # | 文件 | 判定依据 | 建议 |
|---|---|---|---|
| A1 | `server/boot.cjs` | `blueprint/boot.cjs` 注释明示「由项目清单下发（src → server/boot.cjs）」，example/gbmd 清单已有该条目、iwara **漏发**（项目留旧注释版，与 blueprint diff 有差异） | 清单补条目：`server/project/blueprint/boot.cjs → server/boot.cjs` |
| A2 | `server/public/favicon.ico` | 模板 `_iwara-style/public/favicon.ico` 存在且与项目**逐字相同**（md5 `ac391b18`）；清单无条目 | 清单补条目：`server/templates/_iwara-style/public/favicon.ico → server/public/favicon.ico` |
| A3 | `server/public/favicon.png` | 模板 `_iwara-style/public/favicon.png` 存在且与项目**逐字相同**（md5 `f916c745`）；`brand.json` 的 `icon=favicon.png` 引用它；清单无条目 | 清单补条目：`server/templates/_iwara-style/public/favicon.png → server/public/favicon.png` |

注：模板 `_iwara-style/public/app.js`（1586 行）存在但项目 `server/public/app.js`（1569 行）为**改版**（diff 有差异）——项目在模板版基础上定制过，**不能下发覆盖**，保持项目自研（与 gbmd app.js 由模板下发的处理不同，因 iwara 是改版）。

## B 类：应模板化的自研包装层（同 gbmd B3 处理）

| # | 文件 | 判定依据 | 建议 |
|---|---|---|---|
| B1 | `server/lib/auto-update.js` | 与 gbmd 同构的**自动更新参数包装层**（`createAutoUpdate` + projectName/repo/extraExclude/extraWatchExclude），纯配置无业务依赖 | 保存到风格模板 `server/templates/_iwara-style/server/lib/auto-update.js`（顺带修正注释里的过时框架路径）+ 清单补下发条目 |

## C 类：游离/废弃文件（非代码问题，属清理类）

| # | 文件 | 状态 | 建议 |
|---|---|---|---|
| C1 | `assemble.json.bak` | 旧版清单备份，`.gitignore` 的 `*.bak` 已覆盖（未入库） | 删除或移 .trash |

（无 gbmd 那类 public/.trash-*、根 zip；avatar/ 是运行数据见 D 类）

## D 类：运行期文件（gitignore 覆盖，正常不入库，非问题）

- `server/config.json`、`server/*.log`、`server/app.pid`、`avatar/`（331 个头像缓存文件，数据）

## E 类：项目自研业务代码（非模板范畴，清单备查，不动）

- `server/app.js`（入口，模板版基础上的项目改版）、`server/config.js`（配置管理，含 iwaraToken/iwaraCookie，注释注明参考 gbmd 设计）、`server/config.example.json`（示例配置）
- `server/lib/`：device-check、downloader、iwara-api、profile-index、rename-files、search-cache、thumb-cache.cjs、video-index（业务库，均依赖 iwara 特有数据）
- `server/routes/`：account、auth、auto-update、browse、data、download、index、play、rename、search、settings、videos（业务路由）
- 已模板化 ✓：play.html / play-app.js / vendor/（播放页走 `_iwara-style` 下发）、login/setup/theme-init 等 blueprint 前端

---

## 附带发现（小问题，非未模板化）

- `server/public/brand.json` 的 `logo: "brand.png"` **悬空引用**——项目里不存在 brand.png；assemble.json brand 段 `logo=iwara-logo.png`（清单已下发该文件）。brand.json 是旧产物（「存在即保留」规则导致未重新生成）。建议：删除 brand.json 让组装按 brand 段重新生成，或确认是否要提供 brand.png。

---

## 汇总建议（对照 gbmd 已执行的同类处理）

1. **A1/A2/A3**：补 3 条 assemble.json 下发条目（boot.cjs、favicon.ico、favicon.png）
2. **B1**：包装层进 `_iwara-style` 风格模板 + 清单下发
3. **C1**：assemble.json.bak 清理
4. **brand.json**：删除重新生成（悬空 logo 修复）
5. 修复后重跑组装 + 启动自检验证

（本清单为检查产物，待人工复核后决定是否执行修复与入库）
