const state = { allMailboxes: [], mailboxes: [], accounts: [], account: null, selectedMailbox: null, messages: [], currentMessage: null, search: '', openRequest: 0 };
const $ = selector => document.querySelector(selector);
const isInbox = name => /^(inbox|收件箱)$/i.test(String(name || '').trim());
const isSent = name => /^(sent|sent messages|已发邮件|已发送)$/i.test(String(name || '').trim());

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  let data;
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) throw new Error(data.error || '请求失败，请重试');
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
  select.disabled = state.accounts.length < 2;
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
    state.allMailboxes = Array.isArray(response) ? response : response.mailboxes || [];
    state.accounts = [...new Set(state.allMailboxes.map(item => item.account).filter(Boolean))];
    const preferredAccount = savedAccount();
    state.account = state.accounts.includes(preferredAccount) ? preferredAccount : state.accounts[0] || null;
    applyAccountFilter();
    renderAccountSelect();
    updateStatus(true, '已连接到 Apple Mail');
    if (!state.selectedMailbox || !state.mailboxes.some(item => mailboxKey(item) === mailboxKey(state.selectedMailbox))) {
      state.selectedMailbox = state.mailboxes.find(item => isInbox(item.name)) || state.mailboxes[0] || null;
    }
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
    button.addEventListener('click', () => {
      state.selectedMailbox = mailbox;
      state.currentMessage = null;
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
  state.account = event.target.value;
  saveAccount(state.account);
  state.selectedMailbox = null;
  state.currentMessage = null;
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
loadMailboxes();
