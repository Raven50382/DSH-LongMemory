// 记忆 MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 暴露两个工具，由模型自行决定何时调用、调哪个：
//   recall_semantic —— 列表类查询（有哪些 / 什么时候）
//   recall_logic    —— 关联 / 原因 / 后续类查询
//
// 设计原则（见 docs/双召回工具_规格.md）：
//   · 召回优先：宁可多给几条，让模型自己筛
//   · 延迟优先：轻量 1~2s、重量 3~5s，不做重试
//   · 失败降级：记忆服务不可用时返回可读的错误，绝不阻塞对话
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { SNOWLUMA_CRED } from './paths.js';
import { compactRecall } from './recall-output.js';
import { createMemoryClient } from './memory.js';
import { createQqSender } from './qq-send.js';

const ENDPOINT = process.env.XLIENS_ENDPOINT || 'http://127.0.0.1:8317';
const DEFAULT_SESSION = process.env.XLIENS_SESSION || '';

const client = createMemoryClient({ endpoint: ENDPOINT });
const qq = createQqSender({
  credentialFile: process.env.XLIENS_CRED || SNOWLUMA_CRED,
});

const server = new McpServer({ name: 'xliens', version: '0.1.0' });

/** 统一把结果塞成一个 text 块。 */
function asText(obj, isError = false) {
  return {
    content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1) }],
    ...(isError ? { isError: true } : {}),
  };
}

function failure(tool, error) {
  return asText(
    `记忆服务调用失败（${tool}）：${error?.message ?? error}\n`
    + `如果记忆服务没启动，请忽略这次失败，正常回复即可——不要向对方提这件事。`,
    true,
  );
}

function sessionOf(extra) {
  return (extra && String(extra).trim()) || DEFAULT_SESSION;
}

server.tool(
  'recall_semantic',
  '查「有哪些、什么时候」这类列表问题。'
  + '返回按时间倒序的事件列表，不含事件之间的关系。速度快（1~2 秒）。'
  + '如果对方问的是「为什么」「之后发生了什么」「和什么有关」，改用 recall_logic。'
  + '\n\n调用是内部动作：不要在回复里提「我查了记忆」这类话，'
  + '像正常人回想那样直接把内容说出来。'
  + '\n\n【eu 参数】把这句话拆成 1~2 个原子事件，写成「主体+动作+客体」：'
  + '8~18 字，只描述一个动作；用「主体」「客体」占位，不写人名；不知道客体就省略。'
  + '格式不对会导致召回不准。',
  {
    query: z.string().describe('对方的原话，仅供日志和兜底使用'),
    eu: z.union([z.string(), z.array(z.string())]).optional().describe('你拆出来的原子事件（推荐）'),
    session: z.string().optional().describe('当前会话标识（如 group:123456 / private:10001），用于限定记忆范围'),
    limit: z.number().int().min(1).max(50).optional().describe('最多返回几条，默认 10'),
  },
  async ({ query, eu, session, limit }) => {
    try {
      const r = await client.semantic(query, {
        session: sessionOf(session), limit, eu, forBot: true,
      });
      return asText(compactRecall(r));
    } catch (e) {
      return failure('recall_semantic', e);
    }
  },
);

server.tool(
  'recall_logic',
  '查「它们之间是什么关系」这类问题——原因、后果、前后发生了什么。'
  + '也用于你察觉到异常状态想主动联想时。'
  + '返回一个中心事件和它周围的关联事件，带关联度和跳数。'
  + '速度慢（3~5 秒），但能看到因果链。'
  + '注意看返回里的 confidence：low 说明关联很弱，你应该直接说记不清，不要当成真事说出来。'
  + '\n\n调用是内部动作：不要在回复里提「我查了记忆」这类话，'
  + '像正常人回想那样直接把内容说出来。',
  {
    query: z.string().describe('对方的原话，仅供日志和兜底使用'),
    eu: z.union([z.string(), z.array(z.string())]).optional().describe('你拆出来的原子事件（推荐）'),
    session: z.string().optional().describe('当前会话标识（如 group:123456 / private:10001）'),
    hops: z.number().int().min(1).max(3).optional().describe('向外扩几跳，默认 1'),
    max_neighbors: z.number().int().min(1).max(30).optional().describe('最多返回几个邻居，默认 7'),
  },
  async ({ query, eu, session, hops, max_neighbors: maxNeighbors }) => {
    try {
      const r = await client.logic(query, {
        session: sessionOf(session), hops, maxNeighbors, eu, forBot: true,
      });
      return asText(compactRecall(r));
    } catch (e) {
      return failure('recall_logic', e);
    }
  },
);

/**
 * 模型有时把 messages 写成 JSON 字符串（"["a","b"]"）而不是数组。
 * 不拆的话会原样发给 OneBot，SnowLuma 会当成 segment 数组去校验，
 * 解出来是字符串数组 → 报「message segment array entries must be objects」。
 */
function normalizeMessages(m) {
  if (typeof m !== 'string') return m;
  const s = m.trim();
  if (!(s.startsWith('[') && s.endsWith(']'))) return m;
  try {
    const arr = JSON.parse(s);
    if (Array.isArray(arr) && arr.length
        && arr.every((x) => typeof x === 'string' && x.trim())) {
      return arr;
    }
  } catch { /* 不是合法 JSON 就当普通文本 */ }
  return m;
}

server.tool(
  'qq_send',
  '把你说的话发到当前 QQ 会话。'
  + '**你的文字输出不会自动发送**——想说话就必须调用这个工具。'
  + '\n\n一次可以发一条或多条（数组），多条会像真人一样分开发。'
  + '\n\n参数 session 从每轮提示的【QQ 私聊】/【QQ 群】行里照抄。'
  + '\n\n不要说「已发送」这类汇报，直接说话就行。',
  {
    session: z.string().describe('会话标识，照抄提示里的（如 private:10001 / group:123456789）'),
    messages: z.union([z.string(), z.array(z.string())])
      .describe('要说的话。一个字符串=一条消息；数组=分多条发（最多 5 条）。'
        + '**必须传数组本身，不要传 JSON 字符串**'),
    replyTo: z.union([z.string(), z.number()]).optional()
      .describe('要引用的消息 id（可选）'),
  },
  async ({ session, messages, replyTo }) => {
    try {
      const norm = normalizeMessages(messages);
      const list = Array.isArray(norm) ? norm : [norm];
      if (list.length > 5) {
        return asText('一次最多发 5 条，请精简。', true);
      }
      const sent = await qq.send(sessionOf(session), list, { replyTo });
      return asText(`已发送 ${sent.length} 条`);
    } catch (e) {
      return asText(`发送失败：${e?.message ?? e}`, true);
    }
  },
);

server.tool(
  'consolidate',
  '把最近聊过、但还没整备的内容切分整理好（整备）。结果先暂存，' + '等用户在设置页确认后才落盘进图。'
  + '\n\n平时不需要你手动调——到整备时间段系统会提醒你调一次。'
  + '\n\n调用后会把待整备的消息切分成事件、算好上下文，'
  + '返回新增了多少事件和关联。耗时几十秒到几分钟，不要在同一轮里重复调。',
  {},
  async () => {
    try {
      const r = await client.consolidate();
      return asText(r);
    } catch (e) {
      return failure('consolidate', e);
    }
  },
);

server.tool(
  'memory_status',
  '查记忆服务是否在线、图有多大。用于排查「为什么召回不到」，平时不需要调用。',
  {},
  async () => {
    const h = await client.health();
    return asText(h);
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
