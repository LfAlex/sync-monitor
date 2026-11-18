/**
 * Sync Monitor · 页面内提示
 *
 * 1) 接收后台推送的新动态，用 Shadow DOM 渲染卡片，避免受页面样式影响；
 * 2) 为 pageapi / 渲染模式提供“页面内请求”和“读取渲染后 HTML”的能力。
 */

(() => {
  if (window.__syncMonitorInstalled) return;
  window.__syncMonitorInstalled = true;

  const HOST_ID = '__sync_monitor_host__';
  let host = null;
  let shadow = null;
  let stack = null;

  function ensureHost() {
    if (host && document.documentElement.contains(host)) return shadow;
    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; top: 0; right: 0; width: 0; height: 0;';
    shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      .stack {
        position: fixed; top: 16px; right: 16px;
        display: flex; flex-direction: column; gap: 10px;
        width: 360px; max-width: calc(100vw - 32px);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
          "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      }
      .card {
        background: #ffffff; color: #0f172a;
        border-radius: 14px; overflow: hidden;
        box-shadow: 0 18px 40px -12px rgba(15, 23, 42, .35), 0 2px 8px rgba(15, 23, 42, .08);
        border: 1px solid rgba(37, 99, 235, .16);
        animation: sm-in .28s cubic-bezier(.22,.68,.35,1.02);
      }
      .card.leaving { animation: sm-out .2s ease forwards; }
      @keyframes sm-in { from { opacity: 0; transform: translateX(28px) scale(.97); } to { opacity: 1; transform: none; } }
      @keyframes sm-out { to { opacity: 0; transform: translateX(28px) scale(.97); } }
      .head {
        display: flex; align-items: center; gap: 8px;
        padding: 12px 14px; background: linear-gradient(135deg, #1d4ed8, #2563eb 55%, #3b82f6);
        color: #fff;
      }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #7dd3fc; box-shadow: 0 0 0 0 rgba(125, 211, 252, .7); animation: sm-pulse 1.8s infinite; }
      @keyframes sm-pulse { 70% { box-shadow: 0 0 0 8px rgba(125, 211, 252, 0); } 100% { box-shadow: 0 0 0 0 rgba(125, 211, 252, 0); } }
      .title { font-size: 13px; font-weight: 600; line-height: 1.3; flex: 1; }
      .count { font-size: 11px; padding: 2px 7px; border-radius: 999px; background: rgba(255,255,255,.18); }
      .close {
        border: 0; background: transparent; color: rgba(255,255,255,.85);
        font-size: 16px; line-height: 1; cursor: pointer; padding: 2px 4px; border-radius: 6px;
      }
      .close:hover { background: rgba(255,255,255,.16); color: #fff; }
      .body { max-height: 300px; overflow: auto; padding: 6px 0; }
      .item { display: block; padding: 9px 14px; border-bottom: 1px solid #f1f5f9; text-decoration: none; color: inherit; }
      .item:last-child { border-bottom: 0; }
      .item:hover { background: #f8fafc; }
      .meta { display: flex; align-items: center; gap: 6px; font-size: 11px; color: #94a3b8; margin-bottom: 3px; }
      .meta .tag { color: #2563eb; font-weight: 600; }
      .text { font-size: 12.5px; line-height: 1.55; color: #1e293b; word-break: break-word;
        display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
      .foot { display: flex; align-items: center; justify-content: space-between; padding: 9px 14px 11px; background: #f8fafc; }
      .link { font-size: 12px; color: #2563eb; text-decoration: none; font-weight: 600; }
      .link:hover { text-decoration: underline; }
      .hint { font-size: 11px; color: #94a3b8; }
      .error { padding: 12px 14px; font-size: 12px; color: #b91c1c; background: #fef2f2; }
      .empty { padding: 14px; font-size: 12px; color: #64748b; }
    `;
    stack = document.createElement('div');
    stack.className = 'stack';
    shadow.append(style, stack);
    (document.body || document.documentElement).appendChild(host);
    return shadow;
  }

  function createToast(payload) {
    ensureHost();
    const card = document.createElement('section');
    card.className = 'card';

    const items = Array.isArray(payload.items) ? payload.items : [];
    const count = payload.total || items.length;

    const head = document.createElement('div');
    head.className = 'head';
    head.innerHTML = '<span class="dot"></span><span class="title"></span><span class="count"></span>';

    const close = document.createElement('button');
    close.className = 'close';
    close.type = 'button';
    close.title = '关闭';
    close.textContent = '×';
    head.appendChild(close);

    const body = document.createElement('div');
    body.className = 'body';

    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '没有可展示的内容';
      body.appendChild(empty);
    }

    for (const item of items) {
      const row = document.createElement('a');
      row.className = 'item';
      row.href = '#';
      // 点击动态进入扩展内的单条详情页（全文 + 图片），原文链接在详情页里
      row.addEventListener('click', (event) => {
        event.preventDefault();
        chrome.runtime.sendMessage({ type: 'OPEN_DETAIL', id: payload.monitorId, key: item.key });
      });
      const meta = document.createElement('div');
      meta.className = 'meta';
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = '新动态';
      meta.appendChild(tag);
      if (item.time) {
        const time = document.createElement('span');
        time.textContent = item.time;
        meta.appendChild(time);
      }
      const text = document.createElement('div');
      text.className = 'text';
      text.textContent = item.content || item.title || '';
      row.append(meta, text);
      body.appendChild(row);
    }

    const foot = document.createElement('div');
    foot.className = 'foot';
    const home = document.createElement('a');
    home.className = 'link';
    home.href = payload.url || '#';
    home.target = '_blank';
    home.rel = 'noreferrer noopener';
    home.textContent = '打开监控主页 →';
    const detail = document.createElement('a');
    detail.className = 'link';
    detail.href = '#';
    detail.textContent = '查看全文 →';
    detail.addEventListener('click', (event) => {
      event.preventDefault();
      chrome.runtime.sendMessage({ type: 'OPEN_DETAIL', id: payload.monitorId });
    });
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = payload.name || '';
    foot.append(home, detail, hint);

    head.querySelector('.title').textContent = `${payload.name || '监控主页'} 有新动态`;
    head.querySelector('.count').textContent = `+${count}`;

    card.append(head, body, foot);
    stack.appendChild(card);

    while (stack.children.length > 3) stack.removeChild(stack.firstElementChild);

    let timer = null;
    const dismiss = () => {
      if (!card.isConnected) return;
      card.classList.add('leaving');
      setTimeout(() => card.remove(), 220);
    };
    const schedule = () => {
      const seconds = Math.max(5, Number(payload.durationSec) || 25);
      timer = setTimeout(dismiss, seconds * 1000);
    };
    card.addEventListener('mouseenter', () => clearTimeout(timer));
    card.addEventListener('mouseleave', schedule);
    close.addEventListener('click', dismiss);
    schedule();
    return card;
  }

  async function pageFetch(config) {
    const url = new URL(config.url, location.href).href;
    const method = (config.method || 'GET').toUpperCase();
    const headers = { Accept: 'application/json, text/plain, */*', ...(config.headers || {}) };
    const init = { method, credentials: 'include', headers };
    if (config.body !== undefined && config.body !== null && method !== 'GET') {
      init.body = typeof config.body === 'string' ? config.body : JSON.stringify(config.body);
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(url, init);
    const text = await response.text();
    if (!response.ok) {
      return { ok: false, status: response.status, message: `HTTP ${response.status}`, text };
    }
    return { ok: true, status: response.status, text };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) return false;

    if (message.type === 'SYNC_MONITOR_TOAST') {
      try {
        createToast(message.payload || {});
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: String(error && error.message) });
      }
      return false;
    }

    if (message.type === 'SYNC_MONITOR_PAGE_FETCH') {
      pageFetch(message.config || {})
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, message: String(error && error.message) }));
      return true;
    }

    if (message.type === 'SYNC_MONITOR_GET_HTML') {
      sendResponse({ html: document.documentElement.outerHTML, url: location.href });
      return false;
    }

    return false;
  });
})();
