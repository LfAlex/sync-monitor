我想写一个实时这个任务的动态，https\://t.10jqka.com.cn/lgt/user\_page/?user\_code=1179giyc4jr06d6785e69e#/，如果发了动态获取动态信息并通过微信告诉我，需要怎么做

<br />

你给的这个 `user_code` 主页（`https://t.10jqka.com.cn/lgt/user_page/?user_code=1179giyc4jr06d6785e69e#/`）我看了一下，页面本身是**空壳**——Vue 单页应用，内容全靠前端 JS 异步拉取再渲染，直接请求这个 URL 拿到的 HTML 里没有发言数据。所以“监控这个页面”这件事，**不能靠抓页面 HTML，得抓它背后的 XHR 接口**。整条链路拆成四段来做，下面给你一份能落地的方案。

## 整体架构：四层各管一件事

参考通用的“网页变化 → 微信通知”工程模式，拆成采集、去重、调度、通知四层，一台最便宜的云服务器或者你自己的电脑就能跑，不需要公网 Web 服务 。

```
[定时触发] → [请求同花顺动态接口] → [SQLite 去重] → 有新条目? → [Server酱/企微机器人 → 微信]
                    ↑                                        ↓
                    └──────── 记录 last_id / 时间戳 ──────────┘
```

## 第 1 步：先抓到“动态列表”的真实接口（关键，也是唯一需要你手动做的）

页面是异步加载，接口 URL 和参数必须自己抓一次。操作：

1. Chrome 打开你这个 user\_code 主页，按 `F12` → **Network**​ → 勾选 **XHR/fetch**
2. 刷新页面，看列表里哪几个请求返回了 JSON，且 JSON 里能找到“动态内容、发布时间、动态 id”这类字段
3. **重点看这几类信号**：
   * URL 里带 `user_code`、`fid`、`page`、`limit` 之类参数
   * 返回体里有类似 `data.list[]`、`content`、`create_time`、`dynamic_id`、`post_id` 字段
   * 请求头里带 `hexin-v`、`v`、`token`、`Referer`（同花顺风控必需，缺 Referer 大概率 302 到错误页）
4. 右键那个接口 → **Copy → Copy as cURL**，粘到 [curlconverter.com](https://curlconverter.com/) 转成 Python requests 代码，这就是你的采集函数原型

> ⚠️ 同花顺的动态接口大多有 **Cookie 风控 + 动态签名参数**（`v`、`token`、`sign` 每请求都可能变），硬编码 Cookie 用几次就失效 。如果抓到的接口带这些参数，两个选择：
>
> * **轻度方案**：用 Playwright/Pyppeteer 起一个常驻浏览器实例，让 JS 自己生成签名，你只负责从 `page.on('response')` 里截 JSON
> * **纯 requests 方案**：得逆向 `hexin-v` 的生成算法（GitHub 有 `wangh00/10jqka_login` 这类开源参考），维护成本高

对你这个“盯一个人发动态”的场景，建议**直接上 Playwright**，别在逆向签名上耗时间——单账号、单页面、5-10 分钟轮询一次，一个 headless Chromium 常驻完全够用。

## 第 2 步：采集 + 去重（SQLite 一把梭）

拿到接口 JSON 后，核心工程问题是**去重**——不然每次轮询都会把同一条动态推一遍。用 SQLite 的 `UNIQUE` 约束 + `INSERT OR IGNORE` 是最干净的做法 。

```
# collector.py
import sqlite3, json, time
from playwright.sync_api import sync_playwright

DB_PATH = "ths_monitor.db"
TARGET_URL = "https://t.10jqka.com.cn/lgt/user_page/?user_code=1179giyc4jr06d6785e69e#/"
API_KEYWORD = "/lgt/api/"   # 替换成你抓到的接口路径关键词

def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS dynamics (
            dynamic_id TEXT PRIMARY KEY,
            content    TEXT,
            pub_time   TEXT,
            raw        TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.commit(); conn.close()

def fetch_latest_dynamics():
    """用 Playwright 截获动态接口返回的 JSON"""
    captured = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0 Safari/537.36"
        )
        def on_response(resp):
            if API_KEYWORD in resp.url and resp.status == 200:
                try:
                    captured.append(resp.json())
                except Exception:
                    pass
        page.on("response", on_response)
        page.goto(TARGET_URL, wait_until="networkidle", timeout=30000)
        page.wait_for_timeout(5000)   # 给异步接口留时间
        browser.close()
    return captured

def parse_dynamics(payloads):
    """按你抓到的实际 JSON 结构解析；下面字段名是占位，需替换"""
    items = []
    for p in payloads:
        for d in p.get("data", {}).get("list", []):
            items.append({
                "dynamic_id": str(d["id"]),          # ← 换成真实字段
                "content":    d.get("content", "")[:200],
                "pub_time":   d.get("create_time", ""),
                "raw":        json.dumps(d, ensure_ascii=False),
            })
    return items

def save_new(items):
    conn = sqlite3.connect(DB_PATH)
    new = []
    for it in items:
        cur = conn.execute(
            "INSERT OR IGNORE INTO dynamics (dynamic_id, content, pub_time, raw) VALUES (?,?,?,?)",
            (it["dynamic_id"], it["content"], it["pub_time"], it["raw"]),
        )
        if cur.rowcount > 0:
            new.append(it)
    conn.commit(); conn.close()
    return new   # 只返回真正新插入的
```

`rowcount > 0` 是这套去重的关键判断——被 `INSERT OR IGNORE` 跳过的不会进入通知环节 。

## 第 3 步：微信推送，选一个通道

个人使用场景，两个主流选择：

**方案 A：Server酱（推荐，最简单）**

一个 SendKey 就能推到个人微信，扫码登录 [sct.ftqq.com](https://sct.ftqq.com/) 拿 key 即可。免费版 5 条/天、Turbo 版 200 条/天，盯一个人的动态完全够 。

```
# notifier.py
import os
from serverchan_sdk import sc_send

def push(new_items):
    if not new_items:
        return
    title = f"同花顺动态更新 × {len(new_items)}"
    body = "\n\n".join(
        f"🕐 {it['pub_time']}\n{it['content']}\n———" for it in new_items[:5]
    )
    body += f"\n\n🔗 {TARGET_URL}"
    sc_send(os.environ["SERVERCHAN_SENDKEY"], title, body)
```

**方案 B：企业微信群机器人**

如果你有企业微信（建个只有自己的群也行），群设置 → 群机器人 → 复制 Webhook，20 条/分钟，也是最省事的路子 。

```
import requests
def push(new_items):
    if not new_items: return
    webhook = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=你的KEY"
    content = "【同花顺动态更新】\n" + "\n\n".join(
        f"{it['pub_time']}\n{it['content']}" for it in new_items[:5]
    )
    requests.post(webhook, json={"msgtype":"text","text":{"content":content}}, timeout=10)
```

> 💡 个人单账号、频率不高，选 **Server酱**；如果你后面还想扩展成盯多个人、多策略告警，就选**企微机器人**。

## 第 4 步：调度 + 部署

**调度**：`APScheduler` 直接在 Python 进程里按 cron 跑，比系统 crontab 更贴 Python 生态 。

```
# main.py
from apscheduler.schedulers.blocking import BlockingScheduler
from collector import init_db, fetch_latest_dynamics, parse_dynamics, save_new
from notifier import push

def job():
    payloads = fetch_latest_dynamics()
    items = parse_dynamics(payloads)
    new = save_new(items)
    if new:
        push(new)
    print(f"[{time.strftime('%H:%M:%S')}] 抓取 {len(items)} 条，新增 {len(new)} 条")

if __name__ == "__main__":
    init_db()
    job()   # 首次跑建立基线，不发通知（避免上来就推一堆历史动态）
    sched = BlockingScheduler(timezone="Asia/Shanghai")
    sched.add_job(job, "interval", minutes=10)   # 10 分钟一次
    sched.start()
```

**部署三选一**：

| 方式                              | 适合场景           | 成本                    |
| :------------------------------ | :------------- | :-------------------- |
| 本机后台跑（`nohup python main.py &`） | 你电脑常年开机        | 0                     |
| 云服务器（腾讯云/阿里云最便宜的轻量应用服务器）        | 7×24 稳定、不怕本机休眠 | 60-100 元/年            |
| Docker 容器                       | 想环境隔离、迁移方便     | 同上，参考 的 Dockerfile 模板 |

> ⚠️ **频率建议**：盯一个人的动态，**5-10 分钟一次足够**，别设成 1 分钟——同花顺连 10 次就会触发风控跳验证页 ，Playwright 也一样会被封 IP。

## 完整的踩坑清单

* **首次运行只建基线、不推送**：先跑一次把当前所有动态 id 写进 SQLite，之后的轮询才对比出“新增”，不然第一次启动会把历史动态全推一遍
* **`user_code` ≠ `fid` ≠ `uid`**：你 URL 里是 `user_code`，接口参数可能要求另一种 ID，抓包时以实际请求的 query string 为准
* **签名参数失效**：如果跑几天后突然抓不到数据，八成是 `hexin-v` 算法更新了，Playwright 方案一般不受影响（真浏览器跑 JS），纯 requests 方案就得重新逆向
* **动态内容里的图片/引用/@**：`content` 字段可能嵌 HTML 或特殊结构，推微信前做一次 `BeautifulSoup(text)` 清洗，不然微信里会看到一堆标签
* **Server酱免费额度**：5 条/天容易超，如果目标用户发言频繁，直接上 Turbo（几块钱）或换企微机器人

## 合规说明

**自用、低频、不对外分发**，属于《个人信息保护法》里“在合理范围内处理已公开个人信息”，风险可控。但不要做这几件事：

* 把抓到的动态原文转载到其他平台或产品里（灯塔诉同花顺案的败诉方就是踩了这条）
* 批量盯几百上千个用户形成“数据服务”
* 绕过登录去抓需要关注/好友才能看的内容

一个人、一台机器、推自己微信看，就是**个人自动化工具的合理边界**，不用过度担心。

***

想让我帮你把哪一段再拆细？比如：

* **抓包环节**：你打开 F12 后不确定哪个是动态接口，可以把 Network 面板截图发我，我帮你认
* **Playwright 拦截模板**：给一份带重试、带 Cookie 持久化、能扛风控跳转的完整脚本
* **多用户监控**：从盯 1 个人扩展到盯 N 个人、每人一个 SQLite 表 / 一个推送分组的组织方式

告诉我你卡在哪一步，或者你现在 F12 里看到的接口长什么样，我直接对着你的实际情况往下写。
