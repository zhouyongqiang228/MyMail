const state = { allMailboxes: [], mailboxes: [], accounts: [], account: null, selectedMailbox: null, messages: [], currentMessage: null, search: '', openRequest: 0, debugSession: null, debugNew: [], selectedDebugMessage: null, settingsHasKey: false };
const $ = selector => document.querySelector(selector);
const isInbox = name => /^(inbox|收件箱)$/i.test(String(name || '').trim());
const isSent = name => /^(sent|sent messages|已发邮件|已发送)$/i.test(String(name || '').trim());

async function api(url, options = {}) {
  let response;
  try {
    response = await fetch(url, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  } catch (error) {
    const detail = error?.message || String(error);
    throw new Error(`无法连接本地服务。${detail}\n请确认 npm start 仍在运行，并检查浏览器地址是否为 http://localhost:3001。`);
  }
  let data = {};
  let raw = '';
  try {
    if (typeof response.text === 'function') {
      raw = await response.text();
      try { data = JSON.parse(raw); } catch { data = {}; }
    } else data = await response.json();
  } catch { data = {}; }
  if (!data || typeof data !== 'object') data = {};
  if (!response.ok) {
    const parts = [data.error || `请求失败（HTTP ${response.status}）`];
    const rawReason = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1000);
    const reason = data.reason || rawReason;
    if (reason && reason !== data.error) parts.push(`详细原因：${reason}`);
    if (Array.isArray(data.possibleCauses) && data.possibleCauses.length) parts.push(`可能原因：${data.possibleCauses.join('；')}`);
    if (data.requestId) parts.push(`请求 ID：${data.requestId}`);
    throw new Error(parts.join('\n'));
  }
  return data;
}
function showError(message) {
  $('#errorText').textContent = message;
  $('#errorToast').classList.remove('hidden');
}
function mailboxKey(mailbox) { return mailbox ? JSON.stringify([mailbox.account, mailbox.name]) : ''; }
function savedAccount() {
  try { return window.localStorage.getItem('mailAccount'); } catch { return null; }
}
function saveAccount(account) {
  try { window.localStorage.setItem('mailAccount', account); } catch { /* storage can be unavailable in private contexts */ }
}
function debugContextLabel() { return state.selectedMailbox ? `${state.selectedMailbox.account} / ${state.selectedMailbox.name}` : '请选择左侧邮箱文件夹'; }
function debugLog(step, message, level = 'info') {
  const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${message}`;
  state.debugLogs ||= { listen: [], check: [], reply: [] };
  state.debugLogs[step] ||= [];
  state.debugLogs[step].push({ line, level });
  const target = document.querySelector(`#${step}Log`);
  if (target) {
    target.textContent = state.debugLogs[step].map(item => item.line).join('\n');
    target.classList.toggle('error', level === 'error');
  }
}
function resetDebugUi() {
  state.debugSession = null;
  state.debugNew = [];
  state.selectedDebugMessage = null;
  state.debugLogs = { listen: [], check: [], reply: [] };
  $('#debugContext').textContent = `正在测试：${debugContextLabel()}`;
  $('#listenStatus').textContent = '尚未开始测试会话';
  $('#checkStatus').textContent = '请先开始监听。';
  $('#startSessionButton').disabled = false;
  $('#checkNewButton').disabled = true;
  $('#resetSessionButton').disabled = true;
  $('#replyEditor').classList.add('hidden');
  $('#replyEmpty').classList.remove('hidden');
  $('#replyStatus').textContent = '';
  $('#replyInstructions').value = '';
  $('#newDebugMessages').replaceChildren(debugMessageElement(null));
  for (const step of ['listen', 'check', 'reply']) $(`#${step}Log`).textContent = '等待操作。';
}
function setDebugSession(session) {
  state.debugSession = session;
  $('#debugContext').textContent = `正在测试：${debugContextLabel()}`;
  $('#listenStatus').textContent = `已开始监听，等待新邮件\n开始时间：${session.startedAt}`;
  $('#checkStatus').textContent = '等待新邮件；准备好后点击“检查新邮件”。';
  $('#startSessionButton').disabled = true;
  $('#checkNewButton').disabled = false;
  $('#resetSessionButton').disabled = false;
}
async function stopDebugSessionForMailboxChange() {
  if (!state.debugSession) return;
  const session = state.debugSession;
  $('#startSessionButton').disabled = true;
  $('#checkNewButton').disabled = true;
  $('#resetSessionButton').disabled = true;
  try {
    await api('/api/debug/session/' + encodeURIComponent(session.sessionId), { method: 'DELETE' });
  } catch (error) {
    if (state.debugSession === session) {
      $('#startSessionButton').disabled = true;
      $('#checkNewButton').disabled = false;
      $('#resetSessionButton').disabled = false;
    }
    throw error;
  }
}
function applyAccountFilter() {
  state.mailboxes = state.allMailboxes.filter(item => item.account === state.account && (isInbox(item.name) || isSent(item.name)));
}
function renderAccountSelect() {
  const select = $('#accountSelect');
  select.replaceChildren();
  for (const account of state.accounts) {
    const option = document.createElement('option');
    option.value = account;
    option.textContent = account;
    option.selected = account === state.account;
    select.append(option);
  }
  select.disabled = state.accounts.length === 0;
}
function updateStatus(connected, label) {
  $('#statusDot').classList.toggle('online', connected);
  $('#statusDot').classList.toggle('offline', !connected);
  $('#statusText').textContent = label;
}
async function loadMailboxes() {
  $('#mailboxList').innerHTML = '<div class="sidebar-message">正在读取邮箱…</div>';
  try {
    const response = await api('/api/mailboxes');
    const payload = Array.isArray(response) ? { mailboxes: response } : response || {};
    state.allMailboxes = Array.isArray(payload.mailboxes) ? payload.mailboxes : [];
    const reportedAccounts = Array.isArray(payload.accounts) ? payload.accounts : [];
    state.accounts = [...new Set([...reportedAccounts, ...state.allMailboxes.map(item => item.account)])]
      .map(account => String(account || '').trim())
      .filter(Boolean);
    const preferredAccount = savedAccount();
    state.account = state.accounts.includes(preferredAccount) ? preferredAccount : state.accounts[0] || null;
    applyAccountFilter();
    renderAccountSelect();
    updateStatus(true, '已连接到 Apple Mail');
    if (!state.selectedMailbox || !state.mailboxes.some(item => mailboxKey(item) === mailboxKey(state.selectedMailbox))) {
      state.selectedMailbox = state.mailboxes.find(item => isInbox(item.name)) || state.mailboxes[0] || null;
    }
    if (!state.debugSession) $('#debugContext').textContent = `正在测试：${debugContextLabel()}`;
    renderMailboxes();
    if (state.selectedMailbox) await loadMessages();
    else $('#messageList').innerHTML = '<div class="empty-state"><span aria-hidden="true">▱</span><strong>没有可用文件夹</strong><p>当前账号没有找到收件箱或已发邮件。</p></div>';
  } catch (error) {
    updateStatus(false, '无法连接 Apple Mail');
    $('#mailboxList').innerHTML = '<div class="sidebar-message">未能读取邮箱</div>';
    $('#messageList').innerHTML = '<div class="empty-state"><strong>无法连接邮件</strong><p></p><button class="button" id="retryButton" type="button">重试</button></div>';
    $('#messageList p').textContent = error.message;
    $('#retryButton').addEventListener('click', loadMailboxes);
  }
}
function renderMailboxes() {
  const container = $('#mailboxList');
  container.replaceChildren();
  const priority = name => {
    const index = ['收件箱','Inbox','INBOX','已发送','已发邮件','Sent','草稿','Drafts','已归档','Archive','垃圾邮件','Junk','废纸篓','Trash'].findIndex(value => value.toLowerCase() === name.toLowerCase());
    return index < 0 ? 20 : index;
  };
  for (const mailbox of [...state.mailboxes].sort((a, b) => priority(a.name) - priority(b.name) || a.name.localeCompare(b.name))) {
    const button = document.createElement('button');
    button.className = 'mailbox-item';
    button.classList.toggle('active', state.selectedMailbox && mailboxKey(mailbox) === mailboxKey(state.selectedMailbox));
    button.type = 'button';
    button.title = mailbox.account + ' · ' + mailbox.name;
    const icon = document.createElement('span');
    icon.className = 'mailbox-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = isInbox(mailbox.name) ? '▤' : '↗';
    const labels = document.createElement('span');
    labels.className = 'mailbox-labels';
    const name = document.createElement('span');
    name.className = 'mailbox-name';
    name.textContent = mailbox.name;
    labels.append(name);
    const unread = document.createElement('span');
    unread.className = 'unread-count';
    unread.textContent = mailbox.unread ? String(mailbox.unread) : '';
    button.append(icon, labels, unread);
    button.addEventListener('click', async () => {
      if (mailboxKey(mailbox) === mailboxKey(state.selectedMailbox)) return;
      try { await stopDebugSessionForMailboxChange(); }
      catch (error) { showError(error.message); return; }
      state.selectedMailbox = mailbox;
      state.currentMessage = null;
      resetDebugUi();
      state.search = '';
      $('#searchInput').value = '';
      $('#detailPanel').classList.add('hidden');
      $('#listPanel').classList.remove('hidden');
      renderMailboxes();
      loadMessages();
    });
    container.append(button);
  }
}
function mailboxQuery(mailbox) {
  return new URLSearchParams({ account: mailbox.account, mailbox: mailbox.name }).toString();
}
function readPayload(mailbox, read) {
  return { account: mailbox.account, mailbox: mailbox.name, read };
}
function isRead(message) {
  return message?.read === true || message?.read === 'true';
}
function setReadState(message, read) {
  message.read = read;
  const row = state.messages.find(item => String(item.id) === String(message.id));
  if (row) row.read = read;
}
function decrementUnread(mailbox) {
  if (mailbox) mailbox.unread = Math.max(0, Number(mailbox.unread) || 0) - 1;
}
async function loadMessages() {
  if (!state.selectedMailbox) return;
  $('#folderTitle').textContent = state.selectedMailbox.name;
  $('#messageList').setAttribute('aria-busy', 'true');
  $('#messageList').innerHTML = '<div class="loading-state"><span class="spinner"></span><span>正在读取邮件…</span></div>';
  $('#resultCount').textContent = '';
  try {
    const result = await api('/api/messages?' + mailboxQuery(state.selectedMailbox));
    state.messages = result.messages || [];
    renderMessages();
    updateStatus(true, '已连接到 Apple Mail');
  } catch (error) {
    state.messages = [];
    $('#messageList').innerHTML = '<div class="empty-state"><strong>无法读取邮件</strong><p></p><button class="button" id="retryButton" type="button">重试</button></div>';
    $('#messageList p').textContent = error.message;
    $('#retryButton').addEventListener('click', loadMessages);
  } finally { $('#messageList').setAttribute('aria-busy', 'false'); }
}

function debugMessageElement(message) {
  if (!message) {
    const empty = document.createElement('div');
    empty.className = 'empty-debug';
    empty.textContent = '还没有发现测试邮件。';
    return empty;
  }
  const card = document.createElement('article');
  card.className = 'debug-message-card';
  card.classList.toggle('selected', String(state.selectedDebugMessage?.id) === String(message.id));
  const heading = document.createElement('div');
  heading.className = 'debug-message-heading';
  const subject = document.createElement('strong');
  subject.textContent = message.subject || '(无主题)';
  const status = document.createElement('span');
  status.className = 'debug-message-status';
  status.textContent = message.debugStatus === 'sent' ? '已发送' : message.debugStatus === 'generated' ? '已生成回复' : message.debugStatus === 'failed' ? '处理失败' : '待处理';
  heading.append(subject, status);
  const meta = document.createElement('div');
  meta.className = 'debug-message-meta';
  meta.textContent = [message.sender || '未知发件人', message.date || ''].filter(Boolean).join(' · ');
  const body = document.createElement('pre');
  body.className = 'debug-message-body';
  body.textContent = message.body || '';
  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'button debug-message-action';
  action.textContent = message.debugStatus === 'sent' ? '已发送' : String(state.selectedDebugMessage?.id) === String(message.id) ? '已选中' : '选择邮件';
  action.disabled = message.debugStatus === 'sent';
  action.setAttribute('aria-pressed', String(String(state.selectedDebugMessage?.id) === String(message.id)));
  action.addEventListener('click', () => selectDebugMessage(message));
  card.append(heading, meta, body, action);
  return card;
}
function renderDebugNew() {
  const container = $('#newDebugMessages');
  container.replaceChildren();
  if (!state.debugNew.length) { container.append(debugMessageElement(null)); return; }
  for (const message of state.debugNew) container.append(debugMessageElement(message));
}
function compareDebugMessages(left, right) {
  const dateCompare = String(left?.date || '').localeCompare(String(right?.date || ''));
  if (dateCompare) return dateCompare;
  try { return BigInt(String(left?.id || 0)) < BigInt(String(right?.id || 0)) ? -1 : BigInt(String(left?.id || 0)) > BigInt(String(right?.id || 0)) ? 1 : 0; }
  catch { return String(left?.id || '').localeCompare(String(right?.id || '')); }
}
async function startDebugSession() {
  if (!state.selectedMailbox) return debugLog('listen', '失败：请先从左侧选择邮箱文件夹。', 'error');
  const button = $('#startSessionButton');
  button.disabled = true;
  debugLog('listen', `开始请求监听游标：${debugContextLabel()}`);
  try {
    const session = await api('/api/debug/session', { method: 'POST', body: JSON.stringify({ account: state.selectedMailbox.account, mailbox: state.selectedMailbox.name }) });
    state.debugNew = [];
    state.selectedDebugMessage = null;
    setDebugSession(session);
    renderDebugNew();
    $('#replyEditor').classList.add('hidden');
    $('#replyEmpty').classList.remove('hidden');
    debugLog('listen', `监听已开始。游标：${session.cursor.date} / ID ${session.cursor.id}`);
  } catch (error) {
    debugLog('listen', `失败：${error.message}`, 'error');
    $('#listenStatus').textContent = '监听未开始，可查看下面日志后重试。';
  } finally { button.disabled = Boolean(state.debugSession); }
}
async function checkNewDebugMessages() {
  if (!state.selectedMailbox || !state.debugSession) return debugLog('check', '失败：请先开始监听新邮件。', 'error');
  const button = $('#checkNewButton');
  button.disabled = true;
  debugLog('check', `检查游标之后的新邮件：${state.debugSession.cursor.date} / ID ${state.debugSession.cursor.id}`);
  try {
    const result = await api('/api/debug/session/' + encodeURIComponent(state.debugSession.sessionId) + '/messages');
    const incoming = (result.messages || []).sort(compareDebugMessages);
    const existing = new Set(state.debugNew.map(message => String(message.id)));
    const fresh = incoming.filter(message => !existing.has(String(message.id)));
    state.debugNew.push(...fresh);
    state.debugNew.sort(compareDebugMessages);
    if (incoming.length) state.debugSession.cursor = { id: String(incoming[incoming.length - 1].id), date: incoming[incoming.length - 1].date };
    renderDebugNew();
    $('#checkStatus').textContent = fresh.length ? `找到 ${fresh.length} 封新邮件` : '没有新邮件；监听仍在等待。';
    debugLog('check', fresh.length ? `成功：找到 ${fresh.length} 封新邮件，游标已前移。` : '成功：没有新邮件，游标保持不变。');
  } catch (error) {
    $('#checkStatus').textContent = '检查失败，可直接重试。';
    debugLog('check', `失败：${error.message}`, 'error');
  } finally { button.disabled = false; }
}
function selectDebugMessage(message) {
  state.selectedDebugMessage = message;
  $('#replyEmpty').classList.add('hidden');
  $('#replyEditor').classList.remove('hidden');
  $('#replyMeta').textContent = [message.sender || '未知发件人', message.subject || '(无主题)'].join(' · ');
  $('#replyBody').value = message.reply || '';
  $('#replyStatus').textContent = message.debugStatus === 'sent' ? '已发送，不能重复发送' : message.debugStatus === 'failed' ? '处理失败，可以重试。' : message.debugStatus === 'generated' ? '回复已生成，可以编辑后发送。' : '已选择邮件，可以生成回复。';
  $('#sendReplyButton').disabled = message.debugStatus === 'sent';
  renderDebugNew();
  debugLog('reply', `已选择邮件：${message.subject || '(无主题)'}，ID ${message.id}`);
}
async function generateReply() {
  const message = state.selectedDebugMessage;
  if (!message || !state.selectedMailbox) return debugLog('reply', '失败：请先从新邮件列表选择一封邮件。', 'error');
  const button = $('#generateReplyButton');
  button.disabled = true;
  $('#replyStatus').textContent = '正在请求 AI 生成回复…';
  debugLog('reply', `开始生成回复：邮件 ID ${message.id}`);
  try {
    const result = await api('/api/debug/messages/' + encodeURIComponent(message.id) + '/generate-reply', { method: 'POST', body: JSON.stringify({ sessionId: state.debugSession?.sessionId, instructions: $('#replyInstructions').value.trim() }) });
    message.reply = result.reply || '';
    message.debugStatus = 'generated';
    $('#replyBody').value = message.reply;
    $('#replyMeta').textContent = [result.sender, result.subject].filter(Boolean).join(' · ');
    $('#replyStatus').textContent = '回复已生成，可以编辑后发送。';
    renderDebugNew();
    debugLog('reply', `成功：AI 已生成 ${message.reply.length} 个字符的回复。`);
  } catch (error) {
    message.debugStatus = 'failed';
    renderDebugNew();
    $('#replyStatus').textContent = '生成失败，可查看日志后重试。';
    debugLog('reply', `失败：${error.message}`, 'error');
  } finally { button.disabled = false; }
}
async function sendReply() {
  const message = state.selectedDebugMessage;
  if (!message || !state.selectedMailbox) return debugLog('reply', '失败：请选择邮件并填写回复正文。', 'error');
  if (message.debugStatus === 'sent') return debugLog('reply', `已跳过：邮件 ID ${message.id} 已发送过回复，避免重复发送。`, 'error');
  const button = $('#sendReplyButton');
  button.disabled = true;
  $('#replyStatus').textContent = '正在通过 Mail 发送回复…';
  debugLog('reply', `开始发送回复：邮件 ID ${message.id}`);
  try {
    let body = $('#replyBody').value.trim();
    if (!body) {
      const generated = await api('/api/debug/messages/' + encodeURIComponent(message.id) + '/generate-reply', { method: 'POST', body: JSON.stringify({ sessionId: state.debugSession?.sessionId, instructions: $('#replyInstructions').value.trim() }) });
      body = String(generated.reply || '').trim();
      $('#replyBody').value = body;
      message.reply = body;
      message.debugStatus = 'generated';
    }
    if (!body) throw new Error('回复正文不能为空');
    await api('/api/debug/messages/' + encodeURIComponent(message.id) + '/send-reply', { method: 'POST', body: JSON.stringify({ sessionId: state.debugSession?.sessionId, body }) });
    message.reply = body;
    message.debugStatus = 'sent';
    $('#replyStatus').textContent = '已发送，不能重复发送';
    renderDebugNew();
    debugLog('reply', `成功：邮件 ID ${message.id} 已发送回复。`);
  } catch (error) {
    message.debugStatus = 'failed';
    renderDebugNew();
    $('#replyStatus').textContent = '发送失败，可以修正后重试。';
    debugLog('reply', `失败：${error.message}`, 'error');
  } finally { button.disabled = false; }
}
async function loadSettings() {
  try {
    const settings = await api('/api/settings');
    $('#apiEndpoint').value = settings.endpoint || '';
    $('#apiModel').value = settings.model || '';
    $('#autoCheckSeconds').value = settings.autoCheckSeconds ?? 600;
    $('#autoRestartSeconds').value = settings.autoRestartSeconds ?? 86400;
    state.settingsHasKey = Boolean(settings.hasApiKey);
    $('#apiKey').placeholder = state.settingsHasKey ? '已保存密钥，留空表示保持不变' : '输入密钥以保存';
  } catch (error) { $('#settingsStatus').textContent = error.message; }
}
async function saveSettings(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const payload = { endpoint: $('#apiEndpoint').value.trim(), model: $('#apiModel').value.trim(), apiKey: $('#apiKey').value.trim(), autoCheckSeconds: Number($('#autoCheckSeconds').value), autoRestartSeconds: Number($('#autoRestartSeconds').value) };
    const result = await api('/api/settings', { method: 'PUT', body: JSON.stringify(payload) });
    state.settingsHasKey = Boolean(result.hasApiKey);
    $('#apiKey').value = '';
    $('#apiKey').placeholder = state.settingsHasKey ? '已保存密钥，留空表示保持不变' : '输入密钥以保存';
    $('#settingsStatus').textContent = '连接设置已保存';
  } catch (error) { $('#settingsStatus').textContent = error.message; }
  finally { button.disabled = false; }
}
function renderAutomationStatus(status) {
  const running = Boolean(status?.running);
  $('#startAutoButton').disabled = running || !state.selectedMailbox;
  $('#stopAutoButton').disabled = !running;
  $('#autoContext').textContent = running ? `正在监听：${status.account} / ${status.mailbox}` : `待监听：${debugContextLabel()}`;
  $('#autoStatus').textContent = running
    ? `运行中 · 启动于 ${status.startedAt || ''} · 最近检查 ${status.lastCheckAt || '等待首次检查'}${status.lastError ? ` · 最近错误：${status.lastError}` : ''}`
    : '自动运行未启动';
}
async function refreshAutomationLogs() {
  try {
    const [status, result] = await Promise.all([api('/api/automation'), api('/api/automation/logs?limit=500')]);
    renderAutomationStatus(status);
    const events = (result.logs || []).filter(entry => String(entry.event || '').startsWith('automation.'));
    $('#autoLog').textContent = events.length ? events.map(entry => JSON.stringify(entry)).join('\n') : '等待自动运行日志。';
    $('#autoLog').scrollTop = $('#autoLog').scrollHeight;
  } catch (error) { $('#autoStatus').textContent = error.message; }
}
async function startAutomation() {
  if (!state.selectedMailbox) return;
  $('#startAutoButton').disabled = true;
  $('#autoStatus').textContent = '正在启动自动回复…';
  try {
    const status = await api('/api/automation/start', { method: 'POST', body: JSON.stringify({ account: state.selectedMailbox.account, mailbox: state.selectedMailbox.name }) });
    renderAutomationStatus(status);
    await refreshAutomationLogs();
  } catch (error) { $('#autoStatus').textContent = error.message; $('#startAutoButton').disabled = false; }
}
async function stopAutomation() {
  $('#stopAutoButton').disabled = true;
  try {
    renderAutomationStatus(await api('/api/automation/stop', { method: 'POST' }));
    await refreshAutomationLogs();
  } catch (error) { $('#autoStatus').textContent = error.message; $('#stopAutoButton').disabled = false; }
}
async function testSettingsConnection() {
  const button = $('#testConnectionButton');
  button.disabled = true;
  $('#settingsStatus').textContent = '正在测试连接…';
  try { await api('/api/settings/test', { method: 'POST' }); $('#settingsStatus').textContent = '连接测试成功'; }
  catch (error) { $('#settingsStatus').textContent = error.message; }
  finally { button.disabled = false; }
}
function renderMessages() {
  const query = state.search.trim().toLocaleLowerCase();
  const filtered = state.messages.filter(message => !query || [message.sender, message.subject].join(' ').toLocaleLowerCase().includes(query));
  const container = $('#messageList');
  container.replaceChildren();
  $('#resultCount').textContent = filtered.length ? filtered.length + ' 封' : '';
  if (!filtered.length) {
    const label = query ? '没有匹配的邮件' : '文件夹是空的';
    const note = query ? '试试其他关键词。' : '这个文件夹里暂时没有邮件。';
    container.innerHTML = '<div class="empty-state"><span aria-hidden="true">' + (query ? '⌕' : '✓') + '</span><strong>' + label + '</strong><p>' + note + '</p></div>';
    return;
  }
  for (const message of filtered) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'message-row';
    row.classList.toggle('unread', !isRead(message));
    row.classList.toggle('selected', state.currentMessage && String(state.currentMessage.id) === String(message.id));
    const sender = document.createElement('span');
    sender.className = 'message-sender';
    sender.textContent = message.sender || '未知发件人';
    const date = document.createElement('time');
    date.className = 'message-date';
    date.textContent = formatDate(message.date);
    const subject = document.createElement('span');
    subject.className = 'message-subject';
    subject.textContent = message.subject || '(无主题)';
    const status = document.createElement('span');
    status.className = 'message-status';
    status.setAttribute('aria-label', message.flagged ? '已加旗标' : '');
    status.textContent = message.flagged ? '⚑' : '';
    row.append(sender, date, subject, status);
    row.addEventListener('click', () => openMessage(message));
    container.append(row);
  }
}
function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || '';
  const sameDay = date.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat('zh-CN', sameDay ? { hour: 'numeric', minute: '2-digit' } : { month: 'numeric', day: 'numeric' }).format(date);
}
async function openMessage(message) {
  const requestId = ++state.openRequest;
  const mailbox = state.selectedMailbox;
  state.currentMessage = message;
  $('#messageList').setAttribute('aria-busy', 'true');
  try {
    const detail = await api('/api/messages/' + encodeURIComponent(message.id) + '?' + mailboxQuery(mailbox));
    if (requestId !== state.openRequest || mailboxKey(mailbox) !== mailboxKey(state.selectedMailbox)) return;
    state.currentMessage = detail;
    const detailWasRead = isRead(detail);
    if (!detailWasRead) {
      await api('/api/messages/' + encodeURIComponent(message.id) + '/read', { method: 'POST', body: JSON.stringify(readPayload(mailbox, true)) });
      if (requestId !== state.openRequest || mailboxKey(mailbox) !== mailboxKey(state.selectedMailbox)) return;
    }
    const listMailbox = state.mailboxes.find(item => mailboxKey(item) === mailboxKey(mailbox));
    if (!isRead(message) || !detailWasRead) decrementUnread(listMailbox);
    setReadState(message, true);
    detail.read = true;
    renderMailboxes();
    renderDetail(detail);
    $('#listPanel').classList.add('hidden');
    $('#detailPanel').classList.remove('hidden');
  } catch (error) {
    if (requestId === state.openRequest) showError(error.message);
  } finally {
    if (requestId === state.openRequest) $('#messageList').setAttribute('aria-busy', 'false');
  }
}
function renderDetail(message) {
  const article = $('#messageDetail');
  article.replaceChildren();
  const heading = document.createElement('h1');
  heading.className = 'detail-subject';
  heading.textContent = message.subject || '(无主题)';
  const metadata = document.createElement('div');
  metadata.className = 'detail-metadata';
  const sender = document.createElement('strong');
  sender.textContent = message.sender || '未知发件人';
  const date = document.createElement('time');
  date.textContent = message.date || '';
  metadata.append(sender, date);
  const body = document.createElement('pre');
  body.className = 'detail-body';
  body.textContent = message.body || '';
  article.append(heading, metadata, body);
  $('#markUnreadButton').textContent = isRead(message) ? '标为未读' : '标为已读';
}
async function toggleRead() {
  const message = state.currentMessage;
  if (!message || !state.selectedMailbox) return;
  const read = !isRead(message);
  try {
    await api('/api/messages/' + encodeURIComponent(message.id) + '/read', { method: 'POST', body: JSON.stringify(readPayload(state.selectedMailbox, read)) });
    setReadState(message, read);
    const mailbox = state.mailboxes.find(item => mailboxKey(item) === mailboxKey(state.selectedMailbox));
    if (mailbox) mailbox.unread = Math.max(0, Number(mailbox.unread) || 0) + (read ? -1 : 1);
    renderDetail(message);
    renderMailboxes();
  } catch (error) { showError(error.message); }
}
$('#refreshButton').addEventListener('click', loadMailboxes);
$('#accountSelect').addEventListener('change', async event => {
  try { await stopDebugSessionForMailboxChange(); }
  catch (error) {
    event.target.value = state.account;
    showError(error.message);
    return;
  }
  state.account = event.target.value;
  saveAccount(state.account);
  state.selectedMailbox = null;
  state.currentMessage = null;
  resetDebugUi();
  state.search = '';
  $('#searchInput').value = '';
  $('#detailPanel').classList.add('hidden');
  $('#listPanel').classList.remove('hidden');
  applyAccountFilter();
  state.selectedMailbox = state.mailboxes.find(item => isInbox(item.name)) || state.mailboxes[0] || null;
  renderMailboxes();
  if (state.selectedMailbox) await loadMessages();
  else $('#messageList').innerHTML = '<div class="empty-state"><span aria-hidden="true">▱</span><strong>没有可用文件夹</strong><p>当前账号没有找到收件箱或已发邮件。</p></div>';
});
$('#backButton').addEventListener('click', () => {
  $('#detailPanel').classList.add('hidden');
  $('#listPanel').classList.remove('hidden');
  state.currentMessage = null;
  renderMessages();
});
$('#markUnreadButton').addEventListener('click', toggleRead);
$('#searchInput').addEventListener('input', event => { state.search = event.target.value; renderMessages(); });
$('#dismissError').addEventListener('click', () => $('#errorToast').classList.add('hidden'));
$('#composeButton').addEventListener('click', () => {
  $('#composeStatus').textContent = '';
  $('#composeDialog').showModal();
  $('#composeForm').elements.to.focus();
});
$('#closeCompose').addEventListener('click', () => $('#composeDialog').close());
$('#composeDialog').addEventListener('click', event => { if (event.target === $('#composeDialog')) $('#composeDialog').close(); });
$('#composeForm').addEventListener('submit', async event => {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
  const button = $('#sendButton');
  button.disabled = true;
  $('#composeStatus').textContent = '正在通过 Mail 发送…';
  try {
    await api('/api/send', { method: 'POST', body: JSON.stringify(payload) });
    $('#composeDialog').close();
    event.currentTarget.reset();
    showError('邮件已交由 Mail 发送');
    setTimeout(() => $('#errorToast').classList.add('hidden'), 2600);
  } catch (error) { $('#composeStatus').textContent = error.message; }
  finally { button.disabled = false; }
});

for (const tab of document.querySelectorAll('.automation-tab')) {
  tab.addEventListener('click', () => {
    for (const candidate of document.querySelectorAll('.automation-tab')) {
      const active = candidate === tab;
      candidate.classList.toggle('active', active);
      candidate.setAttribute('aria-selected', String(active));
    }
    for (const pane of document.querySelectorAll('.automation-pane')) pane.classList.toggle('hidden', pane.id !== tab.getAttribute('aria-controls'));
  });
}
$('#startSessionButton').addEventListener('click', startDebugSession);
$('#checkNewButton').addEventListener('click', checkNewDebugMessages);
$('#resetSessionButton').addEventListener('click', async () => {
  if (!state.debugSession || !window.confirm('停止监听并清空当前测试会话、已发现邮件及回复数据？')) return;
  const button = $('#resetSessionButton');
  button.disabled = true;
  try {
    await api('/api/debug/session/' + encodeURIComponent(state.debugSession.sessionId), { method: 'DELETE' });
    resetDebugUi();
  } catch (error) {
    button.disabled = false;
    showError(error.message);
  }
});
$('#generateReplyButton').addEventListener('click', generateReply);
$('#sendReplyButton').addEventListener('click', sendReply);
$('#settingsForm').addEventListener('submit', saveSettings);
$('#testConnectionButton').addEventListener('click', testSettingsConnection);
$('#startAutoButton').addEventListener('click', startAutomation);
$('#stopAutoButton').addEventListener('click', stopAutomation);
$('#refreshAutoLogs').addEventListener('click', refreshAutomationLogs);
$('#toggleApiKey').addEventListener('click', () => {
  const input = $('#apiKey');
  const visible = input.type === 'text';
  input.type = visible ? 'password' : 'text';
  $('#toggleApiKey').setAttribute('aria-label', visible ? '显示 API 密钥' : '隐藏 API 密钥');
});
loadSettings();
loadMailboxes();
refreshAutomationLogs();
setInterval(refreshAutomationLogs, 2000);
