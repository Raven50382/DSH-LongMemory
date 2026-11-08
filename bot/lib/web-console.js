// Web 控制台：把一个独立的可视化页面挂到 DSH 的 webServer 上。
//
// 为什么单独做页面，而不是把设置页塞满：
//   DSH 设置页是嵌在宿主里的，空间有限、主题也受宿主影响。有些事（看整张
//   逻辑图、翻章动回放、对比历史召回）需要一个真正铺得开的画布。所以这里
//   只做「补充入口」：设置页保留原样，想深入看的时候点链接过来。
//
// 路由：/xliens/web 及其下的静态资源（index.html / styles.css / app.js）。
// 数据仍然走 /xliens/api/*，不在这里另开一套接口。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 页面根目录：<插件>/web。 */
export const WEB_CONSOLE_DIR = path.resolve(HERE, '..', 'web');

/** 对外路径前缀。DSH 的 prefix 路由要求 pathname 等于它或以它 + '/' 开头。 */
export const WEB_CONSOLE_PATH = '/xliens/web';

// 只服务白名单里的文件。不用「拼路径再判断」是因为任何一次目录穿越
// 的疏漏都会把插件目录暴露出去；白名单从源头就没有这个面。
const ASSETS = new Map([
  ['', 'index.html'],
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/styles.css', 'styles.css'],
  ['/app.js', 'app.js'],
]);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

const isLoopback = (req) => {
  const a = req.socket?.remoteAddress ?? '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
};

function sendText(res, code, text) {
  const data = Buffer.from(String(text), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(data);
}

/** 把 URL 路径换成白名单里的相对文件名；不合法返回 null。 */
export function resolveAsset(urlPath) {
  let sub = String(urlPath || '');
  if (sub.startsWith(WEB_CONSOLE_PATH)) sub = sub.slice(WEB_CONSOLE_PATH.length);
  // /xliens/web/ -> '/', /xliens/web/index.html -> '/index.html'
  if (sub === '') sub = '/';
  if (sub.length > 1) sub = sub.replace(/\/+$/, '');
  return ASSETS.get(sub) ?? null;
}

/** 创建只读静态处理器。单独导出，方便不启动 DSH 也能做冒烟测试。 */
export function createWebConsoleHandler({
  root = WEB_CONSOLE_DIR,
  log = () => {},
  consoleToken = '',
} = {}) {
  const rootAbs = path.resolve(root);
  const token = String(consoleToken || '').replace(/[^A-Za-z0-9_-]/g, '');

  return async function handle(req, res) {
    try {
      if (!isLoopback(req)) {
        sendText(res, 403, '只接受本机回环访问');
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        sendText(res, 405, '只支持 GET / HEAD');
        return;
      }

      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const rel = resolveAsset(url.pathname);
      if (!rel) {
        sendText(res, 404, '页面不存在');
        return;
      }

      const file = path.resolve(rootAbs, rel);
      // 白名单已经挡住了穿越，这里再兜一层，防止以后有人改 ASSETS 时写错。
      if (file !== rootAbs && !file.startsWith(rootAbs + path.sep)) {
        sendText(res, 403, '非法路径');
        return;
      }

      let data = await fs.promises.readFile(file);
      // 静态页把本进程的 console token 写进 <meta>，页面 fetch 时带上；
      // 这样即使 Web 控制台开在没有 DSH 登录 cookie 的系统浏览器里，
      // /xliens/api 也能用一个只对本地页面可见的 token 通过。
      if (rel === 'index.html') {
        const html = data.toString('utf8')
          .replace('__XLIENS_CONSOLE_TOKEN__', token);
        data = Buffer.from(html, 'utf8');
      }
      const type = TYPES[path.extname(file)] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': data.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        // 页面自身只需要同源 fetch / 样式。内联 style 用于动态主题变量。
        'Content-Security-Policy': [
          "default-src 'self'",
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data:",
          "font-src 'self' data:",
          "connect-src 'self'",
          "object-src 'none'",
          "base-uri 'none'",
          "form-action 'none'",
          "frame-ancestors 'none'",
        ].join('; '),
      });
      if (req.method === 'HEAD') res.end();
      else res.end(data);
    } catch (e) {
      log(`Web 控制台请求失败：${e?.message ?? e}`);
      if (!res.headersSent) sendText(res, 500, '控制台页面加载失败');
      else {
        try { res.destroy(); } catch {}
      }
    }
  };
}

/** 注册到 DSH webServer，返回一个卸载函数。 */
export function registerWebConsole({
  ctx,
  root = WEB_CONSOLE_DIR,
  basePath = WEB_CONSOLE_PATH,
  log = () => {},
  consoleToken = '',
} = {}) {
  if (!ctx?.webServer?.register) {
    throw new Error('缺少 webServer 服务，无法挂载 Web 控制台');
  }
  const handler = createWebConsoleHandler({ root, log, consoleToken });
  const dispose = ctx.webServer.register({
    kind: 'prefix',
    path: basePath,
    handler,
  });
  return () => {
    try { dispose?.(); } catch {}
  };
}
