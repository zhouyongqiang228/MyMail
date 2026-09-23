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
