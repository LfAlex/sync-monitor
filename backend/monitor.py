#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Sync Monitor 后端服务。

定时监控主页动态（浏览器接口 / RSS / HTML 列表 / JSON 接口），用 SQLite 去重，
发现新动态后通过 Server酱 推送到微信，并提供本地 Web 管理界面与 HTTP API。

运行：python monitor.py
依赖：仅 Python 3.9+ 标准库；browser 模式需要本机安装 Chrome 或 Edge。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import re
import sqlite3
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections import deque
from datetime import datetime
from html.parser import HTMLParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from browser import BrowserError, BrowserFetcher  # noqa: E402

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.environ.get("SYNC_MONITOR_CONFIG") or os.path.join(BASE_DIR, "config.json")
UI_PATH = os.path.join(BASE_DIR, "ui", "index.html")
MIN_INTERVAL_SEC = 120
MAX_INTERVAL_SEC = 86400
DEFAULT_INTERVAL_SEC = 300
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

LOG_BUFFER: deque[str] = deque(maxlen=300)


class Logger:
    def __init__(self) -> None:
        self.logger = logging.getLogger("sync-monitor")
        self.logger.setLevel(logging.INFO)
        self.logger.handlers.clear()
        formatter = logging.Formatter("%(asctime)s  %(levelname)-7s %(message)s", "%Y-%m-%d %H:%M:%S")
        stream = logging.StreamHandler(sys.stdout)
        stream.setFormatter(formatter)
        self.logger.addHandler(stream)

    def add_file_handler(self, path: str) -> None:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        from logging.handlers import RotatingFileHandler

        handler = RotatingFileHandler(path, maxBytes=2 * 1024 * 1024, backupCount=3, encoding="utf-8")
        handler.setFormatter(logging.Formatter("%(asctime)s  %(levelname)-7s %(message)s"))
        self.logger.addHandler(handler)

    def _emit(self, level: str, message: str, *args) -> None:
        text = message % args if args else message
        LOG_BUFFER.append(f"{time.strftime('%Y-%m-%d %H:%M:%S')}  {level:<7} {text}")
        getattr(self.logger, level.lower(), self.logger.info)(text)

    def info(self, message: str, *args) -> None:
        self._emit("INFO", message, *args)

    def warning(self, message: str, *args) -> None:
        self._emit("WARNING", message, *args)

    def error(self, message: str, *args) -> None:
        self._emit("ERROR", message, *args)


log = Logger()


# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------

def clamp_int(value, default: int, minimum: int, maximum: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = default
    return max(minimum, min(maximum, number))


def normalize_monitor(raw: dict, defaults: dict | None = None) -> dict:
    defaults = defaults or {}
    url = str(raw.get("url") or "").strip()
    monitor_type = str(raw.get("type") or "auto").strip()
    if monitor_type not in ("auto", "rss", "html", "json", "browser"):
        monitor_type = "auto"
    interval = clamp_int(
        raw.get("intervalSec") or defaults.get("intervalSec") or DEFAULT_INTERVAL_SEC,
        DEFAULT_INTERVAL_SEC,
        MIN_INTERVAL_SEC,
        MAX_INTERVAL_SEC,
    )
    monitor = {
        "id": str(raw.get("id") or "").strip() or "m_" + hashlib.md5((url + str(time.time())).encode()).hexdigest()[:10],
        "name": str(raw.get("name") or "").strip() or url,
        "url": url,
        "type": monitor_type,
        "enabled": raw.get("enabled", True) is not False,
        "intervalSec": interval,
        "headers": raw.get("headers") if isinstance(raw.get("headers"), dict) else {},
        "note": str(raw.get("note") or ""),
    }
    monitor["headers"] = {str(k): str(v) for k, v in monitor["headers"].items()}

    browser_cfg = raw.get("browser") if isinstance(raw.get("browser"), dict) else {}
    monitor["browser"] = {
        "pageUrl": str(browser_cfg.get("pageUrl") or url).strip(),
        "waitMs": clamp_int(browser_cfg.get("waitMs", 2500), 2500, 0, 30000),
        "waitCookie": str(browser_cfg.get("waitCookie") or ""),
        "api": browser_cfg.get("api") if isinstance(browser_cfg.get("api"), dict) else {},
    }

    html_cfg = raw.get("html") if isinstance(raw.get("html"), dict) else {}
    monitor["html"] = {
        "itemSelector": str(html_cfg.get("itemSelector") or "").strip(),
        "titleSelector": str(html_cfg.get("titleSelector") or "").strip(),
        "linkSelector": str(html_cfg.get("linkSelector") or "").strip(),
        "timeSelector": str(html_cfg.get("timeSelector") or "").strip(),
        "contentSelector": str(html_cfg.get("contentSelector") or "").strip(),
        "idAttribute": str(html_cfg.get("idAttribute") or "").strip(),
        "itemLimit": clamp_int(html_cfg.get("itemLimit", 30), 30, 1, 200),
    }

    json_cfg = raw.get("json") if isinstance(raw.get("json"), dict) else {}
    monitor["json"] = {
        "listPath": str(json_cfg.get("listPath") or "data.list").strip() or "data.list",
        "idPath": str(json_cfg.get("idPath") or "id").strip(),
        "titlePath": str(json_cfg.get("titlePath") or "").strip(),
        "contentPath": str(json_cfg.get("contentPath") or "content").strip(),
        "timePath": str(json_cfg.get("timePath") or "").strip(),
        "linkPath": str(json_cfg.get("linkPath") or "").strip(),
        "linkTemplate": str(json_cfg.get("linkTemplate") or "").strip(),
        "timeFormat": str(json_cfg.get("timeFormat") or "").strip(),
        "itemLimit": clamp_int(json_cfg.get("itemLimit", 30), 30, 1, 200),
    }

    rss_cfg = raw.get("rss") if isinstance(raw.get("rss"), dict) else {}
    monitor["rss"] = {"url": str(rss_cfg.get("url") or "").strip()}
    return monitor


def load_config(path: str) -> dict:
    if not os.path.exists(path):
        raise SystemExit(f"配置文件不存在：{path}\n可从 config.example.json 复制一份再修改。")
    with open(path, "r", encoding="utf-8") as handle:
        try:
            config = json.load(handle)
        except json.JSONDecodeError as exc:
            raise SystemExit(f"配置文件不是合法 JSON：{exc}") from exc

    server = config.setdefault("server", {})
    server["host"] = os.environ.get("HOST") or server.get("host") or "127.0.0.1"
    server["port"] = int(os.environ.get("PORT") or server.get("port") or 8787)

    serverchan = config.setdefault("serverchan", {})
    if os.environ.get("SERVERCHAN_SENDKEY"):
        serverchan["sendKey"] = os.environ["SERVERCHAN_SENDKEY"]
    serverchan["enabled"] = bool(serverchan.get("enabled", True)) and not os.environ.get("SYNC_MONITOR_NO_PUSH")
    serverchan.setdefault("apiBase", "https://sctapi.ftqq.com")

    defaults = config.setdefault("defaults", {})
    defaults["intervalSec"] = clamp_int(defaults.get("intervalSec", DEFAULT_INTERVAL_SEC), DEFAULT_INTERVAL_SEC, MIN_INTERVAL_SEC, MAX_INTERVAL_SEC)

    config["monitors"] = [normalize_monitor(item, defaults) for item in (config.get("monitors") or []) if item.get("url")]
    return config


def save_config(path: str, config: dict) -> None:
    payload = dict(config)
    payload["monitors"] = [serialize_monitor(item) for item in config["monitors"]]
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def serialize_monitor(monitor: dict) -> dict:
    return {
        "id": monitor["id"],
        "name": monitor["name"],
        "url": monitor["url"],
        "type": monitor["type"],
        "enabled": monitor["enabled"],
        "intervalSec": monitor["intervalSec"],
        "headers": monitor.get("headers") or {},
        "browser": monitor.get("browser") or {},
        "html": monitor.get("html") or {},
        "json": monitor.get("json") or {},
        "rss": monitor.get("rss") or {},
        "note": monitor.get("note") or "",
    }


# ---------------------------------------------------------------------------
# 迷你 HTML / CSS 选择器（用于普通列表页）
# ---------------------------------------------------------------------------

VOID_TAGS = {
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr",
}


class Node:
    __slots__ = ("tag", "attrs", "children", "parent", "text")

    def __init__(self, tag: str = "#document", attrs: dict | None = None, parent: "Node | None" = None):
        self.tag = tag
        self.attrs = attrs or {}
        self.children: list[Node] = []
        self.parent = parent
        self.text = ""


class _DomBuilder(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.root = Node()
        self.stack = [self.root]

    def handle_starttag(self, tag: str, attrs):
        node = Node(tag.lower(), {k.lower(): (v or "") for k, v in attrs}, self.stack[-1])
        self.stack[-1].children.append(node)
        if tag.lower() not in VOID_TAGS:
            self.stack.append(node)

    def handle_startendtag(self, tag: str, attrs):
        node = Node(tag.lower(), {k.lower(): (v or "") for k, v in attrs}, self.stack[-1])
        self.stack[-1].children.append(node)

    def handle_endtag(self, tag: str):
        tag = tag.lower()
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                return

    def handle_data(self, data: str):
        text = data.strip()
        if text:
            node = Node("#text", parent=self.stack[-1])
            node.text = text
            self.stack[-1].children.append(node)


def parse_html(text: str) -> Node:
    builder = _DomBuilder()
    builder.feed(text or "")
    builder.close()
    return builder.root


def node_text(node: Node | None, limit: int = 0) -> str:
    if node is None:
        return ""
    parts: list[str] = []
    stack = [node]
    while stack:
        current = stack.pop()
        if current.tag == "#text":
            parts.append(current.text)
        else:
            stack.extend(reversed(current.children))
    text = re.sub(r"\s+", " ", " ".join(parts)).strip()
    return text[:limit] if limit else text


COMPOUND_RE = re.compile(r"(\*|[a-zA-Z][\w:-]*|\.[\w-]+|#[\w-]+|\[[^\]]*\])")


def parse_compound(token: str) -> list[tuple[str, str, str]]:
    parts: list[tuple[str, str, str]] = []
    for piece in COMPOUND_RE.findall(token):
        if piece == "*":
            parts.append(("any", "", ""))
        elif piece.startswith("."):
            parts.append(("class", "", piece[1:]))
        elif piece.startswith("#"):
            parts.append(("id", "", piece[1:]))
        elif piece.startswith("["):
            body = piece[1:-1].strip()
            match = re.match(r"^([\w:.-]+)\s*(?:([*^$~|]?=)\s*[\"']?([^\"'\]]*)[\"']?)?$", body)
            if match:
                parts.append(("attr", match.group(1).lower(), (match.group(2) or "") + "\x00" + (match.group(3) or "")))
        else:
            parts.append(("tag", "", piece.lower()))
    return parts


def match_compound(node: Node, parts: list[tuple[str, str, str]]) -> bool:
    if node.tag == "#text":
        return False
    for kind, name, value in parts:
        if kind == "any":
            continue
        if kind == "tag" and node.tag != value:
            return False
        if kind == "id" and node.attrs.get("id") != value:
            return False
        if kind == "class" and value not in node.attrs.get("class", "").split():
            return False
        if kind == "attr":
            op, _, expected = value.partition("\x00")
            if name not in node.attrs:
                return False
            actual = node.attrs[name]
            if op == "=" and actual != expected:
                return False
            if op == "*=" and expected not in actual:
                return False
            if op == "^=" and not actual.startswith(expected):
                return False
            if op == "$=" and not actual.endswith(expected):
                return False
            if op == "~=" and expected not in actual.split():
                return False
    return True


def _match_complex(node: Node, tokens: list[str], index: int) -> bool:
    if index < 0:
        return True
    token = tokens[index]
    if token == ">":
        return False
    if not match_compound(node, parse_compound(token)):
        return False
    if index - 1 >= 0 and tokens[index - 1] == ">":
        return bool(node.parent) and _match_complex(node.parent, tokens, index - 2)
    parent = node.parent
    while parent is not None and parent.tag != "#document":
        if _match_complex(parent, tokens, index - 1):
            return True
        parent = parent.parent
    return False


def select_all(root: Node, selector: str) -> list[Node]:
    groups = []
    for part in (selector or "").split(","):
        tokens = part.strip().replace(">", " > ").split()
        if tokens:
            groups.append(tokens)
    if not groups:
        return []

    matches: list[Node] = []
    stack = list(root.children)
    while stack:
        node = stack.pop()
        if node.tag == "#text":
            continue
        if any(_match_complex(node, tokens, len(tokens) - 1) for tokens in groups):
            matches.append(node)
        stack.extend(reversed(node.children))
    return matches


def select_one(root: Node, selector: str) -> Node | None:
    found = select_all(root, selector)
    return found[0] if found else None


def heuristic_nodes(root: Node) -> list[Node]:
    """未配置选择器时，自动寻找“重复列表项”。"""
    best: list[Node] = []
    stack = list(root.children)
    while stack:
        node = stack.pop()
        if node.tag == "#text":
            continue
        stack.extend(reversed(node.children))
        groups: dict[str, list[Node]] = {}
        for child in node.children:
            if child.tag != "#text":
                groups.setdefault(child.tag, []).append(child)
        for group in groups.values():
            if len(group) < 2:
                continue
            with_links = [item for item in group if select_one(item, "a[href]")]
            meaningful = [item for item in with_links if len(node_text(item)) >= 10]
            if len(meaningful) >= max(2, int(len(with_links) * 0.6)) and len(meaningful) > len(best):
                best = meaningful
    return best


# ---------------------------------------------------------------------------
# 采集
# ---------------------------------------------------------------------------

def strip_html(text: str) -> str:
    if not text:
        return ""
    if "<" not in text:
        return re.sub(r"\s+", " ", text).strip()
    return node_text(parse_html(text))


def get_path(payload, path: str):
    if not path:
        return payload
    current = payload
    for key in re.sub(r"\[(\d+)\]", r".\1", path).split("."):
        key = key.strip()
        if not key:
            continue
        if isinstance(current, dict):
            current = current.get(key)
        elif isinstance(current, list) and key.isdigit():
            index = int(key)
            current = current[index] if index < len(current) else None
        else:
            return None
        if current is None:
            return None
    return current


def format_time(value, time_format: str = "") -> str:
    if value is None or value == "":
        return ""
    if isinstance(value, (int, float)) or (isinstance(value, str) and value.strip().isdigit()):
        number = float(value)
        if time_format == "ms" or number > 1e12:
            number /= 1000.0
        elif time_format == "s" or number > 1e9:
            pass
        else:
            return str(value)
        try:
            return datetime.fromtimestamp(number).strftime("%Y-%m-%d %H:%M:%S")
        except (OverflowError, OSError, ValueError):
            return str(value)
    text = str(value).strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
        return parsed.strftime("%Y-%m-%d %H:%M:%S")
    except ValueError:
        return str(value)


def make_item(item_id: str, title: str, content: str, link: str, time_text: str, base_url: str) -> dict:
    title = re.sub(r"\s+", " ", title or "").strip()[:160]
    content = re.sub(r"\s+", " ", content or "").strip()[:500]
    link = urllib.parse.urljoin(base_url, link or "")
    key_source = item_id or link or f"{time_text}|{title}"
    return {
        "key": hashlib.md5(key_source.encode("utf-8", "ignore")).hexdigest(),
        "id": item_id or "",
        "title": title or content[:60],
        "content": content or title,
        "link": link,
        "time": time_text or "",
    }


def dedupe(items: list[dict]) -> list[dict]:
    seen = set()
    result = []
    for item in items:
        if item["key"] in seen:
            continue
        seen.add(item["key"])
        result.append(item)
    return result


def decode_body(raw: bytes, content_type: str) -> str:
    match = re.search(r"charset=[\"']?([\w-]+)", content_type or "", re.I)
    charset = match.group(1) if match else ""
    if not charset:
        head = raw[:2048].decode("utf-8", "ignore")
        meta = re.search(r"<meta[^>]+charset=[\"']?([\w-]+)", head, re.I)
        if meta:
            charset = meta.group(1)
    for name in [charset, "utf-8", "gb18030"]:
        if not name:
            continue
        try:
            return raw.decode(name)
        except (LookupError, UnicodeDecodeError):
            continue
    return raw.decode("utf-8", "ignore")


def http_get(url: str, headers: dict | None = None, timeout: int = 25) -> str:
    request_headers = {"User-Agent": USER_AGENT, "Accept": "*/*", "Accept-Encoding": "identity"}
    request_headers.update(headers or {})
    request = urllib.request.Request(url, headers=request_headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return decode_body(response.read(), response.headers.get("Content-Type", ""))
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"HTTP {exc.code}：{url}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"网络错误：{exc.reason}") from exc


def parse_feed(text: str, base_url: str) -> list[dict]:
    try:
        root = ET.fromstring(text)
    except ET.ParseError as exc:
        raise RuntimeError(f"订阅源解析失败：{exc}") from exc

    def local(tag: str) -> str:
        return tag.rsplit("}", 1)[-1].lower()

    entries = [node for node in root.iter() if local(node.tag) in ("item", "entry")]
    items = []
    for entry in entries:
        fields: dict[str, str] = {}
        links = []
        for child in entry:
            name = local(child.tag)
            if name == "link":
                links.append(child.get("href") or (child.text or ""))
                continue
            if name in ("guid", "id"):
                fields["id"] = (child.text or "").strip()
            elif name in ("title",):
                fields["title"] = (child.text or "").strip()
            elif name in ("description", "summary", "content", "encoded"):
                if name not in fields or len(child.text or "") > len(fields[name]):
                    fields[name] = child.text or ""
            elif name in ("pubdate", "published", "updated", "date"):
                if "time" not in fields:
                    fields["time"] = (child.text or "").strip()
        content = fields.get("encoded") or fields.get("description") or fields.get("summary") or fields.get("content") or ""
        link = next((href for href in links if href), "")
        items.append(
            make_item(
                fields.get("id", ""),
                strip_html(fields.get("title", "")),
                strip_html(content),
                link,
                format_time(fields.get("time", "")),
                base_url,
            )
        )
    return dedupe(items)


def parse_html_items(text: str, base_url: str, config: dict) -> list[dict]:
    document = parse_html(text)
    nodes = select_all(document, config["itemSelector"]) if config.get("itemSelector") else heuristic_nodes(document)
    items = []
    for node in nodes[: config.get("itemLimit", 30)]:
        title_node = select_one(node, config["titleSelector"]) if config.get("titleSelector") else None
        content_node = select_one(node, config["contentSelector"]) if config.get("contentSelector") else None
        time_node = select_one(node, config["timeSelector"]) if config.get("timeSelector") else None
        link_node = select_one(node, config["linkSelector"]) if config.get("linkSelector") else None
        if link_node is None:
            link_node = node if node.tag == "a" else select_one(node, "a[href]")
        href = link_node.attrs.get("href", "") if link_node is not None else ""
        item_id = node.attrs.get(config["idAttribute"], "") if config.get("idAttribute") else ""
        title = node_text(title_node) if title_node is not None else (node_text(link_node) if link_node is not None else node_text(node))
        content = node_text(content_node) if content_node is not None else node_text(node)
        time_text = node_text(time_node) if time_node is not None else ""
        items.append(make_item(item_id or href, title, content, href, time_text, base_url))
    return dedupe(items)


def parse_json_items(payload, base_url: str, config: dict) -> list[dict]:
    listing = get_path(payload, config["listPath"])
    if not isinstance(listing, list):
        keys = list(payload.keys())[:8] if isinstance(payload, dict) else type(payload).__name__
        raise RuntimeError(f"JSON 路径 {config['listPath']} 未取到数组（顶层字段：{keys}）")
    items = []
    for entry in listing[: config.get("itemLimit", 30)]:
        if not isinstance(entry, dict):
            continue
        item_id = get_path(entry, config["idPath"]) if config.get("idPath") else ""
        title = get_path(entry, config["titlePath"]) if config.get("titlePath") else ""
        content = get_path(entry, config["contentPath"]) if config.get("contentPath") else ""
        time_value = get_path(entry, config["timePath"]) if config.get("timePath") else ""
        link = get_path(entry, config["linkPath"]) if config.get("linkPath") else ""
        if not link and config.get("linkTemplate"):
            link = (
                config["linkTemplate"]
                .replace("{id}", "" if item_id is None else str(item_id))
                .replace("{time}", "" if time_value is None else str(time_value))
            )
        items.append(
            make_item(
                "" if item_id is None else str(item_id),
                strip_html(title) if isinstance(title, str) else "",
                strip_html(content) if isinstance(content, str) else ("" if content is None else str(content)),
                "" if link is None else str(link),
                format_time(time_value, config.get("timeFormat", "")),
                base_url,
            )
        )
    return dedupe(items)


class Collector:
    def __init__(self, browser_options: dict):
        self.browser_options = browser_options
        self._browser: BrowserFetcher | None = None
        self._lock = threading.Lock()

    def browser(self) -> BrowserFetcher:
        with self._lock:
            if self._browser is None:
                self._browser = BrowserFetcher(self.browser_options)
            return self._browser

    def close(self) -> None:
        with self._lock:
            if self._browser is not None:
                self._browser.close()
                self._browser = None

    def collect(self, monitor: dict) -> tuple[list[dict], str]:
        monitor_type = monitor["type"]
        base_url = monitor["url"]

        if monitor_type == "browser":
            options = dict(monitor["browser"])
            options["api"] = monitor["browser"].get("api") or {}
            text = self.browser().fetch_in_page(options)
            try:
                payload = json.loads(text)
            except json.JSONDecodeError as exc:
                raise RuntimeError(f"接口返回的不是 JSON（{text[:120]}）") from exc
            return parse_json_items(payload, base_url, monitor["json"]), "browser"

        if monitor_type == "rss":
            feed_url = monitor["rss"].get("url") or base_url
            items = parse_feed(http_get(feed_url, monitor["headers"]), feed_url)
            if not items:
                raise RuntimeError("订阅源中没有条目")
            return items, "rss"

        if monitor_type == "html":
            text = http_get(base_url, monitor["headers"])
            items = parse_html_items(text, base_url, monitor["html"])
            if not items:
                raise RuntimeError("页面中未解析到条目，请配置列表项选择器")
            return items, "html"

        if monitor_type == "json":
            text = http_get(base_url, monitor["headers"])
            try:
                payload = json.loads(text)
            except json.JSONDecodeError as exc:
                raise RuntimeError("返回内容不是合法 JSON，请确认地址是接口而非页面") from exc
            items = parse_json_items(payload, base_url, monitor["json"])
            if not items:
                raise RuntimeError("接口中没有条目")
            return items, "json"

        # auto：按内容嗅探
        text = http_get(base_url, monitor["headers"])
        head = text.lstrip()[:4000]
        if head.startswith("<?xml") or "<rss" in head or "<feed" in head:
            items = parse_feed(text, base_url)
            if items:
                return items, "rss"
        if head.startswith("{") or head.startswith("["):
            try:
                items = parse_json_items(json.loads(text), base_url, monitor["json"])
                if items:
                    return items, "json"
            except (json.JSONDecodeError, RuntimeError):
                pass
        items = parse_html_items(text, base_url, monitor["html"])
        if items:
            return items, "html"
        raise RuntimeError("未能从该地址解析出动态，请改用 RSS 地址或配置选择器")


# ---------------------------------------------------------------------------
# 去重存储
# ---------------------------------------------------------------------------

class Store:
    def __init__(self, path: str):
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        self.path = path
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS items (
                monitor_id TEXT NOT NULL,
                item_key   TEXT NOT NULL,
                title      TEXT,
                content    TEXT,
                link       TEXT,
                pub_time   TEXT,
                first_seen INTEGER NOT NULL,
                notified   INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (monitor_id, item_key)
            );
            CREATE TABLE IF NOT EXISTS monitor_state (
                monitor_id  TEXT PRIMARY KEY,
                initialized INTEGER NOT NULL DEFAULT 0,
                last_check  INTEGER NOT NULL DEFAULT 0,
                last_error  TEXT NOT NULL DEFAULT '',
                last_new_at INTEGER NOT NULL DEFAULT 0,
                last_count  INTEGER NOT NULL DEFAULT 0
            );
            """
        )
        self._conn.commit()

    def get_state(self, monitor_id: str) -> dict:
        with self._lock:
            row = self._conn.execute(
                "SELECT initialized, last_check, last_error, last_new_at, last_count FROM monitor_state WHERE monitor_id=?",
                (monitor_id,),
            ).fetchone()
        if not row:
            return {"initialized": 0, "last_check": 0, "last_error": "", "last_new_at": 0, "last_count": 0}
        return {
            "initialized": row[0],
            "last_check": row[1],
            "last_error": row[2] or "",
            "last_new_at": row[3],
            "last_count": row[4],
        }

    def save_items(self, monitor_id: str, items: list[dict]) -> list[dict]:
        now = int(time.time())
        new_items = []
        with self._lock:
            for item in items:
                cursor = self._conn.execute(
                    "INSERT OR IGNORE INTO items (monitor_id, item_key, title, content, link, pub_time, first_seen, notified)"
                    " VALUES (?,?,?,?,?,?,?,0)",
                    (monitor_id, item["key"], item["title"], item["content"], item["link"], item["time"], now),
                )
                if cursor.rowcount > 0:
                    new_items.append(item)
            self._conn.commit()
        return new_items

    def mark_notified(self, monitor_id: str, items: list[dict]) -> None:
        if not items:
            return
        with self._lock:
            self._conn.executemany(
                "UPDATE items SET notified=1 WHERE monitor_id=? AND item_key=?",
                [(monitor_id, item["key"]) for item in items],
            )
            self._conn.commit()

    def update_state(self, monitor_id: str, *, initialized: int | None = None, last_error: str | None = None,
                     last_new_at: int | None = None, last_count: int | None = None) -> None:
        state = self.get_state(monitor_id)
        with self._lock:
            self._conn.execute(
                "INSERT INTO monitor_state (monitor_id, initialized, last_check, last_error, last_new_at, last_count)"
                " VALUES (?,?,?,?,?,?)"
                " ON CONFLICT(monitor_id) DO UPDATE SET initialized=excluded.initialized, last_check=excluded.last_check,"
                " last_error=excluded.last_error, last_new_at=excluded.last_new_at, last_count=excluded.last_count",
                (
                    monitor_id,
                    state["initialized"] if initialized is None else initialized,
                    int(time.time()),
                    state["last_error"] if last_error is None else last_error,
                    state["last_new_at"] if last_new_at is None else last_new_at,
                    state["last_count"] if last_count is None else last_count,
                ),
            )
            self._conn.commit()

    def recent_items(self, monitor_id: str, limit: int = 20) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT item_key, title, content, link, pub_time, first_seen, notified FROM items"
                " WHERE monitor_id=? ORDER BY first_seen DESC, pub_time DESC LIMIT ?",
                (monitor_id, limit),
            ).fetchall()
        return [
            {
                "key": row[0],
                "title": row[1],
                "content": row[2],
                "link": row[3],
                "time": row[4],
                "firstSeen": row[5],
                "notified": bool(row[6]),
            }
            for row in rows
        ]

    def delete_monitor(self, monitor_id: str) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM items WHERE monitor_id=?", (monitor_id,))
            self._conn.execute("DELETE FROM monitor_state WHERE monitor_id=?", (monitor_id,))
            self._conn.commit()


# ---------------------------------------------------------------------------
# Server酱
# ---------------------------------------------------------------------------

def send_serverchan(settings: dict, title: str, desp: str, timeout: int = 20) -> tuple[bool, str]:
    send_key = str(settings.get("sendKey") or "").strip()
    if not send_key:
        return False, "未配置 serverchan.sendKey"
    if not settings.get("enabled", True):
        return False, "Server酱推送已禁用"
    base = str(settings.get("apiBase") or "https://sctapi.ftqq.com").rstrip("/")
    data = urllib.parse.urlencode({"title": title[:100], "desp": desp[:30000]}).encode("utf-8")
    request = urllib.request.Request(
        f"{base}/{send_key}.send",
        data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded; charset=utf-8", "User-Agent": USER_AGENT},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8", "ignore")
    except urllib.error.HTTPError as exc:
        return False, f"HTTP {exc.code}"
    except urllib.error.URLError as exc:
        return False, f"网络错误：{exc.reason}"
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        return False, f"返回内容异常：{body[:120]}"
    code = payload.get("code", payload.get("status_code"))
    if code == 0:
        return True, "success"
    return False, str(payload.get("message") or payload.get("status_msg") or payload)[:200]


SERVERCHAN_DESP_LIMIT = 30000  # Server酱 desp 上限约 32KB，预留余量


def build_message(monitor: dict, items: list[dict]) -> tuple[str, str]:
    title = f"{monitor['name']}：{len(items)} 条新动态"
    lines = [f"### {monitor['name']}", ""]
    for item in items:
        if item["time"]:
            lines.append(f"**{item['time']}**")
        # 完整内容，不再按 300 字截断；仅受 Server酱 整体长度限制
        lines.append(item["content"])
        if item["link"]:
            lines.append(f"[查看原文]({item['link']})")
        lines.append("")
        lines.append("---")
        lines.append("")
    lines.append(f"监控地址：{monitor['url']}")
    body = "\n".join(lines)
    if len(body) > SERVERCHAN_DESP_LIMIT:
        body = body[:SERVERCHAN_DESP_LIMIT] + "\n\n（内容超出 Server酱 长度上限，已截断，完整内容请点上方原文链接）"
    return title, body


# ---------------------------------------------------------------------------
# 监控服务
# ---------------------------------------------------------------------------

class MonitorService:
    def __init__(self, config_path: str, fallback_port: int | None = None):
        self.config_path = config_path
        self.config = load_config(config_path)
        if fallback_port:
            self.config["server"]["port"] = fallback_port
        storage = self.config.get("storage") or {}
        db_path = storage.get("dbPath") or os.path.join(BASE_DIR, "data", "monitor.db")
        if not os.path.isabs(db_path):
            db_path = os.path.join(os.path.dirname(config_path), db_path)
        self.store = Store(db_path)
        self.collector = Collector(self.config.get("browser") or {})
        self._monitor_locks: dict[str, threading.Lock] = {}
        self._monitor_locks_guard = threading.Lock()
        self._config_mtime = os.path.getmtime(config_path)
        self._config_lock = threading.Lock()
        self._stop = threading.Event()
        self.started_at = int(time.time())

    # -- 配置 ---------------------------------------------------------
    def reload_if_changed(self) -> None:
        try:
            mtime = os.path.getmtime(self.config_path)
        except OSError:
            return
        if mtime == self._config_mtime:
            return
        with self._config_lock:
            try:
                config = load_config(self.config_path)
            except SystemExit as exc:
                log.error("配置重载失败：%s", exc)
                return
            self.config = config
            self._config_mtime = mtime
            log.info("配置文件已热更新（%d 个监控项）", len(config["monitors"]))

    def save(self) -> None:
        with self._config_lock:
            save_config(self.config_path, self.config)
            self._config_mtime = os.path.getmtime(self.config_path)

    def monitor_by_id(self, monitor_id: str) -> dict | None:
        return next((item for item in self.config["monitors"] if item["id"] == monitor_id), None)

    def _lock_for(self, monitor_id: str) -> threading.Lock:
        with self._monitor_locks_guard:
            return self._monitor_locks.setdefault(monitor_id, threading.Lock())

    # -- 检查 ---------------------------------------------------------
    def check(self, monitor: dict, notify: bool = True) -> dict:
        lock = self._lock_for(monitor["id"])
        if not lock.acquire(blocking=False):
            return {"ok": False, "skipped": True, "message": "该监控项正在检查中"}
        try:
            state = self.store.get_state(monitor["id"])
            try:
                items, mode = self.collector.collect(monitor)
            except (BrowserError, RuntimeError, OSError) as exc:
                message = str(exc)
                self.store.update_state(monitor["id"], last_error=message[:300])
                log.error("[%s] 检查失败：%s", monitor["name"], message)
                return {"ok": False, "message": message}

            if not state["initialized"]:
                new_items = self.store.save_items(monitor["id"], items)
                self.store.update_state(monitor["id"], initialized=1, last_error="", last_count=len(items))
                log.info("[%s] 建立基线：记录 %d 条，暂不推送", monitor["name"], len(new_items))
                return {
                    "ok": True,
                    "baseline": True,
                    "mode": mode,
                    "total": len(items),
                    "new": 0,
                    "message": f"已建立基线，记录 {len(items)} 条动态",
                }

            new_items = self.store.save_items(monitor["id"], items)
            self.store.update_state(monitor["id"], last_error="", last_count=len(items))

            if not new_items:
                log.info("[%s] 无新动态（共 %d 条）", monitor["name"], len(items))
                return {"ok": True, "mode": mode, "total": len(items), "new": 0, "message": "无新动态"}

            self.store.update_state(monitor["id"], last_new_at=int(time.time()))
            log.info("[%s] 发现 %d 条新动态", monitor["name"], len(new_items))

            push_result = None
            settings = self.config.get("serverchan") or {}
            if notify and settings.get("enabled", True):
                title, desp = build_message(monitor, new_items)
                ok, message = send_serverchan(settings, title, desp)
                push_result = {"ok": ok, "message": message}
                if ok:
                    self.store.mark_notified(monitor["id"], new_items)
                    log.info("[%s] 已通过 Server酱 推送：%s", monitor["name"], title)
                else:
                    log.error("[%s] Server酱 推送失败：%s", monitor["name"], message)

            return {
                "ok": True,
                "mode": mode,
                "total": len(items),
                "new": len(new_items),
                "items": new_items[:10],
                "push": push_result,
                "message": f"发现 {len(new_items)} 条新动态",
            }
        except Exception as exc:  # noqa: BLE001
            log.error("[%s] 未预期错误：%s\n%s", monitor["name"], exc, traceback.format_exc())
            self.store.update_state(monitor["id"], last_error=str(exc)[:300])
            return {"ok": False, "message": str(exc)}
        finally:
            lock.release()

    def due_monitors(self) -> list[dict]:
        now = int(time.time())
        due = []
        for monitor in self.config["monitors"]:
            if not monitor.get("enabled", True):
                continue
            state = self.store.get_state(monitor["id"])
            if now - state["last_check"] >= monitor["intervalSec"]:
                due.append(monitor)
        return due

    def run_forever(self) -> None:
        log.info(
            "服务已启动：%d 个监控项，Server酱 %s",
            len(self.config["monitors"]),
            "已配置" if (self.config.get("serverchan") or {}).get("sendKey") else "未配置",
        )
        while not self._stop.is_set():
            self.reload_if_changed()
            for monitor in self.due_monitors():
                if self._stop.is_set():
                    break
                self.check(monitor)
            self._stop.wait(2)

    def stop(self) -> None:
        self._stop.set()
        self.collector.close()

    # -- 对外状态 -----------------------------------------------------
    def state_snapshot(self) -> dict:
        monitors = []
        for monitor in self.config["monitors"]:
            item = serialize_monitor(monitor)
            item["runtime"] = self.store.get_state(monitor["id"])
            item["recent"] = self.store.recent_items(monitor["id"], 5)
            monitors.append(item)
        serverchan = self.config.get("serverchan") or {}
        return {
            "monitors": monitors,
            "serverchan": {
                "enabled": bool(serverchan.get("enabled", True)),
                "configured": bool(serverchan.get("sendKey")),
            },
            "logs": list(LOG_BUFFER)[-100:],
            "startedAt": self.started_at,
            "now": int(time.time()),
        }


# ---------------------------------------------------------------------------
# HTTP 服务
# ---------------------------------------------------------------------------

class ApiHandler(BaseHTTPRequestHandler):
    service: MonitorService

    server_version = "SyncMonitor/1.0"

    def log_message(self, fmt, *args):  # noqa: A003
        return

    def _send(self, status: int, body: bytes, content_type: str = "application/json; charset=utf-8"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, payload: dict):
        self._send(status, json.dumps(payload, ensure_ascii=False).encode("utf-8"))

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return {}

    def do_GET(self):  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if path in ("/", "/index.html"):
            try:
                with open(UI_PATH, "rb") as handle:
                    self._send(200, handle.read(), "text/html; charset=utf-8")
            except OSError:
                self._send(500, b"UI file missing", "text/plain; charset=utf-8")
            return
        if path == "/api/state":
            self._json(200, self.service.state_snapshot())
            return
        match = re.match(r"^/api/monitors/([^/]+)/items$", path)
        if match:
            monitor_id = urllib.parse.unquote(match.group(1))
            self._json(200, {"items": self.service.store.recent_items(monitor_id, 30)})
            return
        if path == "/api/logs":
            self._json(200, {"logs": list(LOG_BUFFER)[-200:]})
            return
        self._json(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        payload = self._read_json()

        if path == "/api/monitors":
            monitor = normalize_monitor(payload, self.service.config.get("defaults"))
            if not monitor["url"]:
                self._json(400, {"error": "url 不能为空"})
                return
            self.service.config["monitors"].append(monitor)
            self.service.save()
            log.info("新增监控项：%s", monitor["name"])
            threading.Thread(target=self.service.check, args=(monitor,), daemon=True).start()
            self._json(200, {"ok": True, "monitor": serialize_monitor(monitor)})
            return

        match = re.match(r"^/api/monitors/([^/]+)$", path)
        if match and self.command == "POST":
            monitor_id = urllib.parse.unquote(match.group(1))
            monitor = self.service.monitor_by_id(monitor_id)
            if not monitor:
                self._json(404, {"error": "监控项不存在"})
                return
            updated = normalize_monitor({**monitor, **payload, "id": monitor_id}, self.service.config.get("defaults"))
            index = self.service.config["monitors"].index(monitor)
            self.service.config["monitors"][index] = updated
            self.service.save()
            log.info("更新监控项：%s", updated["name"])
            self._json(200, {"ok": True, "monitor": serialize_monitor(updated)})
            return

        match = re.match(r"^/api/monitors/([^/]+)/(check|toggle)$", path)
        if match:
            monitor_id = urllib.parse.unquote(match.group(1))
            action = match.group(2)
            monitor = self.service.monitor_by_id(monitor_id)
            if not monitor:
                self._json(404, {"error": "监控项不存在"})
                return
            if action == "toggle":
                monitor["enabled"] = not monitor["enabled"]
                self.service.save()
                self._json(200, {"ok": True, "enabled": monitor["enabled"]})
                return
            notify = payload.get("notify", True)
            result = self.service.check(monitor, notify=notify)
            self._json(200, result)
            return

        if path == "/api/test-push":
            settings = self.service.config.get("serverchan") or {}
            ok, message = send_serverchan(settings, "Sync Monitor 测试推送", "如果你收到这条消息，说明 Server酱 配置正确。\n\n服务地址：http://%s:%s" % (
                self.service.config["server"]['host'], self.service.config["server"]["port"]))
            self._json(200, {"ok": ok, "message": message})
            return

        self._json(404, {"error": "not found"})

    def do_DELETE(self):  # noqa: N802
        match = re.match(r"^/api/monitors/([^/]+)$", urllib.parse.urlparse(self.path).path)
        if not match:
            self._json(404, {"error": "not found"})
            return
        monitor_id = urllib.parse.unquote(match.group(1))
        monitor = self.service.monitor_by_id(monitor_id)
        if not monitor:
            self._json(404, {"error": "监控项不存在"})
            return
        self.service.config["monitors"].remove(monitor)
        self.service.save()
        self.service.store.delete_monitor(monitor_id)
        log.info("删除监控项：%s", monitor["name"])
        self._json(200, {"ok": True})


def acquire_instance_lock(config_path: str):
    """单实例锁：多开会争用同一个 Chrome 配置目录（浏览器退出码 21）并重复推送。"""
    lock_path = os.path.join(os.path.dirname(os.path.abspath(config_path)), "data", "monitor.lock")
    os.makedirs(os.path.dirname(lock_path), exist_ok=True)
    handle = open(lock_path, "a+b")
    try:
        if os.path.getsize(lock_path) == 0:
            handle.write(b"0")
            handle.flush()
        handle.seek(0)
        if os.name == "nt":
            import msvcrt

            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        handle.close()
        return None
    return handle


def main() -> None:
    parser = argparse.ArgumentParser(description="Sync Monitor 后端服务")
    parser.add_argument("--config", default=CONFIG_PATH, help="配置文件路径")
    parser.add_argument("--once", action="store_true", help="立即检查一轮后退出（首次为建立基线）")
    parser.add_argument("--monitor", default="", help="仅检查指定 id 的监控项（配合 --once）")
    parser.add_argument("--test-push", action="store_true", help="发送一条 Server酱 测试消息后退出")
    parser.add_argument("--no-push", action="store_true", help="本次运行不推送（仅记录）")
    parser.add_argument("--host", default="", help="覆盖监听地址")
    parser.add_argument("--port", type=int, default=0, help="覆盖监听端口")
    args = parser.parse_args()

    if args.no_push:
        os.environ["SYNC_MONITOR_NO_PUSH"] = "1"

    config = load_config(args.config)
    storage = config.get("storage") or {}
    db_path = storage.get("dbPath") or os.path.join(BASE_DIR, "data", "monitor.db")
    if not os.path.isabs(db_path):
        db_path = os.path.join(os.path.dirname(args.config), db_path)
    log.add_file_handler(os.path.join(os.path.dirname(db_path), "monitor.log"))

    if args.test_push:
        ok, message = send_serverchan(config.get("serverchan") or {}, "Sync Monitor 测试推送", "这是一条测试消息，收到即表示 API Key 可用。")
        log.info("测试推送：%s - %s", "成功" if ok else "失败", message)
        raise SystemExit(0 if ok else 1)

    instance_lock = acquire_instance_lock(args.config)
    if instance_lock is None:
        log.error(
            "已有另一个监控实例在运行，本次启动已取消。"
            "多开会争用同一个 Chrome 配置目录（浏览器退出码 21）并造成重复推送，请先关闭旧实例。"
        )
        raise SystemExit(1)

    service = MonitorService(args.config, args.port or None)
    if args.host:
        service.config["server"]["host"] = args.host

    if args.once:
        targets = service.config["monitors"]
        if args.monitor:
            targets = [item for item in targets if item["id"] == args.monitor]
            if not targets:
                log.error("找不到监控项：%s", args.monitor)
                raise SystemExit(1)
        if not targets:
            log.warning("配置中没有监控项")
            raise SystemExit(0)
        failed = 0
        for monitor in targets:
            result = service.check(monitor, notify=not args.no_push)
            log.info("[%s] %s", monitor["name"], json.dumps(result, ensure_ascii=False))
            if not result.get("ok"):
                failed += 1
        service.collector.close()
        raise SystemExit(1 if failed else 0)

    handler = type("BoundApiHandler", (ApiHandler,), {"service": service})
    host = service.config["server"]["host"]
    port = int(service.config["server"]["port"])
    try:
        httpd = ThreadingHTTPServer((host, port), handler)
    except OSError as exc:
        log.error(
            "端口 %s 无法监听（%s）。该端口可能已被其他程序占用，"
            "请修改 config.json 里的 server.port，或用 --port 指定一个空闲端口后重试。",
            port, exc,
        )
        service.stop()
        raise SystemExit(1)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    log.info("管理界面：http://%s:%s", "127.0.0.1" if host in ("0.0.0.0", "") else host, port)
    log.info("配置文件：%s", os.path.abspath(args.config))

    try:
        service.run_forever()
    except KeyboardInterrupt:
        log.info("收到退出信号，正在停止…")
    finally:
        service.stop()
        httpd.shutdown()


if __name__ == "__main__":
    main()
