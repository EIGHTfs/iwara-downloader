# 计划 ①：播放页「点赞 / 关注」按钮补齐取消能力 + 措辞修正（收藏 → 点赞）

> 本方案仅为设计草案，未实际修改任何代码。请审核确认后，再按方案执行。
> 分四次写：① 取消点赞/取关（本文档）｜② 搜索列表点赞字段 + mtime 动态刷新｜③ 播放器上下滑动音量｜④ 左右滑动连续进度 + 缩略图预览

## 一、修改目标

- **问题描述**：播放页 `likeBtn`（❤️ 收藏）与 `followBtn`（+ 关注）是**单向按钮**——点击永远 `POST /api/like`、`POST /api/follow`，不看按钮当前态；**已点赞状态下再点不会取消点赞，已关注状态下再点不会取关**。后端 `DELETE /api/like`（取消点赞）与 `markUnliked` 已存在但前端无入口调用；**取关（unfollow）后端接口与本地状态方法完全缺失**。
- **期望效果**：按钮为**状态感知的 toggle**——未点赞点击 → 点赞；已点赞（点亮态）点击 → 取消点赞；关注同理。3 秒冷却保留（真实官方接口防误点轰炸）。
- **成功标准**：
  1. 播放页未登录/已登录均可查看初始态（现有 `video-state` 逻辑不变）
  2. 点 `❤️ 点赞` → 变 `❤️ 已点赞`（点亮）→ 再点 → 回到 `❤️ 点赞`（熄灭），本地 `liked_state.json` 同步增删
  3. 点 `+ 关注` → 变 `✓ 已关注`（点亮）→ 再点 → 回到 `+ 关注`（熄灭），本地 `liked_state.json` 同步增删
  4. 刷新页面 / 搜索列表 badge 与播放页按钮状态一致（同一 `liked_state.json` 数据源）
  5. 措辞统一：所有 UI 与文档中「收藏」改为「点赞」（Iwara 的 like 语义是点赞不是收藏）

## 二、潜在问题分析

| 风险类型 | 可能性 | 影响 | 缓解措施 |
|----------|--------|------|----------|
| 官方接口语义不符 | 中 | 若官方 unlike/unfollow 用 DELETE 或不同端点，前端会失败 | 后端封装 `unlikeVideo`（已存在，对照官方 API 实测）/ `unfollowUser`（按 `followUser` 同款姿势写），失败返回 `ok:false` 前端提示 |
| 状态不同步 | 低 | 点赞成功但官方未生效，本地已记 liked | 沿用现有 `video-state` 合并逻辑：官方 + 本地 `isLiked` 兜底；toggle 只按本地结果翻转 |
| 3 秒冷却影响连续操作 | 低 | 取消后想立即再点会被冷却挡住 | 冷却保留（用户此前明确要求限频真实交互），成功/失败都冷却 |
| 未登录点击 | 低 | 401 | 现有 fetch 带 same-origin，未登录后端 401 → 前端 showFeedback 提示（保留现有行为） |

**边界条件**：
1. `id` / `userId` 为空：后端 400（现有逻辑已覆盖）；前端 userId 为空时提示「暂未取得作者 id」（现有逻辑）
2. 官方接口超时/429：后端 catch 返回 `ok:false` + error，前端 showFeedback（现有模式）
3. 并发连点：`btn.disabled` + 冷却双重保护（现有逻辑）

## 三、Skill 学习检查

- 已加载：`plan-template-enhanced`（本文档模板）、`bugfix-auto-authority`（bug 直接修）、`verify-before-diagnose`（先实测）、`feature-todo-readme-cycle`（README 待办闭环）
- 已有知识：播放页按钮限频 3s 冷却（1.7.11 已实现）、`like-state.js` 的 markLiked/markFollowed/markUnliked 模式、后端路由 `routePublic` 鉴权姿势
- 复用方案：**完全仿照现有 `POST /api/like` + `DELETE /api/like` 的成对姿势**，补齐 `unfollow` 一对（`POST /api/follow` 已有 → 新增 `DELETE /api/follow`）
- 不用方案：不做「批量取消」「长按取消」等额外交互——本次只补齐缺失的取消能力，交互保持最小

## 四、涉及文件汇总

| 文件路径 | 操作类型 | 行数预估 | 功能描述 | 依赖关系 |
|----------|----------|----------|----------|----------|
| `server/lib/iwara-api.js` | 修改 | +20 行 | 新增 `unfollowUser(userId)`（仿 `followUser` :757） | 官方 API |
| `server/lib/like-state.js` | 修改 | +15 行 | 新增 `markUnfollowed(userId)`（仿 `markUnliked` :114）+ 导出 | 无 |
| `server/routes/like.js` | 修改 | +15 行 | 新增 `DELETE /api/follow`（仿 `DELETE /api/like` :59）；`POST /api/follow` 保持 | iwara-api + like-state |
| `server/public/play-app.js` | 修改 | ±40 行 | `bindStateButtons` 改 toggle：按 `btn.dataset.on` 判断 POST/DELETE + 翻转 | 上面三个 |
| `server/public/play.html` | 修改 | ±2 行 | 按钮文案「❤️ 收藏」→「❤️ 点赞」；on 态「❤️ 已收藏」→「❤️ 已点赞」 | 无 |
| `server/templates/_iwara-style/…` | 修改 | 同步 | play-app.js / play.html / play-list.js 同步模板 | 模板下发 |
| `README.md` | 修改 | 若干 | 功能表/版本记录措辞「收藏」→「点赞」；记录本次补齐 | 无 |

## 五、逐文件改动详情

### 5.1 `server/lib/iwara-api.js`

- **当前位置**：`followUser` :757（POST /api/follow 官方调用）
- **当前逻辑**：`followUser(userId)` 调官方 `/user/{id}/follow`；模块导出表 :902
- **改动内容**：新增 `async function unfollowUser(userId)`——官方取消关注端点实测后写（`DELETE /user/{id}/follow` 或 `POST /user/{id}/unfollow`，按官方 API 实测为准）；加入导出表
- **改动原因**：取关后端能力缺失
- **潜在影响**：导出表新增一项，无破坏

### 5.2 `server/lib/like-state.js`

- **当前位置**：`markUnliked` :114（删除本地点赞记录）；导出表 :152-158
- **改动内容**：新增 `markUnfollowed(userId)`——从 `followed` 集合删除 + 写盘（照抄 markUnliked 的写盘姿势）；加入导出
- **潜在影响**：`following_cache.json` 语义不变（那是全量增量缓存，本次不动）

### 5.3 `server/routes/like.js`

- **当前位置**：`DELETE /api/like` :59（取消点赞）、`POST /api/follow` :71
- **改动内容**：
  - 新增 `route("DELETE", "/api/follow", ...)`：读 `query.userId` → `iwaraApi.unfollowUser(userId)` → `likeState.markUnfollowed(userId)` → `sendJson(200, {ok:true})`；catch 返回 `{ok:false, error}`
  - `POST /api/follow` 保持现状（关注 + markFollowed）
- **改动原因**：取关入口缺失

### 5.4 `server/public/play-app.js`（核心）

- **当前位置**：`bindStateButtons` :292-335
- **当前逻辑**：两个按钮的 click 都无条件 `fetch POST`，成功后 `setStateBtn(btn, true, ...)`——**从不看 `btn.dataset.on`，无法取消**
- **改动内容**：
  - `likeBtn` click：`if (btn.dataset.on === "true")` → `DELETE /api/like?id=` + `setStateBtn(btn, false, "❤️ 点赞")`；否则 → `POST /api/like` + `setStateBtn(btn, true, "❤️ 已点赞")`
  - `followBtn` click：`if (btn.dataset.on === "true")` → `DELETE /api/follow?userId=` + `setStateBtn(btn, false, "+ 关注")`；否则 → `POST /api/follow` + `setStateBtn(btn, true, "✓ 已关注")`
  - 冷却 `stateBtnCooldown` 保留（点击即冷却）
  - 文案同步：`likeBtn.dataset.off = "❤️ 点赞"`；on 态标签「❤️ 已点赞」
- **改动原因**：补齐 toggle 双向能力
- **潜在影响**：`refreshVideoState` 的 on 态标签也改为「❤️ 已点赞」（:284）

### 5.5 `server/public/play.html`

- `:259` `<button id="likeBtn">❤️ 收藏</button>` → `❤️ 点赞`
- 样式/注释 :63 同步措辞

### 5.6 模板同步

- `dl-server-template/server/templates/_iwara-style/public/play-app.js`、`play.html` 同步；`play-list.js` 无改动（按钮逻辑不在那）

### 5.7 README.md

- 功能表「❤️ 收藏 / 关注」行 → 「👍 点赞 / 关注」措辞修正
- 版本记录 1.7.13（未升版）：播放页按钮补齐取消点赞/取关 + 措辞修正
- 新增章节或既有头像章节不动

## 六、影响分析

| 维度 | 影响程度 | 说明 |
|------|----------|------|
| 现有功能 | 中 | 播放页按钮行为从「单向」变「toggle」；搜索列表 badge 数据源不变（同一 liked_state.json） |
| 性能 | 低 | 无新增轮询；每次点击一次请求（现有） |
| 兼容性 | 低 | 新增 DELETE /api/follow 是新增接口，不影响旧客户端 |
| 安全性 | 低 | 同现有 /api/follow 鉴权姿势 |
| 可维护性 | 中 | toggle 逻辑集中在 bindStateButtons，注释说明状态机 |

## 七、任务看板

### 阶段一：准备
- [ ] 实测官方 unlike/unfollow 端点（curl 官方 API 确认 DELETE 姿势）
- [ ] 备份相关文件（git 天然备份，无需手动）

### 阶段二：代码修改（从简到难，每步小提交）
- [ ] Step 1：`like-state.js` 新增 `markUnfollowed` + 导出 → commit
- [ ] Step 2：`iwara-api.js` 新增 `unfollowUser` + 导出表 → commit
- [ ] Step 3：`routes/like.js` 新增 `DELETE /api/follow` → commit
- [ ] Step 4：`play-app.js` bindStateButtons 改 toggle + 文案 → commit
- [ ] Step 5：`play.html` 文案 → commit
- [ ] Step 6：模板同步 4 件（play-app.js / play.html）→ commit（模板仓库）

### 阶段三：验证
- [ ] curl 实测：POST /api/like → video-state.liked=true → DELETE /api/like → video-state.liked=false（liked_state.json 增删）
- [ ] curl 实测：POST /api/follow → DELETE /api/follow（官方取消 + liked_state.json followed 删）
- [ ] jsdom 播放页全链路：初始态 / 点赞→取消→点赞 / 关注→取关→关注 / 连点冷却
- [ ] 搜索列表 badge 与播放页状态一致
- [ ] 全接口回归 200

### 阶段四：收尾
- [ ] README 功能表 + 版本记录更新
- [ ] squash 成一次提交：`feat: 播放页点赞/关注按钮补齐取消能力（toggle）+ 措辞收藏改点赞`

## 八、验证方案

- 单元/集成：curl 走真实官方 API（有真实 cookie）
- 人工验证：真实环境播放页点赞→取消、关注→取关，刷新后状态一致；搜索列表 badge 同步
- 回归：搜索、下载、播放页基础功能

## 九、中断管理

执行中用户插入新需求 → 暂停分析，默认不执行，继续本任务；发现新 bug → 记录到「后续优化清单」。

## 十、后续优化清单（本次不处理）

- ☐ 搜索列表「已关注」badge 的取关入口（本次只做播放页）
- ☐ 播放页 authorId 为空时的兜底重取策略

## 十一、是否执行？

请回复 **确认** 或 **修改方案**；含新需求将触发中断管理，默认不执行。
