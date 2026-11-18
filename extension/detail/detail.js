const params = new URLSearchParams(location.search);
const state = { monitors: [], results: {}, selected: params.get('monitor') || '' };

const els = {
  name: document.getElementById('monitorName'),
  home: document.getElementById('homeLink'),
  meta: document.getElementById('meta'),
  tabs: document.getElementById('tabs'),
  list: document.getElementById('list'),
  template: document.getElementById('itemTemplate')
};

function send(message) {
  return chrome.runtime.sendMessage(message);
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN', { hour12: false });
}

function renderTabs() {
  els.tabs.textContent = '';
  if (state.monitors.length < 2) return;
  for (const monitor of state.monitors) {
    const result = state.results[monitor.id] || {};
    const button = document.createElement('button');
    button.className = `tab${monitor.id === state.selected ? ' active' : ''}`;
    button.textContent = monitor.name || monitor.url;
    const count = document.createElement('span');
    count.className = 'n';
    count.textContent = (result.items || []).length;
    button.appendChild(count);
    button.addEventListener('click', () => {
      state.selected = monitor.id;
      const url = new URL(location.href);
      url.searchParams.set('monitor', monitor.id);
      history.replaceState(null, '', url);
      render();
    });
    els.tabs.appendChild(button);
  }
}

function renderList() {
  const monitor = state.monitors.find((item) => item.id === state.selected);
  const result = (monitor && state.results[monitor.id]) || {};
  els.list.textContent = '';

  if (!monitor) {
    els.name.textContent = '动态详情';
    els.meta.textContent = '';
    els.home.style.display = 'none';
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '还没有监控项，请先在扩展弹窗里添加。';
    els.list.appendChild(empty);
    return;
  }

  els.name.textContent = monitor.name || monitor.url;
  els.home.href = monitor.url;
  els.home.style.display = '';
  const items = result.items || [];
  els.meta.textContent = result.lastCheckAt
    ? `最近检查：${formatTime(result.lastCheckAt)}　共 ${items.length} 条动态`
    : '尚未检查';

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = result.lastError || '暂无动态记录，点扩展弹窗里的「立即检查」抓取一次。';
    els.list.appendChild(empty);
    return;
  }

  const freshKeys = new Set((result.recentNew || []).map((item) => item.key));
  const highlight = params.get('key');
  for (const item of items) {
    const node = els.template.content.firstElementChild.cloneNode(true);
    node.querySelector('.time').textContent = item.time || formatTime(result.lastCheckAt);
    node.querySelector('.content').textContent = item.content || item.title || '（无正文）';
    const origin = node.querySelector('.origin');
    if (item.link) origin.href = item.link;
    else {
      origin.textContent = '无原文链接';
      origin.classList.add('missing');
      origin.removeAttribute('href');
    }

    // 卡片与「全文与图片」进入该条动态的下钻页；点原文链接不触发跳转
    const drillUrl = `item.html?monitor=${encodeURIComponent(monitor.id)}&key=${encodeURIComponent(item.key)}`;
    const drill = document.createElement('a');
    drill.className = 'origin drill';
    drill.href = drillUrl;
    drill.textContent = '全文与图片 →';
    node.querySelector('.item-foot').insertBefore(drill, origin);
    node.classList.add('clickable');
    node.addEventListener('click', (event) => {
      if (event.target.closest('a')) return;
      location.href = drillUrl;
    });

    if (freshKeys.has(item.key)) node.classList.add('is-new');
    if (highlight && item.key === highlight) node.classList.add('flash');
    els.list.appendChild(node);
  }
}

function render() {
  renderTabs();
  renderList();
}

async function boot() {
  const payload = await send({ type: 'GET_STATE' });
  state.monitors = (payload && payload.monitors) || [];
  state.results = (payload && payload.results) || {};
  if (!state.monitors.some((item) => item.id === state.selected)) {
    const withItems = state.monitors.find((item) => ((state.results[item.id] || {}).items || []).length);
    state.selected = (withItems || state.monitors[0] || {}).id || '';
  }
  render();
}

// 重新采集：覆盖本地条目，把旧数据补成全文 + 图片，不触发新动态提醒
document.getElementById('refreshBtn').addEventListener('click', async () => {
  const button = document.getElementById('refreshBtn');
  if (!state.selected) return;
  button.disabled = true;
  button.textContent = '采集中…';
  try {
    const payload = await send({ type: 'REFRESH_MONITOR', id: state.selected });
    if (payload && payload.monitors) {
      state.monitors = payload.monitors;
      state.results = payload.results || {};
      render();
    }
    const result = (payload && payload.result) || {};
    button.textContent = result.ok ? `已更新 ${result.total ?? 0} 条` : (result.message || '采集失败');
  } catch {
    button.textContent = '采集失败';
  }
  setTimeout(() => {
    button.disabled = false;
    button.textContent = '重新采集';
  }, 2500);
});

void boot();
