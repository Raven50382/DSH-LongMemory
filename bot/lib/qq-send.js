// 直接调 SnowLuma 的 OneBot HTTP API 发消息。
//
// 为什么不复用旧版桥接的 qq_* 工具：那些工具要走旧版桥接（127.0.0.1:3100），
// 而我们已经把旧版桥接从 profile 移除了 —— 桥接不在，工具全废。
// SnowLuma 本身的 OneBot HTTP（3000）是现成的，直接用最简单。
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_HTTP = 'http://127.0.0.1:3000';

/** 从 file/snowluma.ws 读 wsUrl + token，推出 HTTP 端点。 */
function readCred(file) {
  try {
    const lines = fs.readFileSync(file, 'utf8')
      .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const wsUrl = lines[0] || '';
    const token = lines[1] || '';
    // ws://127.0.0.1:3001 -> http://127.0.0.1:3000（OneBot 惯例：WS 端口 -1）
    let httpBase = DEFAULT_HTTP;
    const m = /^ws:\/\/([^:/]+):?(\d+)?/.exec(wsUrl);
    if (m) {
      const host = m[1];
      const port = m[2] ? Number(m[2]) - 1 : 3000;
      httpBase = `http://${host}:${port}`;
    }
    return { httpBase, token };
  } catch {
    return { httpBase: DEFAULT_HTTP, token: '' };
  }
}

export function createQqSender({ credentialFile } = {}) {
  const file = credentialFile
    || path.join(process.cwd(), 'file', 'snowluma.ws');
  let cached = null;

  function cred() {
    if (!cached) cached = readCred(file);
    return cached;
  }

  async function call(action, params) {
    const { httpBase, token } = cred();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const r = await fetch(`${httpBase}/${action}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(params),
        signal: ctrl.signal,
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data?.status === 'failed') {
        throw new Error(`OneBot ${action} 失败：${data?.message || data?.wording || r.status}`);
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 发一条或多条消息到指定会话。
   * session 形如 "private:10001" / "group:100000000"。
   */
  /**
   * 出口兜底：我们自己用【】做系统标记（【主人】【本批判定】【我是】【发送】…）。
   * 万一模型把提示词结构复述出来，别原样发到群里——换成中性写法。
   * 这是确定性过滤，不指望模型自觉。
   */
  function stripSystemTags(text) {
    return String(text ?? '')
      .replace(/【(主人|本批判定|我是|发送|记忆规则|重要|在场|当前时间|QQ 群|QQ 私聊)】/g, '')
      .replace(/^\s*以下是新消息：\s*$/gm, '')
      .trim();
  }

  async function send(session, messages, { replyTo } = {}) {
    const m = /^(private|group):(.+)$/.exec(String(session ?? ''));
    if (!m) throw new Error(`session 格式不对：${session}（应为 private:QQ号 或 group:群号）`);
    const [, kind, id] = m;
    const list = Array.isArray(messages) ? messages : [messages];
    const sent = [];
    for (const text of list) {
      const body = stripSystemTags(text);
      if (!body.trim()) continue;
      const params = kind === 'group'
        ? { group_id: Number(id), message: body }
        : { user_id: Number(id), message: body };
      if (replyTo) {
        params.message = [{ type: 'reply', data: { id: String(replyTo) } },
                          { type: 'text', data: { text: body } }];
      }
      const r = await call(kind === 'group'
        ? 'send_group_msg' : 'send_private_msg', params);
      sent.push({ id: r?.data?.message_id ?? null });
      // 多条之间稍作间隔，像真人打字
      if (list.length > 1) {
        await new Promise((res) => setTimeout(res, 400 + Math.random() * 600));
      }
    }
    return sent;
  }

  return { send, call, cred };
}
