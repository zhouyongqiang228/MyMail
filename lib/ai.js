function completionUrl(endpoint) {
  const trimmed = String(endpoint || '').trim().replace(/\/+$/, '');
  return /\/chat\/completions$/i.test(trimmed) ? trimmed : `${trimmed}/chat/completions`;
}

function timeoutSignal(timeoutMs = 30000) {
  return AbortSignal.timeout(timeoutMs);
}

async function callCompletion(settings, messages, { signal } = {}) {
  if (!settings.apiKey) throw new Error('请先在设置中保存 API 密钥');
  let url;
  try {
    const parsed = new URL(completionUrl(settings.endpoint));
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('API 端点必须使用 HTTP 或 HTTPS');
    url = parsed;
  } catch {
    throw new Error('API 端点格式不正确');
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
    body: JSON.stringify({ model: settings.model, messages, temperature: 0.3 }),
    signal: signal || timeoutSignal(),
  });
  let data = {};
  try { data = await response.json(); } catch { /* handled below */ }
  if (!response.ok) {
    const detail = data?.error?.message || data?.message || `AI 服务返回 ${response.status}`;
    throw new Error(detail);
  }
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('AI 服务没有返回有效内容');
  return content.trim();
}

export async function testConnection(settings, { signal } = {}) {
  await callCompletion(settings, [{ role: 'user', content: '只回复：连接成功' }], { signal });
  return true;
}

export async function generateReply(settings, message, { signal } = {}) {
  const prompt = [
    '请根据下面的邮件生成一封礼貌、清晰、可直接发送的回复。',
    '只输出回复正文，不要输出主题、前缀、解释或 Markdown 代码块。',
    `发件人：${message.sender || ''}`,
    `主题：${message.subject || '(无主题)'}`,
    '原邮件正文：',
    message.body || '',
  ].join('\n');
  return callCompletion(settings, [{ role: 'user', content: prompt }], { signal });
}
