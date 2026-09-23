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
  const boundedLimit = Math.max(1, Math.min(100, Number(limit) || 50));
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
  if (!/^[1-9]\d*$/.test(value)) throw new Error('无效的邮件编号');
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
      else reject(new Error(stderr.trim() || `osascript exited with code ${code}`));
    });
    child.stdin.end(script);
  });
}
