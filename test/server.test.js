import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../server.js';

test('Mail API exposes mailbox data and routes message actions through AppleScript', async t => {
  const scripts = [];
  const app = createApp({
    runScript: async script => {
      scripts.push(script);
      if (script.includes('return name')) return 'Mail';
      if (script.includes('set allMessages to messages')) return JSON.stringify([{ id: '7', subject: 'Hello', read: false }]);
      if (script.includes('set rows to {}')) return JSON.stringify([{ account: 'Personal', name: 'Inbox', unread: 2 }]);
      if (script.includes('set messageBody to content')) return JSON.stringify({ id: '7', body: 'Body' });
      return 'ok';
    },
  });
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;

  const status = await fetch(base + '/api/status').then(response => response.json());
  assert.deepEqual(status, { available: true, name: 'Mail' });
  const boxes = await fetch(base + '/api/mailboxes').then(response => response.json());
  assert.equal(boxes[0].name, 'Inbox');
  const query = new URLSearchParams({ account: 'Personal', mailbox: 'Inbox' });
  const messages = await fetch(base + '/api/messages?' + query).then(response => response.json());
  assert.equal(messages.messages[0].id, '7');
  const detail = await fetch(base + '/api/messages/7?' + query).then(response => response.json());
  assert.equal(detail.body, 'Body');

  const invalid = await fetch(base + '/api/messages/7/read', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: 'Personal', mailbox: 'Inbox', read: 'yes' }),
  });
  assert.equal(invalid.status, 400);
  const sent = await fetch(base + '/api/send', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: 'person@example.test', subject: 'Hello', body: 'Text' }),
  });
  assert.equal(sent.status, 200);
  assert.ok(scripts.some(script => script.includes('make new outgoing message')));
  assert.ok(scripts.some(script => script.includes('unread count of mailboxRef')));
});

test('starting a debug session exposes Apple Mail failures without creating a session', async t => {
  const app = createApp({
    runScript: async () => {
      const error = new Error('Not authorized to send Apple events to Mail (-1743)');
      error.code = 'OSASCRIPT_EXIT_1';
      throw error;
    },
  });
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const query = new URLSearchParams({ account: 'Personal', mailbox: 'Inbox' });
  const response = await fetch(base + '/api/debug/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: 'Personal', mailbox: 'Inbox' }) });
  const body = await response.json();
  assert.equal(response.status, 502);
  assert.equal(body.error, '无法开始监听新邮件');
  assert.match(body.reason, /Not authorized/);
  assert.equal(body.code, 'OSASCRIPT_EXIT_1');
  assert.match(body.requestId, /^[a-f0-9]{8}$/);
  assert.match(body.possibleCauses[0], /自动化/);
});

test('debug session lookup delegates filtering to AppleScript', async t => {
  const scripts = [];
  const app = createApp({
    runScript: async script => {
      scripts.push(script);
      if (script.includes('set candidateRows to {}')) return JSON.stringify([{ id: '9', date: '2026-09-24T02:00:00', body: 'new' }]);
      if (script.includes('set messageBody to content')) return JSON.stringify({ id: '9', date: '2026-09-24T02:00:00', body: 'new' });
      return JSON.stringify({ id: '8', date: '2026-09-24T01:00:00', body: 'baseline' });
    },
  });
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const mailbox = new URLSearchParams({ account: 'Personal', mailbox: 'Inbox' });

  const session = await fetch(base + '/api/debug/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: 'Personal', mailbox: 'Inbox' }) }).then(response => response.json());
  const result = await fetch(base + '/api/debug/session/' + session.sessionId + '/messages').then(response => response.json());
  assert.equal(result.messages[0].id, '9');
  assert.ok(scripts.some(script => script.includes('set candidateRows to {}')));
});

test('debug test sessions keep discovered messages and reject duplicate sends', async t => {
  const scripts = [];
  const app = createApp({
    runScript: async script => {
      scripts.push(script);
      if (script.includes('set latestMessage to item 1')) return JSON.stringify({ id: '8', date: '2026-09-24T01:00:00' });
      if (script.includes('set candidateRows to {}')) return JSON.stringify([{ id: '9', date: '2026-09-24T02:00:00', sender: 'person@example.test', subject: 'Test' }]);
      if (script.includes('set messageBody to content')) return JSON.stringify({ id: '9', date: '2026-09-24T02:00:00', sender: 'person@example.test', subject: 'Test', body: 'Hello' });
      return 'ok';
    },
  });
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const json = { headers: { 'Content-Type': 'application/json' } };
  const sessionResponse = await fetch(base + '/api/debug/session', { ...json, method: 'POST', body: JSON.stringify({ account: 'Personal', mailbox: 'Inbox' }) });
  const session = await sessionResponse.json();
  assert.equal(sessionResponse.status, 200);
  const messagesResponse = await fetch(base + '/api/debug/session/' + session.sessionId + '/messages');
  const messages = await messagesResponse.json();
  assert.equal(messages.messages[0].body, 'Hello');
  const sent = await fetch(base + '/api/debug/messages/9/send-reply', { ...json, method: 'POST', body: JSON.stringify({ sessionId: session.sessionId, body: 'Thanks' }) });
  assert.equal(sent.status, 200);
  const duplicate = await fetch(base + '/api/debug/messages/9/send-reply', { ...json, method: 'POST', body: JSON.stringify({ sessionId: session.sessionId, body: 'Again' }) });
  assert.equal(duplicate.status, 409);
  assert.ok(scripts.some(script => script.includes('set candidateRows to {}')));
  const stopped = await fetch(base + '/api/debug/session/' + session.sessionId, { method: 'DELETE' });
  assert.deepEqual(await stopped.json(), { ok: true });
  const clearedMessages = await fetch(base + '/api/debug/session/' + session.sessionId + '/messages');
  assert.equal(clearedMessages.status, 404);
  const clearedSend = await fetch(base + '/api/debug/messages/9/send-reply', { ...json, method: 'POST', body: JSON.stringify({ sessionId: session.sessionId, body: 'Again' }) });
  assert.equal(clearedSend.status, 404);
});
