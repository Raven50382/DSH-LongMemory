// 工具守卫：QQ 会话只允许白名单里的工具。
//
// 为什么必须有：DSH 默认 preset 带 bash / 文件读写 / 联网，
// 一旦会话落到默认 preset，群里任何人都能借机器人读本机文件。
//
// 两条重要教训（都在这上面栽过）：
//   1. 访问 ctx.tools 必须声明 inject = ['tools']，否则抛
//      "cannot get property tools without inject"，而且这个错会把
//      整个 preset 拖垮 —— 表现是 QQ 消息进得来但投递失败。
//   2. 即使声明了，也不能让 apply 抛任何错：preset 里任何一个插件炸了，
//      整条会话就建不起来。所以下面全部包在 try/catch 里。
//
// 放行的都是只读或对外沟通类：
//   mcp__snowluma__        收发 QQ 消息、看群成员
//   mcp__xliens__          记忆召回（只读查询）
//   mcp__web-search-safe__ 联网搜索/抓取（防 SSRF 的版本）
//   ask_user_question      把问题转给管理员
//   todo_write             任务列表

const SAFE_PREFIXES = [
  'mcp__snowluma__',
  'mcp__xliens__',
  'mcp__web-search-safe__',
];

const SAFE_EXACT = new Set([
  'ask_user_question',
  'todo_write',
]);

export const name = 'xliens-tool-guard';

export const inject = ['tools'];

export function apply(ctx) {
  try {
    if (!ctx?.tools || typeof ctx.tools.guard !== 'function') {
      // 工具服务不可用时不要抛：宁可这个守卫不生效，也不能让会话建不起来
      try { console.error('[xliens-tool-guard] ctx.tools 不可用，跳过守卫'); } catch {}
      return;
    }
    ctx.tools.guard((exec) => {
      const n = exec?.name;
      if (typeof n !== 'string' || n.length === 0) {
        return '工具名无效，已拒绝';
      }
      if (SAFE_EXACT.has(n)) return undefined;
      if (SAFE_PREFIXES.some((p) => n.startsWith(p))) return undefined;
      return `工具 "${n}" 不在 QQ 记忆机器人白名单内，已拒绝`
        + '（仅允许 QQ 工具、记忆召回、安全搜索与无害模型侧工具）';
    });
  } catch (e) {
    try { console.error('[xliens-tool-guard] 初始化失败（已忽略）：', e?.message ?? e); } catch {}
  }
}
