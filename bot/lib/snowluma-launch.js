// 负责把 SnowLuma 网关拉起来并等它就绪。
//
// 为什么需要：DSH 关闭时会连带关掉 SnowLuma（实测），
// 而 DSH 启动时不会再拉起它（那个能力原来在旧版桥接里）。
// 所以由我们的插件负责：先看端口通不通，不通就 spawn，然后轮询等它监听。
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** 端口是否在监听。 */
export function checkPort(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 确保 SnowLuma 在跑。返回 { started, ok }。
 *   started=true 表示这次是我们拉起来的。
 */
export async function ensureSnowluma({
  home, nodeExe, host = '127.0.0.1', port = 3001,
  waitMs = 30000, log = () => {},
} = {}) {
  if (await checkPort(host, port)) {
    log(`SnowLuma 已在运行（${host}:${port}）`);
    return { started: false, ok: true };
  }

  const root = String(home || '').replace(/\/+$/, '');
  const exe = nodeExe || path.join(root, 'node.exe');
  const entry = path.join(root, 'index.mjs');
  if (!fs.existsSync(exe) || !fs.existsSync(entry)) {
    log(`找不到 SnowLuma（exe=${exe}），跳过自动启动`);
    return { started: false, ok: false };
  }

  log(`SnowLuma 未运行，正在启动：${exe}`);
  const logsDir = path.join(root, 'logs');
  try { fs.mkdirSync(logsDir, { recursive: true }); } catch {}
  let out;
  let err;
  try {
    out = fs.openSync(path.join(logsDir, 'stdout.log'), 'a');
    err = fs.openSync(path.join(logsDir, 'stderr.log'), 'a');
  } catch {
    out = 'ignore';
    err = 'ignore';
  }

  const child = spawn(exe, [entry], {
    cwd: root,
    detached: true,
    stdio: ['ignore', out, err],
    windowsHide: true,
  });
  child.unref();
  log(`SnowLuma 已 spawn，PID ${child.pid}，等待端口 ${port}…`);

  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) {
    await sleep(1000);
    if (await checkPort(host, port)) {
      log(`SnowLuma 就绪（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
      return { started: true, ok: true };
    }
  }
  log(`SnowLuma ${waitMs / 1000}s 内未就绪`);
  return { started: true, ok: false };
}
