import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mailboxListScript, markReadScript, messageDetailScript, messageListScript,
  runAppleScript, sendMessageScript,
} from './lib/applescript.js';
import { log, logPath, requestDiagnostics, safeError } from './lib/diagnostics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3001);

export function createApp({ runScript = runAppleScript } = {}) {
  const app = express();
  app.use(requestDiagnostics);
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use(express.static(path.join(__dirname, 'public')));
  app.get('/favicon.ico', (_req, res) => res.status(204).end());

  const runJson = async (req, res, script) => {
    try {
      const output = await runScript(script, { signal: req.upstreamSignal });
      res.json(JSON.parse(output));
    } catch (error) {
      req.log('mail.applescript.error', safeError(error));
      if (res.headersSent || res.destroyed) return;
      const detail = String(error.message || '');
      const message = /not authorized|not permitted|assistive access|automation/i.test(detail)
        ? 'macOS 尚未授权此应用控制“邮件”。请在“系统设置 > 隐私与安全性 > 自动化”中允许终端或此应用控制邮件。'
        : /osascript|not found|enoent/i.test(detail)
          ? '未找到 macOS 脚本运行环境。此应用需要在 macOS 上运行。'
          : 'Apple Mail 操作失败。请确认“邮件”已配置账户且可正常使用。';
      res.status(502).json({ error: message });
    }
  };

  app.get('/api/status', async (req, res) => {
    try {
      const name = await runScript('tell application "Mail" to return name', { signal: req.upstreamSignal });
      res.json({ available: true, name });
    } catch (error) {
      req.log('mail.status.error', safeError(error));
      if (res.headersSent || res.destroyed) return;
      res.status(502).json({ available: false, error: '无法连接 Apple Mail。请确认此应用可在 macOS 上运行。' });
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
      req.log('mail.messages.error', safeError(error));
      if (res.headersSent || res.destroyed) return;
      res.status(502).json({ error: '无法读取该邮箱。请刷新邮箱列表后重试。' });
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
      req.log('mail.message.error', safeError(error));
      if (res.headersSent || res.destroyed) return;
      res.status(404).json({ error: '无法打开这封邮件。它可能已被移动或删除。' });
    }
  });

  app.post('/api/messages/:id/read', async (req, res) => {
    const { account, mailbox, read = true } = req.body || {};
    if (!account || !mailbox || typeof read !== 'boolean') return res.status(400).json({ error: '请求信息不完整' });
    try {
      await runScript(markReadScript({ account, mailbox, id: req.params.id, read }), { signal: req.upstreamSignal });
      res.json({ ok: true });
    } catch (error) {
      req.log('mail.message.update.error', safeError(error));
      if (res.headersSent || res.destroyed) return;
      res.status(502).json({ error: '无法更新邮件状态' });
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
      req.log('mail.send.error', safeError(error));
      if (res.headersSent || res.destroyed) return;
      res.status(502).json({ error: '邮件未能发送。请检查 Mail 账户和网络连接。' });
    }
  });

  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createApp();
  app.listen(port, '127.0.0.1', () => log('server.started', { port, logPath }));
}
