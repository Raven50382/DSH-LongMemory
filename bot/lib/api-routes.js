// 控制台 API：注册到 DSH 的 webServer 上，路径前缀 /xliens/api
//
// 数据来源是 Python 记忆服务（127.0.0.1:8317），这里只做转发 + 安全护栏。
// 安全措施采用已验证的本地桥接方案：
//   · 只接受本机回环
//   · 写操作要求同源 + application/json
//   · 交给 DSH 的 connection.requestRejection 再判一次

import {
  dataInfo, backupGraph, restoreGraph, migrateData, pickDirectory,
  stopMemoryService,
} from './data-manager.js';
import { checkUpdate } from './update-check.js';

export const API_PREFIX = '/xliens/api';

const isLoopback = (req) => {
  const a = req.socket?.remoteAddress ?? '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
};

const sameOrigin = (req) => {
  const origin = req.headers.origin;
  if (!origin) return true;                   // 非浏览器（curl）没有 Origin
  try {
    const o = new URL(origin);
    const host = String(req.headers.host ?? '');
    return o.host === host;
  } catch {
    return false;
  }
};

function sendJson(res, code, obj) {
  const data = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw);
}

export function registerRoutes({ ctx, memoryEndpoint, log = () => {}, consoleToken = '', modelManager = null }) {
  const base = String(memoryEndpoint || 'http://127.0.0.1:8317')
    .replace(/\/+$/, '');
  const disposers = [];

  function route(kind, path, handler) {
    const d = ctx.webServer.register({
      kind,
      path,
      handler: async (req, res) => {
        if (!isLoopback(req)) {
          sendJson(res, 403, { ok: false, error: '只接受本机回环访问' });
          return;
        }
        if (req.method !== 'GET' && !sameOrigin(req)) {
          sendJson(res, 403, { ok: false, error: '跨站请求被拒绝' });
          return;
        }
        if (req.method !== 'GET'
            && !String(req.headers['content-type'] ?? '')
              .toLowerCase().includes('application/json')) {
          sendJson(res, 415, { ok: false, error: '写操作必须是 application/json' });
          return;
        }
        try {
          // Web 控制台可能开在系统浏览器里，没有 DSH 的登录 cookie。
          // 静态页会把每进程随机 token 写进 <meta>，页面请求带上它；
          // token 对上就跳过 DSH 的 connection 认证。回环 + 同源 +
          // 自定义 header（跨站会触发 preflight）仍然保留。
          const provided = String(req.headers['x-xliens-console-token'] ?? '');
          const consoleOk = !!(consoleToken && provided && provided === consoleToken);
          if (!consoleOk) {
            const conn = ctx.get?.('connection');
            if (conn && typeof conn.requestRejection === 'function') {
              const code = conn.requestRejection(req);
              if (code !== undefined && code !== null && code !== false) {
                res.statusCode = typeof code === 'number' ? code : 403;
                res.end();
                return;
              }
            }
          }
          await handler(req, res);
        } catch (e) {
          log(`API 失败：${e?.message ?? e}`);
          try { sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }); } catch {}
        }
      },
    });
    if (d) disposers.push(d);
  }

  route('prefix', API_PREFIX, async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;

    if (p === `${API_PREFIX}/graph`) {
      const r = await fetch(`${base}/api/graph`);
      sendJson(res, 200, await r.json());
      return;
    }
    if (p === `${API_PREFIX}/trace`) {
      const r = await fetch(`${base}/api/trace`);
      sendJson(res, 200, await r.json());
      return;
    }
    if (p === `${API_PREFIX}/allow`) {
      if (req.method === 'GET') {
        const r = await fetch(`${base}/api/allow`);
        sendJson(res, 200, await r.json());
      } else {
        const body = await readBody(req);
        const r = await fetch(`${base}/api/allow`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        sendJson(res, 200, await r.json());
      }
      return;
    }
    if (p === `${API_PREFIX}/health`) {
      const r = await fetch(`${base}/health`);
      sendJson(res, 200, await r.json());
      return;
    }
    if (p === `${API_PREFIX}/update` && req.method === 'GET') {
      sendJson(res, 200, await checkUpdate({
        force: url.searchParams.get('force') === '1',
      }));
      return;
    }
    if (p === `${API_PREFIX}/model`) {
      if (!modelManager) {
        sendJson(res, 200, { ok: false, error: '模型切换未初始化' });
        return;
      }
      if (req.method === 'GET') {
        try {
          sendJson(res, 200, { ok: true, ...(await modelManager.getModelInfo()) });
        } catch (e) {
          sendJson(res, 200, { ok: false, error: String(e?.message || e) });
        }
        return;
      }
      try {
        const body = await readBody(req);
        const info = await modelManager.setModel(body);
        sendJson(res, 200, { ok: true, ...info });
      } catch (e) {
        sendJson(res, 200, { ok: false, error: String(e?.message || e) });
      }
      return;
    }

    // 数据目录 / 逻辑图备份与恢复（本机文件操作，不经过 Python 服务）
    if (p === `${API_PREFIX}/data` && req.method === 'GET') {
      sendJson(res, 200, dataInfo());
      return;
    }
    if (p === `${API_PREFIX}/data/backup` && req.method === 'POST') {
      const body = await readBody(req);
      sendJson(res, 200, await backupGraph(body.name));
      return;
    }
    if (p === `${API_PREFIX}/data/restore` && req.method === 'POST') {
      const body = await readBody(req);
      sendJson(res, 200, await restoreGraph(body.name, { memoryEndpoint: base }));
      return;
    }
    if (p === `${API_PREFIX}/data/migrate` && req.method === 'POST') {
      const body = await readBody(req);
      const result = await migrateData(body.path);
      // 指针已经改好；尽量让旧 8317 退出，避免重启 DSH 后它继续占着端口用旧目录。
      try {
        const r = await fetch(`${base}/api/shutdown`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
          signal: AbortSignal.timeout(8000),
        });
        result.serviceStopped = r.ok;
      } catch {
        result.serviceStopped = false;
      }
      if (!result.serviceStopped) {
        const stop = await stopMemoryService(Number(new URL(base).port || 8317));
        result.serviceStopped = !!stop.stopped;
        if (stop.reason) result.serviceStopReason = stop.reason;
      }
      sendJson(res, 200, result);
      return;
    }
    if (p === `${API_PREFIX}/data/pick-dir` && req.method === 'POST') {
      await readBody(req);
      sendJson(res, 200, await pickDirectory());
      return;
    }
    if (p === `${API_PREFIX}/seg`) {
      const r = await fetch(`${base}/api/seg`, {
        method: req.method,
        headers: req.method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
        body: req.method === 'POST' ? JSON.stringify(await readBody(req)) : undefined,
      });
      const payload = await r.json();
      if (req.method === 'GET' && payload?.ok && modelManager) {
        try {
          const info = await modelManager.getModelInfo();
          const ready = new Map((payload.providers || [])
            .map((x) => [x.provider, x]));
          const providers = [];
          for (const g of info.groups || []) {
            // 账号登录 provider 没有可直接调用的 API Key，不列进切分列表。
            if (g.id === 'deepseek-account') continue;
            const p = ready.get(g.id);
            if (!p) continue;
            for (const m of g.models || []) {
              providers.push({
                ...p,
                label: g.name || p.label,
                model: m.id,
                modelName: m.name || m.id,
                ready: true,
              });
            }
          }
          if (providers.length) {
            const cur = payload.current || {};
            const hit = providers.find((x) => x.provider === cur.provider && x.model === cur.model);
            payload.providers = providers;
            payload.current = hit || { ...providers[0], provider: providers[0].provider, model: providers[0].model };
            payload.groups = (info.groups || [])
              .filter((g) => g.id !== 'deepseek-account' && ready.has(g.id));
          }
        } catch (e) {
          log(`切分模型目录合并失败：${e?.message || e}`);
        }
      }
      sendJson(res, 200, payload);
      return;
    }
    if (p === `${API_PREFIX}/thresholds`) {
      const r = await fetch(`${base}/api/thresholds`, {
        method: req.method,
        headers: req.method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
        body: req.method === 'POST' ? JSON.stringify(await readBody(req)) : undefined,
      });
      sendJson(res, 200, await r.json());
      return;
    }

    // 以下几个是后加的：节点详情、人设、设置、落盘。
    // 之前忘了往这里补，前端就一律 404 —— 表现是「读取失败」。
    const passthrough = [
      ['/node', '/api/node', ['GET']],
      ['/persona', '/api/persona', ['GET', 'POST']],
      ['/settings', '/api/settings', ['GET', 'POST']],
      ['/consolidate', '/api/consolidate', ['POST']],
      ['/node/update', '/api/node/update', ['POST']],
      ['/node/add', '/api/node/add', ['POST']],
      ['/node/delete', '/api/node/delete', ['POST']],
      ['/node/restore', '/api/node/restore', ['POST']],
      ['/trash', '/api/trash', ['GET']],
      ['/owner', '/api/owner', ['GET', 'POST']],
      ['/self', '/api/self', ['GET', 'POST']],
      ['/staging/list', '/api/staging/list', ['GET']],
      ['/staging/get', '/api/staging/get', ['GET']],
      ['/staging/update', '/api/staging/update', ['POST']],
      ['/staging/delete', '/api/staging/delete', ['POST']],
      ['/staging/add', '/api/staging/add', ['POST']],
      ['/staging/commit', '/api/staging/commit', ['POST']],
      ['/staging/discard', '/api/staging/discard', ['POST']],
      // Web 控制台的召回测试：列表类 / 关联类，直接打到记忆服务的双召回接口
      ['/search', '/recall_semantic', ['POST']],
      ['/recall', '/recall_logic', ['POST']],
    ];
    for (const [suffix, target, methods] of passthrough) {
      if (p !== `${API_PREFIX}${suffix}`) continue;
      if (!methods.includes(req.method)) {
        sendJson(res, 405, { ok: false, error: '方法不允许' });
        return;
      }
      const url = new URL(req.url, 'http://127.0.0.1');
      const url2 = `${base}${target}${url.search}`;
      if (req.method === 'GET') {
        const r = await fetch(url2);
        sendJson(res, 200, await r.json());
      } else {
        const body = await readBody(req);
        const r = await fetch(url2, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        sendJson(res, 200, await r.json());
      }
      return;
    }

    sendJson(res, 404, { ok: false, error: '未知接口' });
  });

  return () => {
    for (const d of disposers) {
      try { d?.(); } catch {}
    }
  };
}
