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

async function makeApp(t) {
  const dom = new JSDOM(html, { url: 'http://localhost:3001', runScripts: 'outside-only' });
  const calls = [];
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  dom.window.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (url === '/api/mailboxes') return result({ mailboxes: [
      { account: 'Personal', name: 'Inbox', unread: 1 },
      { account: 'Personal', name: 'Sent', unread: 0 },
      { account: 'Personal', name: 'Drafts', unread: 0 },
      { account: 'Work', name: 'INBOX', unread: 2 },
      { account: 'Work', name: '已发邮件', unread: 0 },
    ] });
    if (String(url).startsWith('/api/messages?')) return result({ messages: [message] });
    if (String(url).startsWith('/api/messages/42/read')) return result({ ok: true });
    if (String(url).startsWith('/api/messages/42?')) return result(detail);
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
