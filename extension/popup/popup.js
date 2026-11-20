const MAX_RECENT_ITEMS = 5;
const $ = (id) => document.getElementById(id);

let state = { monitors: [], results: {}, settings: {} };
let checkingAll = false;

async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response) throw new Error('后台无响应，请重新打开扩展');
  if (response.error) throw new Error(response.error);
  return response;
}

function timestamp(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : fallback;
}

function relativeTime(value) {
  const time = timestamp(value);
  if (!time) return '';
  const diff = Math.max(0, Date.now() - time);
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
  return `${Math.floor(diff / 86400000)} 天前`;
}

function renderCheckStatus() {
  const status = $('checkStatus');
  if (checkingAll) {
    status.textContent = '正在检查…';
    status.removeAttribute('title');
    return;
  }
  const lastCheckAt = Object.values(state.results).reduce(
    (latest, result) => Math.max(latest, timestamp(result.lastCheckAt)),
    0
  );
  status.textContent = lastCheckAt ? `${relativeTime(lastCheckAt)}检查过` : '尚未检查';
  status.title = lastCheckAt ? `最近检查：${new Date(lastCheckAt).toLocaleString('zh-CN', { hour12: false })}` : '';
}

function excerpt(text, max = 120) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function recentItems() {
  const items = [];
  const seen = new Set();
  for (const monitor of state.monitors) {
    const result = state.results[monitor.id] || {};
    for (const item of result.recentNew || []) {
      const dedupeKey = `${monitor.id}:${item.key}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      items.push({
        item,
        monitor,
        discoveredAt: timestamp(item.discoveredAt, result.lastNewAt || 0)
      });
    }
  }
  return items
    .sort((a, b) => b.discoveredAt - a.discoveredAt)
    .slice(0, MAX_RECENT_ITEMS);
}

function openItem(monitorId, key) {
  void send('OPEN_DETAIL', { id: monitorId, key }).catch(showError);
}

function renderItem({ item, monitor }) {
  const node = $('itemTemplate').content.firstElementChild.cloneNode(true);
  const summary = item.aiSummary && item.aiSummary.status === 'ready'
    ? item.aiSummary.text
    : '';
  const title = item.title || excerpt(item.content, 80) || '无标题动态';
  const preview = excerpt(summary || item.content || item.title);

  node.querySelector('.source').textContent = monitor.name || monitor.url;
  node.querySelector('.time').textContent = item.time || relativeTime(item.discoveredAt);
  node.querySelector('.news-title').textContent = title;
  const content = node.querySelector('.news-content');
  content.textContent = preview === title ? '' : preview;
  node.querySelector('.ai-badge').classList.toggle('hidden', !summary);
  node.setAttribute('aria-label', `阅读来自 ${monitor.name} 的动态：${title}`);
  node.addEventListener('click', () => openItem(monitor.id, item.key));
  node.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    openItem(monitor.id, item.key);
  });
  return node;
}

function render() {
  renderCheckStatus();
  const items = recentItems();
  const unread = Object.values(state.results).reduce((sum, result) => sum + (result.unread || 0), 0);
  $('subtitle').textContent = state.monitors.length
    ? `${state.monitors.length} 个监控项${unread ? ` · ${unread} 条未读` : ''}`
    : '主页动态监控';
  $('unreadSummary').textContent = unread ? `共 ${unread} 条未读，当前展示最近 ${items.length} 条` : '没有未读动态';
  $('markRead').disabled = !unread;
  $('checkAll').disabled = state.monitors.length === 0;
  $('openAll').disabled = state.monitors.length === 0;

  const list = $('list');
  list.textContent = '';
  for (const entry of items) list.appendChild(renderItem(entry));

  const empty = !items.length;
  $('emptyTip').classList.toggle('hidden', !empty);
  if (empty) {
    const hasMonitors = state.monitors.length > 0;
    $('emptyTitle').textContent = hasMonitors ? '暂无新动态' : '还没有监控项';
    $('emptyText').textContent = hasMonitors
      ? '发现新内容后，会在这里显示最近几条。'
      : '先在独立设置页添加需要关注的主页或信息源。';
  }
}

function showError(error) {
  $('feedback').textContent = String((error && error.message) || error);
  $('feedback').classList.remove('hidden');
}

async function openSettings() {
  try {
    await send('OPEN_SETTINGS');
  } catch (error) {
    showError(error);
  }
}

$('openSettings').addEventListener('click', openSettings);
$('emptyAction').addEventListener('click', openSettings);
$('openAll').addEventListener('click', () => {
  void send('OPEN_DETAIL').catch(showError);
});
$('checkAll').addEventListener('click', async () => {
  const button = $('checkAll');
  checkingAll = true;
  renderCheckStatus();
  button.disabled = true;
  button.textContent = '检查中…';
  try {
    state = await send('CHECK_ALL_MONITORS');
    render();
    const failed = (state.checks || []).filter((entry) => !entry.result || entry.result.ok === false);
    if (failed.length) {
      const details = failed.map((entry) => {
        const monitor = state.monitors.find((item) => item.id === entry.id);
        return `${monitor ? monitor.name : entry.id}：${(entry.result && entry.result.message) || '正在检查中，请稍后重试'}`;
      });
      throw new Error(details.join('\n'));
    }
    $('feedback').classList.add('hidden');
  } catch (error) {
    showError(error);
  } finally {
    checkingAll = false;
    renderCheckStatus();
    button.disabled = state.monitors.length === 0;
    button.textContent = '全部检查';
  }
});

$('markRead').addEventListener('click', async () => {
  $('markRead').disabled = true;
  try {
    state = await send('MARK_ALL_READ');
    $('feedback').classList.add('hidden');
    render();
  } catch (error) {
    showError(error);
  } finally {
    $('markRead').disabled = false;
  }
});

async function boot() {
  try {
    state = await send('GET_STATE');
    render();
  } catch (error) {
    showError(error);
    render();
  }
}

void boot();
