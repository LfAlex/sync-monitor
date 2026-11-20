# Sync Monitor

面向个人主页和信息源的轻量动态监控工具。支持 RSS / Atom、HTML 列表页、JSON 接口，以及同花顺用户主页这类依赖浏览器登录态和动态签名的单页应用。

项目提供 **Chrome 扩展**和 **Python 后端**两种完全独立的运行方式：扩展在浏览器本地提醒，后端可持续运行并通过 Server酱推送到微信。

![Chrome MV3](https://img.shields.io/badge/Chrome-Manifest_V3-4285F4?logo=googlechrome&logoColor=white)
![Python 3.9+](https://img.shields.io/badge/Python-3.9%2B-3776AB?logo=python&logoColor=white)
![Storage](https://img.shields.io/badge/Storage-Chrome_Local_%2F_SQLite-0F766E)

## 功能特性

- **多类型信息源**：自动识别或手动配置 RSS / Atom、HTML 列表、JSON 接口。
- **单页应用采集**：在真实页面上下文中请求接口，复用页面自身的 Cookie、签名和 Referer，无需逆向签名算法。
- **同花顺快捷添加**：只需填写用户 ID，即可复用现有接口、请求头、解析规则和检查间隔。
- **新动态提醒**：首次检查仅建立基线，不提醒历史内容；后续按条目指纹去重。
- **多种通知方式**：扩展支持页面内提示和系统通知；后端支持 Server酱微信推送。
- **完整动态详情**：保存并展示全文、全部配图和原文链接，支持缩略图及原比例放大查看。
- **批量检查与静默回填**：一键检查所有监控项；重新采集可补齐全文和图片，且不触发新动态提醒。
- **本地管理**：支持启停监控、自定义间隔、配置导入导出；后端提供本地 Web 管理界面和 HTTP API。
- **无重型依赖**：扩展无需构建，后端仅使用 Python 标准库；浏览器模式复用本机 Chrome 或 Edge。

## 两种运行方式

| 对比项 | Chrome 扩展 | Python 后端 |
| --- | --- | --- |
| 运行位置 | 浏览器内 | 本机或服务器后台 |
| 单页应用方式 | `pageapi`，在页面主世界执行请求 | `browser`，通过 CDP 驱动 Chrome / Edge |
| 数据存储 | `chrome.storage.local` | SQLite |
| 通知方式 | 页面提示、系统通知 | Server酱微信推送 |
| 管理入口 | 扩展弹窗与动态详情页 | 本地 Web 管理界面 |
| 额外依赖 | Chrome 102+ 或兼容浏览器 | Python 3.9+；浏览器模式需 Chrome / Edge |
| 适合场景 | 日常使用、快速配置、查看完整动态 | 持续运行、微信通知、长期记录 |

> 两套实现没有相互调用或数据依赖，可以任选其一，也可以分别独立使用。

## 快速开始：Chrome 扩展

### 安装

1. 下载或克隆本仓库。
2. 在 Chrome 中打开 `chrome://extensions`。
3. 开启右上角“开发者模式”。
4. 点击“加载已解压的扩展程序”，选择本项目的 **`extension` 目录**。
5. 固定 Sync Monitor 图标并打开扩展。

扩展使用 Manifest V3，无需执行 `npm install`，也无需构建。

### 添加同花顺监控

1. 点击“添加监控”。
2. 输入同花顺用户 ID，即主页地址中 `user_code` 的值：

   ```text
   https://t.10jqka.com.cn/lgt/user_page/?user_code=你的用户ID
   ```

3. 点击“保存并检查”。首次成功检查只建立基线，不提醒已有动态。
4. 后续发现新内容时，扩展会按设置显示页面提示或系统通知。

如果目标主页尚未打开，扩展会尝试在独立的最小化窗口中打开并复用该页面。其他信息源可点击“高级配置”，手动填写选择器、接口路径、请求头或请求体。

### 日常使用

- 点击顶部“立即检查”，依次检查所有已配置监控项并汇总结果。
- 点击动态进入详情页，查看全文、配图和原文链接。
- 使用“重新采集”刷新本地历史条目，可补齐缺失内容且不会重复提醒。
- 在“设置”中调整提示时长、系统通知和默认检查间隔，或导入、导出监控配置。
- 修改扩展代码后，需要在 `chrome://extensions` 中重新加载扩展。

## 快速开始：Python 后端

### 环境要求

- Python 3.9+
- 使用 `browser` 类型时，本机安装 Chrome 或 Edge
- 需要微信通知时，准备一个 Server酱 SendKey

后端仅使用 Python 标准库，不需要安装 Playwright 或第三方 pip 包。

### 1. 创建本地配置

Windows PowerShell：

```powershell
cd backend
Copy-Item config.example.json config.json
```

macOS / Linux：

```bash
cd backend
cp config.example.json config.json
```

编辑 `backend/config.json`，按需修改监控项、检查间隔、浏览器路径和 Server酱配置。完整示例见 [config.example.json](backend/config.example.json)。

### 2. 执行一次无推送检查

Windows：

```powershell
python monitor.py --once --no-push
```

macOS / Linux：

```bash
python3 monitor.py --once --no-push
```

首次检查用于建立基线。确认配置和日志正常后，再启动持续监控。

### 3. 启动服务

Windows：

```powershell
python monitor.py
```

macOS / Linux：

```bash
python3 monitor.py
```

默认管理地址：<http://127.0.0.1:8787>。

### Server酱配置

可以在 `config.json` 的 `serverchan.sendKey` 中配置，也可以使用环境变量覆盖，避免将密钥写入配置文件：

Windows PowerShell：

```powershell
$env:SERVERCHAN_SENDKEY="你的 SendKey"
```

macOS / Linux：

```bash
export SERVERCHAN_SENDKEY="你的 SendKey"
```

发送测试消息：

```bash
python monitor.py --test-push
```

不需要推送时，可将 `serverchan.enabled` 设为 `false`，或启动时添加 `--no-push`。

### 常用命令

```bash
# 检查一轮后退出
python monitor.py --once

# 只检查指定监控项
python monitor.py --once --monitor ths_demo

# 本次运行只记录，不推送
python monitor.py --no-push

# 使用其他配置文件或端口
python monitor.py --config /path/to/config.json --port 8788
```

## 监控类型与配置

| 类型 | 适用场景 | 关键配置 |
| --- | --- | --- |
| `auto` | 自动探测 RSS、HTML 或 JSON | 主页地址 |
| `rss` | RSS 2.0 / Atom 订阅源 | 订阅地址 |
| `html` | 普通 HTML 列表页 | 列表项、标题、链接、时间、内容选择器 |
| `json` | 公开 JSON 接口 | 列表、ID、正文、时间、链接等点号路径 |
| `pageapi` | 扩展中的单页应用页面接口 | 页面地址、接口地址、方法、请求头、请求体、JSON 路径 |
| `browser` | 后端中的单页应用页面接口 | 浏览器页面、等待参数、接口及 JSON 路径 |

说明：

- JSON 路径支持点号和数组下标，例如 `data.contents`、`info.id`。
- 时间格式支持秒或毫秒时间戳，分别使用 `s`、`ms`。
- 同花顺接口必须携带 `Content-Type: application/json`，请求体中必须包含对应的 `user_code`。
- 同花顺建议采用 **300 秒或更长**的检查间隔，避免高频访问触发目标站点风控。
- 后端默认仅监听 `127.0.0.1`；如暴露到其他网络，请自行补充访问控制和 TLS。

## 项目结构

```text
sync-monitor/
├── extension/                 # Chrome Manifest V3 扩展
│   ├── manifest.json          # 扩展声明与权限
│   ├── background.js          # 调度、采集、去重、通知与本地存储
│   ├── content/toast.js       # 页面内新动态提示
│   ├── lib/parse.js           # RSS / HTML / JSON 解析核心
│   ├── popup/                 # 监控列表、快捷添加与设置界面
│   └── detail/                # 动态列表、单条全文与图片查看
├── backend/                   # 独立 Python 后端
│   ├── monitor.py             # 调度、SQLite、Server酱、Web UI 与 API
│   ├── browser.py             # 基于 CDP 的页面内接口采集
│   ├── config.example.json    # 不含真实密钥的配置模板
│   └── ui/index.html          # 本地管理界面
├── .gitignore                 # 排除密钥配置、数据库和运行缓存
└── README.md
```

## 数据存储与安全

- 扩展的监控配置、采集结果和设置均保存在浏览器本地。
- 后端默认将 SQLite 数据库和运行日志写入 `backend/data/`。
- `backend/config.json`、`backend/data/`、`.env.*` 已被 `.gitignore` 排除，不应提交到仓库。
- 不要将真实 SendKey、Cookie、Token、浏览器配置目录或 SQLite 数据文件提交到 GitHub。
- 页面接口请求会使用当前浏览器会话；请仅监控你有权访问的公开内容，并遵守目标站点条款和适用法律。
- 建议个人、低频使用，不要用于批量采集、转载分发或绕过访问权限。

## 故障排查

### 同花顺返回 `status_code=1000`

重新加载扩展，使旧配置自动完成迁移；然后在高级配置中确认：

- 请求头包含 `Content-Type: application/json`。
- 请求体包含正确的 `user_code`。
- 点击“立即检查”重试，无需删除并重新添加监控。

### 页面接口返回 401 / 403，或提示尚未就绪

目标页面可能尚未完成初始化，或登录态、签名 Cookie 已失效。打开并刷新目标主页，确认页面自身能正常显示动态，等待片刻后重新检查。

### 历史动态缺少全文或图片

点击“立即检查”或对应监控项的“重新采集”，再刷新详情页。重新采集会覆盖本地同一条目的内容，但不会触发新动态提醒。

### 后端找不到浏览器

安装 Chrome / Edge，或在 `config.json` 中通过 `browser.executable` 指定浏览器可执行文件的绝对路径。

### 后端端口被占用

修改 `config.json` 的 `server.port`，或临时使用其他端口：

```bash
python monitor.py --port 8788
```

### 提示已有监控实例运行

后端通过实例锁避免重复采集、重复推送和浏览器配置目录争用。请先关闭旧实例，再启动新的服务。

## 开发与贡献

1. Fork 仓库并创建功能分支。
2. 保持改动聚焦；扩展代码修改后重新加载扩展验证，后端可使用 `--once --no-push` 做无副作用检查。
3. 测试时使用独立浏览器 Profile 和配置副本，避免污染正在使用的监控数据。
4. 配置结构变化时，同步更新 `backend/config.example.json` 和本 README。
5. 提交 Pull Request 时说明问题、改动和验证方式，不要附带真实密钥、Cookie、数据库或个人监控数据。

后端语法检查：

```bash
python -m py_compile backend/monitor.py backend/browser.py
```

欢迎通过 Issue 反馈可复现的问题。建议附上扩展或后端版本、监控类型、脱敏配置、错误信息和复现步骤。
