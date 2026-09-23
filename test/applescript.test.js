import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appleString, mailboxListScript, markReadScript, messageDetailScript, messageListScript,
  sendMessageScript,
} from '../lib/applescript.js';

test('AppleScript text arguments keep quotes and line breaks inside literals', () => {
  const expression = appleString('a"b\\c\nnext');
  assert.match(expression, /\\"/);
  assert.match(expression, /linefeed/);
  assert.doesNotMatch(expression, /\nnext/);
});

test('message lookup only accepts numeric Mail IDs and mailbox values stay quoted', () => {
  assert.throws(() => messageDetailScript({ account: 'Personal', mailbox: 'Inbox', id: '1; do shell script "bad"' }), /无效的邮件编号/);
  const largeID = messageDetailScript({ account: 'Personal', mailbox: 'Inbox', id: '9007199254740993' });
  assert.match(largeID, /whose id is 9007199254740993/);
  const script = messageListScript({ account: 'x"\non run', mailbox: 'Inbox" & do shell script "bad' });
  assert.match(script, /targetAccount to first account whose name is/);
  assert.match(script, /linefeed/);
  assert.match(script, /targetMailbox to first mailbox/);
});

test('send script includes optional recipients and escapes body content', () => {
  const script = sendMessageScript({
    to: 'reader@example.test, second@example.test', cc: 'copy@example.test', bcc: '',
    subject: 'Hello', body: 'First line\n"send"',
  });
  assert.match(script, /make new to recipient/);
  assert.match(script, /make new cc recipient/);
  assert.match(script, /linefeed/);
  assert.match(script, /send\n  end tell/);
  assert.doesNotMatch(script, /First line\n"send"/);
});

test('scripts query the selected mailbox and mark read state explicitly', () => {
  assert.match(mailboxListScript(), /mailboxes of accountRef/);
  assert.match(messageListScript({ account: 'Personal', mailbox: 'Inbox' }), /flagged status/);
  assert.match(messageListScript({ account: 'Personal', mailbox: 'Inbox' }), /isoDate/);
  assert.match(markReadScript({ account: 'Personal', mailbox: 'Inbox', id: 25, read: false }), /set read status of messageRef to false/);
});
