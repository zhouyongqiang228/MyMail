import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';

const root = path.resolve(import.meta.dirname, '..');
const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'mymail-desktop-'));
const artifacts = path.join(root, 'artifacts');
await fs.mkdir(artifacts, { recursive: true });
await fs.chmod(path.join(root, 'test/fixtures/bin/osascript'), 0o755);
await fs.writeFile(path.join(dataDirectory, 'settings.json'), JSON.stringify({ autoCheckSeconds: 10 }));
const env = { ...process.env, MYMAIL_DATA_DIR: dataDirectory, MYMAIL_LOG_DIR: path.join(dataDirectory, 'logs'), PATH: `${root}/test/fixtures/bin:${process.env.PATH}` };
delete env.ELECTRON_RUN_AS_NODE;
const executablePath = process.env.MYMAIL_TEST_APP || electronPath;
const launchArgs = process.env.MYMAIL_TEST_APP ? [] : [root];
let desktop;

async function launch(hidden = false) {
  return electron.launch({ executablePath, args: [...launchArgs, ...(hidden ? ['--hidden'] : [])], env });
}

try {
  desktop = await launch();
  let page = await desktop.firstWindow();
  await page.waitForURL('mymail://app/');
  await page.locator('#accountSelect').selectOption('Desktop Test');
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await page.evaluate(() => typeof window.process), 'undefined');
  assert.equal(await desktop.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('launch-at-login').enabled), Boolean(process.env.MYMAIL_TEST_APP));
  if (process.env.MYMAIL_TEST_APP) {
    for (const enabled of [false, true]) {
      const actual = await desktop.evaluate(({ Menu, app }, value) => {
        const item = Menu.getApplicationMenu().getMenuItemById('launch-at-login');
        item.checked = !value;
        item.click(item);
        return app.getLoginItemSettings().openAtLogin;
      }, enabled);
      assert.equal(actual, enabled);
    }
  }
  const loopbackPort = await desktop.evaluate(() => process._getActiveHandles().find(handle => handle.constructor.name === 'Server').address().port);
  assert.equal((await fetch(`http://127.0.0.1:${loopbackPort}/api/settings`)).status, 403);

  await page.locator('#startAutoButton').click();
  await page.waitForFunction(async () => (await fetch('/api/automation').then(r => r.json())).running);
  await page.waitForFunction(async () => (await fetch('/api/automation/logs').then(r => r.json())).logs.some(entry => entry.event === 'automation.check.completed'));
  await page.screenshot({ path: path.join(artifacts, 'desktop-window.png') });
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
  assert.equal(await desktop.evaluate(({ app }) => app.dock.isVisible()), false);
  await page.waitForFunction(async () => (await fetch('/api/automation/logs').then(r => r.json())).logs.filter(entry => entry.event === 'automation.check.completed').length >= 2, undefined, { timeout: 20000 });

  const duplicate = spawn(executablePath, launchArgs, { env, stdio: 'ignore' });
  const [exitCode] = await once(duplicate, 'exit', { signal: AbortSignal.timeout(15000) });
  assert.equal(exitCode, 0);
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true);
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 640));
  await page.screenshot({ path: path.join(artifacts, 'desktop-compact.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.evaluate(() => localStorage.setItem('desktopPersistenceTest', 'saved'));
  await page.locator('#stopAutoButton').click();
  const closed = desktop.waitForEvent('close');
  await desktop.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('quit').click());
  await closed;
  desktop = null;
  await assert.rejects(fetch(`http://127.0.0.1:${loopbackPort}/api/settings`));

  desktop = await launch(true);
  page = await desktop.firstWindow();
  await page.waitForURL('mymail://app/');
  assert.equal(await page.evaluate(() => localStorage.getItem('desktopPersistenceTest')), 'saved');
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
  await desktop.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('show-window').click());
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true);
  console.log('PASS: desktop rendering, private API, background listener, close/reopen, single instance, quit, hidden launch, persistent storage.');
} finally {
  await desktop?.close();
  await fs.rm(dataDirectory, { recursive: true, force: true });
}
