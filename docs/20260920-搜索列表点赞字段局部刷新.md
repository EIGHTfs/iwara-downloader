# 计划 ②：搜索列表「已点赞」——json 字段驱动 + mtime 局部动态刷新

> 本方案仅为设计草案，未实际修改任何代码。请审核确认后，再按方案执行。
> 分四次写：① 取消点赞/取关（已完成）｜② 搜索列表点赞字段 + mtime 动态刷新（本文档）｜③ 播放器上下滑动音量｜④ 左右滑动连续进度 + 缩略图预览

## 一、修改目标

- **问题描述**：用户反馈搜索列表「已点赞」显示不可靠，「以前能显示，改动后不显示」。经排查：后端 `mergeLikedState` / `mergeOne` **已能**给搜索结果 json 补 `liked: true` 字段并下发，前端 `resultItemHtml` **也读** `v.liked`，但**前端仍同时依赖内存 `likedMeta`（`/api/liked-state` 全量拉取）做兜底**——两个数据源不同步时会互相覆盖；且列表是**全量重渲染**（`renderSearchResults` 整表 innerHTML 重建），没有「json 文件 mtime 变化 → 局部动态刷新」机制。
- **重新设计方向**（用户定案）：**搜索列表 json 增加「是否点赞」字段 → html 根据字段渲染 ❤️ 已赞 → json 文件变动 mtime 立即局部动态显示点赞变动**，按通用模板方向做（模板 `fragment-assembler` 已有 mtime 热更新范式：文件 mtime 变化 → 缓存失效 → 重拼局部内容）。
- **期望效果**：搜索列表每行 ❤️ 已赞 由**唯一数据源**（搜索 json 里的 `liked` 字段）驱动；`liked_state.json`（或搜索缓存 json）mtime 变化时，前端**只更新变化的行**（局部 DOM），不整表刷新；下拉搜索结果时图片不闪、滚动位置不跳。
- **成功标准**：
  1. 搜索返回 json 的每个结果视频条目含 `liked: true/false` 字段（现有 merge 逻辑，确认补全所有返回路径）
  2. 前端只按 `v.liked` 渲染 ❤️ 已赞 badge（不再依赖内存 likedMeta 兜底渲染；likedMeta 仅用于播放页按钮等其余场景）
  3. 播放页点赞/取消后，搜索列表对应行的 ❤️ 在 **≤1 个轮询周期**（或读 mtime 变化后立即）局部翻转，**不整表重建**
  4. 搜索列表滚动位置、已展开图片不因点赞刷新而重置
  5. 回归：搜索、下载勾选、分页加载正常

## 二、潜在问题分析

| 风险类型 | 可能性 | 影响 | 缓解措施 |
|----------|--------|------|----------|
| merge 覆盖路径不全 | 中 | 部分搜索返回（如首次搜索未完成、缓存直读）没补 liked 字段 | 审计所有 results 返回点（`/api/search-status`、`/api/search/cache`、运行时 `searchResults`）统一走 merge；前端对缺失字段按 false 渲染（不误亮） |
| mtime 轮询开销 | 低 | 每 N 秒 stat 一次文件，开销可忽略 | stat 本地文件（ms 级），复用现有轮询定时器 |
| 局部更新误伤 DOM | 中 | 按 id 找行更新时选择器写错会更新错行 | 每行 `data-id` 属性定位；更新只改 badge 节点文本/显隐，不动行内其它节点 |
| liked_state.json 写盘频率 | 低 | markLiked/markFollowed 每次写盘，mtime 变化频繁 | 本来就是用户主动交互触发，频率低；轮询周期内合并多次变化为一次局部更新 |

**边界条件**：
1. liked_state.json 不存在 / 读取失败：mtime 视为 0，前端按 json 字段渲染，不报错
2. 搜索结果 videoid 为空：不参与更新（按现有逻辑跳过）
3. 并发：搜索进行中（results 增长）时 mtime 变化 → 局部更新与增量追加并存，须用同一渲染入口避免互相覆盖
4. mtime 相同（同毫秒写两次）：用 size 或内容 hash 辅助判断，或接受合并

## 三、Skill 学习检查

- 已加载：`plan-template-enhanced`、`bugfix-auto-authority`、`verify-before-diagnose`、`feature-todo-readme-cycle`
- 模板仓库现有范式（已 grep 确认）：
  - `server/framework/assemble/fragment-assembler.js`：`maxMtime(dir, files)` 取文件最大 mtime，`isFresh(hit)` 比较 mtime 判缓存失效 → 重拼局部片段——**本次前端 mtime 检测照此思路**
  - `_gallery-style/public/app.js`：`refreshAuth` / 局部刷新只刷新指定根（`onlyRoot`）+ mtime 聚合前端排序——前端局部刷新参考
- 复用方案：**后端加一个轻量「状态 mtime + 增量"接口（或直接在 liked-state 里带 mtime），前端轮询对比 mtime，变化时只对受影响行做局部 DOM 更新**
- 不用方案：不做 SSE/WebSocket（本服务零依赖、轮询已存在，不引入新通道）

## 四、涉及文件汇总

| 文件路径 | 操作类型 | 行数预估 | 功能描述 | 依赖关系 |
|----------|----------|----------|----------|----------|
| `server/lib/like-state.js` | 修改 | +8 行 | `toPublic()` 增加 `mtime`（STATE_FILE 的 stat.mtimeMs） | 无 |
| `server/lib/search-cache.js` | 修改 | 少量 | 审计/补全 `mergeLikedState` 覆盖所有 results 返回路径（:75/129） | like-state |
| `server/public/app.js` | 修改 | ±60 行 | badge 渲染只读 `v.liked`；轮询改 mtime 对比 + 局部更新函数 `updateLikedBadges(results)` | 上面 |
| `server/templates/_iwara-style/public/app.js` | 修改 | 同源同步 | 模板同步 | 模板下发 |
| `README.md` | 修改 | 若干 | 版本记录 1.7.13：搜索列表点赞 json 字段驱动 + mtime 局部刷新 | 无 |

## 五、逐文件改动详情

### 5.1 `server/lib/like-state.js`

- **当前位置**：`toPublic` :132（返回 `{liked:[], followed:[]}`）
- **改动内容**：`toPublic()` 返回值增加 `mtime: statMtimeMs(STATE_FILE)`（无文件返回 0）
- **改动原因**：前端据此判断 state 是否变化，决定是否局部更新
- **潜在影响**：`/api/liked-state` 多一个字段，兼容旧前端（忽略未知字段）

### 5.2 `server/lib/search-cache.js`

- **当前位置**：`mergeLikedState(list)` :75；`getQueryTask(true)` :129 merge
- **改动内容**：审计所有返回 `results` 的路径，确保都经 merge（`/api/search-status` 已 merge；补 `/api/search/cache` 与首次搜索任务返回）
- **改动原因**：保证搜索 json 每条都带 liked 字段（单一数据源）
- **潜在影响**：无（只多字段）

### 5.3 `server/public/app.js`（核心）

- **当前位置**：`refreshLikedMeta` :19（全量拉 /api/liked-state 存内存）；`resultItemHtml` :924（`v.liked || likedMeta.liked.has(id)`）；`startSearchPoll` :783（每轮 `refreshLikedMeta` + 全量 `renderSearchResults`）
- **改动内容**：
  1. `resultItemHtml`：badge 条件改为只读 `v.liked`（`settings.showLikedInSearch !== false && v.liked`）；`likedMeta` 保留给播放页/其它场景，不再参与搜索行渲染
  2. `startSearchPoll` 轮询：
     - 拉 `/api/liked-state` 得到 `mtime`；与上次比较，**mtime 变了**才触发局部更新
     - 局部更新函数 `updateLikedBadges()`：遍历当前行 DOM（`[data-id]`），查对应结果条目 `v.liked` → 只改该行 badge 节点（有/无 ❤️ 已赞），**不重建整表**
  3. 首次搜索完成 / 增量追加仍走 `renderSearchResults`（结构变化），点赞状态变化走局部更新（纯状态变化）
- **改动原因**：json 字段单一数据源 + mtime 驱动局部刷新
- **潜在影响**：轮询逻辑微调，搜索功能回归重点

### 5.4 模板同步

- `dl-server-template/server/templates/_iwara-style/public/app.js` 同步

### 5.5 README.md

- 版本记录 1.7.13（未升版）：搜索列表已点赞改 json 字段驱动 + mtime 局部动态刷新

## 六、影响分析

| 维度 | 影响程度 | 说明 |
|------|----------|------|
| 现有功能 | 中 | 搜索列表 badge 渲染逻辑改动 + 轮询刷新机制改动 |
| 性能 | 低 | mtime stat 开销 ms 级；局部更新比整表重建更省 |
| 兼容性 | 低 | API 仅加字段 |
| 安全性 | 低 | 无新入口 |
| 可维护性 | 中 | 局部更新函数需注释清楚与整表渲染的分工 |

## 七、任务看板

### 阶段一：准备
- [ ] 实测当前搜索返回 json 是否含 liked 字段（真实环境 curl /api/search-status）
- [ ] 记录 liked_state.json mtime 变化规律（markLiked 后 mtime 是否变）

### 阶段二：代码修改（从简到难，每步小提交）
- [ ] Step 1：`like-state.js` toPublic 加 mtime → commit
- [ ] Step 2：`search-cache.js` merge 覆盖补全 → commit
- [ ] Step 3：`app.js` badge 渲染只读 v.liked → commit
- [ ] Step 4：`app.js` 轮询 mtime 对比 + 局部更新 → commit
- [ ] Step 5：模板同步 app.js → commit（模板仓库）

### 阶段三：验证
- [ ] curl：搜索返回 json 每条含 liked；/api/liked-state 含 mtime
- [ ] 真实页面：点赞后搜索列表 ❤️ ≤1 轮询周期局部亮起；取消后熄灭
- [ ] 滚动位置不跳、图片不闪（局部更新 vs 整表重建对比）
- [ ] 搜索分页/增量加载回归

### 阶段四：收尾
- [ ] README 版本记录更新
- [ ] squash：`feat: 搜索列表已点赞改 json 字段驱动 + mtime 局部动态刷新`

## 八、验证方案

- 集成：curl 真实环境（cookie 已备）验证 merge 字段与 mtime
- 人工：真实页面观察局部刷新行为
- 回归：搜索全流程

## 九、中断管理

同计划①：执行中插入新需求默认暂停本任务，等用户确认。

## 十、后续优化清单（本次不处理）

- ☐ 搜索列表「已关注」作者行是否也走同一机制（用户行 badge）
- ☐ liked_state.json 大时（数千 id）的轮询体积优化

## 十一、是否执行？

请回复 **确认** 或 **修改方案**。