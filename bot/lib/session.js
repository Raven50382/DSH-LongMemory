// DSH 会话管理：给机器人用。
//
// 三件事（对应 docs/机器人集成_设计.md 第六章）：
//   1. 所有机器人会话归同一个 workspace（从第一版就统一，不做分三处再合并）
//   2. 会话标题有意义（私聊 · 角色A / 群 · 名称(id) / 黑话学习 · 名称）
//   3. 会话复用：同一个 key 不重复建，DSH 侧失效了就重建
//
// 注意 DSH 的一个硬约束：session/create 里 workspaceId 与 cwd 互斥。
// 加入工作区 = 用工作区的 path 作为 cwd。
//
// 同一个群的多个实例可能重复建会话：
//   · 缓存文件原来放在 process.cwd()/file，DSH 不同启动方式下 cwd 会变，
//     于是每个进程都以为自己是第一次运行，各建一个会话。现在优先落
//     <仓库>/file/sessions.json，同时兼容读取旧的 cwd 路径。
//   · 缓存保存改成「先读盘再合并」，一个进程不会拿自己内存里的半张表
//     覆盖掉另一个进程刚写进去的映射。
//   · 新建会话时传一个由 key 推导出的稳定 sessionId，DSH 的 create 会
//     复用它（reusable 检查），多进程同时启动也只会有一个。
//   · 启动时列一遍机器人工作区的会话，按标题 / 首条 QQ 消息识别 key，
//     把同 key 的旧窗口归档，只留缓存里的那个（或最新的）。

import fs from 'node:fs';
import path from 'node:path';
import { FILE_DIR, ROOT } from './paths.js';

/** 会话 key 的规范形式：private:<QQ> / group:<群号> */
export function sessionKey(kind, id) {
  return `${kind}:${String(id)}`;
}

export function parseKey(key) {
  const m = /^(private|group):(.+)$/.exec(String(key ?? ''));
  return m ? { kind: m[1], id: m[2] } : { kind: 'private', id: String(key ?? '') };
}

/** 把标题模板里的占位符替换掉。 */
export function renderTitle(template, vars) {
  return String(template || '').replace(/\{(\w+)\}/g, (_, k) =>
    (vars[k] === undefined || vars[k] === null ? '' : String(vars[k])));
}

function normPath(p) {
  try { return path.resolve(String(p)).toLowerCase(); } catch { return ''; }
}

function isNotFound(e) {
  const s = `${e?.code ?? ''} ${e?.message ?? e}`;
  return /not[- _]?found|404|session\/not-found/i.test(s);
}

/** 从群标题里解析群号：群 · 名称(100000000) → group:100000000 */
export function keyFromTitle(title) {
  const s = String(title ?? '').trim();
  const g = /^群\s*[·・]\s*.*[\(（](\d+)[\)）]\s*$/.exec(s);
  if (g) return `group:${g[1]}`;
  if (s === '落盘') return 'system:consolidate';
  return null;
}

/** 旧版私聊会话标题没有 QQ 号，从首条 prompt 的【QQ 私聊】里补。 */
export function keyFromSessionEvents(events) {
  for (const e of events || []) {
    if (e?.type !== 'user/message') continue;
    const content = e.data?.content;
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((x) => (typeof x === 'string' ? x : x?.text || '')).join(' ')
        : '';
    const pr = /QQ\s*私聊[】\]]\s*(\d+)/.exec(text);
    if (pr) return `private:${pr[1]}`;
    const gr = /QQ\s*群消息[】\]]\s*[^\d]*(\d+)/.exec(text);
    if (gr) return `group:${gr[1]}`;
  }
  return null;
}

/** 一个由 key 推导的稳定 sessionId。多进程同时启动也只会建同一个。 */
export function stableSessionId(key) {
  const safe = String(key)
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'misc';
  return `session-xliens-${safe}`;
}

export function createSessionManager({ api, config, log = () => {} }) {
  const cfg = config ?? {};
  const workspacePath = path.resolve(
    cfg.workspace?.path || path.join(ROOT, '.xliens-workspace'));
  const workspaceTitle = cfg.workspace?.title || '机器人';
  const dedupeEnabled = cfg.sessionDedupe !== false;

  let workspaceId = null;
  let workspacePromise = null;
  const sessionCache = new Map();   // key -> sessionId
  const dirtyKeys = new Set();      // 本进程刚写入/更新过的 key
  const deletedKeys = new Set();    // 本进程作废掉的 key
  const modelReady = new Set();     // 本进程已经确认过模型的 sessionId

  // 主缓存固定在仓库 file/ 下；旧代码用的 process.cwd()/file 继续兼容读取，
  // 但只往主缓存写，避免旧路径散落在插件目录里。
  const primaryCache = path.resolve(
    cfg.sessionCacheFile || path.join(FILE_DIR, 'sessions.json'));
  const legacyCache = cfg.sessionCacheLegacy === false
    ? null
    : path.resolve(cfg.sessionCacheLegacy || path.join(process.cwd(), 'file', 'sessions.json'));
  const readFiles = [...new Set([primaryCache, legacyCache].filter(Boolean))];
  const writeFiles = [primaryCache];

  function readCacheFile(file) {
    try {
      const st = fs.statSync(file);
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { file, mtime: st.mtimeMs, data };
    } catch {
      return null;
    }
  }

  function loadCache() {
    const records = [];
    for (const file of readFiles) {
      const r = readCacheFile(file);
      if (!r) continue;
      for (const [k, v] of Object.entries(r.data || {})) {
        if (typeof v === 'string' && v) records.push({ k, v, mtime: r.mtime });
      }
    }
    // 文件新的覆盖旧的；同一 key 只留一份
    records.sort((a, b) => a.mtime - b.mtime);
    for (const r of records) sessionCache.set(r.k, r.v);
    if (records.length) {
      log(`已恢复 ${sessionCache.size} 个会话映射（${readFiles.map((f) => path.basename(f)).join(' / ')}）`);
    }
  }

  /**
   * 保存缓存：先读盘，再把本进程改动合并进去。
   * 为什么要合并：DSH 可能同时存在多个插件实例，各自内存里只有自己见过的
   * key。直接覆盖会让另一个实例刚写的映射消失，下次重启就再建一个窗口。
   */
  function saveCache() {
    const merged = new Map();
    const disk = [];
    for (const file of readFiles) {
      const r = readCacheFile(file);
      if (!r) continue;
      for (const [k, v] of Object.entries(r.data || {})) {
        if (typeof v === 'string' && v) disk.push({ k, v, mtime: r.mtime });
      }
    }
    disk.sort((a, b) => a.mtime - b.mtime);
    for (const r of disk) merged.set(r.k, r.v);
    for (const [k, v] of sessionCache) {
      // 本进程改过的 key 优先；没改过的以盘上的为准，避免拿旧内存覆盖新映射。
      if (dirtyKeys.has(k) || !merged.has(k)) merged.set(k, v);
    }
    for (const k of deletedKeys) merged.delete(k);
    const body = JSON.stringify(Object.fromEntries(merged), null, 1);
    for (const file of writeFiles) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, body, 'utf8');
      } catch (e) {
        log(`保存会话映射失败（${file}）：${e?.message ?? e}`);
      }
    }
    dirtyKeys.clear();
    deletedKeys.clear();
  }

  function remember(key, sid) {
    sessionCache.set(key, sid);
    dirtyKeys.add(key);
    deletedKeys.delete(key);
  }

  loadCache();

  /** 幂等创建/复用机器人专用工作区。 */
  function ensureWorkspace() {
    if (workspaceId) return Promise.resolve(workspaceId);
    if (workspacePromise) return workspacePromise;
    workspacePromise = (async () => {
      fs.mkdirSync(workspacePath, { recursive: true });
      const r = await api.workspace.create({ path: workspacePath });
      const ws = r?.workspace ?? r;
      const id = ws?.workspaceId ?? ws?.id ?? null;
      if (!id) throw new Error('workspace.create 没有返回 workspaceId');
      workspaceId = id;
      // 不管是不是新建都设一次标题：复用旧工作区时也要保证名字是对的。
      try {
        await api.workspace.rename({ workspaceId: id, title: workspaceTitle });
      } catch (e) {
        log(`工作区重命名失败（不影响使用）：${e?.message ?? e}`);
      }
      log(`机器人工作区就绪：${workspaceTitle} (${id})`);
      return id;
    })().finally(() => { workspacePromise = null; });
    return workspacePromise;
  }

  function isArchived(sid) {
    try {
      const ids = api.workspace?.archivedSessionIds;
      return Array.isArray(ids) && ids.includes(sid);
    } catch {
      return false;
    }
  }

  /**
   * 探活：会话还在不在。
   * 先 get（活着的最快）；冷的持久化会话 get 不到，再用 inspect 确认。
   * 不用 selectModel 当探针，否则每条消息都会重新选一次模型。
   */
  async function probeSession(sid) {
    if (isArchived(sid)) return false;
    const sc = api.sessions;

    if (typeof sc?.get === 'function') {
      try {
        const r = await sc.get(sid);
        if (r) return true;
      } catch (e) {
        if (isNotFound(e)) return false;
        // 其它错误继续往下探，别因为临时故障丢掉好会话
      }
    }

    if (typeof sc?.inspect === 'function') {
      try {
        const r = await sc.inspect(sid);
        return !!r;
      } catch (e) {
        if (isNotFound(e)) return false;
        return true;
      }
    }

    // 老 DSH 兜底：selectModel 探测（会顺带应用模型）
    if (typeof sc?.selectModel !== 'function') return true;
    try {
      await applyModel(sid);
      return true;
    } catch (e) {
      if (isNotFound(e)) return false;
      return true;
    }
  }

  /** 给会话选中模型：优先用 DSH 的默认模型，其次用配置里指定的。 */
  async function applyModel(sid) {
    const sc = api.sessions;
    let def = null;
    try {
      if (typeof sc.modelCatalog === 'function') {
        def = (await sc.modelCatalog())?.default ?? null;
      } else if (typeof sc.callUnary === 'function') {
        def = (await sc.callUnary('session.modelCatalog', {}))?.default ?? null;
      }
    } catch (e) {
      log(`读取模型目录失败：${e?.message ?? e}`);
    }
    def = def ?? cfg.model ?? null;
    if (!def?.provider || !def?.model) {
      log('⚠️ 没能确定会话模型，投递很可能被拒（可在配置里指定 bridge.model）');
      return;
    }
    try {
      const req = { sessionId: sid, provider: String(def.provider),
                    model: String(def.model) };
      if (def.reasoningEffort) req.reasoningEffort = String(def.reasoningEffort);
      await sc.selectModel(req);
      log(`会话模型：${req.provider}/${req.model}`
        + (req.reasoningEffort ? ` (${req.reasoningEffort})` : ''));
    } catch (e) {
      log(`设置会话模型失败：${e?.message ?? e}`);
    }
  }

  /**
   * 启动时清一遍同 key 的重复窗口。
   *
   * 旧版本可能已经给同一个群建了 4 个会话；光靠缓存不再新建是不够的，
   * 界面里那 4 个还在。这里用 sessionController.list + inspect 读标题
   * （群标题带群号；私聊旧标题没有号，就从首条【QQ 私聊】里读），
   * 同 key 只留一个：优先正在跑的，其次缓存里的，最后最新的。
   * 其余用 workspaceController.archiveSession 归档（不是删除，可还原）。
   */
  let dedupeDone = false;
  let dedupePromise = null;

  function dedupeOnce() {
    if (dedupePromise) return dedupePromise;
    if (dedupeDone) return Promise.resolve();
    dedupePromise = (async () => {
      if (!dedupeEnabled) { dedupeDone = true; return; }
      const sc = api.sessions;
      if (typeof sc?.list !== 'function' || typeof sc?.inspect !== 'function'
        || typeof api.workspace?.archiveSession !== 'function') {
        log('会话去重跳过：当前 DSH 缺少 list / inspect / archiveSession');
        dedupeDone = true;
        return;
      }

      let items = [];
      try {
        const r = await sc.list({});
        items = Array.isArray(r?.items) ? r.items : Array.isArray(r) ? r : [];
      } catch (e) {
        log(`会话去重跳过：读取会话列表失败（${e?.message ?? e}）`);
        dedupeDone = true;
        return;
      }

      const target = normPath(workspacePath);
      const mine = items.filter((it) => it?.cwd && normPath(it.cwd) === target);
      if (mine.length === 0) { dedupeDone = true; return; }

      const groups = new Map();
      const all = [];
      for (const it of mine) {
        let title = '';
        let key = null;
        let blank = it.blank === true;
        try {
          const info = await sc.inspect(it.sessionId);
          const events = info?.events || [];
          blank = blank || !events.some((e) => e?.type === 'user/message');
          for (let i = events.length - 1; i >= 0; i--) {
            if (events[i]?.type === 'session/title') {
              title = String(events[i].data?.title || '');
              break;
            }
          }
          key = keyFromTitle(title) || keyFromSessionEvents(events);
        } catch (e) {
          log(`读取会话标题失败：${it.sessionId}（${e?.message ?? e}）`);
          continue;
        }
        const row = { ...it, title, key, blank };
        all.push(row);
        if (!key) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
      }

      let archived = 0;
      const archive = async (it, label) => {
        try {
          await api.workspace.archiveSession(it.sessionId);
          archived++;
          log(`归档重复会话：${label} → ${it.sessionId}「${it.title || '(无标题)'}」`);
          return true;
        } catch (e) {
          log(`归档失败（可能仍在运行）：${it.sessionId}：${e?.message ?? e}`);
          return false;
        }
      };

      for (const [key, list] of groups) {
        list.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
        const cachedId = sessionCache.get(key);
        const keeper = list.find((x) => x.running)
          || (cachedId ? list.find((x) => x.sessionId === cachedId) : null)
          || list[0];
        for (const it of list) {
          if (it.sessionId === keeper.sessionId || it.running) continue;
          await archive(it, key);
        }
        remember(key, keeper.sessionId);
        log(`会话去重：${key} 保留 ${keeper.sessionId}「${keeper.title || '(无标题)'}」`
          + (list.length > 1 ? `，归档 ${list.length - 1} 个` : ''));
      }

      // 空会话（建出来但从没收到过消息）没有 key，但同名的一堆也会占窗口。
      // 如果同标题已经有一个有内容的 keyed 会话，全归档；否则只留最新一个。
      const blankByTitle = new Map();
      for (const it of all) {
        if (it.key || !it.blank || !it.title) continue;
        if (!blankByTitle.has(it.title)) blankByTitle.set(it.title, []);
        blankByTitle.get(it.title).push(it);
      }
      for (const [title, list] of blankByTitle) {
        if (list.length <= 1) continue;
        const keyedSame = [...groups.values()].flat()
          .filter((x) => x.title === title && x.sessionId);
        list.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
        const keeper = keyedSame[0] || list.find((x) => x.running) || list[0];
        for (const it of list) {
          if (it.sessionId === keeper.sessionId || it.running) continue;
          await archive(it, `空会话「${title}」`);
        }
        log(`空会话去重：${title} 保留 ${keeper.sessionId}` + (keyedSame.length ? '（有内容的会话）' : ''));
      }

      if (archived || groups.size || blankByTitle.size) saveCache();
      dedupeDone = true;
    })().catch((e) => {
      log(`会话去重异常（不影响使用）：${e?.message ?? e}`);
      dedupeDone = true;
    }).finally(() => { dedupePromise = null; });
    return dedupePromise;
  }

  /** 每个会话本进程只选一次模型；之后复用不再反复 selectModel。 */
  async function ensureModel(sid) {
    if (modelReady.has(sid)) return;
    modelReady.add(sid);
    await applyModel(sid);
  }

  /**
   * 按 key 拿会话；不存在就建。
   *
   * ⚠️ agentPreset 是安全边界，不是可选项：
   * 不加 preset 的会话会落到 DSH 默认 preset，而默认 preset 带 bash / 文件读写，
   * 等于把本地工具暴露给 QQ 群里的任何人。所以**拿不到 preset 就拒绝建会话**
   * （fail-closed）。
   */
  async function ensureSession(key, { title, agentPreset } = {}) {
    const preset = agentPreset || cfg.bridge?.agentPreset;
    if (!preset) {
      throw new Error(
        `拒绝为 ${key} 建会话：没有指定 agentPreset。`
        + 'DSH 默认 preset 带本地工具，绝不能用于 QQ 会话。'
        + '请在配置里设置 bridge.agentPreset（如 xliens-chat）。');
    }

    let cached = sessionCache.get(key);
    if (cached) {
      const alive = await probeSession(cached);
      if (alive) {
        await ensureModel(cached);
        return cached;
      }
      log(`会话 ${key} 在 DSH 侧已不存在，重建`);
      sessionCache.delete(key);
      deletedKeys.add(key);
      saveCache();
    }

    const wid = await ensureWorkspace();
    await dedupeOnce();

    // 去重时可能已经把 key 补进了缓存；再确认一次，避免又多建一个。
    cached = sessionCache.get(key);
    if (cached && await probeSession(cached)) {
      await ensureModel(cached);
      return cached;
    }

    const stable = stableSessionId(key);
    let r;
    try {
      r = await api.sessions.create({
        workspaceId: wid,
        agentPreset: preset,
        sessionId: stable,
      });
    } catch (e) {
      // 稳定 id 对应的旧会话可能被归档、preset 变了，或者不在这个工作区。
      // 回退到随机 id 至少保证机器人能继续回复；缓存会记住新的。
      log(`按稳定 ID 创建会话失败（${stable}）：${e?.message ?? e}；回退随机 ID`);
      r = await api.sessions.create({ workspaceId: wid, agentPreset: preset });
    }
    const sid = r?.sessionId ?? r?.session?.id;
    if (!sid) throw new Error('sessions.create 没有返回 sessionId');

    if (title) {
      try {
        await api.sessions.rename({ sessionId: sid, title });
      } catch (e) {
        log(`会话重命名失败（不影响使用）：${e?.message ?? e}`);
      }
    }

    // ⚠️ 新建的会话**没有选中模型**，不设就会在 prompt 时报
    // "prompt rejected"（DSH 的 RemoteError 外壳是 session/agent-busy）——
    // 真实原因是 agent 没有可用模型，跟"忙"没关系。
    // 读 modelCatalog 的 default，调 selectModel 应用上去。
    await ensureModel(sid);

    // 跟随会话事件。sessionController 自己就有 follow 方法
    // （实测方法清单里有），比 ctx.events 更可靠，两个都试一下。
    try {
      if (typeof api.sessions?.follow === 'function') api.sessions.follow(sid);
      else api.events?.follow?.(sid);
    } catch { /* 非必需，失败也要能继续 */ }

    remember(key, sid);
    saveCache();
    log(`会话就绪：${key} → ${sid}${title ? ` 「${title}」` : ''}`);
    return sid;
  }

  /** 给一个 key 算出标题。 */
  function titleFor(key, { name } = {}) {
    const { kind, id } = parseKey(key);
    const t = cfg.sessionTitle ?? {};
    if (kind === 'group') {
      return renderTitle(t.group || '群 · {name}({id})',
        { name: name || id, id });
    }
    return renderTitle(t.private || '私聊 · {name}',
      { name: name || id, id });
  }

  /** 作废某个 key 的会话缓存：下次 ensureSession 会重建。 */
  function invalidate(key) {
    const had = sessionCache.delete(key);
    if (had) {
      deletedKeys.add(key);
      dirtyKeys.add(key);
      saveCache();
      log(`已作废会话缓存：${key}（下次会重建）`);
    }
    return had;
  }

  /**
   * 这个 agent 是不是 Xliens 机器人自己的会话。
   * 人设只该进这里，绝不能摸到用户正常的工作会话。
   *
   * 判据就是**工作目录**：会话 header 的 cwd 必须是机器人工作区。
   * 不再按 agentPreset 猜——用户正常会话也可能碰巧用同一个 preset，
   * 但工作目录不会是 `.bot-workspace`。没有 cwd 的会话也不冒险注入。
   */
  function isBotAgent(agent) {
    const header = agent?.session?.header ?? {};
    const cwd = header.cwd ?? agent?.options?.cwd;
    if (!cwd) return false;
    return normPath(cwd) === normPath(workspacePath);
  }

  /** 启动时调用：确保工作区 + 清一次重复窗口。失败不影响消息处理。 */
  let initialized = false;
  let initPromise = null;
  function initialize() {
    if (initialized) return Promise.resolve();
    if (initPromise) return initPromise;
    initPromise = (async () => {
      await ensureWorkspace();
      await dedupeOnce();
      initialized = true;
    })().catch((e) => {
      log(`会话初始化失败（不影响使用）：${e?.message ?? e}`);
    }).finally(() => { initPromise = null; });
    return initPromise;
  }

  return {
    ensureWorkspace,
    ensureSession,
    dedupeOnce,
    initialize,
    isBotAgent,
    titleFor,
    parseKey,
    invalidate,
    workspacePath,
  };
}
