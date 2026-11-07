// 整备定时器：到点提醒 agent 调 consolidate 工具（整备 = 切分整理，结果落盘另一步）。
//
// 为什么不是插件直接调 HTTP：用户希望「整备过程也做成工具」，
// agent 有决定权（比如发现没什么可整理就可以跳过）。
// 这里只负责在时间窗口醒来，把提醒塞进一个专用的整备会话。
import { logInfo, logWarn } from './log.js';

function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * 启动整备定时器。
 * @param {object} opts
 * @param {string[]} opts.at  形如 ['03:00', '15:30']，24 小时制
 */
export function startConsolidateScheduler({
  at = [], sessions, api, agentPreset, log = logInfo, warn = logWarn,
  key = 'system:consolidate', promptText, getConfig,
} = {}) {
  // 配置每轮现取：UI 里改完立即生效，不用重启。
  // 现在是「起止时间窗口」而不是时间点列表：落在 [start, end] 之间就跑一次。
  // 支持跨夜（start > end，例如 23:30 ~ 00:30）。
  function currentConfig() {
    let c = null;
    try { c = getConfig?.(); } catch { c = null; }
    const src = c || {};
    const start = String(src.start ?? '').trim();
    const end = String(src.end ?? '').trim();
    return { start, end, enabled: (src.enabled ?? true) !== false };
  }

  /** 现在是否落在窗口内。 */
  function inWindow(conf, hhmm) {
    const { start, end } = conf;
    if (!start || !end) return false;
    if (start <= end) return hhmm >= start && hhmm <= end;
    // 跨夜
    return hhmm >= start || hhmm <= end;
  }

  const initial = currentConfig();
  if (!initial.start || !initial.end) {
    log('整备时间段未配置（可在设置 → 整备 里填起止时间）');
  } else {
    log(`整备时间段已启用：${initial.start} ~ ${initial.end}`);
  }
  let lastRun = '';
  let busy = false;

  async function tick() {
    if (busy) return;
    const conf = currentConfig();
    if (!conf.enabled) return;
    const hhmm = nowHHMM();
    if (!inWindow(conf, hhmm)) return;
    // 同一天同一个窗口只跑一次（用 start 做标识，窗口内多次 tick 不会重复）
    const stamp = `${todayKey()} ${conf.start}`;
    if (lastRun === stamp) return;
    busy = true;
    lastRun = stamp;
    try {
      log(`进入整备时间段（${conf.start}~${conf.end}，现在 ${hhmm}），通知 agent 整备`);
      const sid = await sessions.ensureSession(key, {
        title: '整备',
        agentPreset,
      });
      const ctrl = new AbortController();
      await api.sessions.prompt({
        requestId: crypto.randomUUID(),
        sessionId: sid,
        mode: 'queue',
        content: [{
          type: 'text',
          text: promptText
            || '【系统】到整备时间了。请调用 consolidate 工具，把最近聊过但还没整备的内容'
             + '整理进长期记忆。整理完不用回复我，直接结束这一轮。',
        }],
      }, ctrl.signal);
      log('整备提醒已投递');
    } catch (e) {
      warn(`整备提醒失败：${e?.message ?? e}`);
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(tick, 60 * 1000);
  // 启动 20 秒后先查一次（防止刚好在窗口内启动）
  const first = setTimeout(tick, 20000);

  return () => {
    clearInterval(timer);
    clearTimeout(first);
  };
}
