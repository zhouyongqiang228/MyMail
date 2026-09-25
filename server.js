import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  latestCursorScript, mailboxListScript, markReadScript, messageDetailScript, messageListScript,
  messagesAfterScript,
  runAppleScript, sendMessageScript,
} from './lib/applescript.js';
import { log, logPath, recentLogEntries, requestDiagnostics, safeError } from './lib/diagnostics.js';
import { generateReply, testConnection } from './lib/ai.js';
import { publicSettings, readSettings, writeSettings } from './lib/settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3001);

function errorDetails(error) {
  const message = String(error?.message || error || '未知错误').trim() || '未知错误';
  const code = String(error?.code || error?.type || error?.name || 'UNKNOWN');
  return { message, code, exitCode: error?.exitCode };
}

function possibleCauses(message) {
  const detail = String(message || '').toLowerCase();
  if (/not authorized|not permitted|automation|assistive access|(-1743\b)/i.test(detail)) {
    return ['macOS 尚未允许当前终端或应用控制“邮件”；请到“系统设置 > 隐私与安全性 > 自动化”授权。'];
  }
  if (/timed out|timeout|响应超时/i.test(detail)) {
    return ['“邮件”没有在规定时间内响应，可能正在启动、同步账户或卡住；请先打开“邮件”并确认账户状态。'];
  }
  if (/can't get|can.t get|invalid index|doesn.t understand|mailbox|account/i.test(detail)) {
    return ['账号或邮箱文件夹名称可能已变化，或者该邮件已被移动/删除；请刷新邮箱列表并重新选择文件夹。'];
  }
  if (/osascript|enoent|not found/i.test(detail)) {
    return ['当前环境找不到 macOS 的 osascript；此应用只能在 macOS 上运行。'];
  }
  if (/json|parse/i.test(detail)) {
    return ['AppleScript 返回的数据格式异常，可能是邮件字段包含特殊内容；请查看请求 ID 对应的服务日志。'];
  }
  return ['请确认“邮件”已配置账户、网络正常且应用没有卡住；可根据请求 ID 查看 logs/mail-desk.log。'];
}

function sendDetailedError(req, res, { status = 502, event, fallback, error }) {
  const detail = errorDetails(error);
  req.log(event, { ...safeError(error), exitCode: detail.exitCode });
  res.status(status).json({
    error: fallback,
    reason: detail.message,
    code: detail.code,
    possibleCauses: possibleCauses(detail.message),
    requestId: req.traceId,
  });
}

export function createApp({ runScript = runAppleScript } = {}) {
  const app = express();
  app.use(requestDiagnostics);
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use(express.static(path.join(__dirname, 'public')));
  app.get('/favicon.ico', (_req, res) => res.status(204).end());
  // Debug sessions live for the lifetime of this local server. Keeping the
  // discovered messages here makes repeated checks idempotent and lets us
  // reject a second send even after the message list is refreshed.
  const debugSessions = new Map();
  const automation = { running: false, account: null, mailbox: null, cursor: null, seen: new Set(), timer: null, busy: false, startedAt: null, restartedAt: null, lastCheckAt: null, lastError: null };

  function automationStatus() {
    return {
      running: automation.running,
      account: automation.account,
      mailbox: automation.mailbox,
      startedAt: automation.startedAt,
      restartedAt: automation.restartedAt,
      lastCheckAt: automation.lastCheckAt,
      lastError: automation.lastError,
    };
  }

  function scheduleAutomation() {
    if (!automation.running) return;
    const delay = Math.max(10, Number(readSettings().autoCheckSeconds) || 600) * 1000;
    automation.timer = setTimeout(() => runAutomationCycle(), delay);
  }

  async function runAutomationCycle() {
    if (!automation.running || automation.busy) return;
    automation.busy = true;
    const settings = readSettings();
    try {
      const now = Date.now();
      const restartAfter = Math.max(10, Number(settings.autoRestartSeconds) || 86400) * 1000;
      if (now - Date.parse(automation.restartedAt) >= restartAfter) {
        const latest = JSON.parse(await runScript(latestCursorScript({ account: automation.account, mailbox: automation.mailbox })));
        automation.cursor = latest || { id: '0', date: '1970-01-01T00:00:00' };
        automation.restartedAt = new Date().toISOString();
        log('automation.listener.restarted', { account: automation.account, mailbox: automation.mailbox, cursor: automation.cursor, reason: 'configured_interval' });
      }
      log('automation.check.started', { account: automation.account, mailbox: automation.mailbox, cursor: automation.cursor });
      const candidates = JSON.parse(await runScript(messagesAfterScript({ account: automation.account, mailbox: automation.mailbox, afterDate: automation.cursor.date, afterId: automation.cursor.id })));
      for (const candidate of candidates) {
        if (!automation.running) break;
        const key = String(candidate.id);
        if (automation.seen.has(key)) continue;
        automation.seen.add(key);
        log('automation.message.discovered', { id: key, date: candidate.date, sender: candidate.sender, subject: candidate.subject, account: automation.account, mailbox: automation.mailbox });
        try {
          const message = { ...candidate, ...JSON.parse(await runScript(messageDetailScript({ account: automation.account, mailbox: automation.mailbox, id: key }))) };
          log('automation.reply.generation.started', { id: key, sender: message.sender, subject: message.subject });
          const reply = await generateReply(settings, message, { instructions: settings.replyInstructions });
          log('automation.reply.generation.completed', { id: key, characters: reply.length });
          if (!automation.running) break;
          const address = String(message.sender || '').match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/)?.[0];
          if (!address) throw new Error('无法从原邮件中识别发件人地址');
          const subject = /^re:/i.test(String(message.subject || '')) ? message.subject : `Re: ${message.subject || '(无主题)'}`;
          log('automation.send.started', { id: key, to: address, subject });
          await runScript(sendMessageScript({ to: address, subject, body: reply }));
          log('automation.send.completed', { id: key, to: address, subject, characters: reply.length });
        } catch (error) {
          automation.lastError = String(error?.message || error);
          log('automation.message.failed', { id: key, sender: candidate.sender, subject: candidate.subject, ...safeError(error), reason: automation.lastError });
        }
      }
      if (candidates.length) {
        const last = candidates[candidates.length - 1];
        automation.cursor = { id: String(last.id), date: String(last.date) };
      }
      automation.lastCheckAt = new Date().toISOString();
      automation.lastError = null;
      log('automation.check.completed', { found: candidates.length, cursor: automation.cursor });
    } catch (error) {
      automation.lastError = String(error?.message || error);
      log('automation.check.failed', { account: automation.account, mailbox: automation.mailbox, ...safeError(error), reason: automation.lastError });
    } finally {
      automation.busy = false;
      scheduleAutomation();
    }
  }

  app.get('/api/automation', (_req, res) => res.json(automationStatus()));
  app.get('/api/automation/logs', (req, res) => res.json({ logs: recentLogEntries(req.query.limit) }));

  app.post('/api/automation/start', async (req, res) => {
    const account = String(req.body?.account || '');
    const mailbox = String(req.body?.mailbox || '');
    if (!account || !mailbox) return res.status(400).json({ error: '请选择要监听的邮箱文件夹' });
    if (automation.running) return res.status(409).json({ error: '自动运行已经启动' });
    try {
      const latest = JSON.parse(await runScript(latestCursorScript({ account, mailbox }), { signal: req.upstreamSignal }));
      automation.running = true;
      automation.account = account;
      automation.mailbox = mailbox;
      automation.cursor = latest || { id: '0', date: '1970-01-01T00:00:00' };
      automation.seen = new Set();
      automation.startedAt = new Date().toISOString();
      automation.restartedAt = automation.startedAt;
      automation.lastCheckAt = null;
      automation.lastError = null;
      log('automation.started', { account, mailbox, cursor: automation.cursor, autoCheckSeconds: readSettings().autoCheckSeconds, autoRestartSeconds: readSettings().autoRestartSeconds });
      res.json(automationStatus());
      runAutomationCycle();
    } catch (error) {
      sendDetailedError(req, res, { status: 502, event: 'automation.start.error', fallback: '自动监听未能启动', error });
    }
  });

  app.post('/api/automation/stop', (_req, res) => {
    if (automation.timer) clearTimeout(automation.timer);
    automation.timer = null;
    automation.running = false;
    log('automation.stopped', { account: automation.account, mailbox: automation.mailbox });
    res.json(automationStatus());
  });
  const runJson = async (req, res, script) => {
    try {
      const output = await runScript(script, { signal: req.upstreamSignal });
      res.json(JSON.parse(output));
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      const detail = String(error.message || '');
      const message = /not authorized|not permitted|assistive access|automation/i.test(detail)
        ? 'macOS 尚未授权此应用控制“邮件”。请在“系统设置 > 隐私与安全性 > 自动化”中允许终端或此应用控制邮件。'
        : /osascript|not found|enoent/i.test(detail)
          ? '未找到 macOS 脚本运行环境。此应用需要在 macOS 上运行。'
          : 'Apple Mail 操作失败。请确认“邮件”已配置账户且可正常使用。';
      sendDetailedError(req, res, { status: 502, event: 'mail.applescript.error', fallback: message, error });
    }
  };

  app.get('/api/status', async (req, res) => {
    try {
      const name = await runScript('tell application "Mail" to return name', { signal: req.upstreamSignal });
      res.json({ available: true, name });
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      const detail = errorDetails(error);
      req.log('mail.status.error', { ...safeError(error), exitCode: detail.exitCode });
      res.status(502).json({ available: false, error: '无法连接 Apple Mail。请确认此应用可在 macOS 上运行。', reason: detail.message, code: detail.code, possibleCauses: possibleCauses(detail.message), requestId: req.traceId });
    }
  });

  app.get('/api/mailboxes', async (req, res) => {
    await runJson(req, res, mailboxListScript());
  });

  app.get('/api/messages', async (req, res) => {
    const account = String(req.query.account || '');
    const mailbox = String(req.query.mailbox || '');
    if (!account || !mailbox) return res.status(400).json({ error: '请选择邮箱文件夹' });
    try {
      const output = await runScript(messageListScript({ account, mailbox }), { signal: req.upstreamSignal });
      res.json({ messages: JSON.parse(output) });
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      sendDetailedError(req, res, { status: 502, event: 'mail.messages.error', fallback: '无法读取该邮箱。请刷新邮箱列表后重试。', error });
    }
  });

  app.get('/api/messages/:id', async (req, res) => {
    const account = String(req.query.account || '');
    const mailbox = String(req.query.mailbox || '');
    if (!account || !mailbox) return res.status(400).json({ error: '缺少邮箱信息' });
    try {
      const output = await runScript(messageDetailScript({ account, mailbox, id: req.params.id }), { signal: req.upstreamSignal });
      res.json(JSON.parse(output));
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      sendDetailedError(req, res, { status: 404, event: 'mail.message.error', fallback: '无法打开这封邮件。它可能已被移动或删除。', error });
    }
  });

  async function readMessage(req, account, mailbox, id) {
    const output = await runScript(messageDetailScript({ account, mailbox, id }), { signal: req.upstreamSignal });
    return JSON.parse(output);
  }

  app.post('/api/debug/session', async (req, res) => {
    const account = String(req.body?.account || '');
    const mailbox = String(req.body?.mailbox || '');
    if (!account || !mailbox) return res.status(400).json({ error: '请选择邮箱文件夹' });
    try {
      const output = await runScript(latestCursorScript({ account, mailbox }), { signal: req.upstreamSignal });
      const latest = JSON.parse(output);
      // An empty mailbox still needs a valid cursor so the first incoming message is found.
      const cursor = latest || { id: '0', date: '1970-01-01T00:00:00' };
      const sessionId = req.traceId;
      const session = { id: sessionId, account, mailbox, cursor, startedAt: new Date().toISOString(), messages: new Map() };
      debugSessions.set(sessionId, session);
      res.json({ sessionId, account, mailbox, cursor, startedAt: session.startedAt });
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      sendDetailedError(req, res, { status: 502, event: 'mail.debug.session.error', fallback: '无法开始监听新邮件', error });
    }
  });

  async function debugMessagesForSession(req, res, session) {
    try {
      const output = await runScript(messagesAfterScript({ account: session.account, mailbox: session.mailbox, afterDate: session.cursor.date, afterId: session.cursor.id }), { signal: req.upstreamSignal });
      const candidates = JSON.parse(output);
      for (const candidate of candidates) {
        const key = String(candidate.id);
        if (session.messages.has(key)) {
          continue;
        }
        const message = await readMessage(req, session.account, session.mailbox, key);
        const stored = { ...candidate, ...message, debugStatus: 'pending' };
        session.messages.set(key, stored);
      }
      if (candidates.length) {
        const last = candidates[candidates.length - 1];
        session.cursor = { id: String(last.id), date: String(last.date) };
      }
      res.json({ sessionId: session.id, messages: [...session.messages.values()].sort((a, b) => String(a.date).localeCompare(String(b.date))) });
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      sendDetailedError(req, res, { status: 502, event: 'mail.debug.session.messages.error', fallback: '无法检查新邮件', error });
    }
  }

  app.get('/api/debug/session/:id/messages', async (req, res) => {
    const session = debugSessions.get(String(req.params.id));
    if (!session) return res.status(404).json({ error: '测试会话不存在，请重新开始监听' });
    await debugMessagesForSession(req, res, session);
  });

  app.delete('/api/debug/session/:id', (req, res) => {
    const deleted = debugSessions.delete(String(req.params.id));
    if (!deleted) return res.status(404).json({ error: '测试会话不存在或已清空' });
    res.json({ ok: true });
  });

  function findDebugMessage(id, sessionId) {
    const key = String(id);
    const session = sessionId ? debugSessions.get(String(sessionId)) : null;
    return session?.messages.get(key);
  }

  app.post('/api/debug/messages/:id/generate-reply', async (req, res) => {
    const message = findDebugMessage(req.params.id, req.body?.sessionId);
    if (!message) return res.status(404).json({ error: '测试邮件不存在，请先检查新邮件' });
    if (message.debugStatus === 'sent') return res.status(409).json({ error: '这封邮件已发送，不能重复发送' });
    try {
      const instructions = String(req.body?.instructions || '').trim().slice(0, 2000);
      message.reply = await generateReply(readSettings(), message, { signal: req.upstreamSignal, instructions });
      message.debugStatus = 'generated';
      res.json({ id: message.id, reply: message.reply, sender: message.sender, subject: message.subject, status: message.debugStatus });
    } catch (error) {
      message.debugStatus = 'failed';
      if (res.headersSent || res.destroyed) return;
      sendDetailedError(req, res, { status: 502, event: 'mail.debug.generate.error', fallback: 'AI 回复生成失败', error });
    }
  });

  app.post('/api/debug/messages/:id/send-reply', async (req, res) => {
    const message = findDebugMessage(req.params.id, req.body?.sessionId);
    const body = String(req.body?.body || '').trim();
    if (!message) return res.status(404).json({ error: '测试邮件不存在，请先检查新邮件' });
    if (message.debugStatus === 'sent') return res.status(409).json({ error: '这封邮件已发送，不能重复发送' });
    if (!body) return res.status(400).json({ error: '回复正文不能为空' });
    const address = String(message.sender || '').match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/)?.[0];
    if (!address) return res.status(400).json({ error: '无法从原邮件中识别发件人地址' });
    try {
      const subject = /^re:/i.test(String(message.subject || '')) ? message.subject : `Re: ${message.subject || '(无主题)'}`;
      await runScript(sendMessageScript({ to: address, subject, body }), { signal: req.upstreamSignal });
      message.reply = body;
      message.debugStatus = 'sent';
      res.json({ ok: true, id: message.id, status: message.debugStatus, to: address, subject });
    } catch (error) {
      message.debugStatus = 'failed';
      if (res.headersSent || res.destroyed) return;
      sendDetailedError(req, res, { status: 502, event: 'mail.debug.send.error', fallback: '回复邮件未能发送', error });
    }
  });

  app.post('/api/messages/:id/read', async (req, res) => {
    const { account, mailbox, read = true } = req.body || {};
    if (!account || !mailbox || typeof read !== 'boolean') return res.status(400).json({ error: '请求信息不完整' });
    try {
      await runScript(markReadScript({ account, mailbox, id: req.params.id, read }), { signal: req.upstreamSignal });
      res.json({ ok: true });
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      sendDetailedError(req, res, { status: 502, event: 'mail.message.update.error', fallback: '无法更新邮件状态', error });
    }
  });

  app.post('/api/send', async (req, res) => {
    const { to, cc, bcc, subject, body } = req.body || {};
    if (typeof to !== 'string' || !to.trim() || typeof body !== 'string' || !body.trim()) {
      return res.status(400).json({ error: '收件人和邮件正文不能为空' });
    }
    const recipients = [to, cc || '', bcc || ''].flatMap(value => String(value).split(',').map(item => item.trim()).filter(Boolean));
    if (recipients.some(address => !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(address))) {
      return res.status(400).json({ error: '请检查收件人地址' });
    }
    try {
      await runScript(sendMessageScript({ to: to.trim(), cc, bcc, subject, body }), { signal: req.upstreamSignal });
      res.json({ ok: true });
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      sendDetailedError(req, res, { status: 502, event: 'mail.send.error', fallback: '邮件未能发送。请检查 Mail 账户和网络连接。', error });
    }
  });

  app.get('/api/settings', (_req, res) => res.json(publicSettings()));

  app.put('/api/settings', (req, res) => {
    const current = readSettings();
    const endpoint = String(req.body?.endpoint || '').trim();
    const model = String(req.body?.model || '').trim();
    const apiKey = String(req.body?.apiKey || '').trim();
    if (!endpoint || !model) return res.status(400).json({ error: 'API 端点和模型不能为空' });
    const autoCheckSeconds = Number(req.body?.autoCheckSeconds ?? current.autoCheckSeconds);
    const autoRestartSeconds = Number(req.body?.autoRestartSeconds ?? current.autoRestartSeconds);
    const replyInstructions = String(req.body?.replyInstructions ?? current.replyInstructions ?? '').trim().slice(0, 2000);
    if (!Number.isInteger(autoCheckSeconds) || autoCheckSeconds < 10 || autoCheckSeconds > 2592000 || !Number.isInteger(autoRestartSeconds) || autoRestartSeconds < 10 || autoRestartSeconds > 2592000) {
      return res.status(400).json({ error: '自动检测和重新监听时间必须是 10 到 2592000 之间的整数秒数' });
    }
    try {
      const parsed = new URL(endpoint);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
    } catch {
      return res.status(400).json({ error: 'API 端点必须是有效的 HTTP 或 HTTPS 地址' });
    }
    const saved = writeSettings({ endpoint, model, apiKey: apiKey || current.apiKey, replyInstructions, autoCheckSeconds, autoRestartSeconds });
    res.json(publicSettings(saved));
  });

  app.post('/api/settings/test', async (req, res) => {
    try {
      await testConnection(readSettings(), { signal: req.upstreamSignal });
      res.json({ ok: true });
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      sendDetailedError(req, res, { status: 502, event: 'ai.connection.error', fallback: 'AI 连接测试失败', error });
    }
  });

  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createApp();
  app.listen(port, '127.0.0.1', () => log('server.started', { port, logPath }));
}
