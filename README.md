# iwara-downloader

> 从 [Iwara](https://www.iwara.tv) 搜索、解析并下载视频的零依赖 Node.js 服务：单进程、无 npm 依赖、自带网页界面与本地播放页。


### npx 运行

```bash
npx iwara-downloader --port <端口>
```

数据目录默认 `~/.iwara-downloader`，可用 `--data-dir` 或环境变量 `DATA_DIR` 指定。

## 功能

| 功能 | 做什么 | 入口 |
| --- | --- | --- |
| 关键词搜索 | 对齐官网 `/search?type=videos&query=` | 网页「搜索」 |
| 批量下载 | 输入视频 ID 或完整链接，预解析后一键下载 | 网页「下载」 |
| 断点续传 | Range 续传、失败重试、暂停 / 恢复 / 停止 | 网页「进度」 |
| 本地播放 | 未下完也能播已缓存部分，右侧索引列表懒加载 | 页面 `/{id}` |
| 收藏 / 关注 | 下载自动点赞关注；列表与播放页显示真实状态 | `POST /api/like`、`/api/follow` |
| 作者头像 | 本地缓存作者头像并在播放页显示 | 搜索 / 下载自动更新 |
| 凭证双模式 | Cookie 或 Token，油猴脚本一键采集 | 网页「设置」 |
| 发送到服务器 | 浏览器把当前视频推给服务器建下载任务 | 油猴脚本面板 |
| 文件名模板 | 变量替换，落盘自动补扩展名 | 网页「设置」 |
| 双下载后端 | `direct`（本机 Node 直连）/ `aria2`（JSON-RPC） | 网页「设置」 |
| CDN 子域轮换 | 失败自动换可用子域，成功 / 失败列表持久化 | 下载任务内置 |
| CF 绕过 | IP 直连 + SNI + 精简 UA | 配置 `iwaraCfgIp` |
| 启停脚本 | start / stop / restart / status 单脚本子命令 | `./start.sh` |

## 环境要求

| 项 | 要求 |
| --- | --- |
| Node.js | 18+（零 npm 依赖，不建 `package.json`） |
| 平台 | Linux / macOS；Windows 用 `start-windows.bat` |
| 网络 | 能访问 iwara.tv（默认 IP 直连 + 精简 UA） |
| 可选 | aria2（选 `aria2` 下载后端时需要） |

## 快速开始

### 方式一：启停脚本（Linux / macOS）

```bash
cp server/config.example.json server/config.json   # 填 iwaraToken 或 iwaraCookie、downloadPath
node server/boot.cjs --set-password "你的密码"      # 可选：设置访问密码（不启动服务）
./start.sh                                          # 重启（默认；未运行则直接启动）
# 浏览器打开 http://<本机IP>:8643
```

### 方式二：Windows

```bat
start-windows.bat
```

未设置密码时只警告、可直接使用；局域网内任何人可访问，建议尽快设置。默认端口 8643，取 `server/config.json` 的 `port`。

### 启停命令

| 命令 | 作用 |
| --- | --- |
| `./start.sh` | 重启（默认，等价 restart；未运行则直接启动） |
| `./start.sh start [--port 8643]` | 启动（`--port` 优先，其次 `config.json`，再缺省 8643） |
| `./start.sh stop` | 停止（PID 优雅停止 → 兜底清理残留进程） |
| `./start.sh status` | 状态：进程 / PID 文件 / HTTP 健康检查 / 日志 |
| `./start.sh --set-password "新密码"` | 设置访问密码（不启动服务） |

PID 文件为项目根 `<项目名>.pid`（不入库）；日志超过 10MB 在 start/restart 时轮转并 gzip。

## 用法

### 网页界面

四个选项卡：**⬇ 下载 / 📊 进度 / 🔍 搜索 / ⚙ 设置**。

| 选项卡 | 能做什么 |
| --- | --- |
| 下载 | 每行一个视频 ID 或链接；可先「预解析」再「开始下载」 |
| 进度 | 暂停 / 恢复 / 停止 / 重试失败；每条可本地播放 |
| 搜索 | 关键词（对齐官网 `?query=`）、排序、可选用户名；勾选后下载 |
| 设置 | 下载路径、文件名模板、作者子目录、后端、Cookie / Token、密码 |

### 界面预览

| 登录 | 下载 |
| --- | --- |
| ![登录](https://cdn.jsdelivr.net/gh/EIGHTfs/iwara-downloader@main/docs/screenshots/01-login.jpg) | ![下载](https://cdn.jsdelivr.net/gh/EIGHTfs/iwara-downloader@main/docs/screenshots/02-download.jpg) |

| 下载进度 | 搜索 |
| --- | --- |
| ![下载进度](https://cdn.jsdelivr.net/gh/EIGHTfs/iwara-downloader@main/docs/screenshots/03-progress.jpg) | ![搜索](https://cdn.jsdelivr.net/gh/EIGHTfs/iwara-downloader@main/docs/screenshots/04-search.jpg) |
| ![设置](https://cdn.jsdelivr.net/gh/EIGHTfs/iwara-downloader@main/docs/screenshots/05-settings.jpg) | ![本地播放](https://cdn.jsdelivr.net/gh/EIGHTfs/iwara-downloader@main/docs/screenshots/06-play.jpg) |

| 设置 | 本地播放 |
| --- | --- |

| 油猴脚本 |
| --- |
| ![油猴脚本](https://cdn.jsdelivr.net/gh/EIGHTfs/iwara-downloader@main/docs/screenshots/07-userscript.jpg) |

### 凭证

| 方式 | 怎么拿 | 填到 |
| --- | --- | --- |
| Cookie | 浏览器登录 iwara 后，油猴脚本面板复制完整 Cookie | `config.json` 的 `iwaraCookie` |
| Token | 油猴脚本面板直接读取登录态 Token | `config.json` 的 `iwaraToken` |

两种方式二选一即可；未配置凭证时只能浏览页面，下载与搜索会失败。细节见 [凭证获取与发送](docs/凭证获取与发送.MD)。

### 下载后端

```bash
/downloadBackend direct      # 默认：本机 Node 直连，每次重新解析 fresh 直链，支持断点续传
/downloadBackend aria2       # 把 fresh 直链推给 aria2（另需 aria2Path / aria2Token，downloadPath 用 aria2 机器路径）
```

后端在网页「设置」里切换，写入 `server/config.json`。aria2 的 DSM 代理写法与 DNS 处理见 [下载后端与网络](docs/下载后端与网络.MD)。

### 文件名模板

```text
fileNameTemplate  Iwara_-_{TITLE}_[{ID}]_[{QUALITY}]     # 只写模板，不要写 .mp4（落盘自动补扩展名）
```

变量与油猴脚本一致；`useAuthorSubdir: true` 时落盘为 `<downloadPath>/<作者>/<文件名>`。

### 本地播放与收藏

```text
http://<本机IP>:8643/<video-id>          # 播放页：已缓存部分可播，含作者头像、点赞/关注按钮、右侧索引
```

### 发送到服务器

```text
http://<本机IP>:8643/scripts/iwara-cred-fetch.user.js    # 油猴脚本安装地址（含凭证采集与一键发送）
```

### 自动更新

```bash
curl -s http://<本机IP>:8643/api/auto-update/status                  # 状态与当前模式
curl -s -X POST http://<本机IP>:8643/api/auto-update/check           # 立即检查新版本
```

## API

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `/api/status` | GET | 服务状态、端口、登录态 |
| `/api/login`、`/api/logout` | POST | 登录 / 登出 |
| `/api/change-password` | POST | 改密（已设密码需旧密码） |
| `/api/search` | POST | 关键词搜索（对齐官网 query） |
| `/api/video-info` | GET | 解析单个视频（标题 / 作者 / 画质 / 直链） |
| `/api/download` | POST | 提交下载任务（视频 ID 或链接） |
| `/api/task` | GET | 任务状态与统计 |
| `/api/index`、`/api/index/export` | GET | 本地索引读取 / 导出 |
| `/api/like`、`/api/follow` | POST | 点赞 / 关注 |
| `/api/liked-state`、`/api/following` | GET | 本地已赞 / 已关注状态 |
| `/api/cred` | GET | 当前凭证配置（脱敏） |
| `/api/receive` | POST | 油猴脚本 / 外部推送入口 |
| `/api/auto-update/status` | GET | 自动更新状态 |

```bash
curl -s http://<本机IP>:8643/api/status
# {"ok":true,"needsSetup":true,"needsAuth":false,"authed":false,"port":8643}

curl -s http://<本机IP>:8643/api/task
# {"ok":true,"task":{"status":"idle","items":[],"idx":0,"completed":0,"failed":0,…}}
```

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [项目结构与配置](docs/项目结构与配置.MD) | 目录结构、`server/config.json` 配置项、不入库的用户数据清单 |
| [架构与数据流](docs/架构与数据流.MD) | 进程角色、请求链路、数据落点、前端组织 |
| [凭证获取与发送](docs/凭证获取与发送.MD) | Cookie / Token 两种凭证的获取，以及一键发送到服务器的链路 |
| [下载后端与网络](docs/下载后端与网络.MD) | `direct` / `aria2` 后端配置、IP 直连与 DNS 处理 |
| [作者头像与索引](docs/作者头像与索引.MD) | 作者头像与索引的完整流程、渲染条件与已知边界 |
| [视频页](docs/视频页.MD) | 播放页加载链路、播放器配置、画面手势、播放列表 |
| [进度条缩略图](docs/进度条缩略图.MD) | 雪碧图生成、VTT 描述、接口与边界 |
| [点赞与关注](docs/点赞与关注.MD) | 状态来源、按钮开关逻辑、冷却与后端链路 |
| [搜索列表](docs/搜索列表.MD) | 搜索接口、已赞标记、状态变化的局部刷新 |
| [索引存储技术文档](docs/索引存储技术文档.MD) | 本地索引存储与维护 |
| [常见问题与踩坑](docs/常见问题与踩坑.MD) | 问答与踩坑记录（UA、Cloudflare、链接过期、CDN 子域等） |
| [设计决策记录](docs/设计决策记录.MD) | 关键问题的候选方案对比与取舍依据 |
| [待办](docs/待办.MD) | 未完成项（封面状态机） |
| [CHANGELOG](docs/CHANGELOG.md) | 版本记录（按 git log 聚合） |

## 版本

版本记录见 [docs/CHANGELOG.md](docs/CHANGELOG.md)（首条即当前版本）。
