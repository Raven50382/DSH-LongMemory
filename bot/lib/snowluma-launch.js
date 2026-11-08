// 负责把 SnowLuma 网关拉起来并等它就绪。
//
// 为什么需要：DSH 关闭时会连带关掉 SnowLuma（实测），
// 而 DSH 启动时不会再拉起它（那个能力原来由外部启动器负责）。
// 所以由我们的插件负责：先看端口通不通，不通就 spawn，然后轮询等它监听。
//
// 重要修复（v1.6.17）：
//   旧逻辑只看 OneBot 端口（3001）。SnowLuma 起来了但 QQ 没登录时，WebUI 已经
//   在 5099 监听、3001 永远不开，于是每一轮重试都判定「没就绪」→ 再 spawn 一个，
//   新实例抢不到 5099 就退到 5100/5101… 无限堆积，每个实例还会弹一个控制台窗口。
//   现在先判断「是不是已经有实例在跑」（扫 WebUI 端口），有就绝不再 spawn。
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** SnowLuma 的 WebUI 端口范围：第一个可用端口起，冲突时逐个往上退。 */
const WEBUI_PORTS = [
  5099, 5100, 5101, 5102, 5103, 5104, 5105,
  5106, 5107, 5108, 5109, 5110, 5111, 5112,
];

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

/** 是否已经有 SnowLuma 实例在跑（用 WebUI 端口判断，跨平台、不依赖进程列表）。 */
export async function isSnowlumaRunning(host = '127.0.0.1') {
  for (const p of WEBUI_PORTS) {
    // eslint-disable-next-line no-await-in-loop
    if (await checkPort(host, p, 300)) return p;
  }
  return 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 同一条提示只打一次，避免每次重试都刷日志
let lastNotice = '';

function notice(log, msg) {
  if (msg === lastNotice) return;
  lastNotice = msg;
  log(msg);
}

/**
 * 确保 SnowLuma 在跑。返回 { started, ok }。
 *   started=true  表示这次是我们拉起来的
 *   ok=true       表示 OneBot 端口已经就绪
 *   started=false 且 ok=false 表示「实例在，但网关没就绪」，上层应只重试连接，不再启动
 */
export async function ensureSnowluma({
  home, nodeExe, host = '127.0.0.1', port = 3001,
  waitMs = 30000, log = () => {},
} = {}) {
  if (await checkPort(host, port)) {
    lastNotice = '';
    log(`SnowLuma 已在运行（${host}:${port}）`);
    return { started: false, ok: true };
  }

  // 已经有实例在跑（WebUI 在听）→ 绝不再 spawn。
  // OneBot 端口不开通常是 QQ 没登录，重启一百次也没用，只会堆进程和弹窗。
  const runningPort = await isSnowlumaRunning(host);
  if (runningPort) {
    notice(log, `SnowLuma 已在运行（WebUI :${runningPort}），但 OneBot ${port} 未就绪`
      + `（通常是 QQ 未登录）；不再重复启动，只重试连接`);
    return { started: false, ok: false };
  }

  const root = String(home || '').replace(/\/+$/, '');
  const exe = nodeExe || path.join(root, 'node.exe');
  const entry = path.join(root, 'index.mjs');
  if (!fs.existsSync(exe) || !fs.existsSync(entry)) {
    notice(log, `找不到 SnowLuma（exe=${exe}），跳过自动启动`);
    return { started: false, ok: false };
  }

  lastNotice = '';
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
      lastNotice = '';
      log(`SnowLuma 就绪（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
      return { started: true, ok: true };
    }
  }
  notice(log, `SnowLuma ${waitMs / 1000}s 内未就绪；实例已启动，后续只重试连接`);
  return { started: true, ok: false };
}
