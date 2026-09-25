import { app, BrowserWindow, dialog, Menu, nativeImage, net, protocol, session, shell, Tray } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDirectory = process.env.MYMAIL_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'MyMail');
process.env.MYMAIL_DATA_DIR = dataDirectory;
process.env.MYMAIL_LOG_DIR ||= path.join(dataDirectory, 'logs');
fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
app.setName('MyMail');
app.setPath('userData', dataDirectory);
app.setPath('sessionData', path.join(dataDirectory, 'browser'));
protocol.registerSchemesAsPrivileged([
  { scheme: 'mymail', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let mainWindow;
let tray;
let server;
let serverApp;
let quitting = false;
const preferencesPath = path.join(dataDirectory, 'desktop.json');

function isAppUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'mymail:' && url.host === 'app';
  } catch { return false; }
}

function reportError(title, error) {
  dialog.showErrorBox(title, String(error?.message || error));
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  app.dock?.show();
  mainWindow.show();
  mainWindow.focus();
}

function setLoginEnabled(enabled) {
  app.setLoginItemSettings({ openAtLogin: enabled });
  const actual = app.getLoginItemSettings().openAtLogin;
  if (actual !== enabled) throw new Error('无法更新登录项，请在系统设置 > 通用 > 登录项与扩展中检查 MyMail。');
  fs.writeFileSync(preferencesPath, JSON.stringify({ loginConfigured: true }) + '\n', { mode: 0o600 });
  refreshMenus();
}

function loginMenuItem() {
  return {
    id: 'launch-at-login', label: '开机启动', type: 'checkbox',
    enabled: app.isPackaged,
    checked: app.isPackaged && app.getLoginItemSettings().openAtLogin,
    click: item => {
      try { setLoginEnabled(item.checked); }
      catch (error) { reportError('开机启动设置失败', error); refreshMenus(); }
    },
  };
}

function refreshMenus() {
  tray?.setContextMenu(Menu.buildFromTemplate([
    { label: 'MyMail · 邮件工作台', enabled: false },
    { type: 'separator' },
    { id: 'show-window', label: '打开邮件工作台', click: showWindow },
    loginMenuItem(),
    { label: '打开日志文件夹', click: () => shell.openPath(process.env.MYMAIL_LOG_DIR) },
    { type: 'separator' },
    { id: 'quit', label: '退出 MyMail', click: () => app.quit() },
  ]));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'MyMail', submenu: [
      { role: 'about', label: '关于 MyMail' },
      { type: 'separator' }, loginMenuItem(), { type: 'separator' },
      { role: 'hide', label: '隐藏 MyMail' },
      { role: 'hideOthers', label: '隐藏其他应用' },
      { role: 'unhide', label: '显示全部' },
      { type: 'separator' }, { id: 'quit', label: '退出 MyMail', accelerator: 'CommandOrControl+Q', click: () => app.quit() },
    ] },
    { label: '编辑', submenu: [
      { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' },
      { type: 'separator' }, { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' },
      { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' },
    ] },
    { label: '窗口', submenu: [
      { id: 'show-window', label: '打开邮件工作台', click: showWindow },
      { role: 'minimize', label: '最小化' }, { role: 'zoom', label: '缩放' },
      { role: 'close', label: '关闭窗口' },
    ] },
  ]));
}

async function start() {
  // A stable private origin preserves localStorage across launches. Only the
  // main process knows the token needed to reach the ephemeral loopback port.
  const accessToken = randomBytes(32).toString('hex');
  const { createApp } = await import('../server.js');
  serverApp = createApp({ accessToken });
  server = await new Promise((resolve, reject) => {
    const listener = serverApp.listen(0, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  protocol.handle('mymail', async request => {
    if (!isAppUrl(request.url)) return new Response(null, { status: 403 });
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.set('X-MyMail-Token', accessToken);
    const response = await net.fetch(`${base}${url.pathname}${url.search}`, {
      method: request.method, headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.text(),
      signal: request.signal,
    });
    const responseHeaders = new Headers(response.headers);
    responseHeaders.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    return new Response(response.body, { status: response.status, headers: responseHeaders });
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  const trayIcon = nativeImage.createFromPath(path.join(root, 'assets', 'trayTemplate.png'));
  trayIcon.setTemplateImage(true);
  tray = new Tray(trayIcon);
  tray.setToolTip('MyMail 邮件工作台');
  tray.on('double-click', showWindow);
  app.dock?.setIcon(path.join(root, 'assets', 'icon.png'));
  refreshMenus();

  mainWindow = new BrowserWindow({
    title: 'MyMail 邮件工作台', width: 1360, height: 860, minWidth: 1000, minHeight: 640,
    show: false, backgroundColor: '#f4f6f5',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  mainWindow.on('close', event => {
    if (quitting) return;
    event.preventDefault();
    mainWindow.hide();
    app.dock?.hide();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    if (!quitting && details.reason !== 'clean-exit') {
      mainWindow.loadURL('mymail://app/').catch(error => reportError('界面恢复失败', error));
    }
  });
  const openedAtLogin = app.getLoginItemSettings().wasOpenedAtLogin;
  await mainWindow.loadURL('mymail://app/');
  if (openedAtLogin || process.argv.includes('--hidden')) app.dock?.hide();
  else showWindow();

  // Configure once; subsequent launches respect changes made in System Settings.
  if (app.isPackaged && !fs.existsSync(preferencesPath)) {
    try { setLoginEnabled(true); }
    catch (error) { reportError('开机启动设置失败', error); }
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => {
    quitting = true;
    serverApp?.locals.shutdown();
    server?.close();
    server?.closeAllConnections();
    tray?.destroy();
  });
  app.whenReady().then(start).catch(error => {
    reportError('MyMail 无法启动', error);
    app.quit();
  });
}
