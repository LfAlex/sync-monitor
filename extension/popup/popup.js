/**
 * Sync Monitor · 弹窗界面
 */

const TYPE_LABELS = {
  auto: '自动识别',
  rss: 'RSS',
  html: 'HTML',
  json: 'JSON',
  pageapi: '页面接口'
};

const $ = (id) => document.getElementById(id);

let state = { monitors: [], results: {}, settings: {} };
let editingId = null;

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response) throw new Error('后台无响应，请重新打开扩展');
  if (response.error) throw new Error(response.error);
  return response;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function relativeTime(timestamp) {
  if (!timestamp) return '尚未检查';
  const diff = Date.now() - timestamp;
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
  return `${Math.floor(diff / 86400000)} 天前`;
}

function intervalText(seconds) {
  if (seconds % 60 === 0) return `${seconds / 60} 分钟`;
  return `${seconds} 秒`;
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

function parseJsonField(value, label) {
  const text = String(value || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} 不是合法 JSON`);
  }
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

function render() {
  const list = $('list');
  list.textContent = '';
  const unread = Object.values(state.results).reduce((sum, item) => sum + (item.unread || 0), 0);
  $('subtitle').textContent = state.monitors.length
    ? `${state.monitors.length} 个监控项${unread ? ` · ${unread} 条未读` : ''}`
    : '还没有监控项';
  $('emptyTip').classList.toggle('hidden', state.monitors.length > 0);

  for (const monitor of state.monitors) {
    list.appendChild(renderCard(monitor, state.results[monitor.id] || {}));
  }
}

function renderCard(monitor, result) {
  const card = el('article', 'card');

  const head = el('div', 'card-head');
  const titleWrap = el('div', 'card-title');
  titleWrap.appendChild(el('h3', null, monitor.name));

  const href = safeUrl(monitor.url);
  if (href) {
    const link = el('a', 'card-url', href);
    link.href = href;
    link.target = '_blank';
    link.rel = 'noreferrer noopener';
    titleWrap.appendChild(link);
  } else {
    titleWrap.appendChild(el('span', 'card-url', monitor.url));
  }

  const typeBadge = el('span', 'badge', TYPE_LABELS[monitor.type] || monitor.type);
  const toggle = el('button', `toggle${monitor.enabled ? ' on' : ''}`);
  toggle.type = 'button';
  toggle.title = monitor.enabled ? '点击暂停' : '点击启用';
  toggle.addEventListener('click', async () => {
    toggle.disabled = true;
    try {
      const next = await send('UPDATE_MONITOR', { monitor: { ...monitor, enabled: !monitor.enabled } });
      state = next;
      render();
    } catch (error) {
      toggle.disabled = false;
      alert(error.message);
    }
  });

  head.append(titleWrap, typeBadge, toggle);

  const status = el('div', 'status');
  status.appendChild(el('span', null, `上次：${relativeTime(result.lastCheckAt)}`));
  status.appendChild(el('span', null, `间隔：${intervalText(monitor.intervalSec)}`));
  status.appendChild(el('span', null, `采集：${result.mode || '—'}`));
  if (result.unread) status.appendChild(el('span', 'new', `新动态 +${result.unread}`));
  if (result.lastCount) status.appendChild(el('span', null, `本次 ${result.lastCount} 条`));
  if (result.lastError) status.appendChild(el('span', 'error', result.lastError));
  else if (result.warnings && result.warnings.length) status.appendChild(el('span', 'warn', result.warnings[0]));
  if (!result.initialized) status.appendChild(el('span', 'warn', '等待首次基线检查'));

  card.append(head, status);

  const previewItems = (result.recentNew || []).slice(0, 3);
  if (previewItems.length) {
    const preview = el('div', 'preview');
    for (const item of previewItems) {
      // 点击动态进入扩展内的单条详情页（全文 + 图片），原文链接在详情页里
      const row = el('a');
      row.href = '#';
      row.title = '查看完整内容';
      row.addEventListener('click', (event) => {
        event.preventDefault();
        void send('OPEN_DETAIL', { id: monitor.id, key: item.key });
      });
      if (item.time) row.appendChild(el('span', 'time', item.time));
      const text = item.content || item.title || '';
      row.appendChild(document.createTextNode(text.length > 40 ? `${text.slice(0, 40)}…` : text));
      preview.appendChild(row);
    }
    card.appendChild(preview);
  }

  const actions = el('div', 'card-actions');
  const checkButton = el('button', 'ghost small', '立即检查');
  checkButton.type = 'button';
  checkButton.addEventListener('click', async () => {
    checkButton.disabled = true;
    checkButton.textContent = '检查中…';
    try {
      const next = await send('CHECK_MONITOR', { id: monitor.id });
      state = next;
      render();
      const result = next.result || {};
      if (!result.ok) alert(result.message || '检查失败');
      else if (result.baseline) alert(result.message || '已建立基线');
      else alert(result.message || '检查完成');
    } catch (error) {
      checkButton.disabled = false;
      checkButton.textContent = '立即检查';
      alert(error.message);
    }
  });

  const editButton = el('button', 'ghost small', '编辑');
  editButton.type = 'button';
  editButton.addEventListener('click', () => openForm(monitor));

  const deleteButton = el('button', 'ghost small danger', '删除');
  deleteButton.type = 'button';
  deleteButton.addEventListener('click', async () => {
    if (!confirm(`确定删除“${monitor.name}”？`)) return;
    try {
      state = await send('DELETE_MONITOR', { id: monitor.id });
      if (editingId === monitor.id) closeForm();
      render();
    } catch (error) {
      alert(error.message);
    }
  });

  const detailButton = el('button', 'ghost small', '详情');
  detailButton.type = 'button';
  detailButton.addEventListener('click', () => send('OPEN_DETAIL', { id: monitor.id }));

  actions.append(checkButton, detailButton, editButton, deleteButton);
  card.appendChild(actions);
  return card;
}

/* ------------------------------------------------------------------ */
/* 表单                                                                */
/* ------------------------------------------------------------------ */

function updateAdvancedVisibility() {
  const type = $('fType').value;
  $('advPageapi').classList.toggle('hidden', type !== 'pageapi');
  $('advHtml').classList.toggle('hidden', type !== 'html');
  $('advJson').classList.toggle('hidden', !(type === 'json' || type === 'pageapi'));
}

function fillJsonDefaults() {
  if (!$('fListPath').value) $('fListPath').value = 'data.list';
  if (!$('fIdPath').value) $('fIdPath').value = 'id';
  if (!$('fContentPath').value) $('fContentPath').value = 'content';
}

function openForm(monitor = null) {
  editingId = monitor ? monitor.id : null;
  $('formTitle').textContent = monitor ? '编辑监控项' : '添加监控项';
  $('fId').value = monitor ? monitor.id : '';
  $('fName').value = monitor ? monitor.name : '';
  $('fUrl').value = monitor ? monitor.url : '';
  $('fType').value = monitor ? monitor.type : 'auto';
  $('fInterval').value = monitor ? monitor.intervalSec : (state.settings.defaultIntervalSec || 300);
  $('fEnabled').checked = monitor ? monitor.enabled !== false : true;
  $('fNote').value = monitor ? monitor.note || '' : '';

  const html = (monitor && monitor.html) || {};
  $('fItemSelector').value = html.itemSelector || '';
  $('fTitleSelector').value = html.titleSelector || '';
  $('fLinkSelector').value = html.linkSelector || '';
  $('fTimeSelector').value = html.timeSelector || '';
  $('fContentSelector').value = html.contentSelector || '';
  $('fRenderTab').checked = monitor ? monitor.render === 'tab' : false;

  const json = (monitor && monitor.json) || {};
  $('fListPath').value = json.listPath || '';
  $('fIdPath').value = json.idPath || '';
  $('fTitlePath').value = json.titlePath || '';
  $('fContentPath').value = json.contentPath || '';
  $('fTimePath').value = json.timePath || '';
  $('fTimeFormat').value = json.timeFormat || '';
  $('fLinkPath').value = json.linkPath || '';
  $('fLinkTemplate').value = json.linkTemplate || '';
  $('fImagesPath').value = json.imagesPath || '';

  const pageapi = (monitor && monitor.pageapi) || {};
  $('fPageUrl').value = pageapi.pageUrl || '';
  $('fApiUrl').value = pageapi.url || '';
  $('fApiMethod').value = pageapi.method || 'POST';
  $('fApiBody').value = pageapi.body ? JSON.stringify(pageapi.body, null, 2) : '';

  $('fHeaders').value = monitor && monitor.headers && Object.keys(monitor.headers).length
    ? JSON.stringify(monitor.headers, null, 2)
    : '';

  $('testResult').classList.add('hidden');
  $('testResult').textContent = '';
  updateAdvancedVisibility();
  if ($('fType').value === 'json') fillJsonDefaults();
  $('formPanel').classList.remove('hidden');
  $('formPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeForm() {
  editingId = null;
  $('formPanel').classList.add('hidden');
}

function collectForm() {
  const url = $('fUrl').value.trim();
  if (!url) throw new Error('请填写主页地址');
  const type = $('fType').value;
  const monitor = {
    id: editingId || undefined,
    name: $('fName').value.trim(),
    url,
    type,
    enabled: $('fEnabled').checked,
    intervalSec: Number($('fInterval').value) || 300,
    note: $('fNote').value.trim(),
    headers: parseJsonField($('fHeaders').value, '附加请求头') || {},
    html: {
      itemSelector: $('fItemSelector').value.trim(),
      titleSelector: $('fTitleSelector').value.trim(),
      linkSelector: $('fLinkSelector').value.trim(),
      timeSelector: $('fTimeSelector').value.trim(),
      contentSelector: $('fContentSelector').value.trim()
    },
    render: $('fRenderTab').checked ? 'tab' : 'fetch',
    json: {
      listPath: $('fListPath').value.trim() || 'data.list',
      idPath: $('fIdPath').value.trim(),
      titlePath: $('fTitlePath').value.trim(),
      contentPath: $('fContentPath').value.trim(),
      timePath: $('fTimePath').value.trim(),
      timeFormat: $('fTimeFormat').value,
      linkPath: $('fLinkPath').value.trim(),
      linkTemplate: $('fLinkTemplate').value.trim(),
      imagesPath: $('fImagesPath').value.trim()
    },
    rss: {}
  };

  if (type === 'pageapi') {
    const apiUrl = $('fApiUrl').value.trim();
    if (!apiUrl) throw new Error('页面接口模式需要填写接口地址');
    monitor.pageapi = {
      pageUrl: $('fPageUrl').value.trim() || url,
      url: apiUrl,
      method: $('fApiMethod').value,
      headers: monitor.headers,
      body: parseJsonField($('fApiBody').value, '请求体')
    };
  }
  return monitor;
}

function applyThsPreset() {
  const url = $('fUrl').value.trim();
  const match = url.match(/user_code=([\w]+)/);
  if (!match) {
    alert('请先在“主页地址”里填入包含 user_code 的同花顺主页地址');
    return;
  }
  const code = match[1];
  const pageUrl = `https://t.10jqka.com.cn/lgt/user_page/?user_code=${code}`;
  $('fUrl').value = pageUrl;
  if (!$('fName').value.trim()) $('fName').value = '同花顺 · 主页动态';
  $('fType').value = 'pageapi';
  $('fInterval').value = 300;
  $('fPageUrl').value = pageUrl;
  $('fApiUrl').value = '/user_center/open/api/content/v2/get_by_uid';
  $('fApiMethod').value = 'POST';
  $('fApiBody').value = JSON.stringify({ user_code: code }, null, 2);
  $('fHeaders').value = JSON.stringify({ 'Content-Type': 'application/json' }, null, 2);
  $('fListPath').value = 'data.contents';
  $('fIdPath').value = 'info.id';
  $('fTitlePath').value = '';
  $('fContentPath').value = 'abstract.content';
  $('fTimePath').value = 'info.ctime';
  $('fTimeFormat').value = 'ms';
  $('fLinkPath').value = 'info.jump_url';
  $('fLinkTemplate').value = '';
  $('fImagesPath').value = 'image.urls';
  updateAdvancedVisibility();
}

/* ------------------------------------------------------------------ */
/* 设置                                                                */
/* ------------------------------------------------------------------ */

function fillSettings() {
  const settings = state.settings || {};
  $('sPageToast').checked = settings.pageToast !== false;
  $('sSystemNotification').checked = settings.systemNotification !== false;
  $('sToastDuration').value = settings.toastDurationSec || 25;
  $('sInterval').value = settings.defaultIntervalSec || 300;
}

async function loadState() {
  state = await send('GET_STATE');
  render();
  fillSettings();
  if (state.monitors.length === 0) $('emptyTip').classList.remove('hidden');
}

/* ------------------------------------------------------------------ */
/* 事件绑定                                                            */
/* ------------------------------------------------------------------ */

$('showForm').addEventListener('click', () => openForm());
$('cancelForm').addEventListener('click', closeForm);
$('fType').addEventListener('change', updateAdvancedVisibility);
$('thsPreset').addEventListener('click', applyThsPreset);

$('saveMonitor').addEventListener('click', async () => {
  const button = $('saveMonitor');
  button.disabled = true;
  try {
    const monitor = collectForm();
    const result = editingId
      ? await send('UPDATE_MONITOR', { monitor: { ...monitor, id: editingId } })
      : await send('ADD_MONITOR', { monitor });
    state = result;
    render();
    fillSettings();
    closeForm();
    const check = result.check || {};
    if (check.ok && check.baseline) alert('已保存，并建立基线（不会提示历史动态）');
    else if (check && check.ok === false) alert(`已保存，但首次检查失败：${check.message}`);
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
  }
});

$('testMonitor').addEventListener('click', async () => {
  const button = $('testMonitor');
  const output = $('testResult');
  button.disabled = true;
  button.textContent = '测试中…';
  try {
    const monitor = collectForm();
    const result = await send('TEST_MONITOR', { monitor });
    output.classList.remove('hidden');
    const lines = [
      `采集方式：${result.mode}`,
      `条目数量：${result.total}`,
      ...(result.warnings || []).map((item) => `提示：${item}`),
      '',
      ...result.items.map((item, index) => `${index + 1}. [${item.time || '无时间'}] ${item.content || item.title}\n   ${item.link}`)
    ];
    output.textContent = lines.join('\n');
  } catch (error) {
    output.classList.remove('hidden');
    output.textContent = `测试失败：${error.message}`;
  } finally {
    button.disabled = false;
    button.textContent = '测试解析';
  }
});

$('toggleSettings').addEventListener('click', () => {
  $('settingsPanel').classList.toggle('hidden');
  fillSettings();
});

$('saveSettings').addEventListener('click', async () => {
  try {
    state = await send('SAVE_SETTINGS', {
      settings: {
        pageToast: $('sPageToast').checked,
        systemNotification: $('sSystemNotification').checked,
        toastDurationSec: Number($('sToastDuration').value) || 25,
        defaultIntervalSec: Math.max(60, Number($('sInterval').value) || 300)
      }
    });
    render();
    alert('设置已保存');
  } catch (error) {
    alert(error.message);
  }
});

$('markRead').addEventListener('click', async () => {
  try {
    state = await send('MARK_ALL_READ');
    render();
  } catch (error) {
    alert(error.message);
  }
});

$('exportMonitors').addEventListener('click', () => {
  const payload = state.monitors.map((monitor) => ({
    id: monitor.id,
    name: monitor.name,
    url: monitor.url,
    type: monitor.type,
    enabled: monitor.enabled,
    intervalSec: monitor.intervalSec,
    headers: monitor.headers,
    browser: monitor.browser,
    html: monitor.html,
    json: monitor.json,
    rss: monitor.rss,
    pageapi: monitor.pageapi,
    render: monitor.render,
    note: monitor.note
  }));
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'sync-monitor-monitors.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 2000);
});

$('importMonitors').addEventListener('click', () => $('importFile').click());

$('importFile').addEventListener('change', async (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const monitors = Array.isArray(parsed) ? parsed : parsed.monitors;
    if (!Array.isArray(monitors)) throw new Error('文件格式不正确，应为监控项数组');
    state = await send('IMPORT_MONITORS', { monitors });
    render();
    alert(`已导入 ${monitors.length} 个监控项`);
  } catch (error) {
    alert(`导入失败：${error.message}`);
  } finally {
    event.target.value = '';
  }
});

loadState().catch((error) => {
  $('subtitle').textContent = `加载失败：${error.message}`;
});
