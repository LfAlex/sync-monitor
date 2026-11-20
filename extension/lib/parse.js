/**
 * Sync Monitor · 解析核心
 *
 * 该文件不依赖 DOM / DOMParser，可在扩展 Service Worker、popup、内容脚本
 * 以及 Node 中直接复用（便于测试）。支持：
 *   - RSS 2.0 / Atom 订阅源
 *   - 普通 HTML 列表页（CSS 选择器配置，未配置时自动探测重复列表）
 *   - JSON 接口（点号路径取值，适合异步渲染站点的 XHR 数据）
 */

export const DEFAULT_SETTINGS = {
  pageToast: true,
  systemNotification: true,
  toastDurationSec: 25,
  defaultIntervalSec: 300,
  ai: {
    enabled: false,
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: ''
  },
  serverChan: {
    enabled: false,
    sendKey: '',
    delayMin: 60
  }
};

const MIN_INTERVAL = 60;
const MAX_INTERVAL = 86400;

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

export function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/** FNV-1a，用于生成稳定的条目指纹 */
export function hashKey(text) {
  let h = 0x811c9dc5;
  const s = String(text == null ? '' : text);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

export function collapse(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
}

export function truncate(text, max) {
  const s = collapse(text);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function guessName(url) {
  try {
    const u = new URL(url);
    const tail = u.pathname.replace(/\/+$/, '').split('/').filter(Boolean).pop();
    return tail ? `${u.hostname} / ${tail}` : u.hostname;
  } catch {
    return url || '未命名监控';
  }
}

/* ------------------------------------------------------------------ */
/* 迷你 HTML/XML 解析器（容忍不规范标记，够用且无依赖）                  */
/* ------------------------------------------------------------------ */

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr'
]);

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  middot: '·', bull: '•', laquo: '«', raquo: '»', ldquo: '“', rdquo: '”',
  lsquo: '‘', rsquo: '’', times: '×', divide: '÷', yen: '¥'
};

export function decodeEntities(text) {
  return String(text == null ? '' : text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (raw, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try { return String.fromCodePoint(code); } catch { return raw; }
      }
      return raw;
    }
    const key = body.toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : raw;
  });
}

function addText(parent, text) {
  if (!text) return;
  parent.children.push({ type: 'text', text, parent });
}

function parseAttributes(raw) {
  const attrs = {};
  const re = /([\w:.-]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(raw))) {
    const name = m[1].toLowerCase();
    const value = m[3] != null ? m[3] : m[4] != null ? m[4] : m[5] != null ? m[5] : '';
    if (!(name in attrs)) attrs[name] = decodeEntities(value);
  }
  return attrs;
}

function closeTag(stack, name) {
  for (let i = stack.length - 1; i > 0; i -= 1) {
    if (stack[i].tag === name) {
      stack.length = i;
      return;
    }
  }
}

/** 解析 HTML / XML 文本，返回根节点。xml=true 时不按 HTML 的空标签规则处理（<link> 等可包含文本）。 */
export function parseMarkup(input, options = {}) {
  const xml = options.xml === true;
  const root = { tag: '#document', attrs: {}, children: [], parent: null };
  const stack = [root];
  const html = String(input || '');
  const n = html.length;
  let i = 0;

  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      addText(stack[stack.length - 1], html.slice(i));
      break;
    }
    if (lt > i) addText(stack[stack.length - 1], html.slice(i, lt));

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (html.startsWith('<![CDATA[', lt)) {
      const end = html.indexOf(']]>', lt + 9);
      addText(stack[stack.length - 1], html.slice(lt + 9, end < 0 ? n : end));
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt);
      i = end < 0 ? n : end + 1;
      continue;
    }

    let j = lt + 1;
    let quote = null;
    for (; j < n; j += 1) {
      const c = html[j];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '>') {
        break;
      }
    }
    if (j >= n) {
      addText(stack[stack.length - 1], html.slice(lt));
      break;
    }

    const raw = html.slice(lt + 1, j);
    i = j + 1;

    if (raw[0] === '/') {
      closeTag(stack, raw.slice(1).trim().toLowerCase());
      continue;
    }

    const trimmed = raw.replace(/\s+$/, '');
    const selfClose = trimmed.endsWith('/');
    const inner = selfClose ? trimmed.slice(0, -1) : trimmed;
    const nameMatch = inner.match(/^([a-zA-Z][\w:.-]*)/);
    if (!nameMatch) continue;

    const tag = nameMatch[1].toLowerCase();
    const node = {
      tag,
      attrs: parseAttributes(inner.slice(nameMatch[0].length)),
      children: [],
      parent: stack[stack.length - 1]
    };
    stack[stack.length - 1].children.push(node);
    if (!selfClose && (xml || !VOID_TAGS.has(tag))) stack.push(node);
  }

  return root;
}

/** 元素节点的可见文本 */
export function textOf(node) {
  if (!node) return '';
  if (node.type === 'text') return decodeEntities(node.text);
  const parts = [];
  for (const child of node.children) {
    if (child.type === 'text') {
      if (/\S/.test(child.text)) parts.push(decodeEntities(child.text));
    } else {
      parts.push(textOf(child));
    }
  }
  return collapse(parts.join(' '));
}

/** 把可能含有 HTML 的文本压平成纯文本 */
export function stripHtml(html) {
  if (!/<[a-z!/]/i.test(String(html || ''))) return collapse(decodeEntities(html));
  return textOf(parseMarkup(html));
}

/** 保留换行的空白清理：合并空格、规整空行，但不把段落压成一行 */
function cleanMultiline(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** HTML 正文转文本：把 <br>、块级标签转换成换行，保留原文的段落/编号结构 */
export function htmlToText(html) {
  const source = String(html || '');
  if (!/<[a-z!/]/i.test(source)) return cleanMultiline(decodeEntities(source));
  const withBreaks = source
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<(p|div|li|tr|h[1-6])\b[^>]*>/gi, '\n');
  return cleanMultiline(decodeEntities(withBreaks.replace(/<[^>]+>/g, '')));
}

/* ------------------------------------------------------------------ */
/* 迷你 CSS 选择器（标签 / #id / .class / [attr] / 后代 / 子元素）        */
/* ------------------------------------------------------------------ */

const COMPOUND_RE = /(\*|[a-zA-Z][\w:-]*|\.[\w-]+|#[\w-]+|\[[^\]]*\])/g;

function parseCompound(text) {
  const parts = text.match(COMPOUND_RE) || [];
  return parts.map((part) => {
    if (part === '*') return { kind: 'any' };
    if (part[0] === '.') return { kind: 'class', value: part.slice(1) };
    if (part[0] === '#') return { kind: 'id', value: part.slice(1) };
    if (part[0] === '[') {
      const body = part.slice(1, -1).trim();
      const m = body.match(/^([\w:.-]+)\s*(?:([*^$~|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+)))?$/);
      if (!m) return { kind: 'any' };
      return {
        kind: 'attr',
        name: m[1].toLowerCase(),
        op: m[2] || '',
        value: m[3] != null ? m[3] : m[4] != null ? m[4] : m[5] != null ? m[5] : ''
      };
    }
    return { kind: 'tag', value: part.toLowerCase() };
  });
}

function parseSelector(selector) {
  return String(selector || '')
    .split(',')
    .map((group) => group.trim())
    .filter(Boolean)
    .map((group) => group.replace(/>/g, ' > ').split(/\s+/).filter(Boolean));
}

function matchCompound(node, compound) {
  if (!node || node.type === 'text') return false;
  for (const part of compound) {
    if (part.kind === 'any') continue;
    if (part.kind === 'tag' && node.tag !== part.value) return false;
    if (part.kind === 'id' && node.attrs.id !== part.value) return false;
    if (part.kind === 'class') {
      const classes = (node.attrs.class || '').split(/\s+/);
      if (!classes.includes(part.value)) return false;
    }
    if (part.kind === 'attr') {
      if (!(part.name in node.attrs)) return false;
      if (!part.op) continue;
      const actual = node.attrs[part.name];
      const expected = part.value;
      if (part.op === '=' && actual !== expected) return false;
      if (part.op === '*=' && !actual.includes(expected)) return false;
      if (part.op === '^=' && !actual.startsWith(expected)) return false;
      if (part.op === '$=' && !actual.endsWith(expected)) return false;
      if (part.op === '~=' && !actual.split(/\s+/).includes(expected)) return false;
      if (part.op === '|=' && actual !== expected && !actual.startsWith(`${expected}-`)) return false;
    }
  }
  return true;
}

function matchComplex(node, tokens) {
  const walk = (current, index) => {
    if (index < 0) return true;
    const token = tokens[index];
    if (token === '>') return false;
    if (!matchCompound(current, parseCompound(token))) return false;

    if (index - 1 >= 0 && tokens[index - 1] === '>') {
      return current.parent ? walk(current.parent, index - 2) : false;
    }
    let parent = current.parent;
    while (parent && parent.tag !== '#document') {
      if (walk(parent, index - 1)) return true;
      parent = parent.parent;
    }
    return false;
  };
  return walk(node, tokens.length - 1);
}

function collectElements(root, out = []) {
  for (const child of root.children) {
    if (child.type === 'text') continue;
    out.push(child);
    collectElements(child, out);
  }
  return out;
}

export function querySelectorAll(root, selector) {
  const groups = parseSelector(selector);
  if (!groups.length) return [];
  const elements = collectElements(root);
  return elements.filter((node) => groups.some((tokens) => matchComplex(node, tokens)));
}

export function querySelector(root, selector) {
  const found = querySelectorAll(root, selector);
  return found.length ? found[0] : null;
}

/* ------------------------------------------------------------------ */
/* 监控配置标准化                                                      */
/* ------------------------------------------------------------------ */

export function normalizeMonitor(raw = {}) {
  const url = String(raw.url || '').trim();
  const type = ['auto', 'rss', 'html', 'json', 'pageapi'].includes(raw.type) ? raw.type : 'auto';
  const interval = clamp(raw.intervalSec || DEFAULT_SETTINGS.defaultIntervalSec, MIN_INTERVAL, MAX_INTERVAL);
  const html = raw.html && typeof raw.html === 'object' ? raw.html : {};
  const json = raw.json && typeof raw.json === 'object' ? raw.json : {};
  const rss = raw.rss && typeof raw.rss === 'object' ? raw.rss : {};
  const pageapi = raw.pageapi && typeof raw.pageapi === 'object' ? raw.pageapi : {};

  const monitor = {
    id: raw.id || `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    name: String(raw.name || '').trim() || guessName(url),
    url,
    type,
    enabled: raw.enabled !== false,
    intervalSec: interval,
    aiSummaryEnabled: raw.aiSummaryEnabled === true,
    serverChanEnabled: raw.serverChanEnabled === true,
    serverChanDelayMin: clamp(raw.serverChanDelayMin || 60, 1, 10080),
    // 仅扩展使用：render=tab 时读取已打开标签页渲染后的 DOM（适合 Vue/React 单页应用）
    render: raw.render === 'tab' ? 'tab' : 'fetch',
    headers: raw.headers && typeof raw.headers === 'object' ? { ...raw.headers } : {},
    rss: { url: String(rss.url || '').trim() },
    html: {
      itemSelector: String(html.itemSelector || '').trim(),
      titleSelector: String(html.titleSelector || '').trim(),
      linkSelector: String(html.linkSelector || '').trim(),
      timeSelector: String(html.timeSelector || '').trim(),
      contentSelector: String(html.contentSelector || '').trim(),
      idAttribute: String(html.idAttribute || '').trim(),
      itemLimit: clamp(html.itemLimit || 30, 1, 200)
    },
    json: {
      listPath: String(json.listPath || 'data.list').trim() || 'data.list',
      idPath: String(json.idPath || 'id').trim(),
      titlePath: String(json.titlePath || 'title').trim(),
      contentPath: String(json.contentPath || 'content').trim(),
      timePath: String(json.timePath || 'create_time').trim(),
      linkPath: String(json.linkPath || '').trim(),
      linkTemplate: String(json.linkTemplate || '').trim(),
      imagesPath: String(json.imagesPath || '').trim(),
      timeFormat: String(json.timeFormat || '').trim(),
      itemLimit: clamp(json.itemLimit || 30, 1, 200)
    },
    // 页面内接口模式：在已打开的标签页里用页面自身身份请求接口（应对需要签名 Cookie 的单页应用）
    pageapi: {
      url: String(pageapi.url || '').trim(),
      pageUrl: String(pageapi.pageUrl || url).trim(),
      method: String(pageapi.method || 'POST').toUpperCase(),
      headers: pageapi.headers && typeof pageapi.headers === 'object' ? { ...pageapi.headers } : {},
      body: pageapi.body === undefined ? null : pageapi.body
    },
    note: String(raw.note || '').trim(),
    createdAt: raw.createdAt || new Date().toISOString()
  };
  if (!monitor.name) monitor.name = guessName(monitor.url);
  return monitor;
}

export function summarizeMonitor(monitor) {
  return {
    id: monitor.id,
    name: monitor.name,
    url: monitor.url,
    type: monitor.type,
    enabled: monitor.enabled,
    intervalSec: monitor.intervalSec,
    render: monitor.render
  };
}

/* ------------------------------------------------------------------ */
/* 采集                                                                */
/* ------------------------------------------------------------------ */

function absUrl(href, baseUrl) {
  const value = String(href || '').trim();
  if (!value || value.startsWith('javascript:') || value.startsWith('#')) return '';
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}

function getPath(obj, path) {
  if (!path) return obj;
  const keys = String(path)
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((k) => k.trim())
    .filter(Boolean);
  let current = obj;
  for (const key of keys) {
    if (current == null) return undefined;
    current = current[key];
  }
  return current;
}

function makeItem({ id, title, content, link, time, images }, baseUrl) {
  const cleanTitle = truncate(title || content || link, 160);
  // 正文保留完整内容，卡片/弹窗等预览场景各自裁剪，详情页展示全文
  const cleanContent = cleanMultiline(content || title || '');
  const cleanImages = (Array.isArray(images) ? images : [])
    .map((src) => absUrl(src, baseUrl))
    .filter((src) => /^https?:\/\//i.test(src))
    .slice(0, 20);
  const keySource = id || link || `${time || ''}|${cleanTitle}`;
  return {
    key: hashKey(keySource),
    id: String(id || ''),
    title: cleanTitle,
    content: cleanContent,
    link: absUrl(link, baseUrl),
    time: collapse(time || ''),
    images: cleanImages
  };
}

const IMG_SRC_RE = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

/** 从 HTML 正文里提取图片地址（在剥掉标签之前调用） */
export function extractImages(html) {
  if (!html || typeof html !== 'string') return [];
  const urls = [];
  IMG_SRC_RE.lastIndex = 0;
  let match;
  while ((match = IMG_SRC_RE.exec(html))) {
    const src = String(match[1] || match[2] || match[3] || '').trim();
    if (src && !/^data:/i.test(src) && !urls.includes(src)) urls.push(src);
    if (urls.length >= 20) break;
  }
  return urls;
}

/** 把时间戳（秒/毫秒）或 ISO 字符串格式化为本地可读时间 */
export function formatTimeValue(value, format = '') {
  if (value == null || value === '') return '';
  const numeric = typeof value === 'number' || /^\d+$/.test(String(value).trim());
  if (numeric) {
    let seconds = Number(value);
    if (format === 'ms' || (!format && seconds > 1e12)) seconds /= 1000;
    const date = new Date(seconds * 1000);
    if (!Number.isNaN(date.getTime())) {
      const pad = (n) => String(n).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }
  }
  return collapse(value);
}

function uniqueItems(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (!item.key || seen.has(item.key)) continue;
    seen.add(item.key);
    out.push(item);
  }
  return out;
}

/** 解析 RSS / Atom */
export function parseFeed(text, baseUrl) {
  const doc = parseMarkup(text, { xml: true });
  const nodes = [...querySelectorAll(doc, 'item'), ...querySelectorAll(doc, 'entry')];
  const items = nodes.map((node) => {
    const titleNode = querySelector(node, 'title');
    const linkNode = querySelector(node, 'link');
    const guidNode = querySelector(node, 'guid') || querySelector(node, 'id');
    const contentNode =
      querySelector(node, 'content\\:encoded') ||
      querySelector(node, 'description') ||
      querySelector(node, 'summary') ||
      querySelector(node, 'content');
    const timeNode =
      querySelector(node, 'pubdate') ||
      querySelector(node, 'published') ||
      querySelector(node, 'updated') ||
      querySelector(node, 'dc\\:date');

    const href = linkNode ? linkNode.attrs.href || textOf(linkNode) : '';
    const guid = guidNode ? textOf(guidNode) : '';
    const link = absUrl(href || guid, baseUrl);
    const rawContent = contentNode ? textOf(contentNode) : '';

    return makeItem({
      id: guid || link,
      title: titleNode ? textOf(titleNode) : '',
      content: htmlToText(rawContent),
      images: extractImages(rawContent),
      link,
      time: timeNode ? textOf(timeNode) : ''
    }, baseUrl);
  });
  return uniqueItems(items);
}

function heuristicNodes(doc) {
  // 找出“同一父节点下的一组同类兄弟节点，且每个节点都含链接”，当作列表项
  let best = null;
  for (const parent of collectElements(doc)) {
    const groups = new Map();
    for (const child of parent.children) {
      if (child.type === 'text') continue;
      if (!child.children.length) continue;
      const key = child.tag;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(child);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const withLink = group.filter((node) => querySelector(node, 'a[href]'));
      if (withLink.length < 2) continue;
      const meaningful = withLink.filter((node) => textOf(node).length >= 10);
      if (meaningful.length < Math.max(2, Math.ceil(withLink.length * 0.6))) continue;
      if (!best || meaningful.length > best.length) best = meaningful;
    }
  }
  return best || [];
}

/** 解析 HTML 列表页 */
export function parseHtmlItems(html, baseUrl, htmlConfig = {}) {
  const cfg = { ...normalizeMonitor({ url: baseUrl, html: htmlConfig }).html, ...htmlConfig };
  const doc = parseMarkup(html);
  const nodes = cfg.itemSelector
    ? querySelectorAll(doc, cfg.itemSelector)
    : heuristicNodes(doc);

  const items = nodes.slice(0, cfg.itemLimit).map((node) => {
    if (node.type === 'text') return null;
    const titleNode = cfg.titleSelector ? querySelector(node, cfg.titleSelector) : null;
    const contentNode = cfg.contentSelector ? querySelector(node, cfg.contentSelector) : null;
    const timeNode = cfg.timeSelector ? querySelector(node, cfg.timeSelector) : null;
    let linkNode = cfg.linkSelector ? querySelector(node, cfg.linkSelector) : null;
    if (!linkNode) linkNode = node.tag === 'a' ? node : querySelector(node, 'a[href]');

    const href = linkNode ? linkNode.attrs.href : '';
    const link = absUrl(href, baseUrl);
    const explicitId = cfg.idAttribute ? node.attrs[cfg.idAttribute] : '';
    const title = titleNode ? textOf(titleNode) : linkNode ? textOf(linkNode) : textOf(node);
    const content = contentNode ? textOf(contentNode) : textOf(node);
    const timeText = timeNode ? textOf(timeNode) : '';

    return makeItem({
      id: explicitId || link,
      title,
      content,
      images: querySelectorAll(contentNode || node, 'img').map((img) => img.attrs.src || ''),
      link,
      time: timeText
    }, baseUrl);
  }).filter(Boolean);

  return uniqueItems(items);
}

/** 解析 JSON 接口数据 */
export function parseJsonItems(payload, baseUrl, jsonConfig = {}) {
  const cfg = { ...normalizeMonitor({ url: baseUrl, json: jsonConfig }).json, ...jsonConfig };
  const list = getPath(payload, cfg.listPath);
  if (!Array.isArray(list)) {
    const keys = payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 8).join(', ') : typeof payload;
    throw new Error(`JSON 路径 ${cfg.listPath} 未取到数组（顶层字段：${keys}）`);
  }

  const items = list.slice(0, cfg.itemLimit).map((entry) => {
    if (!entry || typeof entry !== 'object') return null;
    const id = getPath(entry, cfg.idPath);
    const title = cfg.titlePath ? getPath(entry, cfg.titlePath) : '';
    const content = getPath(entry, cfg.contentPath);
    const time = getPath(entry, cfg.timePath);
    const imageValue = cfg.imagesPath ? getPath(entry, cfg.imagesPath) : null;
    // 结构化图片字段（如 image.urls）优先；没有则从正文 HTML 里提取 <img>
    const structuredImages = Array.isArray(imageValue)
      ? imageValue.filter((value) => typeof value === 'string' && value.trim())
      : [];
    let images = structuredImages;
    // 同花顺部分原图只出现在分享卡片中，不在常规 image.urls 字段里
    if (!images.length && cfg.imagesPath === 'image.urls') {
      const displayInfo = getPath(entry, 'share.display_info');
      const sharedValues = displayInfo && Array.isArray(displayInfo.images) ? displayInfo.images.slice() : [];
      if (displayInfo && typeof displayInfo.image === 'string') sharedValues.push(displayInfo.image);
      images = [...new Set(sharedValues.map((value) => {
        if (typeof value === 'string') return value;
        return value && typeof value.url === 'string' ? value.url : '';
      }).filter((value) => value.trim()))];
    }
    let link = cfg.linkPath ? getPath(entry, cfg.linkPath) : '';
    if (!link && cfg.linkTemplate) {
      link = cfg.linkTemplate
        .replace(/\{id\}/g, id == null ? '' : String(id))
        .replace(/\{time\}/g, time == null ? '' : String(time))
        .replace(/\{title\}/g, encodeURIComponent(title == null ? '' : String(title)));
    }
    return makeItem({
      id: id == null ? '' : String(id),
      title: typeof title === 'string' ? stripHtml(title) : '',
      content: typeof content === 'string' ? htmlToText(content) : (content == null ? '' : String(content)),
      images: images.length ? images : extractImages(typeof content === 'string' ? content : ''),
      link,
      time: formatTimeValue(time, cfg.timeFormat)
    }, baseUrl);
  }).filter(Boolean);

  return uniqueItems(items);
}

/* ------------------------------------------------------------------ */
/* 抓取                                                                */
/* ------------------------------------------------------------------ */

function detectCharset(buffer, contentType) {
  const ct = contentType || '';
  const fromHeader = ct.match(/charset=["']?([\w-]+)/i);
  if (fromHeader) return fromHeader[1];
  try {
    const head = new TextDecoder('utf-8').decode(buffer.slice(0, 2048));
    const meta = head.match(/<meta[^>]+charset=["']?([\w-]+)/i);
    if (meta) return meta[1];
  } catch {
    /* ignore */
  }
  return 'utf-8';
}

export function decodeBuffer(buffer, contentType) {
  const charset = detectCharset(buffer, contentType).toLowerCase();
  const candidates = [charset];
  if (charset === 'gb2312' || charset === 'gbk') candidates.push('gb18030');
  candidates.push('utf-8');
  for (const name of candidates) {
    try {
      return new TextDecoder(name).decode(buffer);
    } catch {
      /* try next */
    }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
}

export async function fetchText(url, monitor = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {
      Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html, application/json;q=0.9, */*;q=0.8',
      ...(monitor.headers || {})
    };
    const response = await fetch(url, { headers, signal: controller.signal, credentials: 'include', redirect: 'follow' });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
    const buffer = await response.arrayBuffer();
    return decodeBuffer(new Uint8Array(buffer), response.headers.get('content-type') || '');
  } finally {
    clearTimeout(timer);
  }
}

function looksLikeFeed(text) {
  const head = text.slice(0, 800).trim();
  return /^<\?xml/i.test(head) || /<rss[\s>]/i.test(text.slice(0, 4000)) || /<feed[\s>]/i.test(text.slice(0, 4000));
}

function looksLikeJson(text) {
  const head = text.trimStart()[0];
  return head === '{' || head === '[';
}

export function discoverFeedUrls(html, baseUrl) {
  const doc = parseMarkup(html);
  const links = querySelectorAll(doc, 'link');
  const found = [];
  for (const link of links) {
    const type = (link.attrs.type || '').toLowerCase();
    if (!type.includes('rss') && !type.includes('atom')) continue;
    const href = absUrl(link.attrs.href, baseUrl);
    if (href) found.push(href);
  }
  for (const anchor of querySelectorAll(doc, 'a[href]')) {
    const href = anchor.attrs.href || '';
    if (/\.(xml|rss)(\?|$)/i.test(href) || /\/(feed|rss)(\/|\?|$)/i.test(href)) {
      const abs = absUrl(href, baseUrl);
      if (abs && !found.includes(abs)) found.push(abs);
    }
  }
  return found.slice(0, 3);
}

function requireResult(items, hint) {
  if (!items.length) throw new Error(hint || '未解析到任何条目，请检查选择器或数据路径');
  return items;
}

/**
 * 采集一个监控项。
 * @param {object} monitor 标准化后的监控项
 * @param {{ tabHtml?: string }} options 扩展中 render=tab 时传入已渲染页面的 HTML
 * @returns {Promise<{items: Array, mode: string, source: string, warnings: string[]}>}
 */
export async function collectItems(monitor, options = {}) {
  const warnings = [];
  const baseUrl = monitor.url;

  if (monitor.type === 'rss') {
    const feedUrl = monitor.rss?.url || baseUrl;
    const items = requireResult(parseFeed(await fetchText(feedUrl, monitor), feedUrl), '订阅源中没有条目');
    return { items, mode: 'rss', source: feedUrl, warnings };
  }

  if (monitor.type === 'html') {
    const html = options.tabHtml || (await fetchText(baseUrl, monitor));
    const items = requireResult(
      parseHtmlItems(html, baseUrl, monitor.html),
      monitor.render === 'tab' ? '页面中未解析到条目：请确认页面已打开且选择器正确' : '页面中未解析到条目，请配置列表项选择器'
    );
    return { items, mode: monitor.render === 'tab' ? 'html(tab)' : 'html', source: baseUrl, warnings };
  }

  if (monitor.type === 'json') {
    const text = await fetchText(baseUrl, monitor);
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error('返回内容不是合法 JSON，请确认地址是接口而非页面');
    }
    return { items: requireResult(parseJsonItems(payload, baseUrl, monitor.json), '接口中没有条目'), mode: 'json', source: baseUrl, warnings };
  }

  if (monitor.type === 'pageapi') {
    if (!options.apiText) {
      throw new Error('需要目标页面处于打开状态才能读取接口数据');
    }
    let payload;
    try {
      payload = JSON.parse(options.apiText);
    } catch {
      throw new Error(`接口返回的不是 JSON：${String(options.apiText).slice(0, 120)}`);
    }
    return {
      items: requireResult(parseJsonItems(payload, baseUrl, monitor.json), '接口中没有条目'),
      mode: 'pageapi',
      source: monitor.pageapi.url || baseUrl,
      warnings
    };
  }

  // auto：先按返回内容嗅探，再回退到订阅源自动发现
  const html = options.tabHtml || (await fetchText(baseUrl, monitor));

  if (looksLikeFeed(html)) {
    const items = parseFeed(html, baseUrl);
    if (items.length) return { items, mode: 'rss', source: baseUrl, warnings };
    warnings.push('内容像订阅源但未解析出条目');
  }

  if (looksLikeJson(html)) {
    try {
      const payload = JSON.parse(html);
      const items = parseJsonItems(payload, baseUrl, monitor.json);
      if (items.length) return { items, mode: 'json', source: baseUrl, warnings };
    } catch (error) {
      warnings.push(`JSON 解析失败：${error.message}`);
    }
  }

  const htmlItems = parseHtmlItems(html, baseUrl, monitor.html);
  if (htmlItems.length) {
    return { items: htmlItems, mode: monitor.html.itemSelector ? 'html' : 'html(auto)', source: baseUrl, warnings };
  }

  const feeds = monitor.rss?.url ? [monitor.rss.url] : discoverFeedUrls(html, baseUrl);
  for (const feedUrl of feeds) {
    try {
      const items = parseFeed(await fetchText(feedUrl, monitor), feedUrl);
      if (items.length) {
        warnings.push(`已自动改用订阅源 ${feedUrl}`);
        return { items, mode: 'rss', source: feedUrl, warnings };
      }
    } catch (error) {
      warnings.push(`订阅源 ${feedUrl} 抓取失败：${error.message}`);
    }
  }

  throw new Error('未能从该地址解析出动态，请改用 RSS 地址，或配置 HTML/JSON 选择器');
}
