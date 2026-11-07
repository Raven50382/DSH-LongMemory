// Xliens 机器人插件（host 半）。
//
// 职责：
//   · 会话管理：所有机器人会话归同一个工作区，标题有意义，按 key 复用
//   · 拉起 SnowLuma：DSH 关闭会连带关掉它，启动时又没人拉，所以由我们负责
//   · 桥接：接 SnowLuma 的 OneBot WS，把 QQ 消息攒批投给对应 DSH 会话
//
// 工具（recall_semantic / recall_logic / memory_status）由同包的 MCP server
// lib/mcp-memory.js 提供，在 profile 的 cordis.patch.yml 里以
// @deepseek-ai/dsh-mcp-client 注册——因为 @deepseek-ai/dsh-tools 不在
// 插件可解析的依赖里，原生 defineTool 走不通。

import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { logInfo, logWarn, LOG_PATH } from './log.js';
import { createMemoryClient } from './memory.js';
import { createSessionManager } from './session.js';
import { createBridge } from './bridge.js';
import { ensureSnowluma } from './snowluma-launch.js';
import { registerRoutes } from './api-routes.js';
import { registerWebConsole } from './web-console.js';
import { registerPersona } from './persona.js';
import { startConsolidateScheduler } from './consolidate-scheduler.js';
import { ensureMemory } from './memory-launch.js';
import { ROOT, DATA_ROOT, FILE_DIR, SNOWLUMA_CRED, ALLOW_FILE } from './paths.js';

export const name = 'xliens';

// workspace / webServer 都是 cordis 服务，不声明 inject 就访问会抛
// （踩过：cannot get property "workspace" without inject）
// 服务名必须和真实存在的对得上，否则 cordis 会一直等待注入、插件永远不 apply
// （踩过：写成 workspace，实际叫 workspaceController，界面一直不出现）
export const inject = [
  'webServer',
  'connection',
  'sessionController',
  'workspaceController',
  // 人设要用：systemPrompt 挂在 agent 作用域上，得先有 agents 才能遍历
  'agents',
];

const DEFAULTS = {
  enabled: true,
  // 设置页之外的可视化控制台：/xliens/web
  webConsole: true,
  // 启动时归档同一 key 的旧重复会话（只处理机器人工作区）
  sessionDedupe: true,
  memory: {
    endpoint: 'http://127.0.0.1:8317',
    timeoutMs: 15000,
    // 自动拉起 8317 时用的模型；要和 graph_main/meta.json 的 model 对得上
    model: 'models/reg_v48_s3',
  },
  workspace: { title: 'Xliens机器人', path: '' },
  sessionTitle: {
    private: '私聊 · {name}',
    group: '群 · {name}({id})',
    slang: '黑话学习 · {name}',
  },
  bridge: {
    enabled: true,
    wsUrl: 'ws://127.0.0.1:3001',
    accessToken: '',
    mergeWindowMs: 1500,
    maxBatch: 8,
    // 安全边界：QQ 会话必须挂带工具白名单的 preset，不许落 DSH 默认 preset
    agentPreset: 'xliens-chat',
    // SnowLuma 自动托管
    autoStartSnowluma: true,
    snowlumaHome: '',
    snowlumaHost: '127.0.0.1',
    snowlumaPort: 3001,
    // 连不上就隔一会儿再试，直到成功
    connectRetryMs: 10000,
    // 整备（切分整理）：到这个时间点会在专用会话里提醒 agent 调 consolidate
    consolidate: {
      enabled: true,
      at: ['03:00'],
    },
    // 会话模型兜底：读不到 DSH 默认模型时用这个（一般留空，交给 DSH）
    model: null,
    // 回复时机：默认只接点名 / 直接提问 / 关键词；群里普通聊天只记 pending
    reply: {
      enabled: true,
      mode: 'smart',
      ambientProbability: 0,
      cooldownMs: 45000,
      questions: true,
      keywords: [],
      // 群聊参与：不是每条都回，而是小概率进入一段讨论，之后可以自然接几句。
      // 参考旧版桥接的状态机，时间调短一些。
      social: {
        enabled: true,
        triggerProbability: 0.1,
        activeMs: 5 * 60 * 1000,
        skipProbability: 0.2,
        activeCooldownMs: 15000,
        graceMs: 30000,
      },
    },
  },
};

function mergeConfig(input) {
  const c = input ?? {};
  return {
    ...DEFAULTS,
    ...c,
    memory: { ...DEFAULTS.memory, ...(c.memory ?? {}) },
    workspace: { ...DEFAULTS.workspace, ...(c.workspace ?? {}) },
    sessionTitle: { ...DEFAULTS.sessionTitle, ...(c.sessionTitle ?? {}) },
    bridge: {
      ...DEFAULTS.bridge,
      ...(c.bridge ?? {}),
      reply: { ...DEFAULTS.bridge.reply, ...(c.bridge?.reply ?? {}) },
    },
  };
}

/**
 * 读白名单文件（设置页「白名单」标签写的就是它）。
 *
 * 踩过的坑：UI 存进 file/allow.json，桥接却只看 YAML 里的 bridge.allow，
 * 结果界面上明明加了人，消息还是被拦。现在每次判断都走这里，两边一致。
 * 带 mtime 缓存：文件没变就不重复解析。
 */
const allowCache = { at: 0, data: null };
function readAllowFile(path) {
  try {
    const st = fs.statSync(path);
    if (allowCache.data && st.mtimeMs === allowCache.at) return allowCache.data;
    const d = JSON.parse(fs.readFileSync(path, 'utf8'));
    const out = {
      groups: (d.groups ?? []).map(String),
      private: (d.private ?? []).map(String),
      allowAllWhenEmpty: d.allowAllWhenEmpty === true,
      denyUsers: (d.denyUsers ?? []).map(String),
    };
    allowCache.at = st.mtimeMs;
    allowCache.data = out;
    return out;
  } catch {
    return null;   // 文件不存在或不合法 -> 用 YAML 里的配置
  }
}

/**
 * 读本地凭证文件（不进 git）。格式：第一行 wsUrl，第二行 accessToken。
 * 这样 token 不会出现在仓库里，换账号只改这个文件。
 */
function readLocalSnowluma(file) {
  try {
    const lines = fs.readFileSync(file, 'utf8')
      .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (lines.length >= 2) return { wsUrl: lines[0], accessToken: lines[1] };
    if (lines.length === 1) return { accessToken: lines[0] };
  } catch {
    /* 文件不存在就用配置里的 */
  }
  return null;
}

export function apply(ctx, rawConfig = {}) {
  // 保险：任何初始化错误都不能把宿主启动搞挂。
  try {
    applyInner(ctx, rawConfig);
  } catch (e) {
    try {
      logWarn(`初始化失败（已忽略，不影响其他功能）：${e?.message ?? e}`);
      ctx.logger?.warn?.(`[xliens] 初始化失败：${e?.message ?? e}`);
    } catch { /* 彻底静默 */ }
  }
}

function applyInner(ctx, rawConfig) {
  const cfg = mergeConfig(rawConfig);
  const log = (m) => { logInfo(m); ctx.logger?.info?.(`[xliens] ${m}`); };
  const warn = (m) => { logWarn(m); ctx.logger?.warn?.(`[xliens] ${m}`); };
  // 每个进程一个控制台 token：静态页把它写进 <meta>，页面请求带上；
  // 系统浏览器没有 DSH 登录 cookie 时，用它通过 /xliens/api 的认证。
  const consoleToken = randomUUID();

  log(`插件加载中… 日志 ${LOG_PATH}`);
  if (cfg.enabled === false) {
    log('已按配置禁用');
    return;
  }

  const memory = createMemoryClient({
    endpoint: cfg.memory.endpoint,
    timeoutMs: cfg.memory.timeoutMs,
  });

  const api = {
    workspace: ctx.workspaceController,
    sessions: ctx.sessionController,
    // events 不是必需（没有也能跑），拿不到就算了
    events: (() => { try { return ctx.events; } catch { return undefined; } })(),
  };

  // 启动诊断：把服务暴露的方法记下来。
  // DSH 的 prompt 报错只有 "prompt rejected"，真实原因藏在 code/reason 里，
  // 没有这份清单排查起来很费劲。
  try {
    const dump = (obj, label) => {
      const keys = [];
      let o = obj;
      while (o && o !== Object.prototype) {
        for (const k of Object.getOwnPropertyNames(o)) {
          if (k === 'constructor') continue;
          if (!keys.includes(k)) keys.push(k);
        }
        o = Object.getPrototypeOf(o);
      }
      const fns = keys.filter((k) => {
        try { return typeof obj[k] === 'function'; } catch { return false; }
      });
      log(`诊断 ${label}: ${fns.sort().join(', ') || '（无方法）'}`);
    };
    if (api.sessions) dump(api.sessions, 'sessionController');
    if (api.workspace) dump(api.workspace, 'workspaceController');
    // agentPreset 是否存在，直接问 DSH 要清单
    for (const m of ['listPresets', 'presets', 'listAgentPresets']) {
      try {
        const fn = api.sessions?.[m];
        if (typeof fn === 'function') {
          Promise.resolve(fn.call(api.sessions)).then((r) => {
            const ids = (Array.isArray(r) ? r : r?.presets || [])
              .map((x) => x?.id ?? x).filter(Boolean);
            log(`可用 preset: ${ids.join(', ') || '（空）'}`);
          }).catch((e) => {
            log(`读取 preset 清单失败（${m}）：${e?.message ?? e}`);
          });
          break;
        }
      } catch (e) {
        log(`读取 preset 清单失败（${m}）：${e?.message ?? e}`);
      }
    }
  } catch (e) {
    log(`诊断失败：${e?.message ?? e}`);
  }

  const sessions = createSessionManager({ api, config: cfg, log });

  const state = { memory, sessions, config: cfg, bridge: null, stop: null };
  try {
    ctx.provide?.('xliens', state);
  } catch (e) {
    warn(`provide('xliens') 失败（不影响使用）：${e?.message ?? e}`);
  }
  ctx.xliens = state;

  // 启动就把工作区准备好，并清一次旧版本留下的重复会话窗口。
  // 不阻塞插件加载；失败了第一条消息还会再走一遍 ensureSession。
  void sessions.initialize?.();

  // ── 人设：从 file/persona.md 热加载，改完立即生效 ──
  // 只注入 Xliens 自己的会话（机器人工作区 / 机器人 preset）；
  // 普通工作会话不碰，免得用户在别的会话里也被机器人人设影响。
  try {
    const dispose = registerPersona({
      ctx,
      log,
      file: cfg.personaFile || undefined,
      // 拿不到作用域判断就一个都不注入，宁可机器人没人设，也不污染用户会话。
      shouldApply: typeof sessions.isBotAgent === 'function'
        ? sessions.isBotAgent
        : () => false,
    });
    if (dispose) ctx.effect?.(() => () => { try { dispose(); } catch {} });
  } catch (e) {
    warn(`人设注入异常：${e?.message ?? e}`);
  }

  // ── 依赖服务：Python 记忆服务（重启 DSH 会丢，由我们拉起）──
  ensureMemory({
    root: cfg.root || ROOT,
    dataRoot: cfg.dataRoot || DATA_ROOT,
    port: Number(new URL(cfg.memory.endpoint).port || 8317),
    model: cfg.memory.model,
    log,
  }).then((r) => {
    if (!r.ok) warn('记忆服务未就绪：召回与控制台会不可用（看 logs/serve.err.log）');
  }).catch((e) => warn(`记忆服务启动异常：${e?.message ?? e}`));

  // ── 控制台 API（DSH 设置页用）──
  if (cfg.console !== false) {
    try {
      const dispose = registerRoutes({
        ctx,
        memoryEndpoint: cfg.memory.endpoint,
        log,
        consoleToken,
      });
      ctx.effect?.(() => () => dispose());
      log('控制台 API 已注册：/xliens/api');
    } catch (e) {
      warn(`控制台 API 注册失败（不影响其他功能）：${e?.message ?? e}`);
    }
  }

  // ── Web 控制台：更完整的可视化页面，设置页里留一个入口 ──
  // 不替换设置页：设置页的标签仍可日常用，想铺开看图/翻召回时再开这个。
  if (cfg.webConsole !== false) {
    try {
      const dispose = registerWebConsole({
        ctx,
        log,
        consoleToken,
      });
      ctx.effect?.(() => () => dispose());
      log('Web 控制台已注册：/xliens/web');
    } catch (e) {
      warn(`Web 控制台注册失败（不影响设置页）：${e?.message ?? e}`);
    }
  }

  // ── 整备定时 ──
  const cs = cfg.bridge.consolidate || {};
  if (cs.enabled !== false && Array.isArray(cs.at) && cs.at.length) {
    try {
      const stop = startConsolidateScheduler({
        at: cs.at,
        sessions,
        api,
        agentPreset: cfg.bridge.agentPreset,
        log,
        warn,
        // 每轮读 settings.json，UI 改完立即生效
        getConfig: () => {
          try {
            const f = cfg.settingsFile || `${FILE_DIR}/settings.json`;
            const d = JSON.parse(fs.readFileSync(f, 'utf8'));
            return d.consolidate || null;
          } catch { return null; }
        },
      });
      ctx.effect?.(() => () => stop());
    } catch (e) {
      warn(`整备定时启动失败：${e?.message ?? e}`);
    }
  }

  if (cfg.bridge.enabled) {
    startBridgeWhenReady();
  }

  /** 等 SnowLuma 就绪再连；连不上就定时重试。 */
  function startBridgeWhenReady() {
    let timer = null;
    let stopped = false;

    const attempt = async () => {
      if (stopped) return;

      if (cfg.bridge.autoStartSnowluma !== false) {
        const r = await ensureSnowluma({
          home: cfg.bridge.snowlumaHome,
          host: cfg.bridge.snowlumaHost,
          port: cfg.bridge.snowlumaPort,
          log,
        });
        if (!r.ok && !stopped) {
          log(`SnowLuma 未就绪，${cfg.bridge.connectRetryMs / 1000}s 后重试`);
          timer = setTimeout(attempt, cfg.bridge.connectRetryMs);
          return;
        }
      }
      if (stopped) return;

      try {
        await connectBridge();
      } catch (e) {
        warn(`桥接连接失败：${e?.message ?? e}；${cfg.bridge.connectRetryMs / 1000}s 后重试`);
        if (!stopped) timer = setTimeout(attempt, cfg.bridge.connectRetryMs);
      }
    };

    state.stop = () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      try { state.bridge?.close(); } catch {}
    };
    ctx.effect?.(() => () => state.stop?.());

    attempt();
  }

  async function connectBridge() {
    // 凭证优先取本地文件（不进 git），其次取配置
    if (!cfg.bridge.accessToken) {
      const local = readLocalSnowluma(
        cfg.bridge.credentialFile || SNOWLUMA_CRED);
      if (local) {
        if (local.wsUrl) cfg.bridge.wsUrl = local.wsUrl;
        if (local.accessToken) cfg.bridge.accessToken = local.accessToken;
        log('已从本地文件读取 SnowLuma 凭证');
      } else {
        warn('没有 accessToken，也没找到凭证文件；连接可能被拒');
      }
    }

    const bridge = createBridge({
      api,
      sessions,
      config: cfg.bridge,
      log,
      // 白名单以设置页写的文件为准；文件不在才用 YAML 配置
      allowProvider: () => readAllowFile(ALLOW_FILE) ?? cfg.bridge.allow,
      onClose: () => {
        // 连接断了就重连（SnowLuma 重启、网络抖动都走这里）
        if (state.stop) return;
        warn('桥接连接已断开，准备重连');
        setTimeout(() => {
          connectBridge().catch((e) => warn(`重连失败：${e?.message ?? e}`));
        }, cfg.bridge.connectRetryMs);
      },
    });
    state.bridge = bridge;
    log(`桥接已创建，目标 ${cfg.bridge.wsUrl}`);
    await bridge.ready;          // 连不上会抛，交给 attempt 重试
    return bridge;
  }

  // 空名单默认全拦：启动时明确提示，否则用户会以为机器人坏了
  if (cfg.bridge.enabled) {
    const live = readAllowFile(ALLOW_FILE) ?? cfg.bridge.allow ?? {};
    const g = (live.groups ?? []).length;
    const pv = (live.private ?? []).length;
    if (g === 0 && pv === 0 && cfg.bridge.allow?.allowAllWhenEmpty !== true) {
      warn('放行名单为空：不会响应任何 QQ 消息。'
        + '在 bot/cordis.patch.yml 的 bridge.allow.groups / .private 里加群号或 QQ 号后重启 DSH。');
    } else {
      log(`放行：${g} 个群、${pv} 个私聊`);
    }
  }

  log(`就绪：记忆服务 ${cfg.memory.endpoint}，工作区「${cfg.workspace.title}」`);
}
