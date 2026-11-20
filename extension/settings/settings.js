/**
 * Sync Monitor · 独立设置页
 */

const THS_API_PATH = '/user_center/open/api/content/v2/get_by_uid';
const TYPE_LABELS = {
  auto: '自动识别',
  ths: '同花顺',
  rss: 'RSS',
  html: 'HTML',
  json: 'JSON',
  pageapi: '页面接口'
};

const $ = (id) => document.getElementById(id);

let state = { monitors: [], results: {}, settings: { ai: {} } };
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

function clampNumber(value, fallback, min, max) {
  const number = Number(value) || fallback;
  return Math.max(min, Math.min(max, number));
}

function apiPath(value, baseUrl) {
  try {
    return new URL(value, baseUrl || 'https://t.10jqka.com.cn').pathname;
  } catch {
    return String(value || '').split('?')[0];
  }
}

function isThsMonitor(monitor) {
  return Boolean(monitor && monitor.type === 'pageapi' && monitor.pageapi
    && apiPath(monitor.pageapi.url, monitor.url) === THS_API_PATH);
}

function userIdFromUrl(value) {
  try {
    return new URL(value).searchParams.get('user_code') || '';
  } catch {
    const match = String(value || '').match(/[?&]user_code=([\w]+)/);
    return match ? match[1] : '';
  }
}

function extractThsUserId(monitor) {
  const pageapi = (monitor && monitor.pageapi) || {};
  let body = pageapi.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      body = null;
    }
  }
  if (body && typeof body === 'object' && body.user_code) return String(body.user_code);
  return userIdFromUrl(pageapi.pageUrl) || userIdFromUrl(monitor && monitor.url);
}

function replaceUserIdInUrl(value, code) {
  try {
    const url = new URL(value);
    if (url.searchParams.has('user_code')) url.searchParams.set('user_code', code);
    return url.toString();
  } catch {
    return value;
  }
}

/* ------------------------------------------------------------------ */
/* 监控列表                                                            */
/* ------------------------------------------------------------------ */

function render() {
  const list = $('list');
  list.textContent = '';
  const unread = Object.values(state.results || {}).reduce((sum, item) => sum + (item.unread || 0), 0);
  $('subtitle').textContent = state.monitors.length
    ? `${state.monitors.length} 个监控项${unread ? ` · ${unread} 条未读` : ''}`
    : '还没有监控项';
  $('emptyTip').classList.toggle('hidden', state.monitors.length > 0);
  $('checkAll').disabled = state.monitors.length === 0;

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

  const type = isThsMonitor(monitor) ? 'ths' : monitor.type;
  const typeBadge = el('span', 'badge', TYPE_LABELS[type] || monitor.type);
  const toggle = el('button', `toggle${monitor.enabled ? ' on' : ''}`);
  toggle.type = 'button';
  toggle.title = monitor.enabled ? '点击暂停' : '点击启用';
  toggle.setAttribute('aria-label', toggle.title);
  toggle.addEventListener('click', async () => {
    toggle.disabled = true;
    try {
      state = await send('UPDATE_MONITOR', { monitor: { ...monitor, enabled: !monitor.enabled } });
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
  if (monitor.aiSummaryEnabled) status.appendChild(el('span', 'new', 'AI 概览已开启'));
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
      const row = el('a');
      row.href = '#';
      row.title = '查看完整内容';
      row.addEventListener('click', (event) => {
        event.preventDefault();
        send('OPEN_DETAIL', { id: monitor.id, key: item.key }).catch((error) => alert(error.message));
      });
      if (item.time) row.appendChild(el('span', 'time', item.time));
      const text = item.content || item.title || '';
      row.appendChild(document.createTextNode(text.length > 60 ? `${text.slice(0, 60)}…` : text));
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
      const check = next.result || {};
      if (!check.ok) alert(check.message || '检查失败');
      else if (check.baseline) alert(check.message || '已建立基线');
      else alert(check.message || '检查完成');
    } catch (error) {
      checkButton.disabled = false;
      checkButton.textContent = '立即检查';
      alert(error.message);
    }
  });

  const refreshButton = el('button', 'ghost small', '重新采集');
  refreshButton.type = 'button';
  refreshButton.title = '强制抓取并覆盖本地条目，不触发新动态提醒';
  refreshButton.addEventListener('click', async () => {
    refreshButton.disabled = true;
    refreshButton.textContent = '采集中…';
    try {
      const next = await send('REFRESH_MONITOR', { id: monitor.id });
      state = next;
      render();
      const refresh = next.result || {};
      alert(refresh.ok === false ? (refresh.message || '重新采集失败') : '已重新采集，本地条目已更新');
    } catch (error) {
      refreshButton.disabled = false;
      refreshButton.textContent = '重新采集';
      alert(error.message);
    }
  });

  const detailButton = el('button', 'ghost small', '详情');
  detailButton.type = 'button';
  detailButton.addEventListener('click', () => {
    send('OPEN_DETAIL', { id: monitor.id }).catch((error) => alert(error.message));
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

  actions.append(checkButton, refreshButton, detailButton, editButton, deleteButton);
  card.appendChild(actions);
  return card;
}

/* ------------------------------------------------------------------ */
/* 添加 / 编辑表单                                                     */
/* ------------------------------------------------------------------ */

function updateAdvancedVisibility() {
  const type = $('fType').value;
  const usesPageApi = type === 'pageapi' || type === 'ths';
  $('thsUserField').classList.toggle('hidden', type !== 'ths');
  $('advancedFields').classList.remove('hidden');
  $('advancedFields').open = !['auto', 'rss', 'ths'].includes(type);
  $('advPageapi').classList.toggle('hidden', !usesPageApi);
  $('advHtml').classList.toggle('hidden', type !== 'html');
  $('advJson').classList.toggle('hidden', !(type === 'json' || usesPageApi));
}

function fillJsonDefaults() {
  if (!$('fListPath').value) $('fListPath').value = 'data.list';
  if (!$('fIdPath').value) $('fIdPath').value = 'id';
  if (!$('fContentPath').value) $('fContentPath').value = 'content';
}

function fillThsAdvancedDefaults() {
  $('fApiUrl').value = THS_API_PATH;
  $('fApiMethod').value = 'POST';
  if (!$('fHeaders').value.trim()) {
    $('fHeaders').value = JSON.stringify({ 'Content-Type': 'application/json' }, null, 2);
  }
  if (!$('fListPath').value) $('fListPath').value = 'data.contents';
  if (!$('fIdPath').value) $('fIdPath').value = 'info.id';
  if (!$('fContentPath').value) $('fContentPath').value = 'abstract.content';
  if (!$('fTimePath').value) $('fTimePath').value = 'info.ctime';
  if (!$('fTimeFormat').value) $('fTimeFormat').value = 'ms';
  if (!$('fLinkPath').value) $('fLinkPath').value = 'info.jump_url';
  if (!$('fImagesPath').value) $('fImagesPath').value = 'image.urls';
}

function openForm(monitor = null) {
  editingId = monitor ? monitor.id : null;
  const ths = isThsMonitor(monitor);
  $('formTitle').textContent = monitor ? '编辑监控项' : '添加监控项';
  $('fId').value = monitor ? monitor.id : '';
  $('fName').value = monitor ? monitor.name : '';
  $('fUrl').value = monitor ? monitor.url : '';
  $('fType').value = monitor ? (ths ? 'ths' : monitor.type) : 'auto';
  $('fInterval').value = monitor ? monitor.intervalSec : (state.settings.defaultIntervalSec || 300);
  $('fEnabled').checked = monitor ? monitor.enabled !== false : true;
  $('fAiSummaryEnabled').checked = monitor ? monitor.aiSummaryEnabled === true : false;
  $('fNote').value = monitor ? monitor.note || '' : '';
  $('fThsUserId').value = ths ? extractThsUserId(monitor) : '';

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
  $('fApiBody').value = pageapi.body != null
    ? (typeof pageapi.body === 'string' ? pageapi.body : JSON.stringify(pageapi.body, null, 2))
    : '';

  const requestHeaders = monitor && monitor.type === 'pageapi' ? pageapi.headers : monitor && monitor.headers;
  $('fHeaders').value = requestHeaders && Object.keys(requestHeaders).length
    ? JSON.stringify(requestHeaders, null, 2)
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
  const uiType = $('fType').value;
  const isThs = uiType === 'ths';
  let thsPreset = null;
  let thsUserId = '';
  if (isThs) {
    thsUserId = $('fThsUserId').value.trim() || userIdFromUrl($('fUrl').value);
    if (!/^[\w]+$/.test(thsUserId)) throw new Error('请输入正确的同花顺用户 ID');
    thsPreset = buildQuickThsMonitor(thsUserId);
  }

  const url = isThs ? thsPreset.url : $('fUrl').value.trim();
  if (!url) throw new Error('请填写主页地址');
  const type = isThs ? 'pageapi' : uiType;
  const jsonDefaults = (thsPreset && thsPreset.json) || {};
  const headers = parseJsonField($('fHeaders').value, '附加请求头')
    || (thsPreset ? { ...thsPreset.pageapi.headers } : {});
  const monitor = {
    id: editingId || undefined,
    name: $('fName').value.trim(),
    url,
    type,
    enabled: $('fEnabled').checked,
    intervalSec: Number($('fInterval').value) || 300,
    note: $('fNote').value.trim(),
    aiSummaryEnabled: $('fAiSummaryEnabled').checked,
    headers,
    html: {
      itemSelector: $('fItemSelector').value.trim(),
      titleSelector: $('fTitleSelector').value.trim(),
      linkSelector: $('fLinkSelector').value.trim(),
      timeSelector: $('fTimeSelector').value.trim(),
      contentSelector: $('fContentSelector').value.trim()
    },
    render: $('fRenderTab').checked ? 'tab' : 'fetch',
    json: {
      listPath: $('fListPath').value.trim() || jsonDefaults.listPath || 'data.list',
      idPath: $('fIdPath').value.trim() || jsonDefaults.idPath || '',
      titlePath: $('fTitlePath').value.trim(),
      contentPath: $('fContentPath').value.trim() || jsonDefaults.contentPath || '',
      timePath: $('fTimePath').value.trim() || jsonDefaults.timePath || '',
      timeFormat: $('fTimeFormat').value || jsonDefaults.timeFormat || '',
      linkPath: $('fLinkPath').value.trim() || jsonDefaults.linkPath || '',
      linkTemplate: $('fLinkTemplate').value.trim(),
      imagesPath: $('fImagesPath').value.trim() || jsonDefaults.imagesPath || ''
    },
    rss: {}
  };

  if (type === 'pageapi') {
    const apiUrl = $('fApiUrl').value.trim() || (thsPreset && thsPreset.pageapi.url) || '';
    if (!apiUrl) throw new Error('页面接口模式需要填写接口地址');
    let body = parseJsonField($('fApiBody').value, '请求体');
    if (thsPreset) {
      if (body == null) body = { ...thsPreset.pageapi.body };
      else if (typeof body === 'object' && !Array.isArray(body)) body = { ...body, user_code: thsUserId };
    }
    const presetPageUrl = thsPreset ? thsPreset.pageapi.pageUrl : url;
    const pageUrl = $('fPageUrl').value.trim() || presetPageUrl;
    monitor.pageapi = {
      pageUrl: thsPreset ? replaceUserIdInUrl(pageUrl, thsUserId) : pageUrl,
      url: apiUrl,
      method: $('fApiMethod').value,
      headers,
      body
    };
  }
  return monitor;
}

function applyThsPreset() {
  const code = $('fThsUserId').value.trim() || userIdFromUrl($('fUrl').value);
  if (!/^[\w]+$/.test(code)) {
    alert('请先填写同花顺用户 ID，或在主页地址中提供 user_code');
    return false;
  }
  const preset = buildQuickThsMonitor(code);
  $('fType').value = 'ths';
  $('fThsUserId').value = code;
  $('fUrl').value = preset.url;
  if (!$('fName').value.trim()) $('fName').value = preset.name;
  $('fPageUrl').value = preset.pageapi.pageUrl;
  $('fApiUrl').value = preset.pageapi.url;
  $('fApiMethod').value = preset.pageapi.method;
  $('fApiBody').value = JSON.stringify(preset.pageapi.body, null, 2);
  $('fHeaders').value = JSON.stringify(preset.pageapi.headers || {}, null, 2);
  const json = preset.json || {};
  $('fListPath').value = json.listPath || '';
  $('fIdPath').value = json.idPath || '';
  $('fTitlePath').value = json.titlePath || '';
  $('fContentPath').value = json.contentPath || '';
  $('fTimePath').value = json.timePath || '';
  $('fTimeFormat').value = json.timeFormat || '';
  $('fLinkPath').value = json.linkPath || '';
  $('fLinkTemplate').value = json.linkTemplate || '';
  $('fImagesPath').value = json.imagesPath || '';
  updateAdvancedVisibility();
  return true;
}

function buildQuickThsMonitor(code) {
  const pageUrl = `https://t.10jqka.com.cn/lgt/user_page/?user_code=${code}`;
  const template = state.monitors.find((monitor) => isThsMonitor(monitor));
  if (template) {
    const { id, createdAt, name, url, headers, json, pageapi, ...rest } = template;
    return {
      ...rest,
      name: `同花顺 · ${code}`,
      url: pageUrl,
      enabled: true,
      headers: { ...(headers || {}) },
      json: { ...(json || {}) },
      pageapi: {
        ...pageapi,
        pageUrl,
        headers: { ...(pageapi.headers || {}) },
        body: { user_code: code }
      }
    };
  }
  return {
    name: `同花顺 · ${code}`,
    url: pageUrl,
    type: 'pageapi',
    enabled: true,
    intervalSec: state.settings.defaultIntervalSec || 300,
    aiSummaryEnabled: false,
    pageapi: {
      pageUrl,
      url: THS_API_PATH,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { user_code: code }
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
    }
  };
}

/* ------------------------------------------------------------------ */
/* 常规与 AI 设置                                                      */
/* ------------------------------------------------------------------ */

function collectAiSettings() {
  return {
    enabled: $('sAiEnabled').checked,
    baseUrl: $('sAiBaseUrl').value.trim(),
    apiKey: $('sAiApiKey').value.trim(),
    model: $('sAiModel').value.trim()
  };
}

function fillSettings() {
  const settings = state.settings || {};
  const ai = settings.ai || {};
  $('sPageToast').checked = settings.pageToast !== false;
  $('sSystemNotification').checked = settings.systemNotification !== false;
  $('sToastDuration').value = settings.toastDurationSec || 25;
  $('sInterval').value = settings.defaultIntervalSec || 300;
  $('sAiEnabled').checked = ai.enabled === true;
  $('sAiBaseUrl').value = ai.baseUrl || '';
  $('sAiApiKey').value = ai.apiKey || '';
  $('sAiModel').value = ai.model || '';
}

async function saveSettings(button) {
  button.disabled = true;
  try {
    state = await send('SAVE_SETTINGS', {
      settings: {
        pageToast: $('sPageToast').checked,
        systemNotification: $('sSystemNotification').checked,
        toastDurationSec: clampNumber($('sToastDuration').value, 25, 5, 120),
        defaultIntervalSec: clampNumber($('sInterval').value, 300, 60, 86400),
        ai: collectAiSettings()
      }
    });
    render();
    fillSettings();
    alert('设置已保存');
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
  }
}

async function loadState() {
  state = await send('GET_STATE');
  render();
  fillSettings();
}

/* ------------------------------------------------------------------ */
/* 事件绑定                                                            */
/* ------------------------------------------------------------------ */

$('checkAll').addEventListener('click', async () => {
  const button = $('checkAll');
  button.disabled = true;
  button.textContent = '检查中…';
  try {
    const next = await send('CHECK_ALL_MONITORS');
    state = next;
    render();
    const checks = next.checks || [];
    const failed = checks.filter((item) => !item.result || item.result.ok === false);
    if (failed.length) {
      const details = failed.map((item) => {
        const monitor = next.monitors.find((entry) => entry.id === item.id);
        const message = (item.result && item.result.message) || '正在检查中，请稍后重试';
        return `${monitor ? monitor.name : item.id}：${message}`;
      }).join('\n');
      alert(`检查完成：${checks.length - failed.length} 个成功，${failed.length} 个失败\n${details}`);
    } else {
      alert(`已检查 ${checks.length} 个监控项，全部成功`);
    }
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = state.monitors.length === 0;
    button.textContent = '全部检查';
  }
});

$('showForm').addEventListener('click', () => openForm());
$('closeForm').addEventListener('click', closeForm);
$('cancelForm').addEventListener('click', closeForm);
$('fType').addEventListener('change', () => {
  updateAdvancedVisibility();
  if ($('fType').value === 'ths') {
    const code = $('fThsUserId').value.trim() || userIdFromUrl($('fUrl').value);
    if (/^[\w]+$/.test(code)) applyThsPreset();
    else fillThsAdvancedDefaults();
  } else if ($('fType').value === 'json') {
    fillJsonDefaults();
  }
});
$('fThsUserId').addEventListener('change', () => {
  if ($('fType').value === 'ths' && /^[\w]+$/.test($('fThsUserId').value.trim())) applyThsPreset();
});
$('fThsUserId').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') $('saveMonitor').click();
});
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
      ...(result.items || []).map((item, index) => `${index + 1}. [${item.time || '无时间'}] ${item.content || item.title}\n   ${item.link}`)
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

$('saveSettings').addEventListener('click', () => saveSettings($('saveSettings')));
$('saveAiSettings').addEventListener('click', () => saveSettings($('saveAiSettings')));

$('testAiConnection').addEventListener('click', async () => {
  const button = $('testAiConnection');
  const output = $('aiTestResult');
  button.disabled = true;
  button.textContent = '测试中…';
  output.className = 'inline-status pending';
  output.textContent = '正在连接模型服务…';
  try {
    const result = await send('TEST_AI_CONNECTION', { ai: collectAiSettings() });
    if (result.ok === false) throw new Error(result.message || '连接失败');
    output.className = 'inline-status success';
    output.textContent = result.message || '模型连接成功';
  } catch (error) {
    output.className = 'inline-status error';
    output.textContent = `连接失败：${error.message}`;
  } finally {
    button.disabled = false;
    button.textContent = '测试连接';
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
    aiSummaryEnabled: monitor.aiSummaryEnabled,
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
  alert(`设置页加载失败：${error.message}`);
});
