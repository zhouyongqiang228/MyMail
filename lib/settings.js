import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDirectory = process.env.MYMAIL_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'MyMail');
export const settingsPath = path.join(dataDirectory, 'settings.json');

const defaults = {
  endpoint: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  apiKey: '',
};

function ensureDirectory() {
  fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
}

export function readSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    return { ...defaults, ...parsed };
  } catch {
    return { ...defaults };
  }
}

export function writeSettings(values) {
  ensureDirectory();
  const next = {
    endpoint: String(values.endpoint || defaults.endpoint).trim(),
    model: String(values.model || defaults.model).trim(),
    apiKey: String(values.apiKey || '').trim(),
  };
  const temporaryPath = `${settingsPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporaryPath, settingsPath);
  try { fs.chmodSync(settingsPath, 0o600); } catch { /* best effort on non-macOS filesystems */ }
  return next;
}

export function publicSettings(values = readSettings()) {
  return {
    endpoint: values.endpoint,
    model: values.model,
    hasApiKey: Boolean(values.apiKey),
  };
}
