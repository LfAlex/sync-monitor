const DEFAULT_TIMEOUT_MS = 45000;

function requireConfig(config = {}) {
  const normalized = {
    baseUrl: String(config.baseUrl || '').trim().replace(/\/+$/, ''),
    apiKey: String(config.apiKey || '').trim(),
    model: String(config.model || '').trim()
  };
  if (!normalized.baseUrl || !normalized.apiKey || !normalized.model) {
    throw new Error('请先在设置页完整填写 AI Base URL、API Key 和 Model');
  }
  return normalized;
}

async function readJsonResponse(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`模型服务返回的不是有效 JSON（HTTP ${response.status}）`);
  }
}

export async function generateChineseSummary(rawConfig, item, options = {}) {
  const config = requireConfig(rawConfig);
  const content = String(item && (item.content || item.title) || '').trim();
  if (!content) throw new Error('这条动态没有可用于生成概览的正文');

  const endpoint = config.baseUrl.endsWith('/chat/completions')
    ? config.baseUrl
    : `${config.baseUrl}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        stream: false,
        messages: [
          {
            role: 'system',
            content: '你是动态阅读助手。请依据用户提供的原文，用简洁自然的中文概括核心内容和结论，不补充原文没有的事实，不评价投资价值，只输出概览正文。'
          },
          {
            role: 'user',
            content: `${item.title ? `标题：${item.title}\n\n` : ''}原文：\n${content}`
          }
        ]
      }),
      signal: controller.signal
    });
    const payload = await readJsonResponse(response);
    if (!response.ok) {
      const message = payload && payload.error && (payload.error.message || payload.error);
      throw new Error(`模型请求失败：HTTP ${response.status}${message ? `，${String(message).slice(0, 200)}` : ''}`);
    }
    const summary = payload && payload.choices && payload.choices[0]
      && payload.choices[0].message && payload.choices[0].message.content;
    if (typeof summary !== 'string' || !summary.trim()) {
      throw new Error('模型服务未返回有效的概览内容');
    }
    return summary.trim();
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('模型请求超时，请稍后重试');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function testAiConnection(config) {
  return generateChineseSummary(config, {
    title: 'Sync Monitor 连接测试',
    content: '这是一段用于确认模型服务连接正常的测试文字。'
  }, { timeoutMs: 20000 });
}
