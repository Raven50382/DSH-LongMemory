// 数据目录管理：逻辑图备份/恢复、整个插件数据目录迁移。
//
// 数据根目录由 paths.js 的 DATA_ROOT 决定，指针文件在代码根目录
// （.xliens-data-root），所以搬走数据时不会把指针一起搬走。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ROOT, DATA_ROOT, GRAPH_DIR, DATA_ROOT_POINTER } from './paths.js';

const execFileP = promisify(execFile);
const BACKUP_PREFIXES = ['graph_backup_', 'graph_before_restore_', 'graph_damaged_'];

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-`
    + `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function uniqueDir(prefix) {
  let name = prefix;
  let i = 2;
  while (fs.existsSync(path.join(DATA_ROOT, name))) {
    name = `${prefix}_${i++}`;
  }
  return name;
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function countLines(p) {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return raw.split(/\r?\n/).filter((x) => x.trim()).length;
  } catch { return 0; }
}

function readMeta(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  } catch { return null; }
}

export function graphStats(dir = GRAPH_DIR) {
  return {
    dir,
    eus: countLines(path.join(dir, 'eus.jsonl')),
    edges: countLines(path.join(dir, 'edges.jsonl')),
    meta: readMeta(dir),
  };
}

export function listBackups() {
  let entries = [];
  try { entries = fs.readdirSync(DATA_ROOT, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (!BACKUP_PREFIXES.some((p) => ent.name.startsWith(p))) continue;
    const dir = path.join(DATA_ROOT, ent.name);
    let mtime = 0;
    try { mtime = fs.statSync(dir).mtimeMs; } catch {}
    out.push({
      name: ent.name,
      time: mtime ? new Date(mtime).toISOString() : '',
      eus: countLines(path.join(dir, 'eus.jsonl')),
      edges: countLines(path.join(dir, 'edges.jsonl')),
      meta: readMeta(dir),
    });
  }
  out.sort((a, b) => String(b.time).localeCompare(String(a.time)));
  return out;
}

export function dataInfo() {
  let pending = 0;
  try {
    pending = fs.readdirSync(path.join(DATA_ROOT, 'pending'))
      .filter((x) => x.endsWith('.json')).length;
  } catch {}
  return {
    ok: true,
    codeRoot: ROOT,
    dataRoot: DATA_ROOT,
    graphDir: GRAPH_DIR,
    pointer: DATA_ROOT_POINTER,
    current: graphStats(),
    pending,
    backups: listBackups(),
  };
}

export async function backupGraph() {
  if (!isDir(GRAPH_DIR)) throw new Error(`逻辑图目录不存在：${GRAPH_DIR}`);
  const name = uniqueDir(`graph_backup_${stamp()}`);
  const dest = path.join(DATA_ROOT, name);
  await fsp.cp(GRAPH_DIR, dest, { recursive: true, force: false, errorOnExist: true });
  return { ok: true, name, ...graphStats(dest) };
}

function validBackupName(name) {
  return typeof name === 'string'
    && BACKUP_PREFIXES.some((p) => name.startsWith(p))
    && /^[A-Za-z0-9._-]+$/.test(name);
}

export async function restoreGraph(name, { memoryEndpoint = 'http://127.0.0.1:8317' } = {}) {
  if (!validBackupName(name)) throw new Error('备份名不合法');
  const src = path.join(DATA_ROOT, name);
  if (!isDir(src)) throw new Error(`备份不存在：${name}`);
  if (!fs.existsSync(path.join(src, 'eus.jsonl'))) {
    throw new Error(`备份里没有 eus.jsonl：${name}`);
  }

  const before = uniqueDir(`graph_before_restore_${stamp()}`);
  const beforeDir = path.join(DATA_ROOT, before);
  if (isDir(GRAPH_DIR)) {
    await fsp.cp(GRAPH_DIR, beforeDir, { recursive: true, force: false, errorOnExist: true });
  }

  const tmp = path.join(DATA_ROOT, uniqueDir(`graph_restore_tmp_${stamp()}`));
  await fsp.cp(src, tmp, { recursive: true, force: true });
  const old = path.join(DATA_ROOT, uniqueDir(`graph_restore_old_${stamp()}`));
  let movedOld = false;
  try {
    if (isDir(GRAPH_DIR)) {
      await fsp.rename(GRAPH_DIR, old);
      movedOld = true;
    }
    await fsp.rename(tmp, GRAPH_DIR);
  } catch (e) {
    if (movedOld) {
      try { await fsp.rename(old, GRAPH_DIR); } catch {}
    }
    try { await fsp.rm(tmp, { recursive: true, force: true }); } catch {}
    throw e;
  }
  try { await fsp.rm(old, { recursive: true, force: true }); } catch {}

  let reloaded = false;
  try {
    const r = await fetch(`${String(memoryEndpoint).replace(/\/+$/, '')}/api/reload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(60000),
    });
    reloaded = r.ok;
  } catch { /* 服务没起或还没实现 reload，重启后生效 */ }

  return {
    ok: true,
    restored: name,
    backupOfBefore: before,
    reloaded,
    current: graphStats(),
  };
}

function inside(parent, child) {
  const p = path.resolve(parent).toLowerCase();
  const c = path.resolve(child).toLowerCase();
  return c === p || c.startsWith(p + path.sep);
}

/**
 * 迁移后停掉仍占着 8317 的旧记忆服务，让 DSH 重启时能用新目录。
 * 只停命令行明确是 serve.py 且不是实验模型窗口的进程。
 */
export async function stopMemoryService(port = 8317) {
  const ps = [
    `$c = Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1`,
    'if ($c) {',
    '  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)"',
    '  [pscustomobject]@{ pid = $c.OwningProcess; cmd = $p.CommandLine } | ConvertTo-Json -Compress',
    '}',
  ].join('; ');
  try {
    const { stdout } = await execFileP('powershell.exe', [
      '-NoProfile', '-Command', ps,
    ], { timeout: 20000, windowsHide: true, encoding: 'utf8' });
    const raw = String(stdout || '').trim();
    if (!raw) return { stopped: false, reason: '没有进程监听' };
    const info = JSON.parse(raw);
    const cmd = String(info.cmd || '');
    if (!/serve\.py/i.test(cmd) || /reg_v(?!48)/i.test(cmd)) {
      return { stopped: false, reason: '端口被其他进程占用，未停止' };
    }
    await execFileP('taskkill', ['/PID', String(info.pid), '/T', '/F'], {
      timeout: 20000, windowsHide: true,
    });
    return { stopped: true, pid: info.pid };
  } catch (e) {
    return { stopped: false, reason: String(e?.message || e) };
  }
}

export async function migrateData(toPath) {  const to = path.resolve(String(toPath || '').trim());
  if (!path.isAbsolute(String(toPath || '').trim())) throw new Error('请填写绝对路径');
  if (to === path.resolve(DATA_ROOT)) throw new Error('新目录和当前数据目录相同');
  if (inside(DATA_ROOT, to) || inside(to, DATA_ROOT)) {
    throw new Error('新目录不能和当前数据目录互相包含');
  }

  let existing = [];
  try { existing = fs.readdirSync(to); } catch {}
  if (existing.length) throw new Error('目标目录不是空目录，请换一个空目录');
  await fsp.mkdir(to, { recursive: true });

  const entries = [];
  try {
    for (const ent of fs.readdirSync(DATA_ROOT, { withFileTypes: true })) {
      const name = ent.name;
      const isGraphBackup = BACKUP_PREFIXES.some((p) => name.startsWith(p));
      if (name === 'graph_main' || name === 'pending' || name === 'pending_legacy'
          || name === 'file' || name === 'logs' || name === 'graph_demo'
          || isGraphBackup) {
        entries.push(name);
      }
    }
  } catch (e) {
    throw new Error(`读取当前数据目录失败：${e.message}`);
  }

  const copied = [];
  try {
    for (const name of entries) {
      const src = path.join(DATA_ROOT, name);
      const dest = path.join(to, name);
      await fsp.cp(src, dest, { recursive: true, force: false, errorOnExist: true });
      copied.push(name);
    }
    const tmp = `${DATA_ROOT_POINTER}.tmp`;
    await fsp.writeFile(tmp, `${to}\n`, 'utf8');
    await fsp.rename(tmp, DATA_ROOT_POINTER);
  } catch (e) {
    throw new Error(`迁移失败（旧数据未删除，指针未改）：${e.message}`);
  }

  return {
    ok: true,
    from: DATA_ROOT,
    to,
    copied,
    restartRequired: true,
  };
}

/**
 * 打开 Windows 系统选目录对话框。Web 和插件设置共用这个接口。
 * 取消返回 { ok:false, cancelled:true }。
 */
export async function pickDirectory() {
  const script = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$owner = New-Object System.Windows.Forms.Form',
    '$owner.TopMost = $true; $owner.ShowInTaskbar = $false',
    '$owner.FormBorderStyle = "None"; $owner.Size = New-Object System.Drawing.Size(1,1)',
    '$owner.StartPosition = "Manual"; $owner.Left = -2000; $owner.Top = -2000',
    '$owner.Opacity = 0; $owner.Show()',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    '$d.Description = "选择 Xliens 数据目录（空目录）"',
    '$d.ShowNewFolderButton = $true',
    'if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($d.SelectedPath) }',
    '$owner.Close()',
  ].join('; ');
  try {
    const { stdout } = await execFileP('powershell.exe', [
      '-NoProfile', '-STA', '-Command', script,
    ], { timeout: 300000, windowsHide: false, encoding: 'utf8' });
    const dir = String(stdout || '').trim();
    if (!dir) return { ok: false, cancelled: true };
    return { ok: true, path: dir };
  } catch (e) {
    throw new Error(`打开目录选择器失败：${e.message}`);
  }
}
