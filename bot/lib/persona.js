// 运行时人设：从 file/persona.md 读，改完立即生效（不用重启）。
//
// 关键：systemPrompt 是 **agent 作用域**的服务，不是全局的。
// 之前写成 ctx.systemPrompt.section()，拿到的是 undefined
// （日志里一直是「systemPrompt 服务不可用，跳过人设注入」）。
// 正确做法是给每个 agent 的 ctx 注册，并监听 agent/created。
import fs from 'node:fs';
import path from 'node:path';
import { FILE_DIR } from './paths.js';

function makeReader(personaFile, log) {
  let cache = { at: 0, text: '' };
  return function read() {
    try {
      const st = fs.statSync(personaFile);
      if (st.mtimeMs === cache.at) return cache.text;
      const text = fs.readFileSync(personaFile, 'utf8').trim();
      cache = { at: st.mtimeMs, text };
      return text;
    } catch {
      log(`人设文件读不到：${personaFile}`);
      return '';
    }
  };
}

/**
 * 给指定的 agent 注入人设段落，返回清理函数。
 *
 * 以前是「所有 agent 都注入」，结果普通工作会话也被塞了机器人
 * 人设。现在由 shouldApply(agent) 把关，只进 Xliens 机器人工作区的会话；
 * 普通工作会话不注入。没有 shouldApply 时才退回旧行为（全部注入）。
 */
export function registerPersona({ ctx, log = () => {}, file, shouldApply } = {}) {
  const personaFile = file || path.join(FILE_DIR, 'persona.md');
  const read = makeReader(personaFile, log);

  let agents = ctx?.agents;
  if (!agents && typeof ctx?.get === 'function') {
    try { agents = ctx.get('agents'); } catch { agents = null; }
  }
  if (!agents || typeof agents.list !== 'function') {
    log('agents 服务不可用，跳过人设注入');
    return null;
  }

  const installed = new Map();
  let skippedLogged = false;

  function install(agent) {
    if (!agent || installed.has(agent)) return;
    if (typeof shouldApply === 'function') {
      let ok = false;
      try { ok = !!shouldApply(agent); } catch { ok = false; }
      if (!ok) {
        if (!skippedLogged) {
          skippedLogged = true;
          log('人设只作用于 Xliens 机器人工作区的会话，普通会话跳过');
        }
        return;
      }
    }
    const sp = agent.ctx?.systemPrompt;
    if (!sp || typeof sp.section !== 'function') {
      log('该 agent 没有 systemPrompt.section，跳过');
      return;
    }
    try {
      const dispose = sp.section({
        name: 'xliens:persona',
        order: 30,
        text: () => read(),
      });
      installed.set(agent, dispose);
      log(`人设已注入 Xliens agent（${path.basename(personaFile)}，改完即时生效）`);
    } catch (e) {
      log(`人设注入失败：${e?.message ?? e}`);
    }
  }

  try {
    for (const a of agents.list()) install(a);
  } catch (e) {
    log(`遍历 agent 失败：${e?.message ?? e}`);
  }

  const offs = [];
  try {
    offs.push(ctx.on('agent/created', ({ agent }) => install(agent)));
    offs.push(ctx.on('agent/disposed', ({ agent }) => {
      const d = installed.get(agent);
      installed.delete(agent);
      try { d?.(); } catch { /* ignore */ }
    }));
  } catch (e) {
    log(`注册 agent 生命周期失败：${e?.message ?? e}`);
  }

  return () => {
    for (const off of offs) {
      try { off?.(); } catch { /* ignore */ }
    }
    for (const d of installed.values()) {
      try { d?.(); } catch { /* ignore */ }
    }
    installed.clear();
  };
}
