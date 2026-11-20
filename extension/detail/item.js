const params = new URLSearchParams(location.search);
const monitorId = params.get('monitor') || '';
const itemKey = params.get('key') || '';
const state = { monitors: [], results: {}, settings: {} };

let currentMonitor = null;
let currentItem = null;
let aiBusy = false;
let aiLocalError = '';

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response) throw new Error('后台无响应，请重新打开扩展');
  if (response.error) throw new Error(response.error);
  return response;
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN', { hour12: false });
}

function locateItem() {
  currentMonitor = state.monitors.find((item) => item.id === monitorId) || null;
  const result = (currentMonitor && state.results[currentMonitor.id]) || {};
  const items = [...(result.items || []), ...(result.recentNew || [])];
  currentItem = items.find((item) => item.key === itemKey) || null;
}

function renderAi() {
  const action = document.getElementById('aiAction');
  const text = document.getElementById('aiText');
  const meta = document.getElementById('aiMeta');
  const enabled = state.settings.ai && state.settings.ai.enabled === true;
  const summary = currentItem && currentItem.aiSummary;

  action.hidden = !enabled;
  action.disabled = aiBusy;
  action.textContent = aiBusy
    ? '生成中…'
    : summary && summary.status === 'ready'
      ? '重新生成'
      : summary && summary.status === 'error'
        ? '重试'
        : '生成 AI 概览';

  if (aiBusy) {
    text.textContent = '正在将这条原文发送给所配置的模型，请稍候…';
  } else if (summary && summary.status === 'ready') {
    text.textContent = summary.text;
  } else if (summary && summary.status === 'error') {
    text.textContent = `生成失败：${summary.error || '未知错误'}`;
  } else if (aiLocalError) {
    text.textContent = aiLocalError;
  } else if (enabled) {
    text.textContent = '根据这条原文生成一段简明中文概览。正文仅会发送给你配置的模型服务。';
  } else {
    text.textContent = '尚未开启 AI 概览。可前往设置页配置模型，开启后再生成。';
  }

  meta.textContent = summary && summary.updatedAt
    ? `${summary.model || '模型'} · ${formatTime(summary.updatedAt)}`
    : '';
}

function renderItem() {
  const empty = document.getElementById('empty');
  const card = document.getElementById('card');
  if (!currentMonitor || !currentItem) {
    empty.hidden = false;
    empty.textContent = '没有找到这条动态，可能已被清理。请返回动态列表重新进入。';
    return;
  }

  empty.hidden = true;
  card.hidden = false;
  document.getElementById('monitorName').textContent = currentMonitor.name || currentMonitor.url;
  const result = state.results[currentMonitor.id] || {};
  document.getElementById('meta').textContent = currentItem.time || formatTime(result.lastCheckAt);
  document.getElementById('time').textContent = currentItem.time || '';
  document.getElementById('content').textContent = currentItem.content || currentItem.title || '（无正文）';
  document.getElementById('backLink').href = `detail.html?monitor=${encodeURIComponent(currentMonitor.id)}`;

  const origin = document.getElementById('origin');
  if (currentItem.link) origin.href = currentItem.link;
  else {
    origin.textContent = '无原文链接';
    origin.classList.add('missing');
    origin.removeAttribute('href');
  }

  const images = document.getElementById('images');
  images.textContent = '';
  for (const [index, src] of (currentItem.images || []).entries()) {
    const thumbnail = document.createElement('button');
    thumbnail.className = 'thumbnail';
    thumbnail.type = 'button';
    thumbnail.title = '查看大图';
    thumbnail.setAttribute('aria-label', `查看第 ${index + 1} 张配图`);
    const img = document.createElement('img');
    img.src = src;
    img.referrerPolicy = 'no-referrer';
    img.loading = 'lazy';
    img.alt = `动态配图 ${index + 1}`;
    thumbnail.appendChild(img);
    thumbnail.addEventListener('click', () => openImageViewer(src, img.alt));
    images.appendChild(thumbnail);
  }
  renderAi();
}

const viewer = document.getElementById('imageViewer');
const viewerImg = document.getElementById('imageViewerImg');

function openImageViewer(src, alt) {
  viewerImg.src = src;
  viewerImg.alt = alt || '动态配图大图';
  viewer.hidden = false;
  document.body.classList.add('viewer-open');
}

function closeImageViewer() {
  viewer.hidden = true;
  viewerImg.removeAttribute('src');
  document.body.classList.remove('viewer-open');
}

document.getElementById('closeImageViewer').addEventListener('click', closeImageViewer);
viewer.addEventListener('click', (event) => {
  if (event.target === viewer) closeImageViewer();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !viewer.hidden) closeImageViewer();
});

document.getElementById('aiAction').addEventListener('click', async () => {
  if (!currentItem || aiBusy) return;
  aiBusy = true;
  aiLocalError = '';
  renderAi();
  try {
    const payload = await send({
      type: 'GENERATE_ITEM_SUMMARY',
      id: currentMonitor.id,
      key: currentItem.key,
      force: currentItem.aiSummary && currentItem.aiSummary.status === 'ready'
    });
    state.monitors = payload.monitors || [];
    state.results = payload.results || {};
    state.settings = payload.settings || {};
    locateItem();
    if (payload.ok === false) aiLocalError = payload.message || '生成失败，请稍后重试';
  } catch (error) {
    aiLocalError = String((error && error.message) || error);
  } finally {
    aiBusy = false;
    renderAi();
  }
});

document.getElementById('aiSettings').addEventListener('click', () => {
  void send({ type: 'OPEN_SETTINGS' }).catch((error) => {
    aiLocalError = String((error && error.message) || error);
    renderAi();
  });
});

async function boot() {
  try {
    const payload = await send({ type: 'GET_STATE' });
    state.monitors = payload.monitors || [];
    state.results = payload.results || {};
    state.settings = payload.settings || {};
    locateItem();
    renderItem();
  } catch (error) {
    const empty = document.getElementById('empty');
    empty.hidden = false;
    empty.textContent = String((error && error.message) || error);
  }
}

void boot();
