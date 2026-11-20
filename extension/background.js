/**
 * Sync Monitor · 后台 Service Worker
 *
 * 调度：每分钟唤醒一次，按各监控项的 intervalSec 判断是否到期。
 * 采集：RSS / HTML / JSON 由扩展直接 fetch；pageapi（单页应用）在已打开的
 *       目标页面里用页面自身身份请求接口，规避签名 Cookie 问题。
 * 提示：优先在目标页面内弹出提示，没有打开页面时退化为系统通知。
 */

import { collectItems, normalizeMonitor, DEFAULT_SETTINGS } from './lib/parse.js';
import { generateChineseSummary, testAiConnection } from './lib/ai.js';

const ALARM_NAME = 'sync-monitor-tick';
const STORAGE_KEYS = ['monitors', 'results', 'settings', 'serverChanQueue'];
const SERVER_CHAN_BATCH_SIZE = 10;
const SERVER_CHAN_RETRY_MS = 5 * 60 * 1000;

const memory = {
  monitors: [],
  results: {},
  settings: { ...DEFAULT_SETTINGS },
  serverChanQueue: { jobs: {}, nextAttemptAt: 0, lastError: '' },
  ready: null
};

const running = new Set();
let serverChanFlushing = false;

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

function repairLegacyThsPageApi(monitor) {
  const api = monitor.pageapi;
  if (!api || api.url !== PRESET_THS.pageapi.url) return false;
  let repaired = false;

  const headers = api.headers && typeof api.headers === 'object' ? api.headers : {};
  if (!Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = 'application/json';
    api.headers = headers;
    repaired = true;
  }

  const missingBody = api.body == null || (typeof api.body === 'string' && !api.body.trim());
  if (missingBody) {
    try {
      const pageUrl = api.pageUrl || monitor.url;
      const userCode = new URL(pageUrl).searchParams.get('user_code');
      if (userCode) {
        api.body = { user_code: userCode };
        repaired = true;
      }
    } catch {
      // 保留已有配置，后续请求会透出真实错误
    }
  }
  return repaired;
}

async function loadState() {
  const data = await chrome.storage.local.get(STORAGE_KEYS);
  memory.monitors = (data.monitors || []).map(normalizeMonitor);
  memory.results = data.results || {};
  const storedSettings = data.settings || {};
  memory.settings = {
    ...DEFAULT_SETTINGS,
    ...storedSettings,
    ai: { ...DEFAULT_SETTINGS.ai, ...(storedSettings.ai || {}) },
    serverChan: { ...DEFAULT_SETTINGS.serverChan, ...(storedSettings.serverChan || {}) }
  };
  const queue = data.serverChanQueue || {};
  memory.serverChanQueue = {
    jobs: queue.jobs && typeof queue.jobs === 'object' ? queue.jobs : {},
    nextAttemptAt: Number(queue.nextAttemptAt) || 0,
    lastError: String(queue.lastError || '')
  };

  // 旧版存量配置可能缺少图片字段、页面接口请求体或 JSON 请求头，启动时一并修复
  let migrated = false;
  for (const monitor of memory.monitors) {
    if (monitor.json && monitor.json.contentPath === 'abstract.content' && !monitor.json.imagesPath) {
      monitor.json.imagesPath = 'image.urls';
      migrated = true;
    }
    if (repairLegacyThsPageApi(monitor)) migrated = true;
  }
  if (migrated) await saveState();
  return memory;
}

async function saveState() {
  await chrome.storage.local.set({
    monitors: memory.monitors,
    results: memory.results,
    settings: memory.settings,
    serverChanQueue: memory.serverChanQueue
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
  // 兼容扩展更新前已保存的空请求体或缺失 JSON 请求头；否则同花顺会返回 HTTP 200 + status_code=1000
  if (repairLegacyThsPageApi(monitor)) await saveState();
  const pageUrl = monitor.pageapi.pageUrl || monitor.url;
  const tabs = await findTabs(pageUrl);
  let tab = pickBestTab(tabs, pageUrl);
  let autoOpened = false;
  if (!tab) {
    try {
      if (chrome.windows && chrome.windows.create) {
        // 独立最小化窗口不会在当前浏览器窗口的标签栏中显示，后续检查持续复用
        const win = await chrome.windows.create({ url: pageUrl, focused: false, state: 'minimized' });
        tab = win && win.tabs && win.tabs[0];
      } else {
        // 老版本 Chrome 没有 windows.create 时退化为后台标签页
        tab = await chrome.tabs.create({ url: pageUrl, active: false });
      }
      autoOpened = true;
    } catch (error) {
      throw new Error(`自动打开监控主页失败：${String((error && error.message) || error)}`);
    }
    if (!tab || tab.id == null) throw new Error('自动打开监控主页失败：未创建标签页');
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

  // 同花顺等站点的签名 Cookie 由页面 JS 异步生成，页面刚打开时可能返回 401/403，
  // 也可能以 HTTP 200 返回 status_code/status_msg；自动打开的页面多等待几轮。
  let lastError = '页面内接口请求失败';
  let lastStatus = 0;
  const maxAttempts = autoOpened ? 5 : 3;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    const response = await pageRequest(tab.id, config);
    if (response.ok) {
      let apiError = '';
      try {
        const payload = JSON.parse(response.text);
        const listPath = monitor.json && monitor.json.listPath;
        const expectsData = listPath === 'data' || (typeof listPath === 'string' && listPath.startsWith('data.'));
        if (expectsData && payload && typeof payload === 'object' && !Array.isArray(payload) && !payload.data) {
          const message = payload.status_msg || '响应中缺少 data';
          const code = payload.status_code !== undefined ? `，status_code=${payload.status_code}` : '';
          apiError = `接口暂未就绪：${message}${code}`;
        }
      } catch {
        // 非 JSON 响应交给后续解析器报错
      }
      if (!apiError) return response.text;
      lastStatus = response.status || 0;
      lastError = apiError;
      continue;
    }
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
/* Server 酱未读延时通知                                               */
/* ------------------------------------------------------------------ */

function normalizedServerChan(raw) {
  const config = raw || {};
  return {
    enabled: config.enabled === true,
    sendKey: String(config.sendKey || '').trim(),
    delayMin: Math.max(1, Math.min(10080, Number(config.delayMin) || 60))
  };
}

function serverChanJobKey(monitorId, itemKey) {
  return `${monitorId}:${itemKey}`;
}

function enqueueServerChan(monitor, items) {
  const config = normalizedServerChan(memory.settings.serverChan);
  if (!config.enabled) return;
  for (const item of items) {
    const discoveredAt = item.discoveredAt || Date.now();
    const excerpt = String(item.content || item.title || '（无正文）').slice(0, 200);
    memory.serverChanQueue.jobs[serverChanJobKey(monitor.id, item.key)] = {
      monitorId: monitor.id,
      itemKey: item.key,
      monitorName: monitor.name || monitor.url,
      title: String(item.title || excerpt).slice(0, 120),
      excerpt,
      link: item.link || monitor.url,
      discoveredAt,
      dueAt: discoveredAt + config.delayMin * 60 * 1000
    };
  }
}

function cancelServerChanJobs(predicate) {
  for (const [key, job] of Object.entries(memory.serverChanQueue.jobs)) {
    if (predicate(job, key)) delete memory.serverChanQueue.jobs[key];
  }
}

function rescheduleServerChanJobs(delayMin) {
  for (const job of Object.values(memory.serverChanQueue.jobs)) {
    job.dueAt = job.discoveredAt + delayMin * 60 * 1000;
  }
}

function safeServerChanError(error, sendKey) {
  let message = String((error && error.message) || error || '未知错误');
  if (sendKey) message = message.split(sendKey).join('***');
  return message;
}

async function postServerChan(rawConfig, title, desp) {
  const config = normalizedServerChan(rawConfig);
  if (!config.sendKey) throw new Error('请填写 Server 酱 SendKey');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`https://sctapi.ftqq.com/${encodeURIComponent(config.sendKey)}.send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        Accept: 'application/json'
      },
      body: new URLSearchParams({ title, desp }),
      signal: controller.signal
    });
    const text = await response.text();
    let payload = {};
    try {
      payload = JSON.parse(text);
      if (!payload || typeof payload !== 'object') payload = {};
    } catch {
      if (response.ok) throw new Error('Server 酱返回了非 JSON 响应');
    }
    const detail = String(payload.message || payload.error || '').trim();
    if (!response.ok) throw new Error(`Server 酱 HTTP ${response.status}${detail ? `：${detail}` : ''}`);
    if (payload.code !== 0) throw new Error(detail || `Server 酱返回错误码 ${payload.code}`);
    return payload;
  } catch (error) {
    throw new Error(safeServerChanError(error, config.sendKey));
  } finally {
    clearTimeout(timeout);
  }
}

function serverChanMessage(jobs) {
  const delayMin = normalizedServerChan(memory.settings.serverChan).delayMin;
  const title = `Sync Monitor：${jobs.length} 条未读动态（${delayMin} 分钟）`;
  const desp = jobs.map((job, index) => {
    const heading = `### ${index + 1}. ${job.monitorName}`;
    const itemTitle = job.title || job.excerpt || '未命名动态';
    const linkedTitle = job.link ? `[${itemTitle}](${job.link})` : itemTitle;
    const discoveredAt = new Date(job.discoveredAt).toLocaleString('zh-CN', { hour12: false });
    return `${heading}\n${linkedTitle}\n\n${job.excerpt}\n\n发现时间：${discoveredAt}`;
  }).join('\n\n---\n\n');
  return { title, desp };
}

async function flushServerChan() {
  if (serverChanFlushing) return;
  const config = normalizedServerChan(memory.settings.serverChan);
  const queue = memory.serverChanQueue;
  if (!config.enabled || Date.now() < queue.nextAttemptAt) return;
  const due = Object.entries(queue.jobs)
    .filter(([, job]) => job.dueAt <= Date.now())
    .sort((left, right) => left[1].dueAt - right[1].dueAt);
  if (!due.length) return;

  serverChanFlushing = true;
  try {
    const batch = due.slice(0, SERVER_CHAN_BATCH_SIZE);
    try {
      const message = serverChanMessage(batch.map(([, job]) => job));
      await postServerChan(config, message.title, message.desp);
      for (const [key] of batch) delete queue.jobs[key];
      queue.lastError = '';
      queue.nextAttemptAt = Object.keys(queue.jobs).length ? Date.now() + 60 * 1000 : 0;
    } catch (error) {
      queue.lastError = safeServerChanError(error, config.sendKey);
      queue.nextAttemptAt = Date.now() + SERVER_CHAN_RETRY_MS;
    }
    await saveState();
  } finally {
    serverChanFlushing = false;
  }
}

/* ------------------------------------------------------------------ */
/* AI 概览                                                             */
/* ------------------------------------------------------------------ */

function mergeItemCache(items, previous) {
  const cached = new Map();
  for (const item of [...(previous.items || []), ...(previous.recentNew || [])]) {
    if (!cached.has(item.key)) cached.set(item.key, item);
  }
  return items.map((item) => {
    const old = cached.get(item.key);
    if (!old) return item;
    return {
      ...item,
      ...(old.aiSummary ? { aiSummary: old.aiSummary } : {}),
      ...(old.discoveredAt ? { discoveredAt: old.discoveredAt } : {})
    };
  });
}

async function writeAiSummary(item) {
  const config = memory.settings.ai || {};
  try {
    const text = await generateChineseSummary(config, item);
    item.aiSummary = {
      status: 'ready',
      text,
      error: '',
      model: config.model,
      updatedAt: Date.now()
    };
  } catch (error) {
    item.aiSummary = {
      status: 'error',
      text: '',
      error: String((error && error.message) || error),
      model: config.model || '',
      updatedAt: Date.now()
    };
  }
  return item.aiSummary;
}

async function generateFreshSummaries(items) {
  for (const item of items) await writeAiSummary(item);
}

function updateCachedSummary(result, key, aiSummary) {
  for (const field of ['items', 'recentNew']) {
    for (const item of result[field] || []) {
      if (item.key === key) item.aiSummary = aiSummary;
    }
  }
}

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
    const collectedItems = mergeItemCache(collected.items, previous);
    const initialized = previous.initialized === true;
    const seen = new Set(previous.seen || []);
    const fresh = collectedItems.filter((item) => !seen.has(item.key));
    const discoveredAt = Date.now();
    fresh.forEach((item) => { item.discoveredAt = discoveredAt; });
    collectedItems.forEach((item) => seen.add(item.key));

    const next = {
      ...previous,
      initialized: true,
      mode: collected.mode,
      source: collected.source,
      warnings: collected.warnings || [],
      seen: [...seen].slice(-300),
      items: collectedItems.slice(0, 30),
      lastCheckAt: Date.now(),
      lastError: '',
      lastCount: collectedItems.length
    };

    const isNew = fresh.length > 0 && initialized && !options.silent;
    if (isNew) {
      next.lastNewAt = Date.now();
      next.unread = (previous.unread || 0) + fresh.length;
      next.recentNew = [...fresh.slice(0, 10), ...(previous.recentNew || [])].slice(0, 20);
      enqueueServerChan(monitor, fresh);
    }
    memory.results[monitor.id] = next;
    await saveState();
    updateBadge();

    if (isNew) await notifyMonitor(monitor, fresh);
    if (isNew && monitor.aiSummaryEnabled && memory.settings.ai && memory.settings.ai.enabled) {
      await generateFreshSummaries(fresh);
      await saveState();
    }
    return { ok: true, baseline: !initialized, new: isNew ? fresh.length : 0, total: collectedItems.length, items: next.items };
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
  await flushServerChan();
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
    cancelServerChanJobs((job) => job.monitorId === message.id);
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

  async CHECK_ALL_MONITORS(message) {
    await ensureReady();
    const checks = [];
    for (const monitor of memory.monitors) {
      const result = await checkMonitor(monitor, { force: true, silent: !!message.silent });
      checks.push({ id: monitor.id, result });
    }
    return { checks, ...statePayload() };
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

  async GENERATE_ITEM_SUMMARY(message) {
    await ensureReady();
    if (!memory.settings.ai || !memory.settings.ai.enabled) {
      throw new Error('请先在设置页开启 AI 概览');
    }
    const result = memory.results[message.id];
    if (!result) throw new Error('监控结果不存在');
    const item = [...(result.items || []), ...(result.recentNew || [])]
      .find((entry) => entry.key === message.key);
    if (!item) throw new Error('动态条目不存在');

    if ((!item.aiSummary || item.aiSummary.status !== 'ready') || message.force) {
      const aiSummary = await writeAiSummary(item);
      updateCachedSummary(result, item.key, aiSummary);
      await saveState();
    }
    return {
      ok: item.aiSummary.status === 'ready',
      message: item.aiSummary.error || '',
      item,
      ...statePayload()
    };
  },

  async TEST_AI_CONNECTION(message) {
    await ensureReady();
    const config = message.ai || message.config
      || (message.settings && message.settings.ai) || memory.settings.ai;
    const summary = await testAiConnection(config);
    return { ok: true, message: '模型连接成功', summary };
  },

  async TEST_SERVER_CHAN_CONNECTION(message) {
    await ensureReady();
    const config = message.serverChan || message.config
      || (message.settings && message.settings.serverChan) || memory.settings.serverChan;
    await postServerChan(config, 'Sync Monitor 测试消息',
      `Server 酱连接成功。\n\n发送时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`);
    return { ok: true, message: '测试消息发送成功' };
  },

  async OPEN_SETTINGS() {
    await chrome.tabs.create({ url: chrome.runtime.getURL('settings/settings.html') });
    return { ok: true };
  },

  async SAVE_SETTINGS(message) {
    await ensureReady();
    const incoming = message.settings || {};
    const previousServerChan = normalizedServerChan(memory.settings.serverChan);
    const serverChan = normalizedServerChan({
      ...previousServerChan,
      ...(incoming.serverChan || {})
    });
    if (serverChan.enabled && !serverChan.sendKey) {
      throw new Error('启用 Server 酱前请填写 SendKey');
    }
    memory.settings = {
      ...memory.settings,
      ...incoming,
      ai: { ...memory.settings.ai, ...(incoming.ai || {}) },
      serverChan,
      toastDurationSec: Math.max(5, Math.min(120,
        Number(incoming.toastDurationSec ?? memory.settings.toastDurationSec) || 25))
    };
    if (!serverChan.enabled) {
      memory.serverChanQueue.jobs = {};
      memory.serverChanQueue.nextAttemptAt = 0;
      memory.serverChanQueue.lastError = '';
    } else if (serverChan.delayMin !== previousServerChan.delayMin) {
      rescheduleServerChanJobs(serverChan.delayMin);
    }
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

  async MARK_ITEM_READ(message) {
    await ensureReady();
    const result = memory.results[message.id];
    if (result) {
      const previousUnread = (result.recentNew || []).length;
      const recentNew = (result.recentNew || []).filter((item) => item.key !== message.key);
      const readCount = previousUnread - recentNew.length;
      memory.results[message.id] = {
        ...result,
        recentNew,
        unread: Math.max(0, (result.unread || 0) - readCount)
      };
    }
    cancelServerChanJobs((job) => job.monitorId === message.id && job.itemKey === message.key);
    await saveState();
    updateBadge();
    return statePayload();
  },

  async MARK_ALL_READ() {
    await ensureReady();
    for (const key of Object.keys(memory.results)) {
      memory.results[key] = { ...memory.results[key], unread: 0, recentNew: [] };
    }
    memory.serverChanQueue.jobs = {};
    memory.serverChanQueue.nextAttemptAt = 0;
    memory.serverChanQueue.lastError = '';
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
