import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appleString, latestCursorScript, latestMessageScript, mailboxListScript, markReadScript, messageDetailScript, messageListScript,
  messagesAfterScript,
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

test('debug scripts find the true latest message and advance from a cursor in AppleScript', () => {
  const latest = latestMessageScript({ account: 'Personal', mailbox: 'Inbox' });
  assert.match(latest, /date received of candidate/);
  assert.match(latest, /decimalGreater/);
  assert.match(latest, /content of latestMessage/);
  const next = messagesAfterScript({ account: 'Personal', mailbox: 'Inbox', afterDate: '2026-09-23T01:00:00', afterId: '9007199254740993' });
  assert.match(next, /set candidateRows to \{\}/);
  assert.match(next, /decimalGreater\(candidateID, cursorID\)/);
  const outputRow = next.slice(next.indexOf('set end of rows to'), next.indexOf('\n', next.indexOf('set end of rows to')));
  assert.ok(outputRow.includes('\\\"id\\\":'));
  assert.match(next, /if candidateDate < cursorDate then exit repeat/);
  assert.match(next, /set item 3 of item nextIndex of candidateRows to missing value/);
  assert.throws(() => messagesAfterScript({ account: 'Personal', mailbox: 'Inbox', afterDate: 'invalid', afterId: '1' }), /无效的监听起点日期/);
});

test('listener cursor reads only the newest message instead of scanning the mailbox', () => {
  const script = latestCursorScript({ account: 'Personal', mailbox: 'Inbox' });
  assert.match(script, /set latestMessage to item 1 of allMessages/);
  assert.match(script, /date received of latestMessage/);
  assert.doesNotMatch(script, /repeat with candidate in allMessages/);
});
