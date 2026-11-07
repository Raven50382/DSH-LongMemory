// 记忆服务的 HTTP 客户端。
// 失败一律「软失败」：返回 null / 抛带说明的 Error，由调用方决定怎么降级，
// 绝不让记忆服务的故障拖垮聊天。

const DEFAULT_TIMEOUT_MS = 15000;

export function createMemoryClient({ endpoint, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const base = String(endpoint || 'http://127.0.0.1:8317').replace(/\/+$/, '');

  async function post(path, body, timeout = timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const resp = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!resp.ok) {
        throw new Error(`记忆服务返回 HTTP ${resp.status}`);
      }
      return await resp.json();
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    base,

    async health(timeout = 5000) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeout);
        try {
          const resp = await fetch(`${base}/health`, { signal: ctrl.signal });
          return await resp.json();
        } finally {
          clearTimeout(timer);
        }
      } catch {
        return { ok: false };
      }
    },

    /**
     * 轻量召回：列表类查询（「有哪些、什么时候」）。
     * 返回按时间倒序的事件列表。
     */
    semantic(text, { session, limit, eu } = {}) {
      return post('/recall_semantic', { text, session, limit, eu });
    },

    /**
     * 重量召回：关联 / 原因 / 后续类查询。
     * 返回中心事件 + 周围关联事件（带关联度与跳数）。
     */
    logic(text, { session, hops, maxNeighbors, eu } = {}) {
      return post('/recall_logic', {
        text,
        session,
        hops,
        max_neighbors: maxNeighbors,
        eu,
      });
    },

    /**
     * 整备：把 pending 里的新聊天切分、算上下文、暂存。
     * 会跑几分钟，不能沿用默认 15s 超时。
     */
    consolidate() {
      return post('/api/consolidate', {}, 10 * 60 * 1000);
    },
  };
}
