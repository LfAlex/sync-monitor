const params = new URLSearchParams(location.search);
const monitorId = params.get('monitor') || '';
const itemKey = params.get('key') || '';

const els = {
  name: document.getElementById('monitorName'),
  back: document.getElementById('backLink'),
  meta: document.getElementById('meta'),
  card: document.getElementById('card'),
  time: document.getElementById('time'),
  content: document.getElementById('content'),
  images: document.getElementById('images'),
  origin: document.getElementById('origin'),
  empty: document.getElementById('empty'),
  viewer: document.getElementById('imageViewer'),
  viewerImage: document.getElementById('imageViewerImg'),
  closeViewer: document.getElementById('closeImageViewer')
};

let activeThumbnail = null;

function openImage(src, thumbnail) {
  activeThumbnail = thumbnail;
  els.viewerImage.src = src;
  els.viewer.hidden = false;
  document.body.classList.add('viewer-open');
  els.closeViewer.focus();
}

function closeImage() {
  els.viewer.hidden = true;
  els.viewerImage.removeAttribute('src');
  document.body.classList.remove('viewer-open');
  if (activeThumbnail) activeThumbnail.focus();
  activeThumbnail = null;
}

els.closeViewer.addEventListener('click', closeImage);
els.viewer.addEventListener('click', (event) => {
  if (event.target === els.viewer) closeImage();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !els.viewer.hidden) closeImage();
});

function showEmpty(text) {
  els.card.hidden = true;
  els.empty.hidden = false;
  els.empty.textContent = text;
}

async function boot() {
  const payload = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  const monitor = ((payload && payload.monitors) || []).find((item) => item.id === monitorId);
  els.back.href = `detail.html?monitor=${encodeURIComponent(monitorId)}`;

  if (!monitor) {
    els.name.textContent = '动态内容';
    showEmpty('找不到对应的监控项，可能已被删除。');
    return;
  }

  els.name.textContent = monitor.name || monitor.url;
  const result = (payload.results || {})[monitorId] || {};
  const item = (result.items || []).find((entry) => entry.key === itemKey)
    || (result.recentNew || []).find((entry) => entry.key === itemKey);

  if (!item) {
    showEmpty('这条动态不在本地记录里了，可以回列表查看最新内容。');
    return;
  }

  els.card.hidden = false;
  els.time.textContent = item.time || '';
  els.meta.textContent = result.lastCheckAt ? `采集时间：${new Date(result.lastCheckAt).toLocaleString('zh-CN', { hour12: false })}` : '';
  els.content.textContent = item.content || item.title || '（无正文）';

  els.images.textContent = '';
  for (const [index, src] of (item.images || []).entries()) {
    const thumbnail = document.createElement('button');
    thumbnail.className = 'thumbnail';
    thumbnail.type = 'button';
    thumbnail.title = '点击放大';
    thumbnail.setAttribute('aria-label', `放大查看第 ${index + 1} 张配图`);
    thumbnail.addEventListener('click', () => openImage(src, thumbnail));

    const img = document.createElement('img');
    img.src = src;
    img.referrerPolicy = 'no-referrer';
    img.loading = 'lazy';
    img.alt = `动态配图 ${index + 1}`;
    thumbnail.appendChild(img);
    els.images.appendChild(thumbnail);
  }

  if (item.link) els.origin.href = item.link;
  else {
    els.origin.textContent = '无原文链接';
    els.origin.classList.add('missing');
    els.origin.removeAttribute('href');
  }
}

void boot();
