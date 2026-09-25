import { spawn } from 'node:child_process';

const jsonHandlers = String.raw`
on replaceText(findText, replacementText, sourceText)
  set savedDelimiters to AppleScript's text item delimiters
  set AppleScript's text item delimiters to findText
  set textParts to every text item of sourceText
  set AppleScript's text item delimiters to replacementText
  set resultText to textParts as text
  set AppleScript's text item delimiters to savedDelimiters
  return resultText
end replaceText

on jsonString(sourceValue)
  set textValue to sourceValue as text
  set slash to character id 92
  set quoteMark to character id 34
  set textValue to my replaceText(slash, slash & slash, textValue)
  set textValue to my replaceText(quoteMark, slash & quoteMark, textValue)
  set textValue to my replaceText(return, slash & "r", textValue)
  set textValue to my replaceText(linefeed, slash & "n", textValue)
  set textValue to my replaceText(tab, slash & "t", textValue)
  return quoteMark & textValue & quoteMark
end jsonString

on paddedNumber(sourceNumber)
  if sourceNumber < 10 then return "0" & (sourceNumber as text)
  return sourceNumber as text
end paddedNumber

on decimalGreater(leftValue, rightValue)
  set leftText to leftValue as text
  set rightText to rightValue as text
  if (count of leftText) > (count of rightText) then return true
  if (count of leftText) < (count of rightText) then return false
  return leftText > rightText
end decimalGreater

on decimalLess(leftValue, rightValue)
  set leftText to leftValue as text
  set rightText to rightValue as text
  if (count of leftText) < (count of rightText) then return true
  if (count of leftText) > (count of rightText) then return false
  return leftText < rightText
end decimalLess

on isoDate(sourceDate)
  set dateYear to year of sourceDate as text
  set dateMonth to my paddedNumber(month of sourceDate as integer)
  set dateDay to my paddedNumber(day of sourceDate)
  set dateHour to my paddedNumber(hours of sourceDate)
  set dateMinute to my paddedNumber(minutes of sourceDate)
  set dateSecond to my paddedNumber(seconds of sourceDate)
  return dateYear & "-" & dateMonth & "-" & dateDay & "T" & dateHour & ":" & dateMinute & ":" & dateSecond
end isoDate
`;

function escapeAppleText(value) {
  const slash = String.fromCharCode(92);
  return String(value).split(slash).join(slash + slash).split('"').join(slash + '"');
}

export function appleString(value) {
  const pieces = [];
  let current = '';
  for (const character of String(value)) {
    if (character === '\n' || character === '\r' || character === '\t') {
      pieces.push(`"${escapeAppleText(current)}"`);
      pieces.push(character === '\n' ? 'linefeed' : character === '\r' ? 'return' : 'tab');
      current = '';
    } else current += character;
  }
  pieces.push(`"${escapeAppleText(current)}"`);
  return pieces.join(' & ');
}

export function mailboxListScript() {
  return `${jsonHandlers}
tell application "Mail"
  set rows to {}
  repeat with accountRef in accounts
    set accountName to name of accountRef as text
    repeat with mailboxRef in mailboxes of accountRef
      set mailboxName to name of mailboxRef as text
      set unreadCount to unread count of mailboxRef
      set end of rows to "{\\"account\\":" & my jsonString(accountName) & ",\\"name\\":" & my jsonString(mailboxName) & ",\\"unread\\":" & unreadCount & "}"
    end repeat
  end repeat
  set AppleScript's text item delimiters to ","
  return "[" & (rows as text) & "]"
end tell`;
}

export function messageListScript({ account, mailbox, limit = 50 }) {
  const boundedLimit = Math.max(1, Math.min(5000, Number(limit) || 50));
  return `${jsonHandlers}
tell application "Mail"
  set targetAccount to first account whose name is ${appleString(account)}
  set targetMailbox to first mailbox of targetAccount whose name is ${appleString(mailbox)}
  set allMessages to messages of targetMailbox
  set totalMessages to count of allMessages
  set endIndex to totalMessages
  if totalMessages > ${boundedLimit} then set endIndex to ${boundedLimit}
  set rows to {}
  repeat with messageIndex from 1 to endIndex
    set messageRef to item messageIndex of allMessages
    set messageID to id of messageRef
    set messageSender to sender of messageRef
    set messageSubject to subject of messageRef
    set messageDate to my isoDate(date received of messageRef)
    set isRead to read status of messageRef
    set isFlagged to flagged status of messageRef
    set end of rows to "{\\"id\\":" & my jsonString(messageID) & ",\\"sender\\":" & my jsonString(messageSender) & ",\\"subject\\":" & my jsonString(messageSubject) & ",\\"date\\":" & my jsonString(messageDate) & ",\\"read\\":" & isRead & ",\\"flagged\\":" & isFlagged & "}"
  end repeat
  set AppleScript's text item delimiters to ","
  return "[" & (rows as text) & "]"
end tell`;
}

export function messageDetailScript({ account, mailbox, id }) {
  const numericID = mailMessageID(id);
  return `${jsonHandlers}
tell application "Mail"
  set targetAccount to first account whose name is ${appleString(account)}
  set targetMailbox to first mailbox of targetAccount whose name is ${appleString(mailbox)}
  set messageRef to first message of targetMailbox whose id is ${numericID}
  set messageSender to sender of messageRef
  set messageSubject to subject of messageRef
  set messageDate to my isoDate(date received of messageRef)
  set messageBody to content of messageRef
  set isRead to read status of messageRef
  set isFlagged to flagged status of messageRef
  return "{\\"id\\":" & my jsonString(id of messageRef) & ",\\"sender\\":" & my jsonString(messageSender) & ",\\"subject\\":" & my jsonString(messageSubject) & ",\\"date\\":" & my jsonString(messageDate) & ",\\"body\\":" & my jsonString(messageBody) & ",\\"read\\":" & isRead & ",\\"flagged\\":" & isFlagged & "}"
end tell`;
}

function messageDetailExpression(messageRef) {
  return `"{\\\"id\\\":" & my jsonString(id of ${messageRef}) & ",\\\"sender\\\":" & my jsonString(sender of ${messageRef}) & ",\\\"subject\\\":" & my jsonString(subject of ${messageRef}) & ",\\\"date\\\":" & my jsonString(my isoDate(date received of ${messageRef})) & ",\\\"body\\\":" & my jsonString(content of ${messageRef}) & ",\\\"read\\\":" & (read status of ${messageRef}) & ",\\\"flagged\\\":" & (flagged status of ${messageRef}) & "}"`;
}

function messageCursorExpression(messageRef) {
  return `"{\\\"id\\\":" & my jsonString(id of ${messageRef}) & ",\\\"date\\\":" & my jsonString(my isoDate(date received of ${messageRef})) & "}"`;
}

function dateParserScript(dateValue) {
  return `set cursorDate to current date
  set year of cursorDate to ${Number(dateValue.slice(0, 4))}
  set month of cursorDate to item ${(Number(dateValue.slice(5, 7)) || 1)} of {January, February, March, April, May, June, July, August, September, October, November, December}
  set day of cursorDate to ${Number(dateValue.slice(8, 10)) || 1}
  set hours of cursorDate to ${Number(dateValue.slice(11, 13)) || 0}
  set minutes of cursorDate to ${Number(dateValue.slice(14, 16)) || 0}
  set seconds of cursorDate to ${Number(dateValue.slice(17, 19)) || 0}`;
}

export function latestMessageScript({ account, mailbox }) {
  return `${jsonHandlers}
tell application "Mail"
  set targetAccount to first account whose name is ${appleString(account)}
  set targetMailbox to first mailbox of targetAccount whose name is ${appleString(mailbox)}
  set allMessages to messages of targetMailbox
  if (count of allMessages) is 0 then return "null"
  set latestMessage to item 1 of allMessages
  repeat with candidate in allMessages
    if (date received of candidate) > (date received of latestMessage) then
      set latestMessage to contents of candidate
    else if (date received of candidate) is (date received of latestMessage) and my decimalGreater(id of candidate, id of latestMessage) then
      set latestMessage to contents of candidate
    end if
  end repeat
  return ${messageDetailExpression('latestMessage')}
end tell`;
}

// Mail's messages collection is ordered newest first. Read only that watermark;
// walking every message property turns a cursor request into hundreds of serial
// Apple Events for larger mailboxes.
export function latestCursorScript({ account, mailbox }) {
  return `${jsonHandlers}
tell application "Mail"
  set targetAccount to first account whose name is ${appleString(account)}
  set targetMailbox to first mailbox of targetAccount whose name is ${appleString(mailbox)}
  set allMessages to messages of targetMailbox
  if (count of allMessages) is 0 then return "null"
  set latestMessage to item 1 of allMessages
  return ${messageCursorExpression('latestMessage')}
end tell`;
}

export function messagesAfterScript({ account, mailbox, afterDate, afterId, limit = 500 }) {
  const safeDate = String(afterDate || '');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(safeDate)) throw new Error('无效的监听起点日期');
  const numericID = mailMessageID(afterId);
  const boundedLimit = Math.max(1, Math.min(5000, Number(limit) || 500));
  return `${jsonHandlers}
tell application "Mail"
  set targetAccount to first account whose name is ${appleString(account)}
  set targetMailbox to first mailbox of targetAccount whose name is ${appleString(mailbox)}
  ${dateParserScript(safeDate)}
  set cursorID to ${numericID}
  set candidateRows to {}
  repeat with candidate in (messages of targetMailbox)
    set candidateRef to contents of candidate
    set candidateDate to date received of candidateRef
    if candidateDate < cursorDate then exit repeat
    set candidateID to id of candidateRef as text
    if (candidateDate > cursorDate) or (candidateDate is cursorDate and my decimalGreater(candidateID, cursorID)) then
      set end of candidateRows to {candidateDate, candidateID, candidateRef}
    end if
  end repeat
  set rows to {}
  repeat with rowIndex from 1 to ${boundedLimit}
    set foundNext to false
    repeat with candidateIndex from 1 to (count of candidateRows)
      set candidateEntry to item candidateIndex of candidateRows
      if (item 3 of candidateEntry) is not missing value then
        set candidateDate to item 1 of candidateEntry
        set candidateID to item 2 of candidateEntry
        if (foundNext is false) or (candidateDate < nextDate) or (candidateDate is nextDate and my decimalLess(candidateID, nextID)) then
          set nextIndex to candidateIndex
          set nextDate to candidateDate
          set nextID to candidateID
          set nextRef to item 3 of candidateEntry
          set foundNext to true
        end if
      end if
    end repeat
    if foundNext is false then exit repeat
    -- The scan returns metadata only. The server fetches content for these
    -- matched messages one at a time, so a large mailbox never loads every
    -- message body during a check.
    set end of rows to "{\\\"id\\\":" & my jsonString(id of nextRef) & ",\\\"sender\\\":" & my jsonString(sender of nextRef) & ",\\\"subject\\\":" & my jsonString(subject of nextRef) & ",\\\"date\\\":" & my jsonString(my isoDate(date received of nextRef)) & ",\\\"read\\\":" & (read status of nextRef) & ",\\\"flagged\\\":" & (flagged status of nextRef) & "}"
    set item 3 of item nextIndex of candidateRows to missing value
  end repeat
  set AppleScript's text item delimiters to ","
  return "[" & (rows as text) & "]"
end tell`;
}

export function markReadScript({ account, mailbox, id, read = true }) {
  const numericID = mailMessageID(id);
  return `tell application "Mail"
  set targetAccount to first account whose name is ${appleString(account)}
  set targetMailbox to first mailbox of targetAccount whose name is ${appleString(mailbox)}
  set messageRef to first message of targetMailbox whose id is ${numericID}
  set read status of messageRef to ${read ? 'true' : 'false'}
  return "ok"
end tell`;
}

// Mail exposes message ids as integers, but they can exceed JavaScript's safe
// integer range. Keep the decimal representation intact when embedding it in
// AppleScript instead of converting through Number first.
function mailMessageID(id) {
  const value = String(id ?? '').trim();
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error('无效的邮件编号');
  return value;
}

export function sendMessageScript({ to, cc = '', bcc = '', subject, body }) {
  const recipients = String(to).split(',').map(value => value.trim()).filter(Boolean);
  const ccRecipients = String(cc).split(',').map(value => value.trim()).filter(Boolean);
  const bccRecipients = String(bcc).split(',').map(value => value.trim()).filter(Boolean);
  const addRecipients = (type, values) => values.map(address =>
    `  make new ${type} recipient at end of ${type} recipients with properties {address:${appleString(address)}}`).join('\n');
  return `tell application "Mail"
  set outgoingMessage to make new outgoing message with properties {subject:${appleString(subject || '(无主题)')}, content:${appleString(body)}, visible:false}
  tell outgoingMessage
${addRecipients('to', recipients)}
${addRecipients('cc', ccRecipients)}
${addRecipients('bcc', bccRecipients)}
    send
  end tell
  return "ok"
end tell`;
}

export function runAppleScript(script, { timeoutMs = 45000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('osascript', ['-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    const abort = () => child.kill('SIGTERM');
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => {
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      reject(error);
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      if (code === 0) resolve(stdout.trim());
      else if (timedOut) reject(Object.assign(new Error('Apple Mail script timed out'), { code: 'MAIL_TIMEOUT' }));
      else if (signal?.aborted) reject(Object.assign(new Error('Apple Mail request cancelled'), { code: 'ABORT_ERR' }));
      else {
        const message = stderr.trim() || `osascript exited with code ${code}`;
        const error = new Error(message);
        error.code = `OSASCRIPT_EXIT_${code ?? 'UNKNOWN'}`;
        error.stderr = stderr.trim();
        error.exitCode = code;
        reject(error);
      }
    });
    child.stdin.end(script);
  });
}
