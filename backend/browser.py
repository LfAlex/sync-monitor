#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""基于 Chrome DevTools Protocol 的页面内接口采集。

同花顺等站点的接口依赖页面 JS 生成的签名 Cookie（v / v_c），纯 HTTP 请求会返回
401。这里复用本机已安装的 Chrome/Edge，在真实页面上下文里执行 fetch，因此签名、
Cookie、Referer 都由浏览器自动处理，且不需要额外安装 Playwright 之类的依赖。

仅使用 Python 标准库。
"""

from __future__ import annotations

import base64
import json
import os
import queue
import random
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
]


class BrowserError(RuntimeError):
    """浏览器启动或采集失败。"""


def find_browser(explicit: str = "") -> str:
    if explicit:
        if os.path.exists(explicit):
            return explicit
        raise BrowserError(f"配置的浏览器路径不存在：{explicit}")
    for path in CHROME_CANDIDATES:
        if os.path.exists(path):
            return path
    raise BrowserError(
        "未找到 Chrome/Edge。请安装浏览器，或在配置项 browser.executable 中指定可执行文件路径。"
    )


class _WebSocket:
    """最小 WebSocket 客户端，只服务于 CDP 的文本消息。"""

    def __init__(self, url: str, timeout: float = 30):
        if not url.startswith("ws://"):
            raise BrowserError(f"不支持的 CDP 地址：{url}")
        rest = url[5:]
        host_port, path = rest.split("/", 1)
        host, _, port = host_port.partition(":")
        self.sock = socket.create_connection((host, int(port or 80)), timeout=timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        request = (
            f"GET /{path} HTTP/1.1\r\nHost: {host_port}\r\nUpgrade: websocket\r\n"
            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(request.encode())
        self._buf = b""
        header = b""
        while b"\r\n\r\n" not in header:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise BrowserError("CDP 握手失败：连接被关闭")
            header += chunk
        head, _, rest_bytes = header.partition(b"\r\n\r\n")
        if b" 101 " not in head.split(b"\r\n")[0]:
            raise BrowserError("CDP 握手被拒绝：" + head[:200].decode("utf-8", "ignore"))
        self._buf = rest_bytes

    def send(self, payload: str) -> None:
        data = payload.encode()
        header = bytearray([0x81])
        length = len(data)
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header += struct.pack("!H", length)
        else:
            header.append(0x80 | 127)
            header += struct.pack("!Q", length)
        mask = os.urandom(4)
        header += mask
        masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(data))
        self.sock.sendall(bytes(header) + masked)

    def _read_exact(self, size: int) -> bytes:
        while len(self._buf) < size:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise BrowserError("CDP 连接已断开")
            self._buf += chunk
        data, self._buf = self._buf[:size], self._buf[size:]
        return data

    def recv(self) -> str:
        chunks = []
        while True:
            first, second = self._read_exact(2)
            fin = first & 0x80
            opcode = first & 0x0F
            length = second & 0x7F
            if length == 126:
                length = struct.unpack("!H", self._read_exact(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._read_exact(8))[0]
            masked = second & 0x80
            mask = self._read_exact(4) if masked else None
            payload = self._read_exact(length)
            if mask:
                payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
            if opcode == 0x9:
                continue
            if opcode == 0x8:
                raise BrowserError("CDP 连接被关闭")
            chunks.append(payload)
            if fin:
                return b"".join(chunks).decode("utf-8", "ignore")

    def close(self) -> None:
        try:
            self.sock.close()
        except OSError:
            pass


class _CDP:
    def __init__(self, ws_url: str):
        self._ws = _WebSocket(ws_url)
        self._next_id = 0
        self._lock = threading.Lock()
        self._responses: dict[int, dict] = {}
        self._events: queue.Queue = queue.Queue()
        self._reader = threading.Thread(target=self._loop, daemon=True)
        self._reader.start()

    def _loop(self) -> None:
        try:
            while True:
                message = json.loads(self._ws.recv())
                if "id" in message:
                    self._responses[message["id"]] = message
                else:
                    self._events.put(message)
        except Exception as exc:  # noqa: BLE001
            self._events.put({"method": "__closed__", "error": str(exc)})

    def call(self, method: str, params: dict | None = None, timeout: float = 30) -> dict:
        with self._lock:
            self._next_id += 1
            call_id = self._next_id
        self._ws.send(json.dumps({"id": call_id, "method": method, "params": params or {}}))
        deadline = time.time() + timeout
        while time.time() < deadline:
            response = self._responses.pop(call_id, None)
            if response is not None:
                if "error" in response:
                    raise BrowserError(f"{method} 失败：{response['error'].get('message')}")
                return response.get("result", {})
            time.sleep(0.01)
        raise BrowserError(f"{method} 超时（{timeout}s）")

    def close(self) -> None:
        self._ws.close()


def _http_json(url: str, timeout: float = 3) -> dict | list:
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8", "ignore"))


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


FETCH_JS = r"""
(async () => {
  const cfg = __CONFIG__;
  try {
    const url = new URL(cfg.url, location.href).href;
    const init = {
      method: (cfg.method || 'GET').toUpperCase(),
      credentials: 'include',
      headers: Object.assign({ 'Accept': 'application/json, text/plain, */*' }, cfg.headers || {})
    };
    if (cfg.body !== undefined && cfg.body !== null && init.method !== 'GET') {
      init.body = typeof cfg.body === 'string' ? cfg.body : JSON.stringify(cfg.body);
      if (!init.headers['Content-Type']) init.headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(url, init);
    const text = await response.text();
    return JSON.stringify({ status: response.status, ok: response.ok, url, text });
  } catch (error) {
    return JSON.stringify({ status: 0, ok: false, url: cfg.url, text: '', error: String(error) });
  }
})()
"""


class BrowserFetcher:
    """常驻的无头浏览器，在页面上下文里调用目标接口。"""

    def __init__(self, options: dict | None = None):
        options = options or {}
        self.executable = find_browser(str(options.get("executable") or ""))
        self.headless = options.get("headless", True) is not False
        self.timeout = float(options.get("timeoutMs", 45000)) / 1000.0
        self.user_data_dir = options.get("userDataDir") or os.path.join(
            tempfile.gettempdir(), "sync-monitor-chrome"
        )
        self._lock = threading.Lock()
        self._process: subprocess.Popen | None = None
        self._cdp: _CDP | None = None
        self._port = 0

    # -- 生命周期 -----------------------------------------------------
    def _ensure_started(self) -> _CDP:
        if self._process is not None and self._process.poll() is None and self._cdp is not None:
            return self._cdp
        self._shutdown()
        self._port = _free_port()
        args = [
            self.executable,
            f"--remote-debugging-port={self._port}",
            f"--user-data-dir={self.user_data_dir}",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-extensions",
            "--disable-background-networking",
            "--disable-sync",
            "--mute-audio",
            "--window-size=1280,900",
        ]
        if self.headless:
            args.append("--headless=new")
        args.append("about:blank")

        creation_flags = 0
        if sys.platform == "win32":
            creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
        self._process = subprocess.Popen(
            args,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=creation_flags,
        )

        deadline = time.time() + self.timeout
        last_error = None
        while time.time() < deadline:
            try:
                version = _http_json(f"http://127.0.0.1:{self._port}/json/version", timeout=2)
                targets = _http_json(f"http://127.0.0.1:{self._port}/json/list", timeout=2)
                page = next((t for t in targets if t.get("type") == "page"), None)
                if page and page.get("webSocketDebuggerUrl"):
                    self._cdp = _CDP(page["webSocketDebuggerUrl"])
                    self._cdp.call("Page.enable")
                    self._cdp.call("Runtime.enable")
                    self._cdp.call("Network.enable")
                    return self._cdp
            except Exception as exc:  # noqa: BLE001
                last_error = exc
            if self._process.poll() is not None:
                raise BrowserError(
                    f"浏览器进程提前退出（代码 {self._process.returncode}）。"
                    "若是代码 21，通常是另一个监控实例正在占用同一个 Chrome 配置目录，请只保留一个 monitor.py 运行"
                )
            time.sleep(0.3)
        raise BrowserError(f"浏览器启动超时：{last_error}")

    def _shutdown(self) -> None:
        if self._cdp is not None:
            self._cdp.close()
            self._cdp = None
        if self._process is not None:
            try:
                self._process.terminate()
                self._process.wait(timeout=5)
            except Exception:  # noqa: BLE001
                try:
                    self._process.kill()
                except OSError:
                    pass
            self._process = None

    def close(self) -> None:
        with self._lock:
            self._shutdown()

    # -- 采集 ---------------------------------------------------------
    def _wait_ready(self, cdp: _CDP, page_url: str, wait_ms: int, wait_cookie: str) -> None:
        deadline = time.time() + self.timeout
        while time.time() < deadline:
            result = cdp.call(
                "Runtime.evaluate",
                {
                    "expression": "JSON.stringify({state: document.readyState, href: location.href})",
                    "returnByValue": True,
                },
                timeout=10,
            )
            value = result.get("result", {}).get("value") or "{}"
            try:
                info = json.loads(value)
            except json.JSONDecodeError:
                info = {}
            if info.get("state") == "complete":
                break
            time.sleep(0.3)

        if wait_cookie:
            end = time.time() + min(self.timeout, 15)
            expression = f"document.cookie.split(';').some(c => c.trim().startsWith({json.dumps(wait_cookie + '=')}))"
            while time.time() < end:
                result = cdp.call("Runtime.evaluate", {"expression": expression, "returnByValue": True}, timeout=10)
                if result.get("result", {}).get("value") is True:
                    break
                time.sleep(0.5)

        if wait_ms > 0:
            time.sleep(wait_ms / 1000.0)

    def _evaluate_fetch(self, cdp: _CDP, api: dict) -> dict:
        expression = FETCH_JS.replace("__CONFIG__", json.dumps(api, ensure_ascii=False))
        result = cdp.call(
            "Runtime.evaluate",
            {"expression": expression, "awaitPromise": True, "returnByValue": True},
            timeout=self.timeout,
        )
        if result.get("exceptionDetails"):
            raise BrowserError(f"页面内 fetch 执行失败：{result['exceptionDetails'].get('text')}")
        raw = result.get("result", {}).get("value")
        if not raw:
            raise BrowserError("页面内 fetch 未返回数据")
        return json.loads(raw)

    def fetch_in_page(self, options: dict) -> str:
        """打开监控页面，在其上下文里请求接口，返回响应文本。"""
        page_url = str(options.get("pageUrl") or "").strip()
        api = options.get("api") or {}
        if not page_url or not api.get("url"):
            raise BrowserError("browser 模式需要配置 pageUrl 与 api.url")
        wait_ms = int(options.get("waitMs", 2500))
        wait_cookie = str(options.get("waitCookie") or "")
        retries = int(options.get("retries", 3))

        with self._lock:
            cdp = self._ensure_started()
            try:
                cdp.call("Page.navigate", {"url": page_url}, timeout=self.timeout)
            except BrowserError:
                # 页面可能仍在加载，重新拿一次连接
                self._shutdown()
                cdp = self._ensure_started()
                cdp.call("Page.navigate", {"url": page_url}, timeout=self.timeout)

            self._wait_ready(cdp, page_url, wait_ms, wait_cookie)

            last = None
            for attempt in range(max(1, retries)):
                payload = self._evaluate_fetch(cdp, api)
                text = payload.get("text") or ""
                status = payload.get("status")
                if payload.get("ok") and text.strip():
                    return text
                last = payload.get("error") or f"HTTP {status}：{text[:200]}"
                if status in (401, 403, 0):
                    time.sleep(2 + attempt * 2)
                    continue
                break
            raise BrowserError(f"接口请求失败：{last}")
