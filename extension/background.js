/**
 * Sync Monitor · 后台 Service Worker
 *
 * 调度：每分钟唤醒一次，按各监控项的 intervalSec 判断是否到期。
 * 采集：RSS / HTML / JSON 由扩展直接 fetch；pageapi（单页应用）在已打开的
 *       目标页面里用页面自身身份请求接口，规避签名 Cookie 问题。
 * 提示：优先在目标页面内弹出提示，没有打开页面时退化为系统通知。
 */

import { collectItems, normalizeMonitor, DEFAULT_SETTINGS } from './lib/parse.js';

const ALARM_NAME = 'sync-monitor-tick';
const STORAGE_KEYS = ['monitors', 'results', 'settings'];

const memory = {
  monitors: [],
  results: {},
  settings: { ...DEFAULT_SETTINGS },
  ready: null
};

const running = new Set();

const PRESET_THS = {
  id: 'ths_1179giyc4jr06d6785e69e',
  name: '同花顺 · 重生之散户一哥',
  url: 'https://t.10jqka.com.cn/lgt/user_page/?user_code=1179giyc4jr06d6785e69e',
  type: 'pageapi',
  enabled: true,
  intervalSec: 300,
  pageapi: {
    pageUrl: 'https://t.10jqka.com.cn/lgt/user_page/?user_code=1179giyc4jr06d6785e69e',
    url: '/user_center/open/api/content/v2/get_by_uid',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { user_code: '1179giyc4jr06d6785e69e' }
  },
  json: {
    listPath: 'data.contents',
    idPath: 'info.id',
    titlePath: '',
    contentPath: 'abstract.content',
    imagesPath: 'image.urls',
    timePath: 'info.ctime',
    timeFormat: 'ms',
    linkPath: 'info.jump_url',
    itemLimit: 30
  },
  note: '页面为 Vue 单页应用，需要保持该页面在浏览器中打开；首次检查只建立基线。'
};

/* ------------------------------------------------------------------ */
/* 存储                                                                */
/* ------------------------------------------------------------------ */

async function loadState() {
  const data = await chrome.storage.local.get(STORAGE_KEYS);
  memory.monitors = (data.monitors || []).map(normalizeMonitor);
  memory.results = data.results || {};
  memory.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };

  // 旧版本预置的同花顺监控没有 imagesPath，补上图字段配置，否则重新采集也拿不到图片
  let migrated = false;
  for (const monitor of memory.monitors) {
    if (monitor.json && monitor.json.contentPath === 'abstract.content' && !monitor.json.imagesPath) {
      monitor.json.imagesPath = 'image.urls';
      migrated = true;
    }
  }
  if (migrated) await saveState();
  return memory;
}

async function saveState() {
  await chrome.storage.local.set({
    monitors: memory.monitors,
    results: memory.results,
    settings: memory.settings
  });
}

function ensureReady() {
  if (!memory.ready) memory.ready = loadState();
  return memory.ready;
}

async function ensureAlarm() {
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) {
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1, delayInMinutes: 1 });
  }
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await ensureReady();
  await ensureAlarm();
  if (details.reason === 'install' && memory.monitors.length === 0) {
    memory.monitors = [normalizeMonitor(PRESET_THS)];
    await saveState();
    void checkMonitor(memory.monitors[0], { silent: true });
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureReady();
  await ensureAlarm();
  void tick();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) void tick();
});

/* ------------------------------------------------------------------ */
/* 页面通信                                                            */
/* ------------------------------------------------------------------ */

function originPattern(url) {
  try {
    return `${new URL(url).origin}/*`;
  } catch {
    return '';
  }
}

async function findTabs(url) {
  const pattern = originPattern(url);
  try {
    return await chrome.tabs.query(pattern ? { url: pattern } : {});
  } catch {
    return [];
  }
}

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // 内容脚本可能尚未注入（扩展安装前就已打开的页面），补注入后重试一次
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content/toast.js'] });
      return await chrome.tabs.sendMessage(tabId, message);
    } catch {
      return null;
    }
  }
}

function pickBestTab(tabs, pageUrl) {
  const candidates = (tabs || []).filter((item) => item.id != null);
  if (!candidates.length) return null;
  const base = String(pageUrl || '').split('#')[0];
  const score = (tab) => {
    let value = 0;
    if (tab.url && tab.url.split('#')[0] === base) value += 4;
    if (tab.status === 'complete') value += 2;
    if (tab.active) value += 1;
    return value;
  };
  return candidates.slice().sort((a, b) => score(b) - score(a))[0];
}

async function waitTabReady(tabId, timeoutMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab && tab.status === 'complete') return tab;
    } catch {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

// 在页面主世界执行，与页面自身 XHR 的环境完全一致（chrome.scripting 会序列化此函数）
async function pageFetchMain(config) {
  try {
    const target = new URL(config.url, location.href).toString();
    const init = {
      method: config.method || 'GET',
      credentials: 'include',
      headers: config.headers || {}
    };
    if (config.body !== null && config.body !== undefined && init.method !== 'GET') {
      init.body = typeof config.body === 'string' ? config.body : JSON.stringify(config.body);
    }
    const response = await fetch(target, init);
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  } catch (error) {
    return { ok: false, status: 0, error: String((error && error.message) || error) };
  }
}

async function pageRequest(tabId, config) {
  let mainError = '';
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: pageFetchMain,
      args: [config]
    });
    const response = results && results[0] && results[0].result;
    if (response) return response;
    mainError = '未返回结果';
  } catch (error) {
    mainError = String((error && error.message) || error);
  }

  // 主世界不可用（老版本 Chrome、标签页被丢弃、页面停在错误页等）时退回内容脚本
  const message = { type: 'SYNC_MONITOR_PAGE_FETCH', config };
  let tabError = '无响应';
  try {
    const response = await chrome.tabs.sendMessage(tabId, message);
    if (response) return response;
  } catch {
    // 内容脚本可能尚未注入（扩展安装/重载前就已打开的页面），补注入后重试一次
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content/toast.js'] });
      const response = await chrome.tabs.sendMessage(tabId, message);
      if (response) return response;
    } catch (error) {
      tabError = String((error && error.message) || error);
    }
  }
  return { ok: false, status: 0, error: `主世界注入失败（${mainError}）；内容脚本：${tabError}` };
}

async function fetchViaPage(monitor) {
  const pageUrl = monitor.pageapi.pageUrl || monitor.url;
  const tabs = await findTabs(pageUrl);
  let tab = pickBestTab(tabs, pageUrl);
  if (!tab) {
    throw new Error('页面未打开：请先在浏览器中打开该主页，扩展才能读取其接口数据');
  }

  // Chrome 会丢弃长期未查看的标签页（status=unloaded），此时无法注入脚本，
  // 需要先 reload 唤醒并等待加载完成，再让重试逻辑等待页面生成签名 Cookie。
  if (tab.status === 'unloaded') {
    try {
      await chrome.tabs.reload(tab.id);
    } catch {
      // reload 失败时仍继续尝试注入，由后面的错误信息暴露真实原因
    }
    tab = (await waitTabReady(tab.id)) || tab;
  } else if (tab.status === 'loading') {
    tab = (await waitTabReady(tab.id)) || tab;
  }

  const pattern = originPattern(pageUrl);
  let granted = true;
  try {
    granted = pattern ? await chrome.permissions.contains({ origins: [pattern] }) : true;
  } catch {
    granted = true; // permissions API 不可用时跳过预检，交给实际注入判断
  }
  if (!granted) {
    throw new Error(
      `缺少 ${new URL(pageUrl).origin} 的访问权限：请打开 扩展程序 → Sync Monitor → 详细信息 → 站点访问权限，`
      + '设为「在所有网站上」（或单独添加该站点），然后重新检查'
    );
  }
  const config = {
    url: monitor.pageapi.url,
    method: monitor.pageapi.method,
    headers: monitor.pageapi.headers,
    body: monitor.pageapi.body
  };

  // 同花顺等站点的签名 Cookie 由页面 JS 异步生成，页面刚打开时请求会 401/403；
  // 标签页被丢弃、页面尚在加载时注入也可能临时失败，因此统一退避重试。
  let lastError = '页面内接口请求失败';
  let lastStatus = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    const response = await pageRequest(tab.id, config);
    if (response.ok) return response.text;
    lastStatus = response.status || 0;
    lastError = response.error || response.message || (lastStatus ? `HTTP ${lastStatus}` : lastError);
  }
  const hint = (lastStatus === 401 || lastStatus === 403)
    ? '（请刷新目标主页，等动态列表加载出来后再检查）'
    : `（可尝试刷新目标主页，或关掉重新打开后再检查。目标标签页：${tab.url || '未知'}，状态：${tab.status || '未知'}）`;
  throw new Error(lastError + hint);
}

async function fetchTabHtml(monitor) {
  const tabs = await findTabs(monitor.url);
  const tab = tabs.find((item) => item.id != null);
  if (!tab) throw new Error('页面未打开：请先打开该主页后再检查');
  const response = await sendToTab(tab.id, { type: 'SYNC_MONITOR_GET_HTML' });
  if (!response || !response.html) throw new Error('读取页面内容失败');
  return response.html;
}

/* ------------------------------------------------------------------ */
/* 通知                                                                */
/* ------------------------------------------------------------------ */

async function notifyMonitor(monitor, items) {
  const payload = {
    monitorId: monitor.id,
    name: monitor.name,
    url: monitor.url,
    items: items.slice(0, 6),
    total: items.length,
    durationSec: memory.settings.toastDurationSec
  };

  let deliveredInPage = false;
  if (memory.settings.pageToast) {
    const tabs = await findTabs(monitor.url);
    for (const tab of tabs) {
      if (tab.id == null) continue;
      const response = await sendToTab(tab.id, { type: 'SYNC_MONITOR_TOAST', payload });
      if (response && response.ok) deliveredInPage = true;
    }
  }

  if (!deliveredInPage && memory.settings.systemNotification) {
    const first = items[0];
    const notificationId = `sm_${monitor.id}_${Date.now()}`;
    const stored = await chrome.storage.local.get('notificationLinks');
    const links = { ...(stored.notificationLinks || {}), [notificationId]: first.link || monitor.url };
    const ids = Object.keys(links).slice(-30);
    const trimmed = Object.fromEntries(ids.map((id) => [id, links[id]]));
    await chrome.storage.local.set({ notificationLinks: trimmed });
    chrome.notifications.create(notificationId, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: `${monitor.name} · ${items.length} 条新动态`,
      message: first.content.slice(0, 200),
      priority: 1
    });
  }

  updateBadge();
}

function updateBadge() {
  const unread = Object.values(memory.results).reduce((sum, item) => sum + (item.unread || 0), 0);
  chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
  chrome.action.setBadgeText({ text: unread > 0 ? (unread > 99 ? '99+' : String(unread)) : '' });
}

chrome.notifications.onClicked.addListener(async (notificationId) => {
  const stored = await chrome.storage.local.get('notificationLinks');
  const links = stored.notificationLinks || {};
  const url = links[notificationId];
  if (url) chrome.tabs.create({ url });
  chrome.notifications.clear(notificationId);
});

/* ------------------------------------------------------------------ */
/* 检查                                                                */
/* ------------------------------------------------------------------ */

async function checkMonitor(monitor, options = {}) {
  if (!monitor.enabled && !options.force) return null;
  if (running.has(monitor.id)) return null;
  running.add(monitor.id);

  const previous = memory.results[monitor.id] || {};
  try {
    const extra = {};
    if (monitor.type === 'pageapi') {
      extra.apiText = await fetchViaPage(monitor);
    } else if (monitor.type === 'html' && monitor.render === 'tab') {
      extra.tabHtml = await fetchTabHtml(monitor);
    }

    const collected = await collectItems(monitor, extra);
    const initialized = previous.initialized === true;
    const seen = new Set(previous.seen || []);
    const fresh = collected.items.filter((item) => !seen.has(item.key));
    collected.items.forEach((item) => seen.add(item.key));

    const next = {
      ...previous,
      initialized: true,
      mode: collected.mode,
      source: collected.source,
      warnings: collected.warnings || [],
      seen: [...seen].slice(-300),
      items: collected.items.slice(0, 30),
      lastCheckAt: Date.now(),
      lastError: '',
      lastCount: collected.items.length
    };

    const isNew = fresh.length > 0 && initialized && !options.silent;
    if (isNew) {
      next.lastNewAt = Date.now();
      next.unread = (previous.unread || 0) + fresh.length;
      next.recentNew = [...fresh.slice(0, 10), ...(previous.recentNew || [])].slice(0, 20);
    }
    memory.results[monitor.id] = next;
    await saveState();
    updateBadge();

    if (isNew) await notifyMonitor(monitor, fresh);
    return { ok: true, baseline: !initialized, new: isNew ? fresh.length : 0, total: collected.items.length, items: collected.items };
  } catch (error) {
    memory.results[monitor.id] = {
      ...previous,
      lastCheckAt: Date.now(),
      lastError: String((error && error.message) || error)
    };
    await saveState();
    return { ok: false, message: String((error && error.message) || error) };
  } finally {
    running.delete(monitor.id);
  }
}

async function tick() {
  await ensureReady();
  const now = Date.now();
  const due = memory.monitors.filter((monitor) => {
    if (!monitor.enabled) return false;
    const state = memory.results[monitor.id] || {};
    return now - (state.lastCheckAt || 0) >= monitor.intervalSec * 1000;
  });
  for (const monitor of due) {
    // 串行执行，避免同一时间给目标站点造成压力
    await checkMonitor(monitor);
  }
  updateBadge();
}

/* ------------------------------------------------------------------ */
/* 与 popup 通信                                                       */
/* ------------------------------------------------------------------ */

function statePayload() {
  return {
    monitors: memory.monitors,
    results: memory.results,
    settings: memory.settings
  };
}

const handlers = {
  async GET_STATE() {
    await ensureReady();
    return statePayload();
  },

  async ADD_MONITOR(message) {
    await ensureReady();
    const monitor = normalizeMonitor(message.monitor);
    if (!monitor.url) throw new Error('请填写主页地址');
    memory.monitors.push(monitor);
    await saveState();
    const result = await checkMonitor(monitor, { silent: true });
    return { monitor, check: result, ...statePayload() };
  },

  async UPDATE_MONITOR(message) {
    await ensureReady();
    const index = memory.monitors.findIndex((item) => item.id === message.monitor.id);
    if (index < 0) throw new Error('监控项不存在');
    const previous = memory.monitors[index];
    const monitor = normalizeMonitor({ ...previous, ...message.monitor });
    const changed = previous.url !== monitor.url || previous.type !== monitor.type;
    memory.monitors[index] = monitor;
    if (changed) delete memory.results[monitor.id];
    await saveState();
    const result = await checkMonitor(monitor, { silent: true, force: true });
    return { monitor, check: result, ...statePayload() };
  },

  async DELETE_MONITOR(message) {
    await ensureReady();
    memory.monitors = memory.monitors.filter((item) => item.id !== message.id);
    delete memory.results[message.id];
    await saveState();
    updateBadge();
    return statePayload();
  },

  async CHECK_MONITOR(message) {
    await ensureReady();
    const monitor = memory.monitors.find((item) => item.id === message.id);
    if (!monitor) throw new Error('监控项不存在');
    const result = await checkMonitor(monitor, { force: true, silent: !!message.silent });
    return { result, ...statePayload() };
  },

  async TEST_MONITOR(message) {
    await ensureReady();
    const monitor = normalizeMonitor(message.monitor);
    const extra = {};
    if (monitor.type === 'pageapi') extra.apiText = await fetchViaPage(monitor);
    if (monitor.type === 'html' && monitor.render === 'tab') extra.tabHtml = await fetchTabHtml(monitor);
    const collected = await collectItems(monitor, extra);
    return {
      ok: true,
      mode: collected.mode,
      warnings: collected.warnings,
      items: collected.items.slice(0, 10),
      total: collected.items.length
    };
  },

  async IMPORT_MONITORS(message) {
    await ensureReady();
    const incoming = (message.monitors || []).map(normalizeMonitor).filter((item) => item.url);
    for (const monitor of incoming) {
      const index = memory.monitors.findIndex((item) => item.id === monitor.id || item.url === monitor.url);
      if (index >= 0) memory.monitors[index] = { ...monitor, id: memory.monitors[index].id };
      else memory.monitors.push(monitor);
    }
    await saveState();
    return statePayload();
  },

  async SAVE_SETTINGS(message) {
    await ensureReady();
    memory.settings = {
      ...memory.settings,
      ...message.settings,
      toastDurationSec: Math.max(5, Math.min(120, Number(message.settings.toastDurationSec) || 25))
    };
    await saveState();
    return statePayload();
  },

  async REFRESH_MONITOR(message) {
    await ensureReady();
    const monitor = memory.monitors.find((item) => item.id === message.id);
    if (!monitor) return { ...statePayload(), result: { ok: false, message: '监控项不存在' } };
    // 重新采集：强制抓取并覆盖本地条目（用于补齐全文与图片），不触发新动态提醒
    const result = await checkMonitor(monitor, { force: true, silent: true });
    return { ...statePayload(), result: result || { ok: false, message: '正在检查中，请稍后再试' } };
  },

  async MARK_ALL_READ() {
    await ensureReady();
    for (const key of Object.keys(memory.results)) {
      memory.results[key] = { ...memory.results[key], unread: 0, recentNew: [] };
    }
    await saveState();
    updateBadge();
    return statePayload();
  },

  async OPEN_DETAIL(message) {
    const page = message.key ? 'detail/item.html' : 'detail/detail.html';
    const url = new URL(chrome.runtime.getURL(page));
    if (message.id) url.searchParams.set('monitor', message.id);
    if (message.key) url.searchParams.set('key', message.key);
    await chrome.tabs.create({ url: url.toString() });
    return { ok: true };
  }
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message && message.type];
  if (!handler) return false;
  handler(message)
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ error: String((error && error.message) || error) }));
  return true;
});

void ensureReady().then(() => {
  void ensureAlarm();
  void tick();
});
