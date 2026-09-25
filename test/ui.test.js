import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const script = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
const message = { id: '42', sender: 'Lin <lin@example.test>', subject: '周末安排', date: '2026-09-23T01:00:00Z', read: false, flagged: true };
const detail = { ...message, body: '你好\n周末见。' };

async function makeApp(t, { detailData = detail, mailboxData } = {}) {
  const dom = new JSDOM(html, { url: 'http://localhost:3001', runScripts: 'outside-only' });
  const calls = [];
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  dom.window.confirm = () => true;
  dom.window.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (url === '/api/mailboxes') return result(mailboxData || { mailboxes: [
      { account: 'Personal', name: 'Inbox', unread: 1 },
      { account: 'Personal', name: 'Sent', unread: 0 },
      { account: 'Personal', name: 'Drafts', unread: 0 },
      { account: 'Work', name: 'INBOX', unread: 2 },
      { account: 'Work', name: '已发邮件', unread: 0 },
    ] });
    if (String(url).startsWith('/api/messages?')) return result({ messages: [message] });
    if (String(url).startsWith('/api/messages/42/read')) return result({ ok: true });
    if (String(url).startsWith('/api/messages/42?')) return result(detailData);
    if (url === '/api/debug/session' && options.method === 'POST') return result({ sessionId: 'session-1', cursor: { id: '8', date: '2026-09-24T01:00:00' }, startedAt: '2026-09-24T01:00:00.000Z' });
    if (url === '/api/debug/session/session-1/messages') return result({ messages: [{ id: '9', sender: 'Person <person@example.test>', subject: '借钱', date: '2026-09-24T02:00:00', body: '可以借我一些钱吗？', debugStatus: 'pending' }] });
    if (url === '/api/debug/session/session-1' && options.method === 'DELETE') return result({ ok: true });
    if (url === '/api/debug/messages/9/generate-reply') return result({ id: '9', sender: 'Person <person@example.test>', subject: '借钱', reply: '抱歉，我目前不方便借钱。' });
    if (url === '/api/send') return result({ ok: true });
    return result({ error: 'not found' }, 404);
  };
  const ctx = dom.getInternalVMContext();
  vm.runInContext(script, ctx);
  t.after(() => dom.window.close());
  await settle();
  return { dom, calls, document: dom.window.document };
}
function result(body, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

test('connects to Apple Mail and lists real mailboxes without demo messages', async t => {
  const app = await makeApp(t);
  assert.equal(app.document.querySelector('#statusText').textContent, '已连接到 Apple Mail');
  assert.deepEqual([...app.document.querySelectorAll('.mailbox-name')].map(item => item.textContent), ['Inbox', 'Sent']);
  assert.equal(app.document.querySelectorAll('.message-row').length, 1);
  assert.equal(app.document.querySelector('.message-subject').textContent, '周末安排');
  assert.ok(app.calls.some(call => call.url === '/api/mailboxes'));
  assert.doesNotMatch(script, /demoMessages|alex@example\.com|连接 Gmail/);
});

test('defaults to the first account and lets the user switch the two visible folders', async t => {
  const app = await makeApp(t);
  const accountSelect = app.document.querySelector('#accountSelect');
  assert.deepEqual([...accountSelect.options].map(option => option.value), ['Personal', 'Work']);
  assert.deepEqual([...app.document.querySelectorAll('.mailbox-name')].map(item => item.textContent), ['Inbox', 'Sent']);

  accountSelect.value = 'Work';
  accountSelect.dispatchEvent(new app.dom.window.Event('change', { bubbles: true }));
  await settle();
  assert.deepEqual([...app.document.querySelectorAll('.mailbox-name')].map(item => item.textContent), ['INBOX', '已发邮件']);
  assert.ok(app.calls.some(call => call.url.includes('account=Work')));
});

test('keeps an account with no folders in the account switcher', async t => {
  const app = await makeApp(t, { mailboxData: {
    accounts: ['Personal', 'Work'],
    mailboxes: [{ account: 'Work', name: 'INBOX', unread: 2 }, { account: 'Work', name: '已发邮件', unread: 0 }],
  } });
  const accountSelect = app.document.querySelector('#accountSelect');
  assert.equal(accountSelect.disabled, false);
  assert.deepEqual([...accountSelect.options].map(option => option.value), ['Personal', 'Work']);
  accountSelect.value = 'Work';
  accountSelect.dispatchEvent(new app.dom.window.Event('change', { bubbles: true }));
  await settle();
  assert.equal(app.document.querySelector('#folderTitle').textContent, 'INBOX');
  assert.ok(app.calls.some(call => call.url.includes('account=Work')));
});

test('filters loaded messages and opens a detail with a read action', async t => {
  const app = await makeApp(t);
  app.document.querySelector('#searchInput').value = '周末';
  app.document.querySelector('#searchInput').dispatchEvent(new app.dom.window.Event('input', { bubbles: true }));
  assert.equal(app.document.querySelectorAll('.message-row').length, 1);
  app.document.querySelector('.message-row').click();
  await settle();
  assert.equal(app.document.querySelector('#detailPanel').classList.contains('hidden'), false);
  assert.equal(app.document.querySelector('.detail-body').textContent, detail.body);
  assert.equal(app.document.querySelector('#markUnreadButton').textContent, '标为未读');
  assert.ok(app.calls.some(call => call.url.startsWith('/api/messages/42?')));
  const readUpdate = app.calls.find(call => call.url.startsWith('/api/messages/42/read'));
  assert.deepEqual(JSON.parse(readUpdate.options.body), { account: 'Personal', mailbox: 'Inbox', read: true });
});

test('opening a message reconciles a stale unread row with an already-read detail', async t => {
  const app = await makeApp(t, { detailData: { ...detail, read: true } });
  app.document.querySelector('.message-row').click();
  await settle();
  assert.equal(app.calls.some(call => call.url.startsWith('/api/messages/42/read')), false);
  app.document.querySelector('#backButton').click();
  assert.equal(app.document.querySelector('.message-row').classList.contains('unread'), false);
});

test('stopping a debug session deletes its server data and clears the test panel', async t => {
  const app = await makeApp(t);
  const stopButton = app.document.querySelector('#resetSessionButton');
  assert.equal(stopButton.textContent, '停止监听并清空数据');
  app.document.querySelector('#startSessionButton').click();
  await settle();
  assert.equal(stopButton.disabled, false);
  assert.equal(app.document.querySelector('#startSessionButton').disabled, true);
  stopButton.click();
  await settle();
  assert.ok(app.calls.some(call => call.url === '/api/debug/session/session-1' && call.options.method === 'DELETE'));
  assert.equal(stopButton.disabled, true);
  assert.equal(app.document.querySelector('#startSessionButton').disabled, false);
  assert.equal(app.document.querySelector('#listenStatus').textContent, '尚未开始测试会话');
  assert.equal(app.document.querySelector('#listenLog').textContent, '等待操作。');
  assert.equal(app.document.querySelector('.empty-debug').textContent, '还没有发现测试邮件。');
});

test('switching mailboxes stops and removes the previous debug session', async t => {
  const app = await makeApp(t);
  app.document.querySelector('#startSessionButton').click();
  await settle();
  app.document.querySelectorAll('.mailbox-item')[1].click();
  await settle();
  const deletion = app.calls.findIndex(call => call.url === '/api/debug/session/session-1' && call.options.method === 'DELETE');
  const switchedMailbox = app.calls.findIndex(call => call.url.includes('mailbox=Sent'));
  assert.ok(deletion >= 0);
  assert.ok(switchedMailbox > deletion);
  assert.equal(app.document.querySelector('#listenStatus').textContent, '尚未开始测试会话');
  assert.equal(app.document.querySelector('#debugContext').textContent, '正在测试：Personal / Sent');
});

test('selecting a discovered email opens the editor and reply instructions reach generation', async t => {
  const app = await makeApp(t);
  app.document.querySelector('#startSessionButton').click();
  await settle();
  app.document.querySelector('#checkNewButton').click();
  await settle();
  const selectButton = app.document.querySelector('.debug-message-action');
  assert.equal(selectButton.textContent, '选择邮件');
  selectButton.click();
  assert.equal(app.document.querySelector('#replyEditor').classList.contains('hidden'), false);
  assert.equal(app.document.querySelector('.debug-message-action').textContent, '已选中');
  app.document.querySelector('#replyInstructions').value = '如果对方借钱，请礼貌但明确地拒绝。';
  app.document.querySelector('#generateReplyButton').click();
  await settle();
  const generation = app.calls.find(call => call.url === '/api/debug/messages/9/generate-reply');
  assert.deepEqual(JSON.parse(generation.options.body), { sessionId: 'session-1', instructions: '如果对方借钱，请礼貌但明确地拒绝。' });
  assert.equal(app.document.querySelector('#replyBody').value, '抱歉，我目前不方便借钱。');
});

test('compose form sends through the local Mail API', async t => {
  const app = await makeApp(t);
  app.document.querySelector('#composeButton').click();
  const form = app.document.querySelector('#composeForm');
  form.elements.to.value = 'reader@example.test';
  form.elements.subject.value = '问候';
  form.elements.body.value = '你好';
  form.dispatchEvent(new app.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  const send = app.calls.find(call => call.url === '/api/send');
  assert.ok(send);
  assert.deepEqual(JSON.parse(send.options.body), { to: 'reader@example.test', cc: '', bcc: '', subject: '问候', body: '你好' });
});

test('debug session shows the full server failure details', async t => {
  const app = await makeApp(t);
  app.dom.window.fetch = async () => result({
    error: '无法开始监听新邮件',
    reason: 'Not authorized to send Apple events to Mail (-1743)',
    possibleCauses: ['请在系统设置中允许自动化'],
    requestId: 'abcd1234',
  }, 502);
  app.document.querySelector('#startSessionButton').click();
  await settle();
  const message = app.document.querySelector('#listenLog').textContent;
  assert.match(message, /Not authorized/);
  assert.match(message, /自动化/);
  assert.match(message, /abcd1234/);
});
