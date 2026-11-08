// 统一推导「代码根目录」和「数据根目录」。
//
// 代码根目录 = 插件仓库（bot 的上一层），固定不动；
// 数据根目录 = graph_main / graph_backup_* / pending / file / logs，
// 可以在设置页迁移。指针文件放在代码根目录，跟着代码走，不会被一起搬走。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));   // <root>/bot/lib

/** 代码根目录（bot 的上一层）。 */
export const ROOT = path.resolve(HERE, '..', '..');

/** 数据根目录指针：一行绝对路径。 */
export const DATA_ROOT_POINTER = path.join(ROOT, '.xliens-data-root');

function readDataRoot() {
  const fromEnv = String(process.env.XLIENS_DATA_ROOT || '').trim();
  if (fromEnv && path.isAbsolute(fromEnv) && fs.existsSync(fromEnv)) {
    return path.resolve(fromEnv);
  }
  try {
    const raw = fs.readFileSync(DATA_ROOT_POINTER, 'utf8').trim();
    if (raw && path.isAbsolute(raw) && fs.existsSync(raw)) return path.resolve(raw);
  } catch { /* 还没迁移过 */ }
  return ROOT;
}

/** 数据根目录。 */
export const DATA_ROOT = readDataRoot();

export const LOGS_DIR = path.join(DATA_ROOT, 'logs');
export const FILE_DIR = path.join(DATA_ROOT, 'file');
export const GRAPH_DIR = path.join(DATA_ROOT, 'graph_main');

/** 默认日志文件。 */
export const LOG_PATH = process.env.XLIENS_LOG
  || path.join(LOGS_DIR, 'xliens.log');

/** 本地凭证（不进 git）：第一行 wsUrl，第二行 accessToken。 */
export const SNOWLUMA_CRED = path.join(FILE_DIR, 'snowluma.ws');

/** 白名单文件。 */
export const ALLOW_FILE = path.join(FILE_DIR, 'allow.json');
