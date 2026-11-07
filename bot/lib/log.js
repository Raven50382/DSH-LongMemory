// 极简文件日志：DSH 不把插件日志落到文件，排查时看不到东西。
// 写到 logs/xliens.log，自己轮转（>2MB 就清空）。
import fs from 'node:fs';
import path from 'node:path';
import { LOG_PATH as DEFAULT_LOG } from './paths.js';

const LOG_PATH = process.env.XLIENS_LOG || DEFAULT_LOG;

function ensureDir() {
  try { fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true }); } catch {}
}

export function logLine(level, msg) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
  try {
    ensureDir();
    try {
      const st = fs.statSync(LOG_PATH);
      if (st.size > 2 * 1024 * 1024) fs.writeFileSync(LOG_PATH, '');
    } catch {}
    fs.appendFileSync(LOG_PATH, line, 'utf8');
  } catch {}
  if (level === 'warn' || level === 'error') {
    try { console.error(`[xliens] ${msg}`); } catch {}
  }
}

export const logInfo = (m) => logLine('info', m);
export const logWarn = (m) => logLine('warn', m);
export { LOG_PATH };
