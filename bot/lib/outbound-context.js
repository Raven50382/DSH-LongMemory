// 把机器人成功发出的消息也写进 pending。
//
// 整备只读 pending；如果只记入站消息，落盘上下文永远缺机器人这一侧。
// 这里只记录真正发送成功的文本，发送失败不写，避免污染记忆。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_ROOT, FILE_DIR } from './paths.js';

function botSpeaker() {
  const file = process.env.XLIENS_SELF || path.join(FILE_DIR, 'self.json');
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const names = Array.isArray(d?.names) ? d.names : [];
    return String(names.find((x) => String(x || '').trim()) || '').trim() || '机器人';
  } catch {
    return '机器人';
  }
}

function pendingDir() {
  return process.env.XLIENS_PENDING || path.join(DATA_ROOT, 'pending');
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * @param {string} session private:10001 / group:100000000
 * @param {Array<{id?: string|number, text?: string}|string>} sent
 * @returns {string|null} 写入的文件名；没有可写内容时返回 null
 */
export function appendOutbound(session, sent) {
  const key = String(session || '').trim();
  if (!/^(private|group):.+$/.test(key)) return null;
  const texts = (Array.isArray(sent) ? sent : [])
    .map((x) => (typeof x === 'string' ? x : x?.text))
    .map((x) => String(x || '').trim())
    .filter(Boolean);
  if (!texts.length) return null;

  const dir = pendingDir();
  fs.mkdirSync(dir, { recursive: true });
  const ts = stamp();
  const safe = key.replace(/[:\\/]/g, '_');
  const tag = `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}`;
  const name = `${safe}__${tag}__out.json`;
  const data = {
    session: key,
    messages: texts.map((text) => ({
      ts,
      speaker: botSpeaker(),
      text,
      direction: 'outbound',
    })),
    consumed: false,
    source: 'xliens-bridge-outbound',
  };
  fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 1), 'utf8');
  return name;
}
