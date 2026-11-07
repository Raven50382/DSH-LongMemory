// 负责把 Python 记忆服务拉起来并等它就绪。
//
// 和 SnowLuma 一样的问题：重启 DSH 之后这些常驻服务就没了。
// 由插件在启动时检查端口 + 自动拉起，用户就不用手动开任何东西。
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { stopMemoryService } from './data-manager.js';

function checkPort(host, port, timeoutMs = 800) {
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
 * 确保记忆服务在跑。返回 { started, ok }。
 */
export async function ensureMemory({
  root, dataRoot, python, entry, port = 8317, model,
  log = () => {}, waitMs = 60000,
} = {}) {
  if (await checkPort('127.0.0.1', port)) {
    let health = null;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`,
        { signal: AbortSignal.timeout(3000) });
      health = await r.json();
    } catch { /* 端口在但不像是记忆服务 */ }
    if (!health || typeof health !== 'object') {
      log(`8317 被占用，但读不到记忆服务健康信息；不自动处理`);
      return { started: false, ok: false, reason: 'port-unknown' };
    }
    const expectedRoot = String(dataRoot || root);
    const normRoot = (p) => path.resolve(String(p)).replace(/\//g, '\\').toLowerCase();
    if (health.data_root && normRoot(health.data_root) !== normRoot(expectedRoot)) {
      log(`8317 仍使用旧数据目录 ${health.data_root}，正在停止旧服务…`);
      const stop = await stopMemoryService(port);
      if (!stop.stopped) {
        log(`旧 8317 停止失败：${stop.reason || '未知原因'}`);
        return { started: false, ok: false, reason: 'data-root-mismatch' };
      }
    } else if (!health.data_root) {
      // 旧版 serve.py 没有 data_root 字段；升级后需要重启一次才能用新代码/新目录。
      log('8317 是旧版记忆服务，正在重启以加载当前代码…');
      const stop = await stopMemoryService(port);
      if (!stop.stopped) {
        log(`旧 8317 停止失败：${stop.reason || '未知原因'}`);
        return { started: false, ok: false, reason: 'old-service' };
      }
    } else {
      log(`记忆服务已在运行（127.0.0.1:${port}）`);
      return { started: false, ok: true };
    }
    for (let i = 0; i < 20 && await checkPort('127.0.0.1', port, 300); i++) {
      await sleep(250);
    }
  }

  const data = dataRoot || root;
  const py = python || 'py';
  const script = entry || path.join(root, 'code', 'serve.py');
  if (!fs.existsSync(script)) {
    log(`找不到记忆服务脚本 ${script}`);
    return { started: false, ok: false };
  }

  const env = {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    // 数据目录是硬边界
    XLIENS_DATA_ROOT: data,
    XLIENS_PENDING: path.join(data, 'pending'),
    XLIENS_SETTINGS: path.join(data, 'file', 'settings.json'),
    XLIENS_SELF: path.join(data, 'file', 'self.json'),
    XLIENS_OWNER: path.join(data, 'file', 'owner.json'),
    XLIENS_PERSONA: path.join(data, 'file', 'persona.md'),
    XLIENS_ALLOW: path.join(data, 'file', 'allow.json'),
    XLIENS_STAGING: path.join(data, 'file', 'staging'),
    XLIENS_TRASH: path.join(data, 'file', 'trash.json'),
  };

  const logsDir = path.join(data, 'logs');
  try { fs.mkdirSync(logsDir, { recursive: true }); } catch {}
  let out;
  let err;
  try {
    out = fs.openSync(path.join(logsDir, 'serve.log'), 'a');
    err = fs.openSync(path.join(logsDir, 'serve.err.log'), 'a');
  } catch {
    out = 'ignore';
    err = 'ignore';
  }

  log(`记忆服务未运行，正在启动（首次要加载 CE 模型，约 15~25 秒）`);
  // 图目录：优先用真实图 graph_main（本地数据，不进仓库）。
  // 开源仓库不附带任何图；首次启动创建一个空图，等用户自己导入/整备。
  const ensureEmptyGraph = () => {
    const dir = path.join(data, 'graph_main');
    fs.mkdirSync(dir, { recursive: true });
    const writeIfMissing = (name, content) => {
      const p = path.join(dir, name);
      if (!fs.existsSync(p)) fs.writeFileSync(p, content, 'utf8');
    };
    writeIfMissing('eus.jsonl', '');
    writeIfMissing('edges.jsonl', '');
    writeIfMissing('nodes.json', '[]\n');
    writeIfMissing('meta.json', JSON.stringify({
      mode: 'full', model: model || 'models/reg_v48_s3', threshold: 0.1,
      hops: 1, n_nodes: 0, n_edges: 0, ce_calls: 0,
      note: '空图：等待用户导入或整备',
    }, null, 1) + '\n');
    return dir;
  };
  let graphDir;
  if (fs.existsSync(path.join(data, 'graph_main', 'eus.jsonl'))) {
    graphDir = path.join(data, 'graph_main');
  } else if (fs.existsSync(path.join(data, 'graph_demo', 'eus.jsonl'))) {
    graphDir = path.join(data, 'graph_demo');
  } else {
    graphDir = ensureEmptyGraph();
  }
  log(`使用图目录 ${graphDir}` + (graphDir.endsWith('graph_demo')
    ? '（脱敏演示数据，人物显示为角色A/角色B）'
    : (graphDir === path.join(data, 'graph_main') && !fs.statSync(path.join(graphDir, 'eus.jsonl')).size
      ? '（空图，等待导入）' : '（真实数据）')));

  // 只传配置里的模型；默认 memory.model 是 v48_s3。
  // 如果配置明确指定了实验模型，不在这里覆盖/争抢，发现异常时报告原因即可。
  const modelArg = model ? String(model) : '';

  const args = py === 'py'
    ? ['-3', script, '--port', String(port), '--graph', graphDir]
    : [script, '--port', String(port), '--graph', graphDir];
  if (modelArg) args.push('--model', modelArg);
  const child = spawn(py, args, {
    cwd: root,
    detached: true,
    env,
    stdio: ['ignore', out, err],
    windowsHide: true,
  });
  child.unref();
  log(`记忆服务已 spawn，PID ${child.pid}，等待端口 ${port}…`);

  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) {
    await sleep(2000);
    if (await checkPort('127.0.0.1', port)) {
      // 端口通了还要等它真正能响应 /health
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`);
        if (r.ok) {
          log(`记忆服务就绪（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
          return { started: true, ok: true };
        }
      } catch { /* 还在加载模型 */ }
    }
  }
  log(`记忆服务 ${waitMs / 1000}s 内未就绪（看 logs/serve.err.log）`);
  return { started: true, ok: false };
}
