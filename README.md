# iwara-downloader-server

> 零依赖、单进程 Node.js 服务：从 [Iwara](https://www.iwara.tv) 搜索、解析并下载视频。
> 自带网页界面（浏览器访问）。

**核心能力一览**

| 能力 | 说明 |
|---|---|
| 🔍 关键词搜索 | 走 Iwara 网页同款 `/search?type=videos&query=`，结果与官网一致 |
| ⬇ 批量下载 | 输入视频 ID / 完整链接，预解析后一键下载 |
| 🔑 凭证双模式 | Cookie / Token（油猴脚本一键采集） |
| 📤 发送到服务器 | 油猴脚本把当前视频链接一键推给服务器添加下载任务（服务端清单：添加后下拉选择，不能改只能删） |
| ▶ 本地播放 | 进度页打开 `play.html`（吸收 ArtPlayer MIT 静态文件，非 npm 依赖）：完整文件或 `.part` 已写入字节都能 Range 播；未下完时进度条只到已缓存部分；右侧索引列表滚动懒加载 |
| 🌐 CF 绕过 | IP 直连（`config.json` 的 `iwaraCfgIp`，默认 `104.26.12.12`）+ SNI + 精简 UA，绕开 DNS 污染与 Cloudflare 拦截 |
| 🔄 CDN 子域轮换 | 失败自动换可用子域；成功/失败列表持久化到本机 |
| 📁 文件名模板 | 学油猴脚本变量替换：`Iwara_-_{TITLE}_[{ID}]_[{QUALITY}]`（不要写 `.mp4`，落盘自动补） |
| 🚀 双下载后端 | `direct`（Node 直连，断点续传）/ `aria2`（JSON-RPC 推送） |
| 📦 启停脚本 | 单脚本子命令 `start.sh [start|stop|restart|status]` + 兼容薄壳 + macOS/Windows 版 |

---

## 快速开始

**环境要求**：Node.js 18+（零 npm 依赖，无需安装任何包）。

```bash
# 1. 下载 / 克隆仓库
git clone <仓库地址> && cd iwara-downloader-server

# 2. 复制配置模板（真实配置含凭证，不会入库）
cp server/config.example.json server/config.json
# 编辑 server/config.json：填 iwaraToken 或 iwaraCookie、downloadPath

# 3. （可选）设置访问密码
node server/boot.cjs --set-password "你的密码"

# 4. 启动（无参默认 restart；未运行会直接启动）
./start.sh
# 浏览器打开 http://127.0.0.1:8643
```

> 未设置密码时**只警告、可直接使用**（局域网内任何人可访问，建议尽快设置）。
> 首次启动若没有 `config.json`，会按 `config.js` 的默认值运行；正式使用请从 example 复制后再填路径与凭证。

**启停（POSIX 用 `start.sh`，Windows 用 `start-windows.bat`）**

| 命令 | 作用 |
|---|---|
| `./start.sh` | 重启（默认命令，等价 restart；未运行则直接启动） |
| `./start.sh start [--port 8643]` | 启动（`--port` 优先，缺省读 config.json 的 `port`，再缺省 8643） |
| `./start.sh restart [--port 8643]` | 重启（stop + sleep 1 + start） |
| `./start.sh stop` | 停止（PID 优雅停止 → 兜底清理残留进程） |
| `./start.sh status` | 状态（进程 / PID 文件 / HTTP 健康检查 / 日志） |
| `./start.sh --port 8643` | 兼容旧用法（等价 restart） |
| `./start.sh --set-password "新密码"` | 设置访问密码（不启动服务） |

PID 文件：项目根 `iwara-downloader-server.pid`（不入库）。

`start-linux.sh` / `start-macos.sh` / `start-windows-background.bat` 是薄壳，转发到上面两个主入口。旧名 `stop.sh` / `restart.sh` / `status.sh` 若仍存在，同样转发到 `start.sh`。

终端会自动用绿/黄/红提示（管道或 `NO_COLOR` 时关闭）。日志超过 10MB 在 start/restart 时轮转并 gzip。启动前校验 `server/config.json` 是否为合法 JSON、端口是否在 1–65535。

---

## 网页界面

四个选项卡：**⬇ 下载 / 📊 进度 / 🔍 搜索 / ⚙ 设置**。

| 选项卡 | 功能 |
|---|---|
| 下载 | 每行一个视频 ID 或 `iwara.tv/video/xxxxxx` 链接；可先「预解析」再「开始下载」 |
| 进度 | 暂停 / 恢复 / 停止 / 重试失败；任务不会自动清掉，只能手动从列表移除（不删文件）；每条可本地播放（ArtPlayer，未下完也可播已缓存部分） |
| 搜索 | 关键词（与官网 `?query=` 一致）、排序、可选用户名；勾选后下载 |
| 设置 | 下载路径、文件名模板、作者子目录、后端、Cookie / Token、密码 |

---

## 目录结构

```
├── start.sh / start-macos.sh / start-windows.bat / start-windows-background.bat  # 启停脚本（单脚本子命令）
├── stop.sh / restart.sh / status.sh    # 兼容薄壳 → start.sh
├── scripts/iwara-cred-fetch.user.js  # 油猴凭证采集 + 一键发送
├── userdata-manifest.json            # 用户数据文件清单（备份/恢复按此收集）
└── server/
    ├── app.js
    ├── auth.js
    ├── config.js
    ├── config.example.json           # 配置模板（入库）；真实 config.json 不入库
    ├── lib/
    │   ├── iwara-api.js              # Iwara API（IP 直连 + CF 绕过）
    │   └── downloader.js             # 下载引擎（direct / aria2 + 子域轮换）
    └── public/                       # 网页前端
```

---

## 配置（server/config.json）

记录：**端口、凭证、下载路径、文件名模板、后端（direct / aria2）**。

```json
{
  "port": 8643,
  "iwaraToken": "",
  "iwaraCookie": "",
  "downloadBackend": "direct",
  "downloadPath": "/path/to/your/Iwara/",
  "fileNameTemplate": "Iwara_-_{TITLE}_[{ID}]_[{QUALITY}]",
  "useAuthorSubdir": false
}
```

> ⚠️ **安全说明**：仓库只提交 `server/config.example.json`（示例路径、空凭证）。
> 真实配置（含 token / cookie / 本机路径 / 密码哈希）保存在本地 `server/config.json`，已被 `.gitignore` 忽略，**不会上传**。
> 首次使用：复制 example 为 `config.json` 后填写，或在网页「设置」中保存。

| 字段 | 说明 |
|---|---|
| `iwaraToken` | Iwara refresh_token（油猴脚本复制） |
| `iwaraCookie` | 完整 Cookie（含 cf_clearance；HttpOnly 需油猴 `GM_cookie`） |
| `downloadBackend` | `direct`（默认）或 `aria2` |
| `downloadPath` | 下载根目录。`direct` 为本机路径；`aria2` 为 **aria2 所在机器**上的路径 |
| `fileNameTemplate` | 文件名模板，变量见下表 |
| `useAuthorSubdir` | 是否按作者建子目录（默认 `false`） |
| `concurrency` | 直连并发数 |
| `aria2Path` | Aria2 JSON-RPC 地址 |
| `aria2Token` | Aria2 RPC 密钥（不含 `token:` 前缀，代码会自动加） |
| `port` | HTTP 端口（默认 8643） |

**文件名模板变量**（学油猴脚本 `downloadPath.ts`）：

| 变量 | 含义 |
|---|---|
| `{TITLE}` | 标题 |
| `{ALIAS}` | 别名 |
| `{ID}` | 视频 ID |
| `{AUTHOR}` | 作者 |
| `{QUALITY}` | 清晰度（如 Source / 540） |
| `{UPLOADTIME}` | 上传时间 |
| `{NOWTIME}` | 当前时间 |

默认：`Iwara_-_{TITLE}_[{ID}]_[{QUALITY}]`（不要写扩展名，落盘自动补 `.mp4`）  
**必须含 `{ID}`**：封面 `server/thumbs/<id>.jpg`、sidecar json、视频文件都靠这个 id 对上。设置页保存时缺 `{ID}` 会拒绝。  
例：`Iwara_-_耀佳音与知更鸟摇一摇_[ZsvQjWn9XNQvAy]_[Source].mp4`

---

## 凭证获取

浏览器安装 `scripts/iwara-cred-fetch.user.js`（或打开服务器 `/userscript`）：

1. 打开并登录 [iwara.tv](https://www.iwara.tv)（等 Cloudflare 挑战完成）
2. 点页面右下角 🎫 按钮
3. 一键复制完整 Cookie / Token，粘贴到网页「设置」保存

---

## 发送到服务器（一键把视频推给服务器下载）

油猴脚本（v7.1.0+）「📤 发送到服务器」：

1. 打开任意 iwara 视频页（如 `https://www.iwara.tv/video/eBTWBPRSTFkahe`）
2. 点右下角 🎫 按钮，填服务器地址（`192.168.1.10:28463` 或 `http://192.168.1.10:28463` 均可，没写协议会自动补 `http://`），点 **📤 发送**
3. 脚本行为：
   - 探测 `GET /api/status`；
   - 服务器设了密码则用本地保存的服务器密码 `POST /api/login` 自动登录；
   - 把**当前视频完整链接** `POST /api/receive`（内部转发给 `/api/download`，服务器自行解析 ID 并下载）；
   - 地址/密码可「💾 记住地址」固化。
4. 面板顶部按香蕉网脚本风格显示登录态：已登录 / 用户名 / 用户 id / 主页链接 / Cookie 诊断。

> `/api/receive` 接受 `{ url }` / `{ urls }` / `{ items }` / `{ text }`，解析只走 `/api/download` 一处。

---

## 下载后端

### direct（默认）

本机 Node 直连下载：每次重新解析 **fresh 直链**（链接会过期），IP 直连 Cloudflare 边缘，失败自动换 CDN 子域。支持 Range 断点续传。

### aria2

把 fresh 直链通过 JSON-RPC `aria2.addUri` 推给 aria2。`downloadPath` 必须是 **aria2 机器上的路径**。

群晖 DSM Aria2 套件示例：

```json
{
  "downloadBackend": "aria2",
  "aria2Path": "https://nas.local:5001/webman/3rdparty/Aria2/aria2rpc_proxy.cgi",
  "aria2Token": "你的RPC密钥",
  "downloadPath": "/volume1/downloads/"
}
```

aria2 进程自己做 DNS。若本机 DNS 污染 iwara 子域，需在 **aria2 所在机器** 配 hosts，或用群晖 **DNS Server** 套件把 `iwara.tv` 通配 A 记录指到 `104.26.12.12`，并把该机系统 DNS 指到本机 `127.0.0.1`。常见处理见下方「常见问题」。

---

## 版本

| 版本 | 内容 |
|---|---|
| 1.7.4 | **作者子目录并入文件名模板**（模板 v1.7.0）：原先「作者子目录」是独立开关 `useAuthorSubdir`，与 `fileNameTemplate` 各管一半；现模板里的 `/` 直接作目录分隔，写 `{AUTHOR}/Iwara_-_{TITLE}_[{ID}]_[{QUALITY}]` 即按作者分目录、不写则存下载根目录，开关整体移除（`config.js` / `config.example.json` / `routes/settings.js` / 设置面板下拉 / `app.js` 两处引用一并清理）。实现要点：`applyFileNameTemplate` 把结果按 `/` 分段、逐段 `sanitizeFileName`（原先整串 sanitize 会把 `/` 换成 `_`，目录根本写不出来），空段与 `.`/`..` 段丢弃；`config.normalizeFileNameTemplate` 直接拒绝绝对路径与含 `..` 的模板并回落默认值；`downloader.js` 两处与 `rename-files.js` 一处不再单独拼 `authorDir`，直接用模板产出的相对路径 |
| 1.7.3 | ①下载列表「▶ 播放」样式：它是 `<a>`，此前只有 `.mm-play-btn` 的尺寸规则、没有按钮外观，显示成裸链接；新增 `a.mm-play-btn` 显式补齐边框/圆角/底色/文字色与 hover，不依赖 `.btn` 的层叠顺序。②代码拆分：`bindProgress` 99 行 → 拆出 `refreshTask` / `bindTaskButtons` / `bindRowActions` + `ROW_ACTIONS` 映射表，`bindProgress` 收敛为 3 行；`bindSettingsSave` 52 行 → 拆出 `readSettingsForm` / `afterSettingsSaved`。行内按钮的 5 套分支原本各写一遍，改为查表分发 |
| 1.7.2 | 修复 `<a>` 当按钮用时丢样式（根因：按钮规则限定 `button.` 前缀）：下载列表「▶ 播放」与顶栏「油猴脚本」都是 `<a>`，只拿到尺寸、没有边框/底色/文字色，显示成裸链接；现补 `btn` 类并由 `.btn` 承接按钮外观，`a.ghost` 去下划线 |
| 1.7.1 | 同步模板 1.5.0：①顶栏徽章元素 id 由 `iwaraUserBadge` 统一为 `UserBadge`（`topbar/badge.html` + `app.js` 三处选择器）；②修复 `topbar/userscript.html` 里「安装油猴脚本」按钮样式——按钮类名与 `style.css` 对不上，改为 `ghost hbtn` 后恢复顶栏按钮外观；③框架 `app.js` 新增 `server.drain()` 优雅关停：自动更新重启前等在途响应写完，避免静态资源被截断；④`auto-update` 复制新版本期间挂起文件监听，避免复制途中的中间态触发误重启 |
| 1.7.0 | **顶栏品牌区改由通用框架 + 品牌配置生成**：`topbar/brand.html` 原硬编码 `iwara-logo.png` / `alt="Iwara"`，绕过了框架的品牌占位符机制（登录页早已用 `@brand:`，顶栏却没有，同一页面两套做法）。现改为 `@brand:logo@` / `@brand:title@` / `@brand:displayTitle@` 取值，`brand.json` 新增 `displayTitle` 键承载顶栏三行标题。`topbar/time.html` 同时归位通用层（原为与 gbmd 逐字相同的重复副本）。另移除代码注释里的「AI 思路：」前缀 |
| 1.6.0 | **修复页面完全失去样式**：静态服务只对 `.html` 走片段组装，`style.css` 被漏掉——产物里 `style.css` 只保留 19 条 `@frag:` 指令（942 字节），浏览器拿到的是指令文本而非样式，页面 HTML 结构正常但渲染为纯文本。判据改用组装清单（`assembler.list()`）而非扩展名，展开后 11747 字节、指令零残留。版本号注入仍只对 HTML 生效 |
| 1.5.0 | **修复 `/api/download` 与 `/api/receive` 报 `parseDownloadItems is not a function`**（路由拆分时函数定义被删、调用处保留，油猴「发送到服务器」全程不可用）；**修复服务启动即崩**（`PUBLIC_DIR` 声明在 `loadFragmentAssembler()` 调用之后，触发 TDZ `ReferenceError`）；登录路由归位框架层（`framework/routes-auth.js`），`routes/auth.js` 只留项目专属的 `/api/token`；`aria2Dns` 默认值改为留空（不再写死某台机器的内网 DNS）；`githubRepo` 移出默认配置，改由 `lib/auto-update.js` 的 `defaultRepo` 提供，用户仍可在 `config.json` 覆盖 |
| 1.4.0 | 备份恢复改用框架层 `createBackup`（配置驱动），删除项目内 `lib/data-backup.js`；`userdata-manifest.json` 改为不入库（导出时自动生成）；清单生成统一走 `marker-manifest`，修正此前把框架文档示例当成数据条目、导致部分 desc 显示为 `desc=xxx` 的问题 |
| 1.3.1 | 公开库不再跟踪开发者文档 / TROUBLESHOOTING.md |
| 1.3.0 | start.sh：彩色输出、日志 10MB 轮转压缩、启动前校验 config.json、status 更详细 |
| 1.2.0 | 启停脚本统一为 start.sh / start-windows.bat；PID 写在项目根 `iwara-downloader-server.pid` |
| 1.1.1 | 设置页改为整页长图 |
| 1.1.0 | 网页界面截图：登录 / 下载 / 进度 / 搜索 / 设置 / 本地播放 / 油猴 |
|---|---|
| 1.0.12 | 任务列表左侧封面；播放列表同一张图。后台 `tool/ffmpeg` 抽帧到 `server/thumbs/<id>.jpg`，前台只读。文件名模板必须含 `{ID}` |
| 1.0.11 | 进度页按钮对齐香蕉网（清除失败/清除完成，行尾 ▶播放 🔄重试 🚫跳过）。按时间搜索抽 `search-date-range.js`：结束含当天到次日 0 点，结束不能晚于今天，开始晚于结束则结束跟着开始 |
| 1.0.10 | **播放器铺满舞台**：`#player` 高度不再是 0（黑屏）；`.gitignore` 按运行态/产物/凭据分组 |
| 1.0.9 | **本地播放免登录**：`play.html`、播放列表、`/api/play` 只读设置里的下载路径本机文件，不走 Iwara 在线、不要访问密码 |
| 1.0.8 | **播放页继承同源登录**：`play.html` / 首页未登录服务端 302 到 `login.html?next=`，已登录则直接用 `Path=/` 的 session |
| 1.0.7 | **播放页**：去掉 ArtPlayer `crossOrigin`（同域无 CORS 头会导致 `<video>` 播不了）；未登录跳登录并回到当前 `play.html?id=` |
| 1.0.6 | **本地播放**：吸收 ArtPlayer MIT 静态文件（非 npm）；`.part` / 未下完文件按已写入字节 Range 播；HEAD 与 GET 同头；`boot.cjs` 零依赖启动（禁止 package.json） |
| 1.0.5 | 正式进程改到下载盘同机；单脚本启停；跳过已下载不看索引 |

---


## 界面截图

实际运行界面（`http://nas.local:28463`，Chromium 无头 CDP 截取）。Cookie / Token 已打码。

| 页面 | 说明 |
|---|---|
| [登录](docs/screenshots/01-login.jpg) | 访问密码登录 |
| [下载](docs/screenshots/02-download.jpg) | 批量粘贴视频链接 / ID |
| [下载进度](docs/screenshots/03-progress.jpg) | 任务列表、暂停/继续/重试、本地播放 |
| [搜索](docs/screenshots/04-search.jpg) | 关键词搜索（对齐官网 `/search?query=`） |
| [设置](docs/screenshots/05-settings.jpg) | 路径、文件名模板、后端、凭证 |
| [本地播放](docs/screenshots/06-play.jpg) | `/{id}` 播放页（作者名前头像、右侧列表） |
| [油猴脚本](docs/screenshots/07-userscript.jpg) | 页面右下角面板：发送到服务器 |

![登录](docs/screenshots/01-login.jpg)
![下载](docs/screenshots/02-download.jpg)
![下载进度](docs/screenshots/03-progress.jpg)
![搜索](docs/screenshots/04-search.jpg)
![设置](docs/screenshots/05-settings.jpg)
![本地播放](docs/screenshots/06-play.jpg)
![油猴脚本](docs/screenshots/07-userscript.jpg)

## 用户数据（不入库）

清单见 `userdata-manifest.json`。主要包括：

| 文件 | 说明 |
|---|---|
| `server/config.json` | 凭证、路径、密码 |
| `server/download_task.json` | 任务进度 |
| `server/cdn_hosts_state.json` | CDN 成功/失败子域（运行中自动写） |
| `server/search_cache.json` / `search_task.json` | 搜索记录与按时间搜索任务 |
| `server/server.log` / `app.pid` | 日志与 PID |

备份时按清单复制即可；不要把这些文件提交到 git。

---

## 常见问题

**Q: 未设置密码能直接用吗？**  
A: 可以（只警告）。局域网内任何人可访问，建议 `node server/app.js --set-password "密码"`。

**Q: 下载的视频在哪？**  
A: `config.json` 的 `downloadPath`。`useAuthorSubdir: true` 时为 `<root>/<作者>/<文件名>`，默认否，直接 `<root>/<文件名>`。

**Q: 搜索「奥黛塔」结果不对？**  
A: 必须走 `/search?query=`（与官网 `https://www.iwara.tv/search?type=videos&query=奥黛塔` 一致），不要用 `/videos?search=`。当前版本已按官网 API。

**Q: 下载 403？**  
A: 常见原因：① 直链过期（必须每次重新获取，不要复用旧 URL）② UA 用了完整 Chrome（带 AppleWebKit）会被 CF 拦，必须用精简 UA ③ CDN 子域被挑战（会自动换子域）。常见处理见下方「常见问题」。

**Q: Cookie / Token 会不会被推到 GitHub？**  
A: 不会。`server/config.json` 已 gitignore。仓库只有空凭证的 `config.example.json`。

**Q: GitHub 推送凭据放哪？**  
A: 由 dsh-git-push 插件托管，无需在项目里放 token 文件。

---


---

## TODO

### 封面状态机

当前封面生成逻辑：视频文件不存在 → 不生成；存在 → 抽帧覆盖。

**待实现：引入「状态机」解耦 video_status 和 cover_status**

- video_status：pending → transcoding → available / unavailable（源文件丢失）
- cover_status：empty → generating → done / failed

生成条件：video_status = available 且 cover_status != done

好处：
- 错误封面不再占位（cover_status=done 但 video_status=unavailable 时不生成）
- 视频源恢复后自动触发重新生成
- 避免每次播放都重复抽帧


---
- cover_status：empty → generating → done / failed

生成条件：video_status = available 且 cover_status != done

好处：
- 错误封面不再占位（cover_status=done 但 video_status=unavailable 时不生成）
- 视频源恢复后自动触发重新生成
- 避免每次播放都重复抽帧

## License

MIT
