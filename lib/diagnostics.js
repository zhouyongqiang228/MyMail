import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const logPath = path.join(process.env.MYMAIL_LOG_DIR || path.resolve('logs'), 'mail-desk.log');
fs.mkdirSync(path.dirname(logPath), { recursive: true });
const recentLogs = [];

export function log(event, fields = {}) {
  const entry = { time: new Date().toISOString(), event, ...fields };
  const line = JSON.stringify(entry);
  recentLogs.push(entry);
  if (recentLogs.length > 1000) recentLogs.splice(0, recentLogs.length - 1000);
  console.log(line);
  fs.appendFileSync(logPath, line + '\n', { mode: 0o600 });
}

export function recentLogEntries(limit = 200) {
  return recentLogs.slice(-Math.max(1, Math.min(1000, Number(limit) || 200)));
}

export function safeError(error) {
  const code = String(error.code || error.type || error.name || 'UNKNOWN');
  return { code: /^[A-Za-z0-9_-]{1,50}$/.test(code) ? code : 'UNKNOWN' };
}

export function requestDiagnostics(req, res, next) {
  if (!req.path.startsWith('/api/')) return next();
  const started = Date.now();
  const controller = new AbortController();
  req.traceId = randomUUID().slice(0, 8);
  req.upstreamSignal = controller.signal;
  req.log = (event, fields = {}) => log(event, { requestId: req.traceId, ...fields });
  res.set('X-Request-ID', req.traceId);
  const route = req.path.replace(/(\/messages\/)[^/]+/, '$1:id');
  req.log('http.start', { method: req.method, route });
  const waiting = setInterval(() => req.log('http.waiting', { elapsedMs: Date.now() - started }), 5000);
  const deadline = setTimeout(() => {
    req.log('http.timeout', { elapsedMs: Date.now() - started });
    controller.abort();
    if (!res.headersSent) res.status(504).json({
      error: 'Apple Mail 响应超时，请点击刷新后重试。',
      reason: 'Apple Mail 在 20 秒内没有返回结果。它可能正在启动、同步账户或暂时无响应。',
      code: 'MAIL_TIMEOUT',
      possibleCauses: ['请先打开“邮件”确认账户和网络正常；如果仍超时，请退出并重新打开“邮件”。'],
      requestId: req.traceId,
    });
  }, 20000);
  res.once('close', () => {
    clearInterval(waiting);
    clearTimeout(deadline);
    controller.abort();
    req.log(res.writableFinished ? 'http.end' : 'http.cancelled', { status: res.statusCode, elapsedMs: Date.now() - started });
  });
  next();
}
