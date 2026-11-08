/* ==========================================================================
   Xliens Web 控制台 —— 前端逻辑
   --------------------------------------------------------------------------
   没上框架，也没引 CDN：这个页面要在 DSH 的 webServer 里离线可用。
   结构是「状态 -> 渲染字符串 -> mount 时绑事件」，够用，也方便单文件排错。
   ========================================================================== */

const API = '/xliens/api';

// 静态页由 DSH 注入，只在本地页面里可见；用来在系统浏览器
// 没有 DSH 登录 cookie 时，仍然能通过 /xliens/api 的认证。
const CONSOLE_TOKEN = (() => {
  try {
    return document.querySelector('meta[name="xliens-console-token"]')?.content || '';
  } catch {
    return '';
  }
})();

/* ------------------------------- 基础工具 ------------------------------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const numOr = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

function fmtNum(v) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('zh-CN') : String(v);
}

function fmtTime(v) {
  const s = String(v ?? '').trim();
  if (!s) return '—';
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  return m ? `${m[2]}-${m[3]} ${m[4]}:${m[5]}` : s;
}

function confLabel(c) {
  return c === 'high' ? '高置信' : c === 'medium' ? '中等' : c === 'low' ? '低置信' : '未知';
}
function confPct(c) {
  return c === 'high' ? 86 : c === 'medium' ? 64 : c === 'low' ? 38 : 20;
}
function confColor(c) {
  return c === 'high' ? 'var(--good)' : c === 'medium' ? 'var(--warn)' : c === 'low' ? 'var(--bad)' : 'var(--accent)';
}
function modeLabel(mode) {
  if (!mode) return '—';
  if (mode === 'remote') return '3080Ti（远端）';
  if (mode === 'local') return '本地 CPU';
  if (mode === 'local-circuit') return '本地 CPU（熔断）';
  return String(mode);
}
function humanDesc(nd) {
  let s = String(nd?.desc || '');
  if (nd?.subject) s = s.replace(/主体/g, nd.subject);
  if (nd?.object) s = s.replace(/客体/g, nd.object);
  return s;
}
function edgeKey(e) {
  const a = typeof e.source === 'object' ? e.source.id : e.source;
  const b = typeof e.target === 'object' ? e.target.id : e.target;
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}
function signature(data) {
  const nodes = data?.nodes || [];
  return `${nodes.length}:${(data?.edges || []).length}:${nodes[0]?.id ?? ''}:${nodes[nodes.length - 1]?.id ?? ''}`;
}
function splitIds(s) {
  return String(s ?? '')
    .split(/[\s,，;；]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}
function debounce(fn, ms = 120) {
  let t = 0;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
function storageGet(key, fallback = '') {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v;
  } catch {
    return fallback;
  }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* 隐身模式就算了 */ }
}
function isEditing() {
  const a = document.activeElement;
  return !!a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
}
function modalOpen() {
  return !!$('#modalRoot')?.children.length;
}

/* -------------------------------- 图标 --------------------------------- */

const ICONS = {
  overview: '<rect x="3" y="3" width="7" height="7" rx="1.6"/><rect x="14" y="3" width="7" height="7" rx="1.6"/><rect x="3" y="14" width="7" height="7" rx="1.6"/><rect x="14" y="14" width="7" height="7" rx="1.6"/>',
  graph: '<circle cx="6" cy="6" r="2.6"/><circle cx="18" cy="7" r="2.6"/><circle cx="12" cy="18" r="2.6"/><path d="M8.3 7.2 15.5 8.2M7.2 8.2l3.4 7.5M16.8 9.3l-3.3 6.2"/>',
  trace: '<path d="M3 12h4l2.4-7 4.2 14L16 12h5"/>',
  access: '<path d="M12 3l7 3v5.8c0 4.4-3 7.4-7 9.2-4-1.8-7-4.8-7-9.2V6l7-3z"/><path d="m9.2 12 1.9 1.9 3.8-3.9"/>',
  persona: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c.7-3.6 3.4-5.6 7-5.6s6.3 2 7 5.6"/>',
  owner: '<path d="M3 8l4 3.2L12 5l5 6.2L21 8l-2.2 11H5.2L3 8z"/><path d="M8 19h8"/>',
  consolidate: '<ellipse cx="12" cy="5.5" rx="7" ry="2.8"/><path d="M5 5.5v6c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8v-6"/><path d="M5 11.5v6c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8v-6"/>',
  system: '<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M10 2v3M14 2v3M10 19v3M14 19v3M2 10h3M2 14h3M19 10h3M19 14h3"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  undo: '<path d="M9 7 4 12l5 5"/><path d="M4 12h9a6 6 0 0 1 0 12h-1"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="m4 12 5 5L20 6"/>',
  alert: '<path d="M12 3 2.5 20h19L12 3z"/><path d="M12 9v5"/><path d="M12 17.5v.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><path d="M12 7.5v.01"/>',
  arrowRight: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
  arrowLeft: '<path d="M19 12H5"/><path d="m11 18-6-6 6-6"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M19 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5"/>',
  play: '<path d="M8 5v14l11-7-11-7z"/>',
  save: '<path d="M5 3h11l3 3v15H5V3z"/><path d="M8 3v6h7V3"/><path d="M8 21v-7h8v7"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 14h10l1-14"/><path d="M10 11v6M14 11v6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5z"/><path d="m3 12 9 5 9-5"/><path d="m3 16 9 5 9-5"/>',
  share: '<circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="6" r="2.6"/><circle cx="18" cy="18" r="2.6"/><path d="m8.4 10.8 7.2-3.6M8.4 13.2l7.2 3.6"/>',
  server: '<rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01"/>',
  sparkles: '<path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3z"/><path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14z"/>',
  clockArrow: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/><path d="M17 3l3 3-3 3"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/>',
  eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 6.2A10.9 10.9 0 0 1 12 6c6.5 0 10 6 10 6a17.5 17.5 0 0 1-3.1 3.7"/><path d="M6.5 7.7A17.8 17.8 0 0 0 2 12s3.5 6 10 6a10.5 10.5 0 0 0 4.4-.9"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.2 1.2"/><path d="M14 11a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20.1l1.2-1.2"/>',
  terminal: '<path d="m5 7 5 5-5 5"/><path d="M12 17h7"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8L3 5z"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  bookmark: '<path d="M6 3h12v18l-6-4.5L6 21V3z"/>',
};

function icon(name, size = 18, cls = '') {
  const body = ICONS[name] || ICONS.info;
  return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

/* -------------------------------- 页面表 -------------------------------- */

const PAGES = [
  { id: 'overview', label: '总览', icon: 'overview', group: '控制台', title: '总览', sub: '记忆系统的运行状态与最近一次召回' },
  { id: 'graph', label: '逻辑图', icon: 'graph', group: '记忆', title: '逻辑图', sub: 'EU 事件单元与 CE 关联边，点节点可编辑' },
  { id: 'trace', label: '章动过程', icon: 'trace', group: '记忆', title: '章动过程', sub: '每次召回怎么走、停在哪、带回了什么' },
  { id: 'access', label: '白名单', icon: 'access', group: '配置', title: '白名单', sub: '哪些群和私聊可以唤起机器人' },
  { id: 'persona', label: '人设', icon: 'persona', group: '配置', title: '人设', sub: 'TA 的性格、说话习惯和边界' },
  { id: 'owner', label: '主人', icon: 'owner', group: '配置', title: '主人', sub: '主人和机器人自己的 QQ 号与名字/昵称' },
  { id: 'consolidate', label: '整备', icon: 'consolidate', group: '配置', title: '整备', sub: '把还没整备的聊天切分整理，结果先暂存' },
  { id: 'staging', label: '落盘', icon: 'save', group: '配置', title: '落盘', sub: '审查整备批次，确认后写进逻辑图' },
  { id: 'system', label: '系统', icon: 'system', group: '系统', title: '系统状态', sub: '记忆服务、回收站与接口信息' },
  { id: 'data', label: '数据与存档', icon: 'layers', group: '系统', title: '数据与存档', sub: '工作目录迁移、逻辑图存档与读档' },
  { id: 'plugin', label: '插件详情', icon: 'info', group: '系统', title: '插件详情', sub: '查看版本、检查更新与仓库入口' },
];

/* -------------------------------- 状态 --------------------------------- */

const state = {
  page: 'overview',
  traces: [],
  tracesAt: 0,
  tracesError: null,
  traceSel: null,
  graph: null,
  graphError: null,
  health: null,
  healthError: null,
  healthAt: 0,
  healthLatency: null,
  allow: null,
  owner: null,
  self: null,
  settings: null,
  persona: null,
  trash: null,
  staging: {
    loaded: false, list: [], sel: null, detail: null,
    msg: '', busy: false, error: null, addText: '',
  },
  loading: {},
  errors: {},
  actions: { consolidating: false },
  lastConsolidate: null,
  recallMode: 'semantic',
  recallResult: null,
  recallError: null,
  recallLoading: false,
  recallQuery: '',
  graphSel: null,
  graphDetail: null,
  graphDetailLoading: false,
  graphDetailError: null,
  graphShowLabels: storageGet('xliens.graph.labels', '1') !== '0',
  graphShowHighlight: storageGet('xliens.graph.highlight', '1') !== '0',
  pendingGraphFocus: null,
  pageLoadToken: 0,
  systemRenderedSig: '',
  data: null,
  dataError: null,
  update: null,
  updateError: null,
  model: null,
  modelError: null,
  modelMsg: '',
  modelDraft: null,
  modelOpen: false,
  seg: null,
  segDraft: null,
  segOpen: false,
  segMsg: '',
  segError: null,
  thresholds: null,
  thresholdsMsg: '',
  dataTarget: '',
  dataBusy: false,
  dataMsg: '',
};

/* -------------------------------- 接口 --------------------------------- */

async function request(path, { method = 'GET', body, signal } = {}) {
  const init = {
    method,
    credentials: 'same-origin',
    signal,
    headers: {},
  };
  if (CONSOLE_TOKEN) init.headers['X-Xliens-Console-Token'] = CONSOLE_TOKEN;
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(API + path, init);
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 300) }; }
  }
  if (!res.ok) {
    throw new Error(data?.error || data?.message || `HTTP ${res.status}`);
  }
  if (data && data.ok === false && data.error) {
    throw new Error(data.error);
  }
  // 控制台代理对后端状态码做了 200 包装，错误只会藏在 error 字段里。
  // 这类响应必须当失败处理，否则前端会把「节点不存在」当成一条空记录。
  if (data && data.error && data.ok !== true) {
    throw new Error(data.error);
  }
  return data;
}
const apiGet = (path, opts) => request(path, opts);
const apiPost = (path, body, opts) => request(path, { method: 'POST', body: body ?? {}, ...opts });

/* -------------------------------- Toast -------------------------------- */

function toast(message, kind = 'info', ms = 3600) {
  const root = $('#toasts');
  if (!root) return;
  const iconName = kind === 'good' ? 'check' : kind === 'bad' || kind === 'warn' ? 'alert' : 'info';
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<span class="toast-icon">${icon(iconName, 16)}</span><div>${esc(message)}</div>`;
  root.append(el);
  setTimeout(() => {
    el.classList.add('is-out');
    setTimeout(() => el.remove(), 220);
  }, ms);
}

async function withBusy(btn, label, fn) {
  if (!btn) return fn();
  const old = btn.innerHTML;
  btn.disabled = true;
  if (label) btn.innerHTML = `<span class="spinner"></span>${esc(label)}`;
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    if (btn.isConnected) btn.innerHTML = old;
  }
}

/* -------------------------------- Modal -------------------------------- */

let modalState = null;

function closeModal() {
  const root = $('#modalRoot');
  const prev = modalState;
  modalState = null;
  if (root) root.innerHTML = '';
  if (prev?.returnFocus?.isConnected) {
    try { prev.returnFocus.focus(); } catch { /* ignore */ }
  }
}

function openModal({ title, body, actions = [], width = 560, onMount }) {
  closeModal();
  const root = $('#modalRoot');
  if (!root) return;
  const actionHtml = actions.map((a, i) => (
    `<button type="button" class="btn ${a.kind || 'ghost'}" data-modal-action="${i}">${esc(a.label || '确定')}</button>`
  )).join('');
  root.innerHTML = `
    <div class="modal-backdrop" data-modal-backdrop>
      <div class="modal" style="width:min(${Number(width) || 560}px,100%)" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="modal-head">
          <h3>${esc(title)}</h3>
          <div class="spacer"></div>
          <button type="button" class="icon-btn" data-modal-close aria-label="关闭">${icon('x', 18)}</button>
        </div>
        <div class="modal-body">${body}</div>
        ${actionHtml ? `<div class="modal-foot">${actionHtml}</div>` : ''}
      </div>
    </div>`;
  const modalEl = $('.modal', root);
  modalState = { returnFocus: document.activeElement };
  $$('[data-modal-action]', root).forEach((btn) => {
    btn.addEventListener('click', async () => {
      const a = actions[Number(btn.dataset.modalAction)];
      if (!a) return;
      try {
        await a.onClick?.(btn, closeModal);
      } catch (e) {
        toast(e?.message || String(e), 'bad');
      } finally {
        if (a.close !== false) closeModal();
      }
    });
  });
  $$('[data-modal-close]', root).forEach((b) => b.addEventListener('click', closeModal));
  const backdrop = $('[data-modal-backdrop]', root);
  backdrop?.addEventListener('click', (ev) => {
    if (ev.target === backdrop) closeModal();
  });
  try { onMount?.(modalEl, closeModal); } catch (e) { toast(e?.message || String(e), 'bad'); }
}

function openConfirm({ title, message, confirmLabel = '确认', danger = false, onConfirm }) {
  openModal({
    title,
    width: 460,
    body: `<p class="muted" style="margin:0;line-height:1.7">${message}</p>`,
    actions: [
      { label: '取消', kind: 'ghost' },
      {
        label: confirmLabel,
        kind: danger ? 'danger' : 'primary',
        onClick: async () => {
          closeModal();
          try { await onConfirm?.(); } catch (e) { toast(e?.message || String(e), 'bad'); }
        },
      },
    ],
  });
}

/* ==========================================================================
   数据加载
   ========================================================================== */

// 同一类数据同时只发一个请求。关键是「在飞行中也要把 Promise 交出去」：
// 如果像以前那样直接 return，快速切页时新页面会以为已经加载完、永远停在骨架屏。
const inflight = new Map();
function once(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = Promise.resolve().then(fn).finally(() => { inflight.delete(key); });
  inflight.set(key, p);
  return p;
}

function loadHealth() {
  return once('health', async () => {
    state.loading.health = true;
    const t0 = performance.now();
    try {
      const h = await apiGet('/health');
      state.health = h;
      state.healthError = null;
      state.healthAt = Date.now();
      state.healthLatency = Math.round(performance.now() - t0);
    } catch (e) {
      state.healthError = e?.message || String(e);
    } finally {
      state.loading.health = false;
      updateStatusUI();
      updateNavBadges();
    }
  });
}

function loadGraph(force = false) {
  if (!force && state.graph) {
    GraphView.onData();
    return Promise.resolve();
  }
  return once('graph', async () => {
    state.loading.graph = true;
    try {
      const data = await apiGet('/graph');
      state.graph = data;
      state.graphError = null;
      if (GraphView.ui) GraphView.onData();
      updateNavBadges();
    } catch (e) {
      state.graphError = e?.message || String(e);
      if (GraphView.ui) GraphView.updateOverlay();
      if (state.page === 'graph' && !state.graph) toast(`逻辑图加载失败：${state.graphError}`, 'bad');
    } finally {
      state.loading.graph = false;
      if (GraphView.ui) GraphView.updateOverlay();
    }
  });
}

function loadTraces(force = false) {
  if (!force && state.tracesAt && Date.now() - state.tracesAt < 4000) return Promise.resolve();
  return once('traces', async () => {
    state.loading.traces = true;
    const prev = selectedTrace();
    try {
      const d = await apiGet('/trace');
      const list = Array.isArray(d?.traces) ? d.traces : [];
      // 记忆服务是按发生顺序 append 的，但控制台/脚本也可能喂新到旧，
      // 统一按时间升序，页面里再反转成「最新在上」。这样两种来源都不会挑错。
      list.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
      state.traces = list;
      state.tracesAt = Date.now();
      state.tracesError = null;
      if (prev) {
        const idx = list.findIndex((t) => t.at === prev.at && t.query === prev.query);
        state.traceSel = idx >= 0 ? idx : list.length - 1;
      } else if (list.length) {
        state.traceSel = list.length - 1;
      } else {
        state.traceSel = null;
      }
      updateNavBadges();
      if (state.page === 'graph') GraphView.draw();
    } catch (e) {
      state.tracesError = e?.message || String(e);
      if (state.page === 'trace') toast(`召回记录加载失败：${state.tracesError}`, 'bad');
    } finally {
      state.loading.traces = false;
    }
  });
}

function loadAllow(force = false) {
  if (!force && state.allow) return Promise.resolve();
  return once('allow', async () => {
    state.loading.allow = true;
    try {
      state.allow = await apiGet('/allow');
      state.errors.allow = null;
      updateNavBadges();
    } catch (e) {
      state.errors.allow = e?.message || String(e);
    } finally {
      state.loading.allow = false;
    }
  });
}

function loadOwner(force = false) {
  if (!force && state.owner) return Promise.resolve();
  return once('owner', async () => {
    state.loading.owner = true;
    try {
      state.owner = await apiGet('/owner');
      state.errors.owner = null;
    } catch (e) {
      state.errors.owner = e?.message || String(e);
    } finally {
      state.loading.owner = false;
    }
  });
}

function loadSelf(force = false) {
  if (!force && state.self) return Promise.resolve();
  return once('self', async () => {
    state.loading.self = true;
    try {
      // 和设置页一致：走 /settings 的 self 字段。
      // /self 是后加的，DSH 没重启前那条路由可能还不存在。
      const d = await apiGet('/settings');
      state.settings = d;
      state.self = d.self || { ids: [], names: [] };
      state.errors.self = null;
    } catch (e) {
      state.errors.self = e?.message || String(e);
    } finally {
      state.loading.self = false;
    }
  });
}

function loadStaging(force = false) {
  if (!force && state.staging.loaded) return Promise.resolve();
  return once('staging', async () => {
    state.loading.staging = true;
    try {
      const d = await apiGet('/staging/list');
      const list = Array.isArray(d?.items) ? d.items : [];
      state.staging.list = list;
      state.staging.error = null;
      let sel = state.staging.sel;
      if (!list.some((x) => x.id === sel)) {
        const pending = list.find((x) => x.status === 'pending');
        sel = (pending || list[0] || {}).id ?? null;
      }
      state.staging.sel = sel;
      if (sel) {
        try {
          state.staging.detail = await apiGet(`/staging/get?id=${encodeURIComponent(sel)}`);
        } catch (e) {
          state.staging.detail = null;
          state.staging.error = e?.message || String(e);
        }
      } else {
        state.staging.detail = null;
      }
      state.staging.loaded = true;
      updateNavBadges();
    } catch (e) {
      state.staging.error = e?.message || String(e);
      state.staging.loaded = true;
    } finally {
      state.loading.staging = false;
    }
  });
}

function loadStagedBatch(id) {
  if (!id) return Promise.resolve();
  return once(`staging:${id}`, async () => {
    state.loading.stagingDetail = true;
    try {
      state.staging.detail = await apiGet(`/staging/get?id=${encodeURIComponent(id)}`);
      state.staging.sel = id;
      state.staging.error = null;
    } catch (e) {
      state.staging.detail = null;
      state.staging.error = e?.message || String(e);
    } finally {
      state.loading.stagingDetail = false;
    }
  });
}

function loadSettings(force = false) {
  if (!force && state.settings) return Promise.resolve();
  return once('settings', async () => {
    state.loading.settings = true;
    try {
      state.settings = await apiGet('/settings');
      state.errors.settings = null;
    } catch (e) {
      state.errors.settings = e?.message || String(e);
    } finally {
      state.loading.settings = false;
    }
  });
}

function loadPersona(force = false) {
  if (!force && state.persona) return Promise.resolve();
  return once('persona', async () => {
    state.loading.persona = true;
    try {
      const d = await apiGet('/persona');
      state.persona = { text: String(d?.text ?? '') };
      state.errors.persona = null;
    } catch (e) {
      state.errors.persona = e?.message || String(e);
    } finally {
      state.loading.persona = false;
    }
  });
}

function loadTrash(force = false) {
  if (!force && state.trash) return Promise.resolve();
  return once('trash', async () => {
    state.loading.trash = true;
    try {
      const d = await apiGet('/trash');
      state.trash = Array.isArray(d?.items) ? d.items : [];
      state.errors.trash = null;
    } catch (e) {
      state.errors.trash = e?.message || String(e);
    } finally {
      state.loading.trash = false;
    }
  });
}

function loadData(force = false) {
  if (!force && state.data) return Promise.resolve();
  return once('data', async () => {
    state.loading.data = true;
    try {
      state.data = await apiGet('/data');
      state.dataError = null;
    } catch (e) {
      state.dataError = e?.message || String(e);
    } finally {
      state.loading.data = false;
    }
  });
}

function loadUpdate(force = false) {
  if (!force && state.update) return Promise.resolve();
  return once('update', async () => {
    state.loading.update = true;
    try {
      state.update = await apiGet(`/update${force ? '?force=1' : ''}`);
      state.updateError = null;
    } catch (e) {
      state.updateError = e?.message || String(e);
    } finally {
      state.loading.update = false;
    }
  });
}

function loadModel(force = false) {
  if (!force && state.model) return Promise.resolve();
  return once('model', async () => {
    try {
      const d = await apiGet('/model');
      if (!d.ok) throw new Error(d.error || '读取模型目录失败');
      state.model = d;
      if (!state.modelDraft) state.modelDraft = d.current || null;
      state.modelError = null;
    } catch (e) {
      state.modelError = e?.message || String(e);
    }
  });
}

function defaultSegProviders() {
  return [
    { provider: 'glm', label: 'GLM', model: 'glm-5.3-flash', keyRef: 'GLM_API_KEY', ready: true },
  ];
}

function loadSeg(force = false) {
  if (!force && state.seg) return Promise.resolve();
  return once('seg', async () => {
    try {
      const d = await apiGet('/seg');
      if (!d.ok) throw new Error(d.error || '读取切分 API 失败');
      if (!Array.isArray(d.providers) || !d.providers.length) {
        d.providers = defaultSegProviders();
      }
      state.seg = d;
      if (!state.segDraft) state.segDraft = d.current || { provider: 'glm', model: 'glm-5.3-flash' };
      state.segError = null;
    } catch (e) {
      state.segError = e?.message || String(e);
      if (!state.seg) {
        state.seg = {
          current: { provider: 'glm', model: 'glm-5.3-flash', label: 'GLM', keyRef: 'GLM_API_KEY', ready: null },
          providers: defaultSegProviders(),
        };
        if (!state.segDraft) state.segDraft = state.seg.current;
      }
    }
  });
}

function loadThresholds(force = false) {
  if (!force && state.thresholds) return Promise.resolve();
  return once('thresholds', async () => {
    try {
      state.thresholds = await apiGet('/thresholds');
    } catch (e) {
      state.thresholdsMsg = e?.message || String(e);
    }
  });
}

function modelLabel(info, m) {
  if (!m) return '—';
  const g = (info?.groups || []).find((x) => x.id === m.provider);
  const md = g?.models?.find((x) => x.id === m.model);
  return `${g?.name || m.provider} / ${md?.name || m.model}`;
}

async function loadPageData(page, { force = false } = {}) {
  const token = ++state.pageLoadToken;
  const jobs = [];
  if (page === 'overview') {
    jobs.push(loadHealth());
    jobs.push(loadTraces(force || !state.tracesAt));
    jobs.push(loadAllow(force));
    jobs.push(loadOwner(force));
    jobs.push(loadSettings(force));
    jobs.push(loadPersona(force));
    jobs.push(loadUpdate(force));
    jobs.push(loadModel(force));
    jobs.push(loadSeg(force));
  } else if (page === 'graph') {
    jobs.push(loadHealth());
    jobs.push(loadTraces(force || !state.tracesAt));
    jobs.push(loadGraph(force));
  } else if (page === 'trace') {
    jobs.push(loadTraces(force));
  } else if (page === 'access') {
    jobs.push(loadAllow(force));
  } else if (page === 'persona') {
    jobs.push(loadPersona(force));
  } else if (page === 'owner') {
    jobs.push(loadOwner(force));
    jobs.push(loadSelf(force));
  } else if (page === 'consolidate') {
    jobs.push(loadSettings(force));
  } else if (page === 'staging') {
    // 整备刚结束时，落盘批次是新的；不能复用上次进入页面时的缓存。
    jobs.push(loadStaging(true));
    jobs.push(loadSettings(force));
  } else if (page === 'system') {
    jobs.push(loadHealth());
    jobs.push(loadTrash(force));
    jobs.push(loadThresholds(force));
  } else if (page === 'data') {
    jobs.push(loadData(force));
  } else if (page === 'plugin') {
    jobs.push(loadUpdate(force));
  }
  await Promise.allSettled(jobs);
  if (token !== state.pageLoadToken) return;
  refreshAfterLoad(page);
}

function refreshAfterLoad(page) {
  if (state.page !== page) return;
  if (modalOpen()) return;
  if (page === 'graph') {
    if (GraphView.ui) GraphView.onData();
    else renderPage();
    return;
  }
  if (isEditing() && page !== 'overview' && page !== 'system') return;
  renderPage();
}

async function refreshCurrentPage() {
  toast('正在刷新…', 'info', 1200);
  await loadPageData(state.page, { force: true });
}

/* ==========================================================================
   外壳 / 导航
   ========================================================================== */

function renderNav() {
  const nav = $('#nav');
  if (!nav) return;
  const groups = [...new Set(PAGES.map((p) => p.group))];
  let html = '';
  for (const g of groups) {
    html += `<div class="nav-group-label">${esc(g)}</div>`;
    for (const p of PAGES.filter((x) => x.group === g)) {
      const active = state.page === p.id ? 'is-active' : '';
      html += `<a class="nav-item ${active}" href="#${p.id}" data-nav="${p.id}">
        ${icon(p.icon, 18)}
        <span>${esc(p.label)}</span>
        <span class="nav-badge" data-badge="${p.id}" hidden></span>
      </a>`;
    }
  }
  nav.innerHTML = html;
  updateNavBadges();
}

function updateNavBadges() {
  const set = (id, value) => {
    const el = document.querySelector(`[data-badge="${id}"]`);
    if (!el) return;
    if (value === null || value === undefined || value === '') {
      el.hidden = true;
      el.textContent = '';
    } else {
      el.hidden = false;
      el.textContent = String(value);
    }
  };
  set('graph', state.graph?.nodes?.length ?? state.health?.nodes ?? null);
  set('trace', state.traces.length || null);
  set('access', state.allow ? ((state.allow.groups?.length || 0) + (state.allow.private?.length || 0)) || null : null);
  set('staging', state.staging.list.filter((x) => x.status === 'pending').length || null);
}

function healthSig() {
  const h = state.health;
  if (!h) return `none:${state.healthError || ''}`;
  return [h.nodes, h.edges, h.calls, h.ce_mode, h.ce_remote_configured, h.meta?.updated_at].join('|');
}

function updateStatusUI() {
  const ok = !!state.health && !state.healthError;
  const h = state.health;
  const dot = $('#healthDot');
  const text = $('#healthText');
  const pill = $('#healthPill');
  if (dot) dot.className = `status-dot ${ok ? 'is-ok' : state.healthError ? 'is-bad' : 'is-idle'}`;
  if (text) text.textContent = ok ? '记忆服务在线' : state.healthError ? '记忆服务离线' : '连接中…';
  if (pill) {
    pill.classList.toggle('is-ok', ok);
    pill.classList.toggle('is-bad', !!state.healthError);
    pill.title = state.healthError
      ? `记忆服务未响应：${state.healthError}`
      : ok
        ? `响应 ${state.healthLatency ?? '?'}ms · CE ${modeLabel(h.ce_mode)}`
        : '正在连接记忆服务';
  }

  const sidebarDot = $('#sidebarDot');
  const sidebarService = $('#sidebarService');
  const sidebarMeta = $('#sidebarMeta');
  if (sidebarDot) sidebarDot.className = `status-dot ${ok ? 'is-ok' : state.healthError ? 'is-bad' : 'is-idle'}`;
  if (sidebarService) sidebarService.textContent = ok ? '记忆服务在线' : state.healthError ? '记忆服务离线' : '连接中…';
  if (sidebarMeta) {
    if (ok) {
      sidebarMeta.textContent = `${fmtNum(h.nodes)} 节点 · ${fmtNum(h.edges)} 边 · CE ${modeLabel(h.ce_mode)}`;
    } else if (state.healthError) {
      sidebarMeta.textContent = '服务未响应，稍后会自动重试';
    } else {
      sidebarMeta.textContent = '正在读取记忆服务';
    }
  }

  updateOverviewLive();
  if (state.page === 'system' && !isEditing() && !modalOpen()
    && healthSig() !== state.systemRenderedSig) {
    renderPage();
  }
}

function updateOverviewLive() {
  const h = state.health;
  const set = (key, value) => {
    $$(`[data-live="${key}"]`).forEach((el) => { el.textContent = value; });
  };
  if (h) {
    set('nodes', fmtNum(h.nodes));
    set('edges', fmtNum(h.edges));
    set('calls', fmtNum(h.calls));
    set('service', '在线');
    set('ce', modeLabel(h.ce_mode));
    set('latency', `${state.healthLatency ?? '—'} ms`);
  } else if (state.healthError) {
    set('service', '离线');
  }
}

function applyPage(id) {
  const p = PAGES.find((x) => x.id === id) || PAGES[0];
  const prev = state.page;
  if (prev === 'graph' && p.id !== 'graph') GraphView.detach();
  state.page = p.id;
  document.title = `Xliens · ${p.title}`;
  const titleEl = $('#pageTitle');
  const subEl = $('#pageSub');
  if (titleEl) titleEl.textContent = p.title;
  if (subEl) subEl.textContent = p.sub;
  renderNav();
  const view = $('#view');
  if (view) view.scrollTop = 0;
  window.scrollTo(0, 0);
  renderPage();
  closeSidebar();
  loadPageData(p.id);
}

function navigate(id) {
  if (!PAGES.some((p) => p.id === id)) id = 'overview';
  const hash = `#${id}`;
  if (location.hash === hash) {
    // 同一个页面不重复重建（逻辑图尤其不能重排）
    if (state.page !== id) applyPage(id);
    return;
  }
  location.hash = hash;
}

function closeSidebar() {
  const sb = $('#sidebar');
  const btn = $('#menuBtn');
  const shade = $('#sidebarShade');
  if (sb) sb.classList.remove('is-open');
  if (btn) btn.setAttribute('aria-expanded', 'false');
  if (shade) shade.classList.remove('is-show');
}

function toggleSidebar() {
  const sb = $('#sidebar');
  const btn = $('#menuBtn');
  const shade = $('#sidebarShade');
  if (!sb) return;
  const next = !sb.classList.contains('is-open');
  sb.classList.toggle('is-open', next);
  if (btn) btn.setAttribute('aria-expanded', String(next));
  if (shade) shade.classList.toggle('is-show', next);
}

/* ==========================================================================
   渲染辅助
   ========================================================================== */

const TONES = {
  teal: { c: '#5eead4', bg: 'rgba(94,234,212,.1)', line: 'rgba(94,234,212,.22)', glow: 'rgba(94,234,212,.15)' },
  blue: { c: '#7c9cff', bg: 'rgba(124,156,255,.1)', line: 'rgba(124,156,255,.22)', glow: 'rgba(124,156,255,.15)' },
  violet: { c: '#c084fc', bg: 'rgba(192,132,252,.1)', line: 'rgba(192,132,252,.22)', glow: 'rgba(192,132,252,.15)' },
  amber: { c: '#fbbf24', bg: 'rgba(251,191,36,.1)', line: 'rgba(251,191,36,.22)', glow: 'rgba(251,191,36,.15)' },
  rose: { c: '#fb7185', bg: 'rgba(251,113,133,.1)', line: 'rgba(251,113,133,.22)', glow: 'rgba(251,113,133,.15)' },
  good: { c: '#34d399', bg: 'rgba(52,211,153,.1)', line: 'rgba(52,211,153,.22)', glow: 'rgba(52,211,153,.15)' },
};

function statCard({ label, value, sub, iconName, tone = 'teal', numeric = true, live = '' }) {
  const t = TONES[tone] || TONES.teal;
  const inner = `<span ${live ? `data-live="${live}"` : ''}>${esc(value ?? '—')}</span>`;
  return `<div class="stat-card" style="--stat-color:${t.c};--stat-bg:${t.bg};--stat-line:${t.line};--stat-glow:${t.glow}">
    <div class="stat-top">
      <span class="stat-label">${esc(label)}</span>
      <span class="stat-icon">${icon(iconName, 17)}</span>
    </div>
    <div class="stat-value">${inner}</div>
    <div class="stat-sub">${esc(sub || '')}</div>
  </div>`;
}

function emptyState(iconName, title, text, action = '') {
  return `<div class="empty">
    <div class="empty-icon">${icon(iconName, 24)}</div>
    <strong>${esc(title)}</strong>
    <p>${esc(text)}</p>
    ${action}
  </div>`;
}

function noticeHtml(text, kind = 'warn', iconName = 'alert') {
  return `<div class="notice ${kind}">${icon(iconName, 17)}<div>${esc(text)}</div></div>`;
}

function summaryRow(k, v) {
  return `<div class="summary-row"><span class="k">${esc(k)}</span><span class="v">${v}</span></div>`;
}

function kvItem(k, v, mono = false) {
  return `<div class="kv-item"><div class="k">${esc(k)}</div><div class="v ${mono ? 'mono' : ''}">${v}</div></div>`;
}

function loadingBlock(height = 220) {
  return `<div class="card" style="min-height:${height}px">
    <div class="skeleton" style="height:18px;width:150px;margin-bottom:16px"></div>
    <div class="skeleton" style="height:11px;width:100%;margin-bottom:9px"></div>
    <div class="skeleton" style="height:11px;width:82%;margin-bottom:9px"></div>
    <div class="skeleton" style="height:11px;width:64%"></div>
  </div>`;
}

/* ------------------------------- Markdown ------------------------------- */

function inlineMd(s) {
  const codes = [];
  let out = String(s).replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  out = out.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)] ?? ''}</code>`);
  return out;
}

function renderMarkdown(src) {
  const text = String(src ?? '').replace(/\r\n?/g, '\n');
  if (!text.trim()) return '<p class="muted">还没有内容。</p>';
  const lines = esc(text).split('\n');
  const out = [];
  let i = 0;
  let list = null;
  let para = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.map(inlineMd).join('<br>')}</p>`);
      para = [];
    }
  };
  const closeList = () => {
    if (list) { out.push(`</${list}>`); list = null; }
  };

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trimEnd();

    if (/^```/.test(line)) {
      flushPara(); closeList();
      const lang = line.slice(3).trim();
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { code.push(lines[i]); i++; }
      i++;
      out.push(`<pre><code${lang ? ` data-lang="${esc(lang)}"` : ''}>${code.join('\n')}</code></pre>`);
      continue;
    }

    if (!line.trim()) {
      flushPara(); closeList(); i++; continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushPara(); closeList();
      const lv = heading[1].length;
      out.push(`<h${lv}>${inlineMd(heading[2])}</h${lv}>`);
      i++; continue;
    }

    if (/^-{3,}$/.test(line.trim())) {
      flushPara(); closeList(); out.push('<hr>'); i++; continue;
    }

    const quote = line.match(/^&gt;\s?(.*)$/);
    if (quote) {
      flushPara(); closeList();
      out.push(`<blockquote>${inlineMd(quote[1])}</blockquote>`);
      i++; continue;
    }

    const ul = line.match(/^[-*+]\s+(.*)$/);
    if (ul) {
      flushPara();
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inlineMd(ul[1])}</li>`);
      i++; continue;
    }

    const ol = line.match(/^\d+[.)]\s+(.*)$/);
    if (ol) {
      flushPara();
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${inlineMd(ol[1])}</li>`);
      i++; continue;
    }

    closeList();
    para.push(line);
    i++;
  }
  flushPara();
  closeList();
  return out.join('\n');
}

/* ==========================================================================
   总览
   ========================================================================== */

function pageOverview() {
  const h = state.health || {};
  const counts = state.graph || {};
  const nodes = h.nodes ?? counts.nodes ?? null;
  const edges = h.edges ?? counts.edges ?? null;
  const calls = h.calls ?? null;
  const service = state.health ? '在线' : state.healthError ? '离线' : '…';
  const last = state.traces.length ? state.traces[state.traces.length - 1] : null;
  const replyOn = state.settings?.reply?.enabled !== false;
  const segCur = state.segDraft || state.seg?.current;
  const segText = segCur
    ? `${state.seg?.providers?.find((p) => p.provider === segCur.provider)?.label || segCur.label || segCur.provider} / ${segCur.model}`
    : '—';

  const statHtml = [
    statCard({ label: '事件节点', value: nodes, sub: 'EU 事件单元', iconName: 'layers', tone: 'teal', live: 'nodes' }),
    statCard({ label: '逻辑关联', value: edges, sub: 'CE 关联边', iconName: 'share', tone: 'blue', live: 'edges' }),
    statCard({ label: '召回调用', value: calls, sub: '本次服务启动以来', iconName: 'trace', tone: 'violet', live: 'calls' }),
    statCard({ label: '记忆服务', value: service, sub: `CE ${modeLabel(h.ce_mode)}`, iconName: 'server', tone: state.health ? 'good' : 'rose', numeric: false, live: 'service' }),
  ].join('');

  return `<div class="overview">
    <section class="hero">
      <div class="hero-copy">
        <span class="eyebrow">XLIENS MEMORY ENGINE</span>
        <h2>让每一次对话<br><em>都有迹可循</em></h2>
        <p>事件单元被切成图上的节点，CrossEncoder 算出它们之间的逻辑关联。召回时沿着图游走，不是把聊天记录一股脑塞进上下文。</p>
        <div class="hero-actions">
          <button class="btn primary" type="button" data-go="graph">${icon('graph', 16)} 打开逻辑图</button>
          <button class="btn ghost" type="button" data-act="check-update">${icon('refresh', 16)} 检查更新</button>
          <button class="btn ghost" type="button" data-go="trace">${icon('trace', 16)} 查看章动过程</button>
          <label class="switch reply-quick ${replyOn ? 'is-on' : ''}" title="关闭后机器人只记录消息，不回复">
            <input type="checkbox" id="overviewReply" ${replyOn ? 'checked' : ''}>
            <span class="track"></span>
            <span>机器人回复</span>
            <b class="reply-quick-state" id="overviewReplyState">${replyOn ? '已开启' : '已暂停'}</b>
          </label>
        </div>
      </div>
      <div class="hero-visual" aria-hidden="true">
        <div class="orbit o1"></div>
        <div class="orbit o2"></div>
        <div class="orbit o3"></div>
        <div class="hero-core">X</div>
      </div>
    </section>

    <section class="card api-switch-card">
      <div class="api-switch-row">
      <div class="api-switch-col">
        <span class="api-switch-label">对话API</span>
        <b class="api-switch-current">${esc(modelLabel(state.model, state.model?.current))}</b>
        ${state.modelError ? `<span class="hint bad">${esc(state.modelError)}</span>` : ''}
        <div class="spacer"></div>
        <div class="api-model-wrap">
          <button class="api-model-trigger" type="button" data-act="toggle-model"
            aria-haspopup="listbox" aria-expanded="${state.modelOpen ? 'true' : 'false'}">
            <span>${esc(modelLabel(state.model, state.modelDraft || state.model?.current))}</span>
            ${icon('chevronDown', 14)}
          </button>
          ${state.modelOpen ? `
            <div class="api-model-backdrop" data-act="close-model"></div>
            <div class="api-model-menu" role="listbox" aria-label="机器人 LLM API">
              ${(state.model?.groups || []).map((g) => `
                <div class="api-model-group">
                  <div class="api-model-group-title">${esc(g.name)}</div>
                  ${(g.models || []).map((m) => {
                    const cur = state.modelDraft || state.model?.current;
                    const selected = cur && cur.provider === g.id && cur.model === m.id;
                    return `<button class="api-model-option${selected ? ' selected' : ''}" type="button"
                      role="option" aria-selected="${selected ? 'true' : 'false'}"
                      data-model-provider="${esc(g.id)}" data-model-id="${esc(m.id)}">
                      <span>${esc(m.name)}</span>
                      ${selected ? icon('check', 14) : ''}
                    </button>`;
                  }).join('')}
                </div>`).join('')}
            </div>` : ''}
        </div>
        <button class="btn small primary" type="button" data-act="save-model">确认</button>
      </div>
      <div class="api-switch-col api-switch-col-seg">
        <span class="api-switch-label">切分API</span>
        <b class="api-switch-current">${esc(segText)}</b>
        <div class="spacer"></div>
        <div class="api-model-wrap">
          <button class="api-model-trigger" type="button" data-act="toggle-seg"
            aria-haspopup="listbox" aria-expanded="${state.segOpen ? 'true' : 'false'}">
            <span>${esc(segText)}</span>
            ${icon('chevronDown', 14)}
          </button>
          ${state.segOpen ? `
            <div class="api-model-backdrop" data-act="close-seg"></div>
            <div class="api-model-menu" role="listbox" aria-label="整备切分 API">
              <div class="api-model-group">
                <div class="api-model-group-title">API Key 已接入</div>
                ${(state.seg?.providers || []).map((p) => {
                  const selected = segCur && segCur.provider === p.provider && segCur.model === p.model;
                  return `<button class="api-model-option${selected ? ' selected' : ''}" type="button"
                    role="option" aria-selected="${selected ? 'true' : 'false'}"
                    data-seg-provider="${esc(p.provider)}" data-seg-model="${esc(p.model)}">
                    <span>${esc(p.label)} / ${esc(p.model)}</span>
                    ${selected ? icon('check', 14) : ''}
                  </button>`;
                }).join('')}
              </div>
            </div>` : ''}
        </div>
        <button class="btn small" type="button" data-act="save-seg">确认</button>
      </div>
      </div>
      ${state.modelMsg ? `<div class="hint" style="margin-top:6px">${esc(state.modelMsg)}</div>` : ''}
      ${state.segMsg ? `<div class="hint" style="margin-top:6px">${esc(state.segMsg)}</div>` : ''}
      ${state.segError ? `<div class="hint bad" style="margin-top:6px">${esc(state.segError)}</div>` : ''}
    </section>

    <section class="stat-grid">${statHtml}</section>

    <section class="two-col">
      <div class="card">${recentTraceCard(last)}</div>
      <div class="card">${configSummaryCard()}</div>
    </section>

    <section class="card">
      <div class="card-head">
        <h3>服务与图</h3>
        <span class="hint">${state.healthLatency != null ? `响应 ${state.healthLatency}ms` : '—'}</span>
        <div class="spacer"></div>
        <button class="btn small ghost" type="button" data-act="refresh-overview">${icon('refresh', 15)} 刷新</button>
      </div>
      ${state.healthError ? noticeHtml(
        state.health
          ? `记忆服务暂时没响应，下面是最后一次成功读取的数据：${state.healthError}`
          : `记忆服务暂时没响应：${state.healthError}。插件会自动重试，也可以稍后刷新。`,
        'warn',
      ) : ''}
      ${systemInfoCard(h)}
    </section>
  </div>`;
}

function recentTraceCard(last) {
  if (!last) {
    return `<div class="card-head"><h3>最近一次召回</h3><div class="spacer"></div><span class="badge">还没有记录</span></div>
      ${emptyState('trace', '还没有召回记录', '在 QQ 里问一句需要回忆的话，这里就会出现完整的章动跳步。', '<button class="btn small ghost" type="button" data-go="trace">去召回测试</button>')}`;
  }
  const n = (last.neighbors || []).length;
  return `<div class="card-head">
      <h3>最近一次召回</h3>
      <span class="badge ${esc(last.confidence || '')}">${esc(confLabel(last.confidence))}</span>
      <div class="spacer"></div>
      <button class="btn small ghost" type="button" data-go="trace">全部记录 ${icon('arrowRight', 14)}</button>
    </div>
    <div class="recent-trace">
      <div class="query">${esc(traceQuery(last))}</div>
      <div class="trace-facts">
        <span><b>${esc(last.at || '—')}</b></span>
        <span><b>${(last.eus || []).length}</b> 个 EU</span>
        <span><b>${n}</b> 个邻居</span>
        <span>召回 <b>${esc(last.ms_recall ?? '—')}ms</b></span>
      </div>
      <div class="chip-row">${(last.eus || []).slice(0, 4).map((x) => `<span class="eu-chip">${esc(x)}</span>`).join('') || '<span class="muted small">没有切出 EU</span>'}</div>
      <div class="row">
        <button class="btn small" type="button" data-go="trace">查看章动过程</button>
        ${last.center ? `<button class="btn small ghost" type="button" data-act="focus-last">${icon('target', 14)} 在图中定位中心</button>` : ''}
      </div>
    </div>`;
}

function configSummaryCard() {
  const a = state.allow;
  const o = state.owner;
  const c = state.settings?.consolidate;
  const p = state.persona;
  const win = c ? (c.enabled === false ? '已关闭' : `${c.start || '—'} → ${c.end || '—'}`) : null;
  return `<div class="card-head">
      <h3>配置概览</h3>
      <div class="spacer"></div>
      <button class="btn small ghost" type="button" data-go="access">${icon('access', 14)} 白名单</button>
    </div>
    <div class="summary-list">
      ${summaryRow('放行群组', a ? `<b>${a.groups?.length || 0}</b> 个` : '—')}
      ${summaryRow('放行私聊', a ? `<b>${a.private?.length || 0}</b> 个` : '—')}
      ${summaryRow('黑名单', a ? `<b>${a.denyUsers?.length || 0}</b> 个` : '—')}
      ${summaryRow('主人', o ? (o.ids?.length ? `<b>${o.ids.length}</b> 个号 · ${esc((o.names || []).slice(0, 2).join(' / ') || '未命名')}` : '未设置') : '—')}
      ${summaryRow('整备窗口', win ? `<b>${esc(win)}</b>` : '—')}
      ${summaryRow('落盘模式', c ? (c.mode === 'auto' ? '自动落盘' : '人工审查') : '—')}
      ${summaryRow('人设', p ? `<b>${p.text.length}</b> 字` : '—')}
    </div>`;
}

function systemInfoCard(h) {
  const meta = h?.meta || {};
  return `<div class="kv-grid">
    ${kvItem('图目录', esc(h?.graph || '—'), true)}
    ${kvItem('CE 设备', esc(h?.device || '—'), true)}
    ${kvItem('打分模式', esc(modeLabel(h?.ce_mode)))}
    ${kvItem('CE 远端', h?.ce_remote_configured ? '已配置' : '未配置')}
    ${kvItem('节点 / 边', `${fmtNum(h?.nodes)} / ${fmtNum(h?.edges)}`)}
    ${kvItem('模型', esc(meta.model || '—'))}
    ${kvItem('图更新时间', esc(meta.updated_at || '—'), true)}
  </div>`;
}

function mountOverview() {
  $('[data-act="refresh-overview"]')?.addEventListener('click', refreshCurrentPage);
  $('[data-act="focus-last"]')?.addEventListener('click', () => {
    const last = state.traces.length ? state.traces[state.traces.length - 1] : null;
    if (last?.center?.id != null) focusNodeInGraph(last.center.id);
  });
  $('[data-act="check-update"]')?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    await loadUpdate(true);
    btn.disabled = false;
    navigate('plugin');
  });
  $('[data-act="toggle-model"]')?.addEventListener('click', () => {
    state.modelOpen = !state.modelOpen;
    renderPage();
  });
  $('[data-act="close-model"]')?.addEventListener('click', () => {
    state.modelOpen = false;
    renderPage();
  });
  document.querySelectorAll('[data-model-provider]').forEach((el) => {
    el.addEventListener('click', () => {
      state.modelDraft = {
        provider: el.dataset.modelProvider,
        model: el.dataset.modelId,
      };
      state.modelOpen = false;
      state.modelMsg = '';
      renderPage();
    });
  });
  $('[data-act="save-model"]')?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    const draft = state.modelDraft;
    if (!draft?.provider || !draft?.model) {
      state.modelMsg = '请选择一个可用模型';
      renderPage();
      return;
    }
    btn.disabled = true;
    state.modelMsg = '正在切换并同步到机器人会话…';
    state.modelOpen = false;
    renderPage();
    try {
      const r = await apiPost('/model', draft);
      if (!r.ok) throw new Error(r.error || '切换失败');
      state.model = r;
      state.modelDraft = r.current || null;
      state.modelError = null;
      state.modelMsg = `已切换到 ${modelLabel(r, r.current)}`;
      toast(state.modelMsg, 'good');
    } catch (e) {
      state.modelMsg = '';
      state.modelError = e?.message || String(e);
      toast(`切换失败：${state.modelError}`, 'bad');
    }
    renderPage();
  });

  $('[data-act="toggle-seg"]')?.addEventListener('click', () => {
    state.segOpen = !state.segOpen;
    renderPage();
  });
  $('[data-act="close-seg"]')?.addEventListener('click', () => {
    state.segOpen = false;
    renderPage();
  });
  document.querySelectorAll('[data-seg-provider]').forEach((el) => {
    el.addEventListener('click', () => {
      state.segDraft = {
        provider: el.dataset.segProvider,
        model: el.dataset.segModel,
      };
      state.segOpen = false;
      state.segMsg = '';
      renderPage();
    });
  });
  $('[data-act="save-seg"]')?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    const draft = state.segDraft;
    if (!draft?.provider || !draft?.model) {
      state.segMsg = '请选择一个切分 API';
      renderPage();
      return;
    }
    btn.disabled = true;
    state.segMsg = '正在保存切分 API…';
    state.segOpen = false;
    renderPage();
    try {
      const r = await apiPost('/seg', draft);
      if (!r.ok) throw new Error(r.error || '保存失败');
      state.seg = r;
      state.segDraft = r.current || null;
      state.segError = null;
      state.segMsg = `切分 API：${r.current?.label || r.current?.provider} / ${r.current?.model}`;
      toast(state.segMsg, 'good');
    } catch (e) {
      state.segMsg = '';
      state.segError = e?.message || String(e);
      toast(`切分 API 保存失败：${state.segError}`, 'bad');
    }
    renderPage();
  });

  const replyToggle = $('#overviewReply');
  const replyState = $('#overviewReplyState');
  replyToggle?.addEventListener('change', async () => {
    const next = !!replyToggle.checked;
    replyToggle.disabled = true;
    const pill = replyToggle.closest('.reply-quick');
    if (replyState) replyState.textContent = next ? '正在开启…' : '正在暂停…';
    try {
      const r = await apiPost('/settings', { reply: { enabled: next } });
      state.settings = r;
      const on = r.reply?.enabled !== false;
      replyToggle.checked = on;
      if (replyState) replyState.textContent = on ? '已开启' : '已暂停';
      pill?.classList.toggle('is-on', on);
      toast(on ? '机器人回复已开启' : '机器人回复已暂停', 'good', 2200);
    } catch (e) {
      replyToggle.checked = !next;
      if (replyState) replyState.textContent = !next ? '已开启' : '已暂停';
      toast(`回复开关保存失败：${e?.message || e}`, 'bad', 4000);
    } finally {
      replyToggle.disabled = false;
    }
  });
}

/* ==========================================================================
   逻辑图
   ========================================================================== */

const COMM_COLORS = [
  '#5eead4', '#7c9cff', '#c084fc', '#fbbf24', '#fb7185',
  '#38bdf8', '#a3e635', '#f472b6', '#facc15', '#2dd4bf',
  '#818cf8', '#fb923c',
];

const G = {
  data: null,
  world: new Map(),
  sparse: new Set(),
  communities: new Map(),
  view: { x: 0, y: 0, k: 1 },
  inited: false,
  initialLayoutDone: false,
  signature: '',
  fitSize: null,
  stageUsable: false,
  reflowTimer: 0,
  W: 900,
  H: 600,
  dpr: 1,
  detailToken: 0,
  pulse: null,
};

function mulberry32(a) {
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 给颜色补 alpha。节点颜色可能是 hex，也可能是邻居节点算出来的 rgb()；
 * 以前只按 hex 解析，rgb(...) 会被 parseInt 成 NaN，最后画成黑色。
 */
function colorWithAlpha(color, alpha) {
  const s = String(color ?? '').trim();
  const m = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (m) {
    const parts = m[1].split(',').map((x) => x.trim());
    if (parts.length >= 3) return `rgba(${parts[0]},${parts[1]},${parts[2]},${alpha})`;
  }
  if (s.startsWith('#')) {
    const hex = s.slice(1);
    const n = hex.length === 3
      ? hex.split('').map((c) => c + c).join('')
      : hex.padEnd(6, '0').slice(0, 6);
    const v = parseInt(n, 16);
    if (Number.isFinite(v)) {
      return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${alpha})`;
    }
  }
  return s;
}

function mixColors(a, b, t) {
  const k = clamp(Number(t) || 0, 0, 1);
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
  ];
}

const GraphView = {
  ui: null,

  attach() {
    const stage = $('#graphStage');
    const cv = $('#graphCanvas');
    if (!stage || !cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    this.detach();
    const ui = { stage, cv, ctx, ro: null, pointer: null, hover: null, tip: $('#graphTip'), raf: 0, traceTimer: 0 };
    this.ui = ui;
    ui.ro = new ResizeObserver(() => {
      const oldW = G.W;
      const oldH = G.H;
      const refit = this.resize();
      // 首次尺寸不可用（后台标签页 clientHeight=0 等）时会先按 fallback 尺寸布局；
      // 恢复到真实尺寸后必须重新 layout，否则图会偏到画布角落。
      if (!refit && G.view && (oldW !== G.W || oldH !== G.H)) {
        G.view.x += (G.W - oldW) / 2;
        G.view.y += (G.H - oldH) / 2;
      }
      this.draw();
    });
    ui.onVis = () => {
      if (document.visibilityState !== 'visible' || !this.ui) return;
      if (this.resize()) this.draw();
    };
    document.addEventListener('visibilitychange', ui.onVis);
    ui.ro.observe(stage);
    this.resize();
    this.bindPointer();
    this.updateMeta();
    this.updateOverlay();
    this.renderDrawer();
    if (state.graph) {
      // 本次页面生命周期里第一次进图，或当前相机已经把所有节点都甩到画布外：
      // 不要沿用旧坐标/旧视角，按当前真实画布尺寸重新 layout。
      if (!G.initialLayoutDone || !this.viewLooksSane()) G.inited = false;
      this.onData();
    }
    const pending = state.pendingGraphFocus;
    if (pending != null && state.graph) {
      state.pendingGraphFocus = null;
      requestAnimationFrame(() => this.focus(pending));
    }
  },

  detach() {
    if (this.ui?.ro) { try { this.ui.ro.disconnect(); } catch { /* ignore */ } }
    if (this.ui?.onVis) { try { document.removeEventListener('visibilitychange', this.ui.onVis); } catch { /* ignore */ } }
    if (G.reflowTimer) { try { clearTimeout(G.reflowTimer); } catch { /* ignore */ } G.reflowTimer = 0; }
    if (this.ui?.pulseRaf) { try { cancelAnimationFrame(this.ui.pulseRaf); } catch { /* ignore */ } }
    if (this.ui?.traceTimer) { try { clearTimeout(this.ui.traceTimer); } catch { /* ignore */ } }
    G.pulse = null;
    this.ui = null;
  },

  resize() {
    const ui = this.ui;
    if (!ui) return false;
    const dpr = window.devicePixelRatio || 1;
    const rawW = ui.stage.clientWidth || ui.cv.clientWidth || 0;
    const rawH = ui.stage.clientHeight || ui.cv.clientHeight || 0;
    const w = Math.max(1, rawW || 900);
    const h = Math.max(1, rawH || 600);
    G.stageUsable = rawW >= 100 && rawH >= 100;
    const prevW = G.W;
    const prevH = G.H;
    G.W = w; G.H = h; G.dpr = dpr;
    if (ui.cv.width !== Math.round(w * dpr) || ui.cv.height !== Math.round(h * dpr)) {
      ui.cv.width = Math.round(w * dpr);
      ui.cv.height = Math.round(h * dpr);
    }
    // 之前用 fallback 尺寸或错误的初始尺寸布局过：力导向的位置本身依赖画布尺寸，
    // 只 fit 不够，必须在真实尺寸上重新 layout，否则节点坐标会保持错误的展开比例。
    const staleFit = !!G.fitSize
      && (!G.fitSize.usable || G.fitSize.W < 100 || G.fitSize.H < 100);
    const sizeChanged = prevW !== w || prevH !== h;
    const sizeJump = !!G.fitSize && (
      Math.abs(w - G.fitSize.W) > Math.max(80, G.fitSize.W * 0.25)
      || Math.abs(h - G.fitSize.H) > Math.max(80, G.fitSize.H * 0.25)
    );
    if (G.inited && sizeChanged && (staleFit || sizeJump || !G.fitSize) && G.stageUsable) {
      // 先标记为可用，避免 layout() 内部再次 resize 时递归重排
      G.fitSize = { W: G.W, H: G.H, usable: true };
      this.layout();
      return true;
    }
    return false;
  },

  /**
   * 首次进入页面时，浏览器可能先用一个中间尺寸（不只是 0）完成布局，
   * 等最终尺寸下来后 ResizeObserver 只会平移视图，图仍会偏。
   * 数据加载后延迟复核一次实际尺寸，必要时重新 layout。
   */
  /**
   * 相机是否还能看到东西。用于重新进入图页时识别「上次留下的空视角」。
   */
  viewLooksSane() {
    const pts = [...G.world.values()];
    if (!pts.length || !G.W || !G.H) return false;
    let inView = 0;
    for (const p of pts) {
      const x = p.x * G.view.k + G.view.x;
      const y = p.y * G.view.k + G.view.y;
      if (x >= 0 && x <= G.W && y >= 0 && y <= G.H) inView += 1;
      if (inView >= 3) return true;
    }
    return false;
  },

  reflowIfNeeded() {
    const ui = this.ui;
    if (!ui || !G.inited) return false;
    const w = ui.stage.clientWidth || 0;
    const h = ui.stage.clientHeight || 0;
    if (w < 100 || h < 100) return false;
    const f = G.fitSize;
    if (f && f.usable && Math.abs(w - f.W) <= 8 && Math.abs(h - f.H) <= 8) {
      return false;
    }
    // 先标记成实际尺寸，避免 layout() 内部的 resize 再触发一次重排
    G.fitSize = { W: w, H: h, usable: true };
    this.layout();
    this.draw();
    return true;
  },

  onData() {
    if (!this.ui) return;
    const data = state.graph;
    if (!data) { this.updateOverlay(); return; }
    const sig = signature(data);
    if (!G.inited) {
      this.layout();
    } else if (sig !== G.signature) {
      this.mergePositions(data, sig);
    }
    G.data = data;
    this.updateOverlay();
    this.updateMeta();
    this.renderDrawer();
    this.draw();
    const pending = state.pendingGraphFocus;
    if (pending == null) {
      if (G.reflowTimer) clearTimeout(G.reflowTimer);
      G.reflowTimer = setTimeout(() => {
        G.reflowTimer = 0;
        if (state.page === 'graph') this.reflowIfNeeded();
      }, 350);
    }
    if (pending != null) {
      state.pendingGraphFocus = null;
      requestAnimationFrame(() => this.focus(pending));
    }
  },

  mergePositions(data, sig) {
    const nodes = data.nodes || [];
    const rand = mulberry32(nodes.length * 131 + 17);
    for (const nd of nodes) {
      if (G.world.has(nd.id)) continue;
      const cen = { x: G.W / 2 + (rand() - 0.5) * G.W * 0.35, y: G.H / 2 + (rand() - 0.5) * G.H * 0.35 };
      G.world.set(nd.id, { x: cen.x, y: cen.y, vx: 0, vy: 0 });
    }
    G.signature = sig;
  },

  layout() {
    const data = state.graph;
    if (!data) return;
    this.resize();
    const W = G.W;
    const H = G.H;
    const nodes = Array.isArray(data.nodes) ? data.nodes : [];
    const edges = Array.isArray(data.edges) ? data.edges : [];
    const n = Math.max(1, nodes.length);

    // 稀疏化：完整图可能有几千条边，直接布局会糊成一团。
    const byNode = new Map(nodes.map((nd) => [nd.id, []]));
    for (const e of edges) {
      if (byNode.has(e.source)) byNode.get(e.source).push(e);
      if (byNode.has(e.target)) byNode.get(e.target).push(e);
    }
    const TOP_K = edges.length > 1500 ? 3 : 4;
    const keep = new Set();
    for (const list of byNode.values()) {
      list.sort((a, b) => (b.score || 0) - (a.score || 0));
      for (const e of list.slice(0, TOP_K)) keep.add(edgeKey(e));
    }
    G.sparse = keep;
    const sparse = edges.filter((e) => keep.has(edgeKey(e)));

    // 社区检测：标签传播。稠密图上连通分量只能分出一坨，标签传播能找出「更紧的一撮」。
    const adj = new Map(nodes.map((nd) => [nd.id, []]));
    for (const e of sparse) {
      const w = Math.max(0.05, Number(e.score) || 0.1);
      adj.get(e.source)?.push([e.target, w]);
      adj.get(e.target)?.push([e.source, w]);
    }
    const label = new Map(nodes.map((nd) => [nd.id, nd.id]));
    const rand = mulberry32(nodes.length * 7919 + edges.length);
    for (let round = 0; round < 14; round++) {
      let changed = 0;
      const order = nodes.map((nd) => nd.id);
      for (let k = order.length - 1; k > 0; k--) {
        const r = Math.floor(rand() * (k + 1));
        [order[k], order[r]] = [order[r], order[k]];
      }
      for (const id of order) {
        const tally = new Map();
        for (const [v, w] of adj.get(id) || []) {
          const lv = label.get(v);
          tally.set(lv, (tally.get(lv) || 0) + w);
        }
        if (!tally.size) continue;
        let best = label.get(id);
        let bestW = tally.get(best) || 0;
        for (const [lv, w] of tally) {
          if (w > bestW + 1e-9) { bestW = w; best = lv; }
        }
        if (best !== label.get(id)) {
          label.set(id, best);
          changed++;
        }
      }
      if (!changed) break;
    }

    const groups = new Map();
    for (const nd of nodes) {
      const l = label.get(nd.id);
      if (!groups.has(l)) groups.set(l, []);
      groups.get(l).push(nd.id);
    }
    const comps = [...groups.values()].sort((a, b) => b.length - a.length);
    G.communities = new Map();
    comps.forEach((ids, ci) => ids.forEach((id) => G.communities.set(id, ci)));

    // 簇心：多簇时用黄金角铺开，避免大环上挤成一排。
    const centroids = new Map();
    const nc = comps.length;
    if (nc <= 1) {
      centroids.set(0, { x: W / 2, y: H / 2 });
    } else {
      const base = Math.min(W, H);
      for (let c = 0; c < nc; c++) {
        const angle = c * 2.399963229728653 - Math.PI / 2;
        const radius = base * (0.07 + 0.37 * Math.sqrt((c + 0.5) / nc));
        centroids.set(c, {
          x: W / 2 + Math.cos(angle) * radius * 1.18,
          y: H / 2 + Math.sin(angle) * radius,
        });
      }
    }

    const world = new Map();
    comps.forEach((ids, ci) => {
      const cen = centroids.get(ci) || { x: W / 2, y: H / 2 };
      const rr = Math.max(44, 20 * Math.sqrt(ids.length));
      ids.forEach((id, i) => {
        const a = (i / Math.max(1, ids.length)) * Math.PI * 2 + ci * 0.7;
        const jitter = 0.65 + rand() * 0.5;
        world.set(id, {
          x: cen.x + Math.cos(a) * rr * jitter,
          y: cen.y + Math.sin(a) * rr * jitter,
          vx: 0, vy: 0,
        });
      });
    });

    const repel = 1500 * Math.max(1, n / 40);
    const ideal = 88 + Math.min(140, n * 0.38);
    const rounds = 240;
    for (let it = 0; it < rounds; it++) {
      const cool = 1 - it / rounds;
      for (let a = 0; a < nodes.length; a++) {
        const pa = world.get(nodes[a].id);
        if (!pa) continue;
        for (let b = a + 1; b < nodes.length; b++) {
          const pb = world.get(nodes[b].id);
          if (!pb) continue;
          let dx = pa.x - pb.x;
          let dy = pa.y - pb.y;
          const d2 = dx * dx + dy * dy || 0.01;
          if (d2 > 250000) continue;
          const d = Math.sqrt(d2) || 0.01;
          const f = repel / d2;
          dx /= d; dy /= d;
          pa.vx += dx * f; pa.vy += dy * f;
          pb.vx -= dx * f; pb.vy -= dy * f;
        }
      }
      for (const e of sparse) {
        const pa = world.get(e.source);
        const pb = world.get(e.target);
        if (!pa || !pb) continue;
        let dx = pb.x - pa.x;
        let dy = pb.y - pa.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const f = (d - ideal) * 0.012 * Math.max(0.15, Number(e.score) || 0.3);
        dx /= d; dy /= d;
        pa.vx += dx * f; pa.vy += dy * f;
        pb.vx -= dx * f; pb.vy -= dy * f;
      }
      for (const nd of nodes) {
        const p = world.get(nd.id);
        if (!p) continue;
        const cen = centroids.get(G.communities.get(nd.id)) || { x: W / 2, y: H / 2 };
        p.vx += (cen.x - p.x) * 0.003;
        p.vy += (cen.y - p.y) * 0.003;
        p.x += p.vx * cool * 0.72;
        p.y += p.vy * cool * 0.72;
        p.vx *= 0.80; p.vy *= 0.80;
      }
    }

    // 画布通常是宽屏，而力导向是各向同性的，算出来会是一团接近正圆。
    // 横向拉开一点，fit() 才能把宽度也用上，不至于两边一大片空。
    const stretchX = clamp((W / Math.max(1, H)) / 1.1, 0.9, 2.2);
    if (stretchX > 1.02) {
      for (const p of world.values()) {
        p.x = W / 2 + (p.x - W / 2) * stretchX;
      }
    }

    G.world = world;
    G.inited = true;
    G.signature = signature(data);
    G.data = data;
    this.fit();
  },

  fit() {
    const pts = [...G.world.values()];
    if (!pts.length) { G.view = { x: 0, y: 0, k: 1 }; return; }
    const xs = pts.map((p) => p.x).sort((a, b) => a - b);
    const ys = pts.map((p) => p.y).sort((a, b) => a - b);
    const q = (arr, t) => arr[clamp(Math.floor((arr.length - 1) * t), 0, arr.length - 1)];
    let minX = xs[0];
    let maxX = xs[xs.length - 1];
    let minY = ys[0];
    let maxY = ys[ys.length - 1];

    // 少量离群节点（新导入的边、单独的小社区）会把整张图的 bbox 拉得很大，
    // fit 之后主社区被压到画布边缘，看起来就像「图不见了」。
    // 节点够多时按每个轴分别用 5%~95% 的稳健范围取景；某个轴本身就是
    // 均匀铺开的（稳健范围太小）才退回全量。离群点仍可以拖动画布找到。
    if (pts.length >= 30) {
      const rx0 = q(xs, 0.05), rx1 = q(xs, 0.95);
      const ry0 = q(ys, 0.05), ry1 = q(ys, 0.95);
      if (rx1 - rx0 > (maxX - minX) * 0.2) { minX = rx0; maxX = rx1; }
      if (ry1 - ry0 > (maxY - minY) * 0.2) { minY = ry0; maxY = ry1; }
    }

    const padX = G.W * 0.11;
    const padY = G.H * 0.13;
    const k = clamp(
      Math.min(
        (G.W - padX * 2) / Math.max(1, maxX - minX),
        (G.H - padY * 2) / Math.max(1, maxY - minY),
      ),
      0.28, 1.6,
    );
    // 用中位数当相机中心，而不是 bbox 中心：即使一侧有少量离群点，
    // 或者社区分布本身偏向一边，主社区也会落在画布中间。
    const cx = q(xs, 0.5);
    const cy = q(ys, 0.5);
    G.view = {
      k,
      x: G.W / 2 - cx * k,
      y: G.H / 2 - cy * k,
    };
    G.fitSize = { W: G.W, H: G.H, usable: G.stageUsable !== false };
    G.initialLayoutDone = true;
  },

  project(p) {
    return { x: p.x * G.view.k + G.view.x, y: p.y * G.view.k + G.view.y };
  },

  traceInfo() {
    const last = state.traces.length ? state.traces[state.traces.length - 1] : null;
    const entries = new Set();
    const bests = new Set();
    const paths = [];
    if (!last) return { last, entries, bests, paths };
    for (const run of last.runs || []) {
      for (const id of run.entries || []) {
        const n = Number(id);
        if (Number.isFinite(n)) entries.add(n);
      }
      for (const b of run.bests || []) {
        const n = Number(b?.id ?? b?.node);
        if (Number.isFinite(n)) bests.add(n);
      }
      for (const ev of run.trace || []) {
        if (ev?.kind === 'entry' && ev.node != null) {
          const n = Number(ev.node);
          if (Number.isFinite(n)) entries.add(n);
        }
        if (ev?.kind === 'best') {
          const n = Number(ev.node);
          if (Number.isFinite(n)) bests.add(n);
          if (Array.isArray(ev.path)) {
            const path = [];
            for (const item of ev.path) {
              const raw = Array.isArray(item) ? item[0] : (item?.id ?? item?.node ?? item);
              const v = Number(raw);
              if (Number.isFinite(v) && path[path.length - 1] !== v) path.push(v);
            }
            if (path.length >= 2) paths.push(path);
          }
        }
      }
    }
    return { last, entries, bests, paths };
  },

  highlightSet() {
    if (!state.graphShowHighlight) return new Set();
    const t = this.traceInfo();
    if (!t.last) return new Set();
    const s = new Set(t.entries);
    for (const n of t.bests) s.add(n);
    if (t.last.center?.id != null) s.add(t.last.center.id);
    for (const n of t.last.neighbors || []) s.add(n.id);
    return s;
  },

  startTraceFlow() {
    const ui = this.ui;
    if (!ui || ui.traceTimer) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return;
    const step = () => {
      ui.traceTimer = 0;
      if (this.ui !== ui) return;
      if (!this.traceInfo().paths.length) return;
      this.draw();
      if (!ui.traceTimer) ui.traceTimer = setTimeout(step, 50);
    };
    ui.traceTimer = setTimeout(step, 50);
  },

  stopTraceFlow() {
    const ui = this.ui;
    if (!ui?.traceTimer) return;
    try { clearTimeout(ui.traceTimer); } catch { /* ignore */ }
    ui.traceTimer = 0;
  },

  drawTracePaths(ctx, trace, now) {
    if (!trace.paths.length) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    ctx.save();
    ctx.lineCap = 'round';
    for (const path of trace.paths) {
      const pts = path.map((id) => {
        const p = G.world.get(id);
        return p ? this.project(p) : null;
      });
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        if (!a || !b) continue;
        const grad = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
        grad.addColorStop(0, 'rgba(255,190,92,.34)');
        grad.addColorStop(0.55, 'rgba(255,210,120,.9)');
        grad.addColorStop(1, 'rgba(255,236,180,.95)');
        ctx.strokeStyle = grad;
        ctx.lineWidth = 4.4;
        ctx.shadowColor = 'rgba(255,190,92,.6)';
        ctx.shadowBlur = 14;
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();

        ctx.shadowBlur = 0;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([7, 8]);
        ctx.lineDashOffset = reduce ? 0 : -((now / 45) % 15);
        ctx.strokeStyle = 'rgba(255,244,205,.95)';
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();

        if (!reduce) {
          const q = ((now / 1100) + i / Math.max(1, pts.length - 1)) % 1;
          const px = a.x + (b.x - a.x) * q;
          const py = a.y + (b.y - a.y) * q;
          ctx.setLineDash([]);
          ctx.fillStyle = '#fff3c4';
          ctx.shadowColor = '#ffd479';
          ctx.shadowBlur = 12;
          ctx.beginPath(); ctx.arc(px, py, 2.5, 0, Math.PI * 2); ctx.fill();
          ctx.shadowBlur = 0;
        }
      }
    }
    ctx.restore();
  },

  drawRoleBadges(ctx, pt, r, isEntry, isBest) {
    if (!isEntry && !isBest) return;
    ctx.save();
    if (isEntry) {
      const x = pt.x - r - 4.8;
      const y = pt.y - r - 4.8;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.PI / 4);
      ctx.shadowColor = 'rgba(124,156,255,.95)';
      ctx.shadowBlur = 7;
      ctx.fillStyle = '#8ba8ff';
      ctx.fillRect(-3.1, -3.1, 6.2, 6.2);
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(226,235,255,.95)';
      ctx.lineWidth = 0.8;
      ctx.strokeRect(-3.1, -3.1, 6.2, 6.2);
      ctx.restore();
    }
    if (isBest) {
      const x = pt.x + r + 4.8;
      const y = pt.y - r - 4.8;
      ctx.save();
      ctx.translate(x, y);
      ctx.shadowColor = 'rgba(255,212,121,.95)';
      ctx.shadowBlur = 8;
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (Math.PI * 2 * i) / 10;
        const rad = i % 2 === 0 ? 4 : 1.8;
        const px = Math.cos(a) * rad;
        const py = Math.sin(a) * rad;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = '#ffd479';
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(255,248,220,.95)';
      ctx.lineWidth = 0.75;
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  },

  scheduleDraw() {
    const ui = this.ui;
    if (!ui || ui.raf) return;
    ui.raf = requestAnimationFrame(() => {
      ui.raf = 0;
      this.draw();
    });
  },

  /** 选中瞬间的一次扩散脉冲；只跑约 0.9s，不做持续重绘。 */
  runPulse() {
    const ui = this.ui;
    if (!ui) return;
    if (ui.pulseRaf) {
      try { cancelAnimationFrame(ui.pulseRaf); } catch { /* ignore */ }
      ui.pulseRaf = 0;
    }
    const step = () => {
      ui.pulseRaf = 0;
      if (this.ui !== ui || !G.pulse) return;
      const age = performance.now() - G.pulse.t0;
      this.draw();
      if (age < 900) ui.pulseRaf = requestAnimationFrame(step);
      else {
        G.pulse = null;
        this.draw();
      }
    };
    ui.pulseRaf = requestAnimationFrame(step);
  },

  draw() {
    const ui = this.ui;
    if (!ui || !G.inited) return;
    const cv = ui.cv;
    const ctx = ui.ctx;
    const dpr = G.dpr;
    const W = G.W;
    const H = G.H;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const data = state.graph;
    if (!data) return;
    const nodes = data.nodes || [];
    const edges = data.edges || [];
    const hi = this.highlightSet();
    const trace = state.graphShowHighlight
      ? this.traceInfo()
      : { last: null, entries: new Set(), bests: new Set(), paths: [] };
    const selId = state.graphSel?.id ?? null;
    const hover = ui.hover;
    const k = G.view.k;
    const drawAllEdges = edges.length <= 1200;

    // 选中节点的邻居关联度先算出来：边、节点、标签三处都要用。
    const selAdj = new Map();
    if (selId != null) {
      for (const e of edges) {
        if (e.source === selId) selAdj.set(e.target, Number(e.score) || 0);
        else if (e.target === selId) selAdj.set(e.source, Number(e.score) || 0);
      }
    }

    // 普通边：选中节点的边先跳过，最后单独用渐变色画在最上层。
    const seen = new Set();
    for (const e of edges) {
      const key = edgeKey(e);
      const touch = selId != null && (e.source === selId || e.target === selId);
      if (touch) continue;
      const active = hi.size > 0 && hi.has(e.source) && hi.has(e.target);
      if (!drawAllEdges && !active && !G.sparse.has(key)) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      const a = G.world.get(e.source);
      const b = G.world.get(e.target);
      if (!a || !b) continue;
      const pa = this.project(a);
      const pb = this.project(b);
      const s = clamp(Number(e.score) || 0, 0, 1);
      // 跨越大半个画布的长边往往只是「同社区」的弱联系，画满会像一根横线
      // 横穿整张图。按长度淡出，重点仍然留给近距离的强关联。
      const dist = Math.hypot(pb.x - pa.x, pb.y - pa.y);
      const lengthFade = clamp(1 - dist / (Math.max(W, H) * 1.05), 0.18, 1);
      if (active) {
        ctx.strokeStyle = `rgba(94,234,212,${(0.16 + s * 0.62) * lengthFade})`;
        ctx.lineWidth = 0.9 + s * 2.1;
      } else {
        const fade = drawAllEdges ? 1 : 0.8;
        ctx.strokeStyle = `rgba(128,154,192,${(0.035 + s * 0.17) * fade * lengthFade})`;
        ctx.lineWidth = 0.55 + s * 0.9;
      }
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }

    // 章动路径：把 entry → best 的行走路线画在普通边之上、选中边之下。
    this.drawTracePaths(ctx, trace, performance.now());

    // 选中节点的边：青绿 → 蓝紫渐变，带一层柔光和一个细亮芯。
    if (selId != null) {
      ctx.save();
      for (const e of edges) {
        if (e.source !== selId && e.target !== selId) continue;
        const a = G.world.get(e.source);
        const b = G.world.get(e.target);
        if (!a || !b) continue;
        const pa = this.project(a);
        const pb = this.project(b);
        const start = e.source === selId ? pa : pb;
        const end = e.source === selId ? pb : pa;
        const s = clamp(Number(e.score) || 0, 0, 1);
        const kk = clamp((s - 0.3) / 0.7, 0, 1);
        const dist = Math.hypot(end.x - start.x, end.y - start.y);
        const lengthFade = clamp(1 - dist / (Math.max(W, H) * 1.05), 0.2, 1);
        const grad = ctx.createLinearGradient(start.x, start.y, end.x, end.y);
        grad.addColorStop(0, `rgba(94,234,212,${(0.38 + kk * 0.52) * lengthFade})`);
        grad.addColorStop(0.52, `rgba(124,156,255,${(0.2 + kk * 0.48) * lengthFade})`);
        grad.addColorStop(1, kk > 0.5
          ? `rgba(94,234,212,${(0.16 + kk * 0.4) * lengthFade})`
          : `rgba(192,132,252,${(0.16 + kk * 0.4) * lengthFade})`);

        ctx.strokeStyle = grad;
        ctx.lineWidth = 1.1 + kk * 4.6;
        ctx.shadowColor = 'rgba(94,234,212,.35)';
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();

        // 细亮芯，让线看起来像在导光
        ctx.shadowBlur = 0;
        ctx.strokeStyle = `rgba(234,255,251,${0.16 + kk * 0.34})`;
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();
      }
      ctx.restore();
    }

    // 节点
    const labels = [];
    for (const nd of nodes) {
      const p = G.world.get(nd.id);
      if (!p) continue;
      const pt = this.project(p);
      const isSel = nd.id === selId;
      const isHover = nd.id === hover;
      const active = hi.has(nd.id);
      const isCenter = nd.id === (state.traces.length ? state.traces[state.traces.length - 1]?.center?.id : null);
      const isEntry = trace.entries.has(nd.id);
      const isBest = trace.bests.has(nd.id);
      const neighborScore = selAdj.get(nd.id);
      const isNeighbor = neighborScore !== undefined;
      const isDim = (hi.size > 0 || selId != null)
        && !active && !isSel && !isNeighbor;
      const degree = Number(nd.degree) || 0;
      const baseR = 4 + Math.min(7, degree * 0.9) + (isCenter ? 3 : isBest ? 2 : 0);
      const r = Math.max(2.2, baseR * clamp(0.78 + k * 0.35, 0.62, 1.55));

      let fill = COMM_COLORS[(G.communities.get(nd.id) || 0) % COMM_COLORS.length];
      let alpha = isDim ? (selId != null ? 0.18 : 0.3) : 0.86;
      let neighborColor = null;
      if (active) {
        fill = isCenter ? '#ffd479' : '#5eead4';
        alpha = 1;
      }
      if (isNeighbor && !isSel) {
        const kk = clamp((neighborScore - 0.3) / 0.7, 0, 1);
        neighborColor = mixColors([192, 132, 252], [94, 234, 212], kk);
        fill = `rgb(${neighborColor[0]},${neighborColor[1]},${neighborColor[2]})`;
        alpha = 1;
      }
      if (isHover) { fill = '#f4fbff'; alpha = 1; }
      if (isSel) { fill = '#f4fffd'; alpha = 1; }

      // 选中节点：先铺一层大范围的青绿柔光，再画节点本体。
      if (isSel) {
        const halo = ctx.createRadialGradient(pt.x, pt.y, r * 0.4, pt.x, pt.y, r * 5.4);
        halo.addColorStop(0, 'rgba(94,234,212,.26)');
        halo.addColorStop(0.42, 'rgba(124,156,255,.12)');
        halo.addColorStop(1, 'rgba(94,234,212,0)');
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, r * 5.4, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.save();
      if (isSel) {
        ctx.shadowColor = 'rgba(94,234,212,.95)';
        ctx.shadowBlur = 28;
      } else if (isCenter) {
        ctx.shadowColor = 'rgba(255,212,121,.8)';
        ctx.shadowBlur = 18;
      } else if (isNeighbor && neighborColor) {
        ctx.shadowColor = `rgba(${neighborColor[0]},${neighborColor[1]},${neighborColor[2]},.55)`;
        ctx.shadowBlur = 14;
      } else if (active) {
        ctx.shadowColor = 'rgba(94,234,212,.65)';
        ctx.shadowBlur = 12;
      }
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
      ctx.fillStyle = colorWithAlpha(fill, alpha);
      ctx.fill();
      ctx.restore();

      if (isSel) {
        // 白青色内核 + 青绿中心点，和网页版的玻璃/霓虹风格一致。
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, Math.max(1.4, r * 0.36), 0, Math.PI * 2);
        ctx.fillStyle = '#5eead4';
        ctx.fill();

        // 外圈虚线 + 内圈实线
        ctx.save();
        ctx.setLineDash([3, 6]);
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, r + 9, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(94,234,212,.58)';
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.restore();

        ctx.beginPath();
        ctx.arc(pt.x, pt.y, r + 4.2, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(124,156,255,.88)';
        ctx.lineWidth = 1.6;
        ctx.stroke();

        // 四个方向的刻度，像一张定位校准框
        ctx.strokeStyle = 'rgba(94,234,212,.62)';
        ctx.lineWidth = 1.1;
        for (let i = 0; i < 4; i++) {
          const a = (Math.PI / 2) * i;
          const x1 = pt.x + Math.cos(a) * (r + 13);
          const y1 = pt.y + Math.sin(a) * (r + 13);
          const x2 = pt.x + Math.cos(a) * (r + 17);
          const y2 = pt.y + Math.sin(a) * (r + 17);
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
        }

        // 选中瞬间的扩散脉冲（约 0.9s，reduced-motion 下不启动）
        if (G.pulse && G.pulse.id === nd.id) {
          const age = performance.now() - G.pulse.t0;
          if (age >= 0 && age < 900) {
            const p = age / 900;
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, r + 5 + p * 40, 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(94,234,212,${(1 - p) * 0.5})`;
            ctx.lineWidth = 2 - p * 1.2;
            ctx.stroke();
          }
        }
      } else if (isNeighbor && neighborColor) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, r + 2.8, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${neighborColor[0]},${neighborColor[1]},${neighborColor[2]},.5)`;
        ctx.lineWidth = 1.1;
        ctx.stroke();
      }
      if (!isSel && !isNeighbor && isCenter) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, r + 3.2, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,212,121,.9)';
        ctx.lineWidth = 1.7;
        ctx.stroke();
      }
      this.drawRoleBadges(ctx, pt, r, isEntry, isBest);

      const wantLabel = state.graphShowLabels
        && (isSel || isCenter || isEntry || isBest || isHover || (active && k >= 1.1)
          || (isNeighbor && (neighborScore || 0) >= 0.45)
          || (k >= 1.55 && degree >= 6) || k >= 2.1);
      if (wantLabel) {
        labels.push({
          nd, pt, r, active, isSel, isCenter, isHover, degree,
          neighbor: isNeighbor, score: neighborScore || 0,
          priority: isSel ? 100 : isCenter ? 90 : isHover ? 85
            : isNeighbor ? 65 + Math.min(20, (neighborScore || 0) * 20)
              : active ? 60 + Math.min(20, degree) : 10 + Math.min(20, degree),
        });
      }
    }

    // 标签最后画，而且做一次简单的矩形避让：
    // 高亮节点一多，标签会互相压住，看起来像一团小字。先按优先级排，
    // 放不下的低优先级标签直接跳过；选中/悬停/中心永远保留。
    labels.sort((a, b) => b.priority - a.priority);
    // 详情抽屉会盖住画布右侧约 420px；标签的可用右边界要提前收回来。
    const rightLimit = state.graphSel ? Math.max(140, W - 430) : W - 8;
    const placed = [];
    const placements = [];
    for (const item of labels) {
      const full = humanDesc(item.nd);
      const maxLen = item.isSel ? 28 : (G.view.k >= 1.85 ? 32 : 18);
      let text = full.length > maxLen ? `${full.slice(0, maxLen)}…` : full;
      if (item.isSel) text = `#${item.nd.id} · ${text}`;
      if (!text) continue;
      const fs = clamp(10.5 * clamp(G.view.k, 0.8, 1.5), 10, 15) + (item.isSel ? 1 : 0);
      ctx.font = `${item.isSel ? 600 : 500} ${fs}px "Inter","Microsoft YaHei",sans-serif`;
      const tw = ctx.measureText(text).width;
      const padX = 6;
      const bh = fs + 8;
      let bx = item.pt.x + item.r + 6;
      if (bx + tw + padX * 2 > rightLimit) bx = item.pt.x - item.r - 6 - (tw + padX * 2);
      // 靠边缘的节点，标签翻到左边会被画布裁掉；实在放不下就贴边。
      if (bx < 8) bx = clamp(item.pt.x + item.r + 6, 8,
        Math.max(8, rightLimit - (tw + padX * 2)));
      let by = item.pt.y - bh / 2;
      if (by < 6) by = 6;
      if (by + bh > H - 6) by = H - 6 - bh;
      const box = { x: bx - 3, y: by - 2, w: tw + padX * 2 + 6, h: bh + 4 };
      const collide = placed.some((p) => (
        box.x < p.x + p.w && box.x + box.w > p.x
        && box.y < p.y + p.h && box.y + box.h > p.y
      ));
      if (collide && !item.isSel && !item.isHover && !item.isCenter) continue;
      placed.push(box);
      placements.push({ item, text, fs, tw, bh, bx, by });
      if (placements.length >= 20) break;
    }
    // 倒序绘制，让选中/悬停的标签压在最上面。
    for (let i = placements.length - 1; i >= 0; i--) {
      const { item, text, fs, tw, bh, bx, by } = placements[i];
      const padX = 6;
      const selected = !!item.isSel;
      const neighbor = !!item.neighbor;
      ctx.font = `${selected ? 600 : 500} ${fs}px "Inter","Microsoft YaHei",sans-serif`;

      if (selected) {
        // 选中标签：网页版自己的青绿→紫罗兰渐变描边 + 左侧色条
        const bg = ctx.createLinearGradient(bx, by, bx, by + bh);
        bg.addColorStop(0, 'rgba(12,30,38,.97)');
        bg.addColorStop(1, 'rgba(8,14,24,.95)');
        const border = ctx.createLinearGradient(bx, by, bx + tw + padX * 2, by + bh);
        border.addColorStop(0, 'rgba(94,234,212,.78)');
        border.addColorStop(0.55, 'rgba(124,156,255,.62)');
        border.addColorStop(1, 'rgba(192,132,252,.72)');
        roundRect(ctx, bx, by, tw + padX * 2, bh, 7);
        ctx.save();
        ctx.shadowColor = 'rgba(94,234,212,.38)';
        ctx.shadowBlur = 18;
        ctx.fillStyle = bg;
        ctx.fill();
        ctx.restore();
        ctx.strokeStyle = border;
        ctx.lineWidth = 1.35;
        ctx.stroke();
        ctx.fillStyle = '#5eead4';
        roundRect(ctx, bx + 2, by + 3.5, 3, bh - 7, 2);
        ctx.fill();
        ctx.fillStyle = '#f2fffd';
      } else if (neighbor) {
        roundRect(ctx, bx, by, tw + padX * 2, bh, 6);
        ctx.fillStyle = 'rgba(7,14,22,.88)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(94,234,212,.3)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = '#dffcf7';
      } else {
        roundRect(ctx, bx, by, tw + padX * 2, bh, 6);
        ctx.fillStyle = 'rgba(7,11,18,.82)';
        ctx.fill();
        ctx.strokeStyle = item.active ? 'rgba(94,234,212,.26)' : 'rgba(148,163,184,.14)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = item.active ? '#eafffb' : 'rgba(198,209,228,.9)';
      }

      ctx.textBaseline = 'middle';
      ctx.fillText(text, bx + padX + (selected ? 4 : 0), by + bh / 2 + 0.5);
    }
    if (trace.paths.length) this.startTraceFlow();
    else this.stopTraceFlow();
  },

  updateMeta() {
    const el = $('#graphMeta');
    if (!el) return;
    const g = state.graph;
    if (!g) { el.textContent = state.graphError ? '加载失败' : '正在加载…'; return; }
    const nodes = g.nodes?.length ?? 0;
    const edges = g.edges?.length ?? 0;
    const ce = modeLabel(g.ce_mode || state.health?.ce_mode);
    const last = state.traces.length ? state.traces[state.traces.length - 1] : null;
    el.innerHTML = `<b>${fmtNum(nodes)}</b> 节点 · <b>${fmtNum(edges)}</b> 边 · CE ${esc(ce)}${last ? ` · 最近召回 ${esc(fmtTime(last.at))}` : ''}`;
  },

  updateOverlay() {
    const ov = $('#graphOverlay');
    if (!ov) return;
    if (state.graph) { ov.remove(); return; }
    if (state.loading.graph) {
      ov.innerHTML = `<div class="empty" style="padding:24px"><span class="spinner lg"></span><strong style="margin-top:10px">正在加载逻辑图…</strong><p>节点少的时候很快，图大的话要等布局算完。</p></div>`;
      return;
    }
    if (state.graphError) {
      ov.innerHTML = `<div class="empty" style="padding:24px"><div class="empty-icon">${icon('alert', 24)}</div>
        <strong>逻辑图加载失败</strong><p>${esc(state.graphError)}</p>
        <button class="btn small" type="button" data-act="retry-graph">${icon('refresh', 14)} 重试</button></div>`;
      $('[data-act="retry-graph"]', ov)?.addEventListener('click', () => loadGraph(true));
      return;
    }
    ov.innerHTML = `<div class="empty" style="padding:24px"><span class="spinner lg"></span><strong style="margin-top:10px">准备中…</strong><p>正在连接记忆服务。</p></div>`;
  },

  bindPointer() {
    const ui = this.ui;
    if (!ui) return;
    const cv = ui.cv;
    const toWorld = (ev) => {
      const rect = cv.getBoundingClientRect();
      return {
        x: (ev.clientX - rect.left - G.view.x) / G.view.k,
        y: (ev.clientY - rect.top - G.view.y) / G.view.k,
      };
    };
    const hit = (ev) => {
      const p = toWorld(ev);
      const tol = 13 / Math.max(0.5, G.view.k);
      let best = null;
      let bestD = Infinity;
      for (const nd of state.graph?.nodes || []) {
        const q = G.world.get(nd.id);
        if (!q) continue;
        const d2 = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
        if (d2 < tol * tol && d2 < bestD) { bestD = d2; best = nd; }
      }
      return best;
    };
    const setHover = (nd) => {
      const id = nd?.id ?? null;
      if (ui.hover === id) return;
      ui.hover = id;
      cv.classList.toggle('is-node', id != null);
      cv.classList.toggle('is-grabbing', !!ui.pointer && ui.pointer.type === 'pan');
      this.draw();
    };
    const hideTip = () => { ui.tip?.classList.remove('show'); };
    const showTip = (nd, ev) => {
      if (!ui.tip) return;
      const desc = humanDesc(nd);
      ui.tip.innerHTML = `<div class="tip-title">${esc(desc)}</div><div class="tip-meta">#${esc(nd.id)} · ${esc(fmtTime(nd.time))} · ${esc(nd.degree ?? 0)} 条边</div>`;
      const sr = ui.stage.getBoundingClientRect();
      let x = ev.clientX - sr.left + 16;
      let y = ev.clientY - sr.top + 16;
      if (x + 280 > sr.width) x = ev.clientX - sr.left - 292;
      if (y + 80 > sr.height) y = ev.clientY - sr.top - 86;
      ui.tip.style.left = `${Math.max(8, x)}px`;
      ui.tip.style.top = `${Math.max(8, y)}px`;
      ui.tip.classList.add('show');
    };

    cv.addEventListener('pointerdown', (ev) => {
      if (ev.button != null && ev.button !== 0) return;
      const nd = hit(ev);
      const p = toWorld(ev);
      if (nd) {
        const q = G.world.get(nd.id);
        ui.pointer = {
          type: 'node', id: nd.id, ox: q.x - p.x, oy: q.y - p.y,
          sx: ev.clientX, sy: ev.clientY, moved: false,
        };
      } else {
        ui.pointer = {
          type: 'pan', sx: ev.clientX, sy: ev.clientY,
          vx: G.view.x, vy: G.view.y, moved: false,
        };
        cv.classList.add('is-grabbing');
      }
      try { cv.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
      hideTip();
    });

    cv.addEventListener('pointermove', (ev) => {
      const m = ui.pointer;
      if (!m) {
        const nd = hit(ev);
        setHover(nd);
        if (nd) showTip(nd, ev); else hideTip();
        return;
      }
      const dx = ev.clientX - m.sx;
      const dy = ev.clientY - m.sy;
      if (Math.abs(dx) + Math.abs(dy) > 3) m.moved = true;
      if (m.type === 'node') {
        const p = toWorld(ev);
        const q = G.world.get(m.id);
        if (q) { q.x = p.x + m.ox; q.y = p.y + m.oy; this.scheduleDraw(); }
      } else {
        G.view.x = m.vx + dx;
        G.view.y = m.vy + dy;
        this.scheduleDraw();
      }
      hideTip();
    });

    const endPointer = (ev) => {
      const m = ui.pointer;
      if (!m) return;
      ui.pointer = null;
      cv.classList.remove('is-grabbing');
      try { cv.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
      if (!m.moved) {
        if (m.type === 'node') this.select(m.id);
        else this.clearSelection();
      }
    };
    cv.addEventListener('pointerup', endPointer);
    cv.addEventListener('pointercancel', (ev) => {
      ui.pointer = null;
      cv.classList.remove('is-grabbing');
      try { cv.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
    });
    cv.addEventListener('pointerleave', () => {
      if (ui.pointer) return;
      setHover(null);
      hideTip();
    });

    cv.addEventListener('wheel', (ev) => {
      // 同上：只有按住 Ctrl / Cmd 才缩放，否则交给页面滚动
      if (!ev.ctrlKey && !ev.metaKey) return;
      ev.preventDefault();
      const rect = cv.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      const my = ev.clientY - rect.top;
      const f = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
      this.zoomAt(mx, my, f);
    }, { passive: false });

    cv.addEventListener('dblclick', (ev) => {
      const nd = hit(ev);
      if (nd) this.focus(nd.id);
    });
  },

  zoomAt(mx, my, factor) {
    const v = G.view;
    const nk = clamp(v.k * factor, 0.28, 3.6);
    v.x = mx - ((mx - v.x) / v.k) * nk;
    v.y = my - ((my - v.y) / v.k) * nk;
    v.k = nk;
    this.draw();
  },

  zoom(factor) {
    this.zoomAt(G.W / 2, G.H / 2, factor);
  },

  fitView() {
    if (!G.inited) this.layout();
    else { this.fit(); this.draw(); }
  },

  resetView() {
    if (!state.graph) return;
    this.layout();
    this.clearSelection();
    this.draw();
    toast('已重新布局逻辑图', 'good', 1800);
  },

  focus(id) {
    const nid = Number(id);
    if (!state.graph) {
      state.pendingGraphFocus = nid;
      if (state.page !== 'graph') navigate('graph');
      else loadGraph();
      return;
    }
    if (!G.inited) this.layout();
    const p = G.world.get(nid);
    if (!p) { toast(`图里没有 #${nid}`, 'warn'); return; }
    const k = Math.max(G.view.k, 1.35);
    // 选中会打开右侧详情抽屉；把节点居中在抽屉左侧的可见区域，
    // 否则标签和光晕会钻到抽屉底下。
    const drawerW = Math.min(420, G.W * 0.48);
    const cx = Math.max(80, (G.W - drawerW) / 2);
    G.view = { k, x: cx - p.x * k, y: G.H / 2 - p.y * k };
    this.select(nid);
    this.draw();
  },

  select(id) {
    const nid = Number(id);
    const node = state.graph?.nodes?.find((n) => n.id === nid);
    if (!node) return;
    state.graphSel = { id: nid, desc: node.desc, degree: node.degree };
    state.graphDetail = null;
    state.graphDetailLoading = true;
    state.graphDetailError = null;
    this.renderDrawer();
    this.draw();
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    if (!reduced) {
      G.pulse = { id: nid, t0: performance.now() };
      this.runPulse();
    } else {
      G.pulse = null;
    }
    const token = ++G.detailToken;
    apiGet(`/node?id=${encodeURIComponent(nid)}`)
      .then((d) => {
        if (token !== G.detailToken) return;
        state.graphDetail = d;
        state.graphDetailLoading = false;
        state.graphDetailError = null;
        this.renderDrawer();
      })
      .catch((e) => {
        if (token !== G.detailToken) return;
        state.graphDetail = null;
        state.graphDetailLoading = false;
        state.graphDetailError = e?.message || String(e);
        this.renderDrawer();
      });
  },

  clearSelection() {
    state.graphSel = null;
    state.graphDetail = null;
    state.graphDetailLoading = false;
    state.graphDetailError = null;
    G.detailToken++;
    G.pulse = null;
    if (this.ui?.pulseRaf) {
      try { cancelAnimationFrame(this.ui.pulseRaf); } catch { /* ignore */ }
      this.ui.pulseRaf = 0;
    }
    this.renderDrawer();
    this.draw();
  },

  renderDrawer() {
    const el = $('#graphDrawer');
    if (!el) return;
    const sel = state.graphSel;
    if (!sel) { el.innerHTML = ''; el.style.display = 'none'; return; }
    el.style.display = 'flex';
    const d = state.graphDetail && state.graphDetail.id === sel.id ? state.graphDetail : null;
    if (state.graphDetailLoading) {
      el.innerHTML = `<div class="drawer-head"><span class="node-id">#${esc(sel.id)}</span><h3>事件详情</h3><div class="spacer"></div><button class="icon-btn" data-drawer-close aria-label="关闭">${icon('x', 17)}</button></div>
        <div class="drawer-body"><div class="skeleton" style="height:16px;width:70%;margin-bottom:12px"></div><div class="skeleton" style="height:80px;margin-bottom:10px"></div><div class="skeleton" style="height:11px;width:80%"></div></div>`;
      this.bindDrawer();
      return;
    }
    if (state.graphDetailError) {
      el.innerHTML = `<div class="drawer-head"><span class="node-id">#${esc(sel.id)}</span><h3>事件详情</h3><div class="spacer"></div><button class="icon-btn" data-drawer-close aria-label="关闭">${icon('x', 17)}</button></div>
        <div class="drawer-body">${noticeHtml(`读取失败：${state.graphDetailError}`, 'bad')}<div class="drawer-actions" style="margin-top:12px"><button class="btn small" data-retry-node>重试</button></div></div>`;
      this.bindDrawer();
      return;
    }
    if (!d) return;
    const nb = (d.neighbors || []).slice(0, 14);
    el.innerHTML = `<div class="drawer-head">
        <span class="node-id">#${esc(d.id)}</span><h3>事件详情</h3>
        <div class="spacer"></div>
        <span class="badge">${esc((d.neighbors || []).length)} 条边</span>
        <button class="icon-btn" data-drawer-close aria-label="关闭">${icon('x', 17)}</button>
      </div>
      <div class="drawer-body">
        <form id="nodeForm" autocomplete="off">
          <div class="field">
            <label for="ndDesc">事件描述</label>
            <textarea id="ndDesc" name="event_desc" class="textarea" style="min-height:74px" spellcheck="false">${esc(d.desc || '')}</textarea>
            <div class="desc">主体 + 动作 + 客体，8~18 字。保存后不会自动重算关联边。</div>
          </div>
          <div class="field">
            <label for="ndTime">时间</label>
            <input id="ndTime" name="time" class="input mono" value="${esc(d.time || '')}" spellcheck="false">
          </div>
          <div class="row" style="gap:8px;align-items:flex-start">
            <div class="field" style="flex:1;min-width:120px">
              <label for="ndSubj">主体</label>
              <input id="ndSubj" name="subject" class="input" value="${esc(d.subject || '')}">
            </div>
            <div class="field" style="flex:1;min-width:120px">
              <label for="ndObj">客体</label>
              <input id="ndObj" name="object" class="input" value="${esc(d.object || '')}">
            </div>
          </div>
          <div class="field">
            <label for="ndSrc">原始对话${d.session ? `（${esc(d.session)}）` : ''}</label>
            <textarea id="ndSrc" name="source_text" class="textarea mono" style="min-height:220px" spellcheck="false">${esc(d.source_text || '')}</textarea>
          </div>
          <div class="drawer-actions">
            <button class="btn primary small" type="submit">${icon('save', 14)} 保存</button>
            <button class="btn danger small" type="button" data-delete-node>${icon('trash', 14)} 删除</button>
          </div>
        </form>
        <div class="drawer-section-title">关联事件（关联度从高到低）</div>
        ${nb.length ? `<div class="neighbor-list">${nb.map((n) => {
          const kk = clamp(((n.score || 0) - 0.3) / 0.7, 0, 1);
          return `<button class="neighbor-item" type="button" data-focus-node="${esc(n.id)}">
            <span class="nid">#${esc(n.id)}</span>
            <span class="score">${esc((n.score ?? 0).toFixed ? n.score.toFixed(2) : n.score)}</span>
            <span class="ndesc">${esc(humanDesc(n))}</span>
            <span class="bar"><i style="width:${Math.round(18 + kk * 82)}%"></i></span>
          </button>`;
        }).join('')}</div>` : '<div class="muted small">这个节点还没有关联边。</div>'}
      </div>`;
    this.bindDrawer();
  },

  bindDrawer() {
    const el = $('#graphDrawer');
    if (!el) return;
    $('[data-drawer-close]', el)?.addEventListener('click', () => this.clearSelection());
    $('[data-retry-node]', el)?.addEventListener('click', () => {
      if (state.graphSel) this.select(state.graphSel.id);
    });
    const form = $('#nodeForm', el);
    if (form) {
      form.addEventListener('submit', (ev) => {
        ev.preventDefault();
        const btn = $('button[type="submit"]', form);
        const id = state.graphSel?.id;
        if (id == null) return;
        const fd = new FormData(form);
        const fields = {
          event_desc: String(fd.get('event_desc') || '').trim(),
          time: String(fd.get('time') || '').trim(),
          subject: String(fd.get('subject') || '').trim(),
          object: String(fd.get('object') || '').trim(),
          source_text: String(fd.get('source_text') || ''),
        };
        if (!fields.event_desc) { toast('事件描述不能为空', 'warn'); return; }
        withBusy(btn, '保存中…', async () => {
          await apiPost('/node/update', { id, fields });
          toast(`已保存 #${id}`, 'good');
          await loadGraph(true);
          if (state.graphSel?.id === id) this.select(id);
        }).catch((e) => toast(`保存失败：${e?.message || e}`, 'bad'));
      });
      $('[data-delete-node]', el)?.addEventListener('click', () => {
        const id = state.graphSel?.id;
        if (id == null) return;
        openConfirm({
          title: '删除这个节点？',
          message: `#${esc(id)} 会从图里移除，关联边一起消失。删除后可以在工具条里撤销（回收站是后进先出）。`,
          confirmLabel: '删除',
          danger: true,
          onConfirm: async () => {
            await apiPost('/node/delete', { id });
            toast(`已删除 #${id}，可用「撤销删除」恢复`, 'good');
            this.clearSelection();
            await loadGraph(true);
          },
        });
      });
    }
    // 邻居跳转交给 document 上的全局 [data-focus-node] 处理，避免重复绑定。
  },

  openAdd() {
    openModal({
      title: '新增事件',
      width: 580,
      body: `<form id="addNodeForm" autocomplete="off">
        <div class="field">
          <label for="addDesc">事件描述</label>
          <textarea id="addDesc" class="textarea" style="min-height:76px" placeholder="主体 + 动作 + 客体，8~18 字" spellcheck="false"></textarea>
          <div class="desc">会用 CE 跟现有全部节点算关联度，自动连边。事件太短或太泛会被过滤掉。</div>
        </div>
        <div class="field" style="margin-bottom:0">
          <label for="addSource">原始对话（可选）</label>
          <textarea id="addSource" class="textarea mono" style="min-height:150px" placeholder="贴几句当时的原话，召回时模型能讲清楚细节" spellcheck="false"></textarea>
        </div>
      </form>`,
      actions: [
        { label: '取消', kind: 'ghost' },
        {
          label: '添加并连边',
          kind: 'primary',
          close: false,
          onClick: async (btn) => {
            const desc = String($('#addDesc')?.value || '').trim();
            const source = String($('#addSource')?.value || '');
            if (!desc) { toast('事件描述不能为空', 'warn'); $('#addDesc')?.focus(); return; }
            await withBusy(btn, '添加中…', async () => {
              const r = await apiPost('/node/add', { event_desc: desc, source_text: source });
              closeModal();
              toast(`已新增 #${r.id}，连了 ${r.edges ?? 0} 条边`, 'good');
              await loadGraph(true);
              if (r.id != null) this.focus(r.id);
            }).catch((e) => toast(`新增失败：${e?.message || e}`, 'bad'));
          },
        },
      ],
      onMount: () => {
        setTimeout(() => $('#addDesc')?.focus(), 30);
      },
    });
  },

  undo() {
    withBusy($('#graphUndo'), '撤销中…', async () => {
      const r = await apiPost('/node/restore', {});
      toast(`已撤销删除：#${r.id} ${r.desc || ''}`, 'good', 4200);
      await loadGraph(true);
      if (r.id != null) this.focus(r.id);
    }).catch((e) => toast(`撤销失败：${e?.message || e}`, 'bad'));
  },
};

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function pageGraph() {
  return `<div class="graph-page">
    <div class="graph-toolbar">
      <div class="search-wrap">
        ${icon('search', 15)}
        <input id="graphSearch" class="input" placeholder="搜索事件，或输入 #编号 定位" autocomplete="off" spellcheck="false">
      </div>
      <button class="btn small" type="button" id="graphReset">${icon('refresh', 14)} 重置视图</button>
      <label class="switch" title="显示节点标签">
        <input type="checkbox" id="graphLabels" ${state.graphShowLabels ? 'checked' : ''}>
        <span class="track"></span>标签
      </label>
      <label class="switch" title="高亮最近一次召回">
        <input type="checkbox" id="graphHighlight" ${state.graphShowHighlight ? 'checked' : ''}>
        <span class="track"></span>召回高亮
      </label>
      <span class="toolbar-sep"></span>
      <button class="btn small primary" type="button" id="graphAdd">${icon('plus', 14)} 新增事件</button>
      <button class="btn small ghost" type="button" id="graphUndo">${icon('undo', 14)} 撤销删除</button>
      <div class="graph-meta" id="graphMeta">正在加载…</div>
    </div>
    <div class="graph-stage" id="graphStage">
      <canvas id="graphCanvas" tabindex="0" aria-label="逻辑关联图"></canvas>
      <div class="graph-zoom" aria-label="缩放">
        <button type="button" class="zoom-btn" data-zoom="in" title="放大">${icon('plus', 15)}</button>
        <button type="button" class="zoom-btn" data-zoom="out" title="缩小">−</button>
        <button type="button" class="zoom-btn" data-zoom="fit" title="适应画布">${icon('target', 15)}</button>
      </div>
      <div class="graph-legend" aria-hidden="true">
        <div class="legend-row"><span class="legend-dot" style="background:#5eead4"></span>事件社区</div>
        <div class="legend-row"><span class="legend-badge entry">◆</span>蓝方块 = 章动入口</div>
        <div class="legend-row"><span class="legend-badge best">★</span>金星 = 最终 best</div>
        <div class="legend-row"><span class="legend-line" style="background:linear-gradient(90deg,#ffbe5c,#fff3c4)"></span>章动路径</div>
        <div class="legend-row"><span class="legend-line"></span>关联度：低 → 高</div>
      </div>
      <div class="graph-hint">滚轮缩放 · 拖动平移 · 点击节点查看详情</div>
      <div class="graph-tip" id="graphTip"></div>
      <div class="graph-drawer" id="graphDrawer" style="display:none"></div>
      ${!state.graph ? `<div class="graph-overlay" id="graphOverlay"></div>` : ''}
    </div>
  </div>`;
}

function mountGraph() {
  GraphView.attach();
  const $stage = $('#graphStage');
  $('#graphReset')?.addEventListener('click', () => GraphView.resetView());
  $('#graphAdd')?.addEventListener('click', () => GraphView.openAdd());
  $('#graphUndo')?.addEventListener('click', () => GraphView.undo());
  $('#graphLabels')?.addEventListener('change', (ev) => {
    state.graphShowLabels = ev.target.checked;
    storageSet('xliens.graph.labels', state.graphShowLabels ? '1' : '0');
    GraphView.draw();
  });
  $('#graphHighlight')?.addEventListener('change', (ev) => {
    state.graphShowHighlight = ev.target.checked;
    storageSet('xliens.graph.highlight', state.graphShowHighlight ? '1' : '0');
    GraphView.draw();
  });
  $$('[data-zoom]', $stage).forEach((b) => {
    b.addEventListener('click', () => {
      const z = b.dataset.zoom;
      if (z === 'in') GraphView.zoom(1.2);
      else if (z === 'out') GraphView.zoom(1 / 1.2);
      else GraphView.fitView();
    });
  });
  const search = $('#graphSearch');
  search?.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    const q = String(search.value || '').trim();
    if (!q) return;
    const num = Number(q.replace(/[^0-9]/g, ''));
    let node = null;
    if (/^#?\d+$/.test(q)) node = state.graph?.nodes?.find((n) => n.id === num);
    if (!node) {
      const lower = q.toLowerCase();
      node = state.graph?.nodes?.find((n) => humanDesc(n).toLowerCase().includes(lower));
    }
    if (node) {
      GraphView.focus(node.id);
      search.value = '';
      search.blur();
    } else {
      toast(`没有找到「${q}」`, 'warn');
    }
  });
  GraphView.updateOverlay();
}

function focusNodeInGraph(id) {
  const nid = Number(id);
  if (!Number.isFinite(nid)) return;
  state.pendingGraphFocus = nid;
  if (state.page === 'graph') {
    state.pendingGraphFocus = null;
    GraphView.focus(nid);
  } else {
    navigate('graph');
  }
}

/* ==========================================================================
   章动过程
   ========================================================================== */

const KIND_NAME = {
  filter: '筛选', entry: '入口', score: '打分', move: '跳步',
  stop: '停止', entry_end: '入口结束', best: '最佳',
};

function traceQuery(t) {
  if (!t) return '（空查询）';
  const q = String(t.query || '').trim();
  if (q) return q;
  const firstEu = Array.isArray(t.eus) ? String(t.eus[0] || '').trim() : '';
  if (firstEu) return firstEu;
  const centerDesc = String(t.center?.desc || '').trim();
  return centerDesc || '（空查询）';
}

function selectedTrace() {
  if (!state.traces.length) return null;
  const i = clamp(state.traceSel ?? state.traces.length - 1, 0, state.traces.length - 1);
  return state.traces[i] || null;
}

function traceListItem(t, i, active) {
  return `<button class="trace-item ${active ? 'is-active' : ''}" type="button" data-trace="${i}">
    <div class="trace-item-top">
      <span class="badge ${esc(t.confidence || '')}">${esc(confLabel(t.confidence))}</span>
      <time title="${esc(t.at || '')}">${esc(fmtTime(t.at))}</time>
    </div>
    <div class="trace-item-query">${esc(traceQuery(t))}</div>
    <div class="trace-item-meta"><span>${(t.eus || []).length} EU</span><span>${(t.neighbors || []).length} 邻居</span><span>${esc(t.ms_recall ?? '—')}ms</span></div>
  </button>`;
}

function traceDetailHtml(t) {
  if (!t) {
    return `<div class="card" style="min-height:380px">${emptyState('trace', '选一条召回记录', '左边是按时间倒序的召回历史。点一条就能看到它当时怎么走的。', '<button class="btn small ghost" type="button" data-go="graph">去逻辑图逛逛</button>')}</div>`;
  }
  const pct = confPct(t.confidence);
  const color = confColor(t.confidence);
  const center = t.center;
  const runs = t.runs || [];
  const neighbors = t.neighbors || [];
  return `<div class="card trace-head">
      <div class="conf-ring" style="--p:${pct};--ring-color:${color}">
        <div class="conf-inner"><span class="conf-num">${pct}</span><span class="conf-label">${esc(confLabel(t.confidence))}</span></div>
      </div>
      <div class="trace-title">
        <h2>${esc(traceQuery(t))}</h2>
        <div class="meta">
          <span>${esc(t.at || '—')}</span>
          <span>切分 <b>${esc(t.ms_seg ?? '—')}ms</b></span>
          <span>召回 <b>${esc(t.ms_recall ?? '—')}ms</b></span>
          <span><b>${(t.eus || []).length}</b> 个 EU</span>
        </div>
      </div>
      ${center ? `<button class="btn small ghost" type="button" data-act="highlight-trace">${icon('target', 14)} 在图中定位</button>` : ''}
    </div>

    <div class="card">
      <div class="card-head"><h3>切出的 EU</h3><span class="hint">模型把这句话拆成了这些事件</span></div>
      <div class="chip-row">${(t.eus || []).length ? t.eus.map((x) => `<span class="eu-chip">${esc(x)}</span>`).join('') : '<span class="muted small">没有切出 EU</span>'}</div>
    </div>

    ${center ? `<div class="center-card">
      <div class="center-icon">${icon('target', 18)}</div>
      <div class="center-main">
        <div class="center-desc">${esc(humanDesc(center))}</div>
        <div class="center-meta">
          <span>#${esc(center.id)}</span>
          <span>${esc(fmtTime(center.time))}</span>
          <span>主体 ${esc(center.subject || '—')} → 客体 ${esc(center.object || '—')}</span>
        </div>
      </div>
      <div class="center-score">${esc(center.score ?? '—')}</div>
    </div>` : ''}

    <div class="card">
      <div class="card-head"><h3>游走过程</h3><span class="hint">每个 EU 独立走一遍，Best 是停下来的地方</span></div>
      ${runs.length ? runs.map((run) => `<div class="run-card card flat" style="margin-bottom:10px">
        <div class="run-head"><span class="eu-label">EU：<b>${esc(run.eu || '—')}</b></span></div>
        <div class="run-body">
          ${(run.trace || []).length ? `<div class="timeline">${run.trace.map((st) => `<div class="step ${['move', 'stop', 'best'].includes(st.kind) ? st.kind : ''}">
            <span class="kind">${esc(KIND_NAME[st.kind] || st.kind || '—')}</span>
            <span class="text">${esc(st.text || '')}</span>
          </div>`).join('')}</div>` : '<div class="muted small">没有跳步记录</div>'}
          ${(run.bests || []).length ? `<div class="chip-row" style="margin-top:8px">${run.bests.map((b) => `<span class="badge accent">#${esc(b.id)} · ${esc(b.score)}</span>`).join('')}</div>` : ''}
        </div>
      </div>`).join('') : '<div class="muted small">这次没有留下游走详情。</div>'}
    </div>

    <div class="card">
      <div class="card-head"><h3>带回的邻居</h3><span class="hint">按关联度排序</span></div>
      ${neighbors.length ? `<div class="neighbor-grid">${neighbors.map((n) => `<button class="neighbor-card" type="button" data-focus-node="${esc(n.id)}" title="${esc(humanDesc(n))}">
        <span class="hops">${esc(n.hops ?? 1)}跳</span>
        <span class="desc">${esc(humanDesc(n))}</span>
        <span class="score">${esc(n.score ?? '—')}</span>
      </button>`).join('')}</div>` : '<div class="muted small">这次没有带回邻居。</div>'}
    </div>`;
}

function recallResultHtml() {
  if (state.recallLoading) {
    return `<div class="recall-result"><div class="run-status"><span class="spinner"></span>正在召回…切分和 CE 打分要几秒，第一次还会加载模型</div></div>`;
  }
  if (state.recallError) {
    return `<div class="recall-result">${noticeHtml(`召回失败：${state.recallError}`, 'bad')}</div>`;
  }
  const r = state.recallResult;
  if (!r) return '';
  if (r.mode === 'semantic' || Array.isArray(r.events)) {
    const events = r.events || [];
    return `<div class="recall-result">
      <div class="recall-summary">${esc(r.summary || `共 ${events.length} 条`)} <span class="faint">· ${esc(r.ms ?? '—')}ms</span></div>
      ${events.length ? events.map((e) => `<button class="recall-row" type="button" data-focus-node="${esc(e.id)}" title="${esc(humanDesc(e))}">
        <span class="rid">#${esc(e.id)}</span>
        <span class="rscore">${esc(e.score ?? '—')}</span>
        <span class="rbody"><span class="rdesc">${esc(humanDesc(e))}</span><span class="rmeta">${esc(fmtTime(e.time))} · 主体 ${esc(e.subject || '—')} → 客体 ${esc(e.object || '—')}</span></span>
      </button>`).join('') : '<div class="muted small">没有找到同类事件。</div>'}
    </div>`;
  }
  const center = r.center;
  const nbrs = r.neighbors || [];
  if (!center) {
    return `<div class="recall-result">${noticeHtml(r.note || '没有找到关联事件。', 'info', 'info')}</div>`;
  }
  return `<div class="recall-result">
    <div class="recall-summary">${esc(r.note || '沿图游走找到这些关联')} <span class="faint">· ${esc(r.ms ?? '—')}ms</span></div>
    <div class="center-card">
      <div class="center-icon">${icon('target', 18)}</div>
      <div class="center-main">
        <div class="center-desc">${esc(humanDesc(center))}</div>
        <div class="center-meta"><span>#${esc(center.id)}</span><span>${esc(fmtTime(center.time))}</span><span>中心事件</span></div>
      </div>
      <div class="center-score">${esc(center.score ?? '—')}</div>
    </div>
    ${nbrs.length ? `<div class="neighbor-grid">${nbrs.map((n) => `<button class="neighbor-card" type="button" data-focus-node="${esc(n.id)}" title="${esc(humanDesc(n))}">
      <span class="hops">${esc(n.hops ?? 1)}跳</span><span class="desc">${esc(humanDesc(n))}</span><span class="score">${esc(n.score ?? '—')}</span>
    </button>`).join('')}</div>` : ''}
  </div>`;
}

function recallCardHtml() {
  return `<div class="card recall-card">
    <div class="card-head">
      <h3>召回测试</h3>
      <span class="hint">直接问记忆服务</span>
      <div class="spacer"></div>
      <div class="segmented" role="group" aria-label="召回类型">
        <button type="button" class="${state.recallMode === 'semantic' ? 'is-active' : ''}" data-recall-mode="semantic">列表类</button>
        <button type="button" class="${state.recallMode === 'logic' ? 'is-active' : ''}" data-recall-mode="logic">关联类</button>
      </div>
    </div>
    <div class="recall-form">
      <input id="recallInput" class="input" placeholder="例如：上次提到的那件事是什么时候 / 之前是不是聊过某个安排" autocomplete="off">
      <button id="recallBtn" class="btn primary" type="button">${icon('zap', 15)} 召回一下</button>
    </div>
    <div class="muted small" style="margin-top:-2px">列表类按时间倒序返回同类事件；关联类沿图游走，返回中心 + 邻居。关联类还会在左边留下一条新记录。</div>
    <div id="recallResult">${recallResultHtml()}</div>
  </div>`;
}

function pageTrace() {
  const t = selectedTrace();
  const list = state.traces.map((x, i) => ({ x, i })).reverse();
  return `<div class="trace-page">
    ${state.tracesError ? noticeHtml(`召回记录读取失败：${state.tracesError}`, 'bad') : ''}
    <div class="trace-layout">
      <div class="trace-left">
        <aside class="card trace-list-card">
          <div class="trace-list-head">
            <h3>召回记录</h3>
            <span class="count">${state.traces.length} 条</span>
            <div class="spacer"></div>
            <button class="icon-btn" type="button" data-act="refresh-traces" title="刷新">${icon('refresh', 16)}</button>
          </div>
          <div class="trace-items">
            ${list.length ? list.map(({ x, i }) => traceListItem(x, i, i === state.traceSel)).join('') : `<div class="empty" style="padding:28px 12px"><div class="empty-icon">${icon('trace', 22)}</div><strong>还没有记录</strong><p>在 QQ 里问一句需要回忆的话。</p></div>`}
          </div>
        </aside>
        ${recallCardHtml()}
      </div>
      <section class="trace-detail">${traceDetailHtml(t)}</section>
    </div>
  </div>`;
}

function mountTrace() {
  $$('.trace-item[data-trace]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.traceSel = Number(btn.dataset.trace);
      renderPage();
    });
  });
  $('[data-act="refresh-traces"]')?.addEventListener('click', (ev) => {
    withBusy(ev.currentTarget, null, async () => {
      await loadTraces(true);
      if (state.page === 'trace') renderPage();
    }).catch((e) => toast(e?.message || String(e), 'bad'));
  });
  $('[data-act="highlight-trace"]')?.addEventListener('click', () => {
    const t = selectedTrace();
    if (t?.center?.id != null) focusNodeInGraph(t.center.id);
  });
  $$('[data-recall-mode]').forEach((b) => {
    b.addEventListener('click', () => {
      state.recallMode = b.dataset.recallMode;
      $$('[data-recall-mode]').forEach((x) => x.classList.toggle('is-active', x === b));
    });
  });
  const input = $('#recallInput');
  input?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); runRecall(); }
  });
  $('#recallBtn')?.addEventListener('click', runRecall);
}

async function runRecall() {
  if (state.recallLoading) return;
  const input = $('#recallInput');
  const query = String(input?.value || '').trim();
  if (!query) { toast('先写一句要回忆的话', 'warn'); input?.focus(); return; }
  state.recallQuery = query;
  state.recallLoading = true;
  state.recallError = null;
  state.recallResult = null;
  const box = $('#recallResult');
  if (box) box.innerHTML = recallResultHtml();
  const btn = $('#recallBtn');
  if (btn) btn.disabled = true;
  try {
    const r = state.recallMode === 'logic'
      ? await apiPost('/recall', { text: query, hops: 1, max_neighbors: 10 })
      : await apiPost('/search', { text: query, limit: 8 });
    state.recallResult = r;
    state.recallLoading = false;
    state.recallError = null;
    if (box) box.innerHTML = recallResultHtml();
    if (state.recallMode === 'logic') {
      await loadTraces(true);
      if (state.page === 'trace' && !isEditing()) renderPage();
    }
  } catch (e) {
    state.recallLoading = false;
    state.recallError = e?.message || String(e);
    if (box) box.innerHTML = recallResultHtml();
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ==========================================================================
   白名单
   ========================================================================== */

function pageAccess() {
  if (!state.allow && !state.errors.allow) return `<div class="settings-page">${loadingBlock(360)}</div>`;
  const a = state.allow || { groups: [], private: [], denyUsers: [], allowAllWhenEmpty: false };
  const allowAll = !!a.allowAllWhenEmpty;
  return `<div class="settings-page">
    ${state.errors.allow ? noticeHtml(`白名单读取失败：${state.errors.allow}`, 'bad') : ''}
    <div class="settings-grid">
      <section class="card settings-card">
        <div class="card-head">
          <h3>放行白名单</h3>
          <span class="badge accent">立即生效</span>
          <div class="spacer"></div>
          <button class="btn small ghost" type="button" data-act="reload-allow">${icon('refresh', 14)} 重新读取</button>
        </div>
        <p class="lead">默认全部不放行。只有写进这里的群和私聊，机器人才会接消息。改动保存后下一句话就生效，不用重启 DSH。</p>

        <div class="id-field" data-field="groups">
          <div class="id-head"><span class="label">允许的群号</span><span class="cnt">空</span></div>
          <div class="chip-box"><input class="chip-input" placeholder="输入群号，回车添加" inputmode="numeric" autocomplete="off"></div>
          <div class="help">在 QQ 群设置里能看到群号。多个群可以一次粘贴，用换行或逗号分隔。</div>
        </div>

        <div class="id-field" data-field="private">
          <div class="id-head"><span class="label">允许的私聊 QQ 号</span><span class="cnt">空</span></div>
          <div class="chip-box"><input class="chip-input" placeholder="输入 QQ 号，回车添加" inputmode="numeric" autocomplete="off"></div>
          <div class="help">私聊主人或信任的人时，把对方 QQ 号加进来。</div>
        </div>

        <div class="id-field" data-field="denyUsers">
          <div class="id-head"><span class="label">黑名单</span><span class="cnt">空</span></div>
          <div class="chip-box"><input class="chip-input" placeholder="这些人的消息一律不理" inputmode="numeric" autocomplete="off"></div>
          <div class="help">优先级高于白名单。一般留空。</div>
        </div>

        <label class="switch" style="margin-top:2px">
          <input type="checkbox" id="allowAllWhenEmpty" ${allowAll ? 'checked' : ''}>
          <span class="track"></span>名单为空时放行全部（不推荐）
        </label>

        <div class="settings-actions">
          <button class="btn primary" type="button" id="saveAccess">${icon('save', 15)} 保存白名单</button>
          <span class="status" id="accessStatus">未修改</span>
        </div>
      </section>

      <aside class="card settings-card">
        <div class="card-head"><h3>当前放行</h3></div>
        <div class="summary-list">
          ${summaryRow('群组', `<b id="sumGroups">${a.groups?.length || 0}</b> 个`)}
          ${summaryRow('私聊', `<b id="sumPrivate">${a.private?.length || 0}</b> 个`)}
          ${summaryRow('黑名单', `<b id="sumDeny">${a.denyUsers?.length || 0}</b> 人`)}
          ${summaryRow('空名单策略', allowAll ? '放行全部' : '全部拦截')}
        </div>
        <div class="divider"></div>
        <div class="notice info">${icon('info', 16)}<div>白名单存在 <span class="mono">file/allow.json</span>，桥接每条消息都会重新读，所以保存即生效。</div></div>
        <div class="notice warn">${icon('alert', 16)}<div>如果这里全空、又没打开「空名单放行」，机器人不会回应任何 QQ 消息。这不是坏了。</div></div>
      </aside>
    </div>
  </div>`;
}

function setupChipField(root, initial, { numeric = false, placeholder = '' } = {}) {
  if (!root) return { get: () => [], set: () => {} };
  const box = $('.chip-box', root);
  const input = $('.chip-input', box);
  const cnt = $('.cnt', root);
  if (placeholder) input.placeholder = placeholder;
  let values = [];
  const seen = new Set();
  let changeCb = () => {};

  // 初始值必须先灌进来。之前忘了这一步，白名单明明有 1 个群/1 个私聊，
  // chip 框却显示空——右边的统计又对，看起来像保存丢了。
  for (const v of initial || []) {
    const s = String(v ?? '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    values.push(s);
  }

  const paint = () => {
    $$('.chip', box).forEach((el) => el.remove());
    values.forEach((v) => {
      const chip = document.createElement('span');
      chip.className = `chip ${numeric ? '' : 'violet'}`;
      const txt = document.createElement('span');
      txt.textContent = v;
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'x';
      x.textContent = '×';
      x.setAttribute('aria-label', `移除 ${v}`);
      x.addEventListener('click', (ev) => {
        ev.stopPropagation();
        values = values.filter((z) => z !== v);
        seen.delete(v);
        paint();
        changeCb(values.slice());
      });
      chip.append(txt, x);
      box.insertBefore(chip, input);
    });
    if (cnt) cnt.textContent = values.length ? `${values.length} 项` : '空';
  };

  const add = (raw) => {
    let changed = false;
    for (const tok of splitIds(raw)) {
      const v = numeric ? tok.replace(/[^\d]/g, '') : tok.slice(0, 40);
      if (!v) continue;
      if (numeric && !/^\d{5,12}$/.test(v)) {
        toast(`QQ 号应该是 5~12 位数字：${tok}`, 'warn');
        continue;
      }
      if (seen.has(v)) continue;
      seen.add(v);
      values.push(v);
      changed = true;
    }
    if (changed) { paint(); changeCb(values.slice()); }
  };

  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ',' || ev.key === '，' || ev.key === ';' || ev.key === '；') {
      ev.preventDefault();
      add(input.value);
      input.value = '';
    } else if (ev.key === 'Backspace' && !input.value && values.length) {
      const v = values.pop();
      seen.delete(v);
      paint();
      changeCb(values.slice());
    }
  });
  input.addEventListener('paste', (ev) => {
    const text = ev.clipboardData?.getData('text') || '';
    if (!/[\s,，;；]/.test(text.trim())) return;
    ev.preventDefault();
    add(text);
    input.value = '';
  });
  box.addEventListener('click', () => input.focus());
  paint();

  return {
    get: () => values.slice(),
    set: (arr) => {
      values = [];
      seen.clear();
      for (const v of arr || []) {
        const s = String(v).trim();
        if (s) { values.push(s); seen.add(s); }
      }
      paint();
    },
    onChange: (fn) => { changeCb = fn; },
  };
}

function mountAccess() {
  if (!state.allow) return;
  const a = state.allow;
  const groups = setupChipField($('[data-field="groups"]'), a.groups || [], { numeric: true });
  const priv = setupChipField($('[data-field="private"]'), a.private || [], { numeric: true });
  const deny = setupChipField($('[data-field="denyUsers"]'), a.denyUsers || [], { numeric: true });
  const all = $('#allowAllWhenEmpty');
  const status = $('#accessStatus');
  const markDirty = () => {
    if (status) { status.textContent = '有未保存修改'; status.className = 'status'; }
    const sg = $('#sumGroups'); if (sg) sg.textContent = groups.get().length;
    const sp = $('#sumPrivate'); if (sp) sp.textContent = priv.get().length;
    const sd = $('#sumDeny'); if (sd) sd.textContent = deny.get().length;
  };
  groups.onChange(markDirty);
  priv.onChange(markDirty);
  deny.onChange(markDirty);
  all?.addEventListener('change', markDirty);

  $('[data-act="reload-allow"]')?.addEventListener('click', (ev) => {
    withBusy(ev.currentTarget, null, async () => {
      await loadAllow(true);
      if (state.page === 'access') renderPage();
      toast('已重新读取白名单', 'good', 1600);
    }).catch((e) => toast(e?.message || String(e), 'bad'));
  });

  $('#saveAccess')?.addEventListener('click', (ev) => {
    withBusy(ev.currentTarget, '保存中…', async () => {
      const r = await apiPost('/allow', {
        groups: groups.get(),
        private: priv.get(),
        denyUsers: deny.get(),
        allowAllWhenEmpty: !!all?.checked,
      });
      state.allow = { ...state.allow, ...r };
      state.errors.allow = null;
      if (status) { status.textContent = '已保存，立即生效'; status.className = 'status good'; }
      toast(`白名单已保存：${(r.groups || []).length} 个群、${(r.private || []).length} 个私聊`, 'good');
      updateNavBadges();
    }).catch((e) => {
      if (status) { status.textContent = `保存失败：${e?.message || e}`; status.className = 'status bad'; }
      toast(`保存失败：${e?.message || e}`, 'bad');
    });
  });
}

/* ==========================================================================
   人设
   ========================================================================== */

function pagePersona() {
  if (!state.persona && !state.errors.persona) return `<div class="settings-page">${loadingBlock(520)}</div>`;
  const text = state.persona?.text ?? '';
  return `<div class="settings-page">
    ${state.errors.persona ? noticeHtml(`人设读取失败：${state.errors.persona}`, 'bad') : ''}
    <div class="persona-layout">
      <section class="card persona-editor">
        <div class="card-head">
          <h3>人设全文</h3>
          <span class="badge">热生效</span>
          <div class="spacer"></div>
          <button class="btn small ghost" type="button" data-act="reload-persona">${icon('refresh', 14)} 重新读取</button>
        </div>
        <div class="editor-bar">
          <span id="personaCount">${text.length} 字</span>
          <span id="personaState" class="saved">未修改</span>
          <div class="spacer"></div>
          <button class="btn small ghost" type="button" id="personaReset">撤销修改</button>
          <button class="btn small primary" type="button" id="savePersona">${icon('save', 14)} 保存</button>
        </div>
        <textarea id="personaText" class="textarea" spellcheck="false" style="min-height:560px">${esc(text)}</textarea>
        <div class="muted small">只注入 Xliens 机器人工作区（.bot-workspace）的会话，不会影响你当前的工作会话。文件在 <span class="mono">file/persona.md</span>。保存后下一轮对话立即生效，不需要重启。改之前建议先复制一份。</div>
      </section>
      <aside class="persona-preview" id="personaPreview">${renderMarkdown(text)}</aside>
    </div>
  </div>`;
}

function mountPersona() {
  const ta = $('#personaText');
  if (!ta) return;
  const preview = $('#personaPreview');
  const count = $('#personaCount');
  const status = $('#personaState');
  const saved = state.persona?.text ?? '';

  const update = () => {
    const v = ta.value;
    if (count) count.textContent = `${v.length} 字`;
    if (status) {
      const dirty = v !== saved;
      status.textContent = dirty ? '有未保存修改' : '未修改';
      status.className = dirty ? 'dirty' : 'saved';
    }
    if (preview) preview.innerHTML = renderMarkdown(v);
  };
  ta.addEventListener('input', debounce(update, 140));
  update();

  $('#personaReset')?.addEventListener('click', () => {
    ta.value = saved;
    update();
    toast('已恢复到上次读取的内容', 'info', 1800);
  });
  $('[data-act="reload-persona"]')?.addEventListener('click', (ev) => {
    withBusy(ev.currentTarget, null, async () => {
      await loadPersona(true);
      if (state.page === 'persona') renderPage();
      toast('已重新读取人设', 'good', 1600);
    }).catch((e) => toast(e?.message || String(e), 'bad'));
  });
  $('#savePersona')?.addEventListener('click', (ev) => {
    const v = ta.value;
    withBusy(ev.currentTarget, '保存中…', async () => {
      const r = await apiPost('/persona', { text: v });
      state.persona = { text: v };
      state.errors.persona = null;
      if (status) { status.textContent = `已保存（${r.chars ?? v.length} 字）`; status.className = 'saved'; }
      toast(`人设已保存（${r.chars ?? v.length} 字），下一轮对话生效`, 'good');
    }).catch((e) => toast(`保存失败：${e?.message || e}`, 'bad'));
  });
}

/* ==========================================================================
   主人
   ========================================================================== */

function pageOwner() {
  if (!state.owner && !state.errors.owner) return `<div class="settings-page">${loadingBlock(360)}</div>`;
  const o = state.owner || { ids: [], names: [] };
  const me = state.self || { ids: [], names: [] };
  return `<div class="settings-page">
    ${state.errors.owner ? noticeHtml(`主人读取失败：${state.errors.owner}`, 'bad') : ''}
    ${state.errors.self ? noticeHtml(`我的名字读取失败：${state.errors.self}`, 'bad') : ''}
    <div class="settings-grid">
      <section class="card settings-card">
        <div class="card-head">
          <h3>主人</h3>
          <span class="badge violet">偏心依据</span>
          <div class="spacer"></div>
          <button class="btn small ghost" type="button" data-act="reload-owner">${icon('refresh', 14)} 重新读取</button>
        </div>
        <p class="lead">填了这里，主人的消息在提示里会被标成【主人】，人设里「对主人偏心」「管理员就是主人」才有依据。QQ 号和 B 站是同一个人，不用分开填。</p>

        <div class="id-field" data-field="ids">
          <div class="id-head"><span class="label">主人的 QQ 号</span><span class="cnt">空</span></div>
          <div class="chip-box"><input class="chip-input" placeholder="输入 QQ 号，回车添加" inputmode="numeric" autocomplete="off"></div>
          <div class="help">多个号可以都加进来。第一个会作为主要称呼对象。</div>
        </div>

        <div class="id-field" data-field="names">
          <div class="id-head"><span class="label">主人的名字/昵称</span><span class="cnt">空</span></div>
          <div class="chip-box"><input class="chip-input" placeholder="名字、昵称、常用称呼…回车添加" autocomplete="off"></div>
          <div class="help">群名片、昵称、你叫他的称呼都算。别填太常见的词，容易误伤。</div>
        </div>

        <div class="settings-actions">
          <button class="btn primary" type="button" id="saveOwner">${icon('save', 15)} 保存主人</button>
          <span class="status" id="ownerStatus">未修改</span>
        </div>
      </section>

      <aside class="card settings-card">
        <div class="card-head"><h3>当前生效</h3></div>
        <div class="owner-preview" id="ownerPreview"></div>
        <div class="divider"></div>
        <div class="notice info">${icon('info', 16)}<div>存在 <span class="mono">file/owner.json</span>，每次组 prompt 都会重新读。保存即生效。</div></div>
      </aside>
    </div>

    <section class="card settings-card">
      <div class="card-head">
        <h3>我的名字 / 昵称 / ID</h3>
        <span class="badge accent">机器人自己</span>
        <div class="spacer"></div>
        <button class="btn small ghost" type="button" data-act="reload-self">${icon('refresh', 14)} 重新读取</button>
      </div>
      <p class="lead">机器人自己的号和名字。看到这些名字，就是在叫它——即使那条消息 @ 的是别人，它也会接话；提示里也会告诉它「这些是在叫我」。改完立即生效。</p>

      <div class="id-field" data-field="selfIds">
        <div class="id-head"><span class="label">我的 QQ 号 / ID</span><span class="cnt">空</span></div>
        <div class="chip-box"><input class="chip-input" placeholder="输入机器人自己的 QQ 号" inputmode="numeric" autocomplete="off"></div>
        <div class="help">多个号可以都加进来。只放机器人自己的账号。</div>
      </div>

      <div class="id-field" data-field="selfNames">
        <div class="id-head"><span class="label">别人怎么叫它</span><span class="cnt">空</span></div>
        <div class="chip-box"><input class="chip-input" placeholder="角色A、角色B…回车添加" autocomplete="off"></div>
        <div class="help">群友用来叫它的名字 / 昵称。别填太常见的词，容易误接。</div>
      </div>

      <div class="settings-actions">
        <button class="btn primary" type="button" id="saveSelf">${icon('save', 15)} 保存我的名字</button>
        <span class="status" id="selfStatus">未修改</span>
      </div>
    </section>
  </div>`;
}

function mountOwner() {
  if (!state.owner) return;
  const o = state.owner;
  const me = state.self || { ids: [], names: [] };
  const ids = setupChipField($('[data-field="ids"]'), o.ids || [], { numeric: true });
  const names = setupChipField($('[data-field="names"]'), o.names || [], { placeholder: '主人、老婆、老板…' });
  const selfIds = setupChipField($('[data-field="selfIds"]'), me.ids || [], { numeric: true });
  const selfNames = setupChipField($('[data-field="selfNames"]'), me.names || [], { placeholder: '角色A、角色B…' });
  const status = $('#ownerStatus');
  const selfStatus = $('#selfStatus');
  const preview = $('#ownerPreview');

  const refreshPreview = () => {
    if (!preview) return;
    const is = ids.get();
    const ns = names.get();
    if (!is.length && !ns.length) {
      preview.innerHTML = `<div class="muted small">还没有设置主人。机器人会把所有人当普通群友。</div>`;
      return;
    }
    preview.innerHTML = is.length
      ? is.map((id, i) => `<div class="owner-pill">
          <div class="avatar">${esc((ns[i] || ns[0] || '主').slice(0, 1))}</div>
          <div class="who"><b>${esc(ns[i] || ns[0] || '未命名')}</b><span>${esc(id)}</span></div>
          ${i === 0 ? '<span class="badge accent" style="margin-left:auto">主要</span>' : ''}
        </div>`).join('')
      : ns.map((n) => `<span class="chip violet">${esc(n)}</span>`).join('');
  };

  const markDirty = () => {
    if (status) { status.textContent = '有未保存修改'; status.className = 'status'; }
    refreshPreview();
  };
  ids.onChange(markDirty);
  names.onChange(markDirty);
  selfIds.onChange(() => {
    if (selfStatus) { selfStatus.textContent = '有未保存修改'; selfStatus.className = 'status'; }
  });
  selfNames.onChange(() => {
    if (selfStatus) { selfStatus.textContent = '有未保存修改'; selfStatus.className = 'status'; }
  });
  refreshPreview();

  $('[data-act="reload-owner"]')?.addEventListener('click', (ev) => {
    withBusy(ev.currentTarget, null, async () => {
      await loadOwner(true);
      if (state.page === 'owner') renderPage();
      toast('已重新读取主人设置', 'good', 1600);
    }).catch((e) => toast(e?.message || String(e), 'bad'));
  });

  $('#saveOwner')?.addEventListener('click', (ev) => {
    withBusy(ev.currentTarget, '保存中…', async () => {
      const r = await apiPost('/owner', { ids: ids.get(), names: names.get() });
      state.owner = { ids: r.ids || [], names: r.names || [] };
      state.errors.owner = null;
      if (status) { status.textContent = '已保存，立即生效'; status.className = 'status good'; }
      refreshPreview();
      toast(`主人已保存：${(r.ids || []).length} 个号、${(r.names || []).length} 个名字/昵称`, 'good');
    }).catch((e) => {
      if (status) { status.textContent = `保存失败：${e?.message || e}`; status.className = 'status bad'; }
      toast(`保存失败：${e?.message || e}`, 'bad');
    });
  });

  $('[data-act="reload-self"]')?.addEventListener('click', (ev) => {
    withBusy(ev.currentTarget, null, async () => {
      await loadSelf(true);
      if (state.page === 'owner') renderPage();
      toast('已重新读取我的名字', 'good', 1600);
    }).catch((e) => toast(e?.message || String(e), 'bad'));
  });

  $('#saveSelf')?.addEventListener('click', (ev) => {
    withBusy(ev.currentTarget, '保存中…', async () => {
      const r = await apiPost('/settings', { self: { ids: selfIds.get(), names: selfNames.get() } });
      state.settings = r;
      state.self = { ids: r.self?.ids || [], names: r.self?.names || [] };
      state.errors.self = null;
      if (selfStatus) { selfStatus.textContent = '已保存，立即生效'; selfStatus.className = 'status good'; }
      toast(`我的名字已保存：${state.self.ids.length} 个号、${state.self.names.length} 个名字`, 'good');
    }).catch((e) => {
      if (selfStatus) { selfStatus.textContent = `保存失败：${e?.message || e}`; selfStatus.className = 'status bad'; }
      toast(`保存失败：${e?.message || e}`, 'bad');
    });
  });
}

/* ==========================================================================
   落盘
   ========================================================================== */

function normalizeConsolidate() {
  const c = state.settings?.consolidate || {};
  return {
    enabled: c.enabled !== false,
    start: c.start || (Array.isArray(c.at) && c.at[0]) || '03:00',
    end: c.end || '06:00',
    mode: c.mode === 'auto' ? 'auto' : 'review',
  };
}

function consolidateResultHtml(r) {
  if (!r) {
    return `<div class="muted small">第一次跑要加载切分模型，可能要一两分钟。跑的时候可以切走，回来结果还在这。</div>`;
  }
  if (r.skipped) {
    return `<div class="notice info">${icon('info', 16)}<div>${esc(r.reason || '没有需要整备的内容')}</div></div>`;
  }
  const review = r.mode === 'review';
  const auto = r.mode === 'auto';
  return `<div class="run-result">
    <div class="rr"><div class="k">会话</div><div class="v">${fmtNum(r.sessions)}</div></div>
    <div class="rr"><div class="k">消息</div><div class="v">${fmtNum(r.messages)}</div></div>
    <div class="rr"><div class="k">${review ? '待审查事件' : '新增事件'}</div><div class="v">${fmtNum(r.new_eus)}</div></div>
    <div class="rr"><div class="k">${review ? '关联' : '新增关联'}</div><div class="v">${review ? '—' : fmtNum(r.new_edges)}</div></div>
  </div>
  ${review
    ? `<div class="notice info" style="margin-top:10px">${icon('info', 16)}<div>批次 <span class="mono">${esc(r.staged || '—')}</span> 已暂存，等人工审查。去「落盘」页确认后才会写进图。<div class="row" style="margin-top:8px"><button class="btn small" type="button" data-go="staging">去落盘页审查</button></div></div></div>`
    : `<div class="muted small">现有 ${fmtNum(r.nodes)} 个节点 / ${fmtNum(r.edges)} 条边。${auto ? '（自动落盘模式，已直接入图）' : ''}</div>`}`;
}

function pageConsolidate() {
  if (!state.settings && !state.errors.settings) return `<div class="settings-page">${loadingBlock(380)}</div>`;
  const c = normalizeConsolidate();
  return `<div class="settings-page">
    ${state.errors.settings ? noticeHtml(`整备设置读取失败：${state.errors.settings}`, 'bad') : ''}
    <div class="settings-grid">
      <section class="card settings-card">
        <div class="card-head">
          <h3>定时整备</h3>
          <span class="badge accent">每日</span>
          <div class="spacer"></div>
          <button class="btn small ghost" type="button" data-act="reload-settings">${icon('refresh', 14)} 重新读取</button>
        </div>
        <p class="lead">在这个时间窗口里，插件会在专用会话提醒 TA 调用 consolidate 工具，把这段时间的聊天切成事件。结果默认先进「落盘」页暂存，确认后才写进图。</p>

        <label class="switch">
          <input type="checkbox" id="csEnabled" ${c.enabled ? 'checked' : ''}>
          <span class="track"></span>启用定时整备
        </label>

        <div class="time-row">
          <div class="field">
            <label for="csStart">从</label>
            <input id="csStart" class="input time-input" type="time" value="${esc(c.start)}">
          </div>
          <div class="arrow">→</div>
          <div class="field">
            <label for="csEnd">到</label>
            <input id="csEnd" class="input time-input" type="time" value="${esc(c.end)}">
          </div>
        </div>
        <div class="preset-row">
          <button class="preset-chip" type="button" data-preset="03:00|06:00">03:00 → 06:00</button>
          <button class="preset-chip" type="button" data-preset="02:00|02:30">02:00 → 02:30</button>
          <button class="preset-chip" type="button" data-preset="23:30|00:30">23:30 → 00:30</button>
          <button class="preset-chip" type="button" data-preset="04:00|05:00">04:00 → 05:00</button>
        </div>
        <div class="muted small">起始晚于结束表示跨夜，例如 23:30 到 00:30。留空或关闭开关就不定时整备。</div>

        <div class="settings-actions">
          <button class="btn primary" type="button" id="saveConsolidate">${icon('save', 15)} 保存设置</button>
          <span class="status" id="consolidateStatus">未修改</span>
        </div>
      </section>

      <aside class="card settings-card">
        <div class="card-head"><h3>立刻整备</h3><span class="hint">手动跑一次</span></div>
        <p class="lead">把还没整备的聊天立刻切分整理。默认结果先进入「落盘」页暂存，审查确认后才写进逻辑图。</p>
        <div class="consolidate-run">
          <button class="btn primary" type="button" id="runConsolidate" ${state.actions.consolidating ? 'disabled' : ''}>
            ${state.actions.consolidating ? '<span class="spinner"></span>整备中…' : `${icon('play', 15)} 立刻整备`}
          </button>
          <div class="run-status"><span id="runTimer">${state.actions.consolidating ? '正在处理…' : '还没跑过'}</span></div>
          <div id="runResult">${consolidateResultHtml(state.lastConsolidate)}</div>
        </div>
      </aside>
    </div>
  </div>`;
}

function mountConsolidate() {
  if (!state.settings) return;
  const c = normalizeConsolidate();
  const enabled = $('#csEnabled');
  const start = $('#csStart');
  const end = $('#csEnd');
  const status = $('#consolidateStatus');
  const markDirty = () => {
    if (status) { status.textContent = '有未保存修改'; status.className = 'status'; }
  };
  enabled?.addEventListener('change', markDirty);
  start?.addEventListener('change', markDirty);
  end?.addEventListener('change', markDirty);
  $$('[data-preset]').forEach((b) => {
    b.addEventListener('click', () => {
      const [s, e] = String(b.dataset.preset || '').split('|');
      if (start && s) start.value = s;
      if (end && e) end.value = e;
      markDirty();
    });
  });
  $('[data-act="reload-settings"]')?.addEventListener('click', (ev) => {
    withBusy(ev.currentTarget, null, async () => {
      await loadSettings(true);
      if (state.page === 'consolidate') renderPage();
      toast('已重新读取整备设置', 'good', 1600);
    }).catch((e) => toast(e?.message || String(e), 'bad'));
  });
  $('#saveConsolidate')?.addEventListener('click', (ev) => {
    withBusy(ev.currentTarget, '保存中…', async () => {
      const r = await apiPost('/settings', {
        consolidate: {
          enabled: !!enabled?.checked,
          start: String(start?.value || '').trim(),
          end: String(end?.value || '').trim(),
        },
      });
      state.settings = r;
      state.errors.settings = null;
      if (status) { status.textContent = '已保存，下一轮定时生效'; status.className = 'status good'; }
      toast('整备设置已保存', 'good');
    }).catch((e) => {
      if (status) { status.textContent = `保存失败：${e?.message || e}`; status.className = 'status bad'; }
      toast(`保存失败：${e?.message || e}`, 'bad');
    });
  });
  $('#runConsolidate')?.addEventListener('click', (ev) => runConsolidate(ev.currentTarget));
}

async function runConsolidate(btn) {
  if (state.actions.consolidating) return;
  state.actions.consolidating = true;
  const started = Date.now();
  const timer = setInterval(() => {
    const el = $('#runTimer');
    if (el) el.textContent = `正在处理… 已用 ${Math.round((Date.now() - started) / 1000)}s`;
  }, 500);
  const label = $('#runTimer');
  if (label) label.textContent = '正在处理… 已用 0s';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>整备中…';
  }
  try {
    const r = await apiPost('/consolidate', {});
    state.lastConsolidate = r;
    // 新批次已经落盘：下一次进「落盘」必须重新拉，并直接选中这批。
    state.staging.loaded = false;
    if (r.staged) state.staging.sel = r.staged;
    if (label) label.textContent = `上次用时 ${Math.round((Date.now() - started) / 1000)}s`;
    const box = $('#runResult');
    if (box) box.innerHTML = consolidateResultHtml(r);
    const toastMsg = r.skipped
      ? (r.reason || '没有需要整备的内容')
      : r.mode === 'review'
        ? `已暂存 ${r.new_eus} 个事件，去「落盘」页审查确认入图`
        : `整备完成：新增 ${r.new_eus} 个事件、${r.new_edges} 条关联`;
    toast(toastMsg, r.skipped ? 'info' : 'good', 5000);
    if (state.page === 'overview') {
      navigate('consolidate');
    }
  } catch (e) {
    if (label) label.textContent = '整备失败';
    toast(`整备失败：${e?.message || e}`, 'bad', 5000);
  } finally {
    state.actions.consolidating = false;
    clearInterval(timer);
    if (btn?.isConnected) {
      btn.disabled = false;
      btn.innerHTML = `${icon('play', 15)} 立刻整备`;
    }
  }
}

/* ==========================================================================
   落盘（审查整备批次）
   ========================================================================== */

function stagingStatusBadge(s) {
  if (s === 'committed') return '<span class="badge high">已入图</span>';
  if (s === 'discarded') return '<span class="badge">已丢弃</span>';
  return '<span class="badge medium">待审查</span>';
}

function stagingStatusText(s) {
  return s === 'committed' ? '已入图' : s === 'discarded' ? '已丢弃' : '待审查';
}

const StagingGraph = {
  ui: null,
  data: null,
  sel: null,
  hover: null,
  pos: new Map(),
  view: { x: 0, y: 0, k: 1 },
  drag: null,
  showLabels: false,
  showCandidates: true,
  pulse: null,
  lockPulse: null,

  attach() {
    const stage = $('#stagingGraphStage');
    const cv = $('#stagingGraphCanvas');
    if (!stage || !cv || !state.staging.detail) return;
    this.detach();
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    this.ui = { stage, cv, ctx, ro: null };
    this.build();
    this.layout();
    this.ro = new ResizeObserver(() => { this.layout(); });
    this.ui.ro = this.ro;
    this.ro.observe(stage);
    this.bind();
    this.draw();
    this.runRipple();
    this.renderDrawer();
    this.updateMeta();
  },

  detach() {
    if (this.ro) { try { this.ro.disconnect(); } catch { /* ignore */ } this.ro = null; }
    if (this.ui?.pulseRaf) {
      try { cancelAnimationFrame(this.ui.pulseRaf); } catch { /* ignore */ }
      this.ui.pulseRaf = 0;
    }
    if (this.ui?.lockRaf) {
      try { cancelAnimationFrame(this.ui.lockRaf); } catch { /* ignore */ }
      this.ui.lockRaf = 0;
    }
    if (this.ui?.rippleRaf) {
      try { cancelAnimationFrame(this.ui.rippleRaf); } catch { /* ignore */ }
      this.ui.rippleRaf = 0;
    }
    if (this.ui?.onWheel) this.ui.cv.removeEventListener('wheel', this.ui.onWheel);
    this.ui = null;
  },

  build() {
    const d = state.staging.detail;
    if (!d) { this.data = null; return; }
    const targets = Array.isArray(d.targets) ? d.targets : [];
    const events = Array.isArray(d.events) ? d.events : [];
    const nodeTargets = targets.filter((t) => t.type === 'node');
    const maxId = nodeTargets.reduce((m, t) => Math.max(m, Number(t.id) || 0), -1);
    const temp = (i) => maxId + 1 + i;
    const nodes = [];
    const byId = new Map();
    nodeTargets.forEach((t) => {
      const n = { id: Number(t.id), desc: t.desc || '', batch: false };
      nodes.push(n); byId.set(n.id, n);
    });
    events.forEach((e, i) => {
      const n = { id: temp(i), desc: e.desc || '（无描述）', batch: true, locked: !!e.locked, event: e, idx: i };
      nodes.push(n); byId.set(n.id, n);
    });
    const edges = [];
    const seen = new Set();
    (d.graph_edges || []).forEach((e) => {
      const a = Number(e.source), b = Number(e.target);
      if (!byId.has(a) || !byId.has(b)) return;
      const key = `${a}|${b}|old`;
      if (seen.has(key)) return;
      seen.add(key);
      edges.push({ source: a, target: b,
        score: Number(e.score || 0), kind: 'old' });
    });
    events.forEach((e, i) => {
      (e.candidates || []).forEach((c, ci) => {
        const target = c.target_type === 'batch' ? temp(Number(c.target_index)) : Number(c.target_id);
        if (!byId.has(target) || target === temp(i)) return;
        const key = `${temp(i)}|${target}|${ci}`;
        if (seen.has(key)) return;
        seen.add(key);
        edges.push({ source: temp(i), target,
          score: Number(c.score || 0), kind: 'candidate',
          manual: !!c.manual, eventIdx: i, candIdx: ci });
      });
    });
    this.data = { nodes, edges, byId, temp, maxId };
    // 和逻辑图一样做稀疏化：每个节点只画最强的几条旧边，避免糊成毛线团。
    const degree = new Map(nodes.map((n) => [n.id, 0]));
    const byNode = new Map(nodes.map((n) => [n.id, []]));
    for (const e of edges) {
      if (e.kind !== 'old') continue;
      degree.set(e.source, (degree.get(e.source) || 0) + 1);
      degree.set(e.target, (degree.get(e.target) || 0) + 1);
      byNode.get(e.source)?.push(e); byNode.get(e.target)?.push(e);
    }
    for (const n of nodes) n.degree = degree.get(n.id) || 0;
    const sparse = new Set();
    for (const list of byNode.values()) {
      list.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
      for (const e of list.slice(0, 4)) sparse.add(`${e.source}|${e.target}|${e.kind}`);
    }
    this.sparse = sparse;
    // 候选边默认每个本批节点只画最强的 3 条，避免虚线铺满画布；抽屉里仍显示全部。
    const candSparse = new Set();
    const candBy = new Map();
    for (const e of edges) {
      if (e.kind !== 'candidate') continue;
      if (!candBy.has(e.source)) candBy.set(e.source, []);
      candBy.get(e.source).push(e);
    }
    for (const list of candBy.values()) {
      list.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
      for (const e of list.slice(0, 3)) candSparse.add(`${e.source}|${e.target}|${e.kind}`);
    }
    this.candSparse = candSparse;
    // 简单标签传播，给已有节点分社区色，靠近逻辑图的观感。
    const lab = new Map(nodes.map((n) => [n.id, n.id]));
    const cadj = new Map(nodes.map((n) => [n.id, []]));
    for (const e of edges) {
      if (e.kind !== 'old') continue;
      cadj.get(e.source)?.push(e.target);
      cadj.get(e.target)?.push(e.source);
    }
    for (let round = 0; round < 8; round++) {
      for (const n of nodes) {
        const tally = new Map();
        for (const v of cadj.get(n.id) || []) {
          const l = lab.get(v);
          tally.set(l, (tally.get(l) || 0) + 1);
        }
        let best = lab.get(n.id), bestN = tally.get(best) || 0;
        for (const [l, cnt] of tally) if (cnt > bestN) { best = l; bestN = cnt; }
        lab.set(n.id, best);
      }
    }
    const commIndex = new Map();
    nodes.forEach((n) => {
      const l = lab.get(n.id);
      if (!commIndex.has(l)) commIndex.set(l, commIndex.size);
      n.community = commIndex.get(l);
    });
    this.sel = null;
    this.hover = null;
    this.lockPulse = null;
    this.pos = new Map();
  },

  layout() {
    const d = this.data;
    const ui = this.ui;
    if (!d || !ui) return;
    const W = Math.max(320, ui.stage.clientWidth || 900);
    const H = Math.max(320, ui.stage.clientHeight || 600);
    // 用固定的逻辑图基准画布布局，再缩放到当前落盘画布：
    // 这样即使左侧多了批次卡片，节点团簇形状仍和逻辑图一致。
    const LW = 1150, LH = 700;
    this.W = W; this.H = H;
    const baseNodes = d.nodes.filter((nd) => !nd.batch);
    const n = baseNodes.length;
    if (!n) return;
    const oldEdgeCount = d.edges.filter((e) => e.kind === 'old').length;
    const rand = mulberry32(baseNodes.length * 7919 + oldEdgeCount);
    const keyOf = (e) => `${e.source}|${e.target}|${e.kind}`;
    const sparse = d.edges.filter((e) => e.kind === 'old' && this.sparse?.has(keyOf(e)));
    const adj = new Map(baseNodes.map((nd) => [nd.id, []]));
    for (const e of sparse) {
      if (!adj.has(e.source) || !adj.has(e.target)) continue;
      const w = Math.max(0.05, Number(e.score) || 0.1);
      adj.get(e.source).push([e.target, w]);
      adj.get(e.target).push([e.source, w]);
    }
    // 与逻辑图完全一致的加权标签传播
    const label = new Map(baseNodes.map((nd) => [nd.id, nd.id]));
    for (let round = 0; round < 14; round++) {
      let changed = 0;
      const order = baseNodes.map((nd) => nd.id);
      for (let k = order.length - 1; k > 0; k--) {
        const r = Math.floor(rand() * (k + 1));
        [order[k], order[r]] = [order[r], order[k]];
      }
      for (const id of order) {
        const tally = new Map();
        for (const [v, w] of adj.get(id) || []) {
          const lv = label.get(v);
          tally.set(lv, (tally.get(lv) || 0) + w);
        }
        if (!tally.size) continue;
        let best = label.get(id), bestW = tally.get(best) || 0;
        for (const [lv, w] of tally) {
          if (w > bestW + 1e-9) { bestW = w; best = lv; }
        }
        if (best !== label.get(id)) { label.set(id, best); changed++; }
      }
      if (!changed) break;
    }
    const groups = new Map();
    for (const nd of baseNodes) {
      const l = label.get(nd.id);
      if (!groups.has(l)) groups.set(l, []);
      groups.get(l).push(nd.id);
    }
    const comps = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
    const nc = comps.length;
    const centroids = new Map();
    const base = Math.min(LW, LH);
    comps.forEach(([cid], ci) => {
      if (nc <= 1) { centroids.set(cid, { x: LW / 2, y: LH / 2 }); return; }
      const angle = ci * 2.399963229728653 - Math.PI / 2;
      const radius = base * (0.07 + 0.37 * Math.sqrt((ci + 0.5) / nc));
      centroids.set(cid, {
        x: LW / 2 + Math.cos(angle) * radius * 1.18,
        y: LH / 2 + Math.sin(angle) * radius,
      });
    });
    const bp = new Map();
    comps.forEach(([cid, ids], ci) => {
      const cen = centroids.get(cid) || { x: LW / 2, y: LH / 2 };
      const rr = Math.max(44, 20 * Math.sqrt(ids.length));
      ids.forEach((id, i) => {
        const a = (i / Math.max(1, ids.length)) * Math.PI * 2 + ci * 0.7;
        const jitter = 0.65 + rand() * 0.5;
        bp.set(id, { x: cen.x + Math.cos(a) * rr * jitter,
          y: cen.y + Math.sin(a) * rr * jitter, vx: 0, vy: 0 });
      });
    });
    const repel = 1500 * Math.max(1, n / 40);
    const ideal = 88 + Math.min(140, n * 0.38);
    const rounds = 240;
    for (let it = 0; it < rounds; it++) {
      const cool = 1 - it / rounds;
      for (let a = 0; a < baseNodes.length; a++) {
        const pa = bp.get(baseNodes[a].id);
        for (let b = a + 1; b < baseNodes.length; b++) {
          const pb = bp.get(baseNodes[b].id);
          let dx = pa.x - pb.x, dy = pa.y - pb.y;
          const d2 = dx * dx + dy * dy || 0.01;
          if (d2 > 250000) continue;
          const dist = Math.sqrt(d2) || 0.01;
          const f = repel / d2;
          dx /= dist; dy /= dist;
          pa.vx += dx * f; pa.vy += dy * f;
          pb.vx -= dx * f; pb.vy -= dy * f;
        }
      }
      for (const e of sparse) {
        const pa = bp.get(e.source), pb = bp.get(e.target);
        if (!pa || !pb) continue;
        let dx = pb.x - pa.x, dy = pb.y - pa.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const f = (dist - ideal) * 0.012 * Math.max(0.15, Number(e.score) || 0.3);
        dx /= dist; dy /= dist;
        pa.vx += dx * f; pa.vy += dy * f;
        pb.vx -= dx * f; pb.vy -= dy * f;
      }
      for (const nd of baseNodes) {
        const p = bp.get(nd.id);
        if (!p) continue;
        const cen = centroids.get(label.get(nd.id)) || { x: LW / 2, y: LH / 2 };
        p.vx += (cen.x - p.x) * 0.003;
        p.vy += (cen.y - p.y) * 0.003;
        p.x += p.vx * cool * 0.72;
        p.y += p.vy * cool * 0.72;
        p.vx *= 0.80; p.vy *= 0.80;
      }
    }
    const stretchX = Math.max(0.9, Math.min(2.2, (LW / Math.max(1, LH)) / 1.1));
    if (stretchX > 1.02) {
      for (const p of bp.values()) p.x = LW / 2 + (p.x - LW / 2) * stretchX;
    }
    // 本批新增节点按屏幕半径围成一圈，避免被已有图的缩放压成一坨。
    const batchNodes = d.nodes.filter((nd) => nd.batch);
    const xs = baseNodes.map((nd) => bp.get(nd.id).x).sort((a, b) => a - b);
    const ys = baseNodes.map((nd) => bp.get(nd.id).y).sort((a, b) => a - b);
    const q = (arr, t) => arr[Math.max(0, Math.min(arr.length - 1, Math.floor(arr.length * t)))];
    let minX = xs[0], maxX = xs[xs.length - 1], minY = ys[0], maxY = ys[ys.length - 1];
    if (xs.length >= 30) {
      const rx0 = q(xs, 0.05), rx1 = q(xs, 0.95);
      const ry0 = q(ys, 0.05), ry1 = q(ys, 0.95);
      if (rx1 - rx0 > (maxX - minX) * 0.2) { minX = rx0; maxX = rx1; }
      if (ry1 - ry0 > (maxY - minY) * 0.2) { minY = ry0; maxY = ry1; }
    }
    const padX = W * 0.11, padY = H * 0.13;
    const k = Math.max(0.36, Math.min(1.6,
      Math.min((W - padX * 2) / Math.max(1, maxX - minX),
        (H - padY * 2) / Math.max(1, maxY - minY))));
    this.view.k = k;
    this.view.x = W / 2 - q(xs, 0.5) * k;
    this.view.y = H / 2 - q(ys, 0.5) * k;
    const worldCx = (W / 2 - this.view.x) / k;
    const worldCy = (H / 2 - this.view.y) / k;
    const ringScreenR = Math.min(W, H) * 0.42;
    const ringWorldR = ringScreenR / k;
    batchNodes.forEach((nd, i) => {
      const a = (i / Math.max(1, batchNodes.length)) * Math.PI * 2 - Math.PI / 2;
      bp.set(nd.id, { x: worldCx + Math.cos(a) * ringWorldR,
        y: worldCy + Math.sin(a) * ringWorldR, vx: 0, vy: 0 });
    });
    this.pos = bp;
  },

  fit() {
    if (!this.ui || !this.data) return;
    const W = this.ui.stage.clientWidth, H = this.ui.stage.clientHeight;
    const xs = [...this.pos.values()].map((p) => p.x).sort((a, b) => a - b);
    const ys = [...this.pos.values()].map((p) => p.y).sort((a, b) => a - b);
    if (!xs.length) return;
    const q = (arr, t) => arr[Math.max(0, Math.min(arr.length - 1, Math.floor(arr.length * t)))];
    let minX = xs[0], maxX = xs[xs.length - 1];
    let minY = ys[0], maxY = ys[ys.length - 1];
    if (xs.length >= 30) {
      const rx0 = q(xs, 0.05), rx1 = q(xs, 0.95);
      const ry0 = q(ys, 0.05), ry1 = q(ys, 0.95);
      if (rx1 - rx0 > (maxX - minX) * 0.2) { minX = rx0; maxX = rx1; }
      if (ry1 - ry0 > (maxY - minY) * 0.2) { minY = ry0; maxY = ry1; }
    }
    const padX = W * 0.11, padY = H * 0.13;
    const k = Math.max(0.36, Math.min(1.6,
      Math.min((W - padX * 2) / Math.max(1, maxX - minX),
        (H - padY * 2) / Math.max(1, maxY - minY))));
    this.view.k = k;
    this.view.x = W / 2 - q(xs, 0.5) * k;
    this.view.y = H / 2 - q(ys, 0.5) * k;
    this.draw();
  },

  screen(id) {
    const p = this.pos.get(id);
    if (!p) return null;
    return { x: p.x * this.view.k + this.view.x, y: p.y * this.view.k + this.view.y };
  },

  draw() {
    const ui = this.ui, d = this.data;
    if (!ui || !d) return;
    const ctx = ui.ctx;
    const W = ui.stage.clientWidth, H = ui.stage.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (ui.cv.width !== Math.round(W * dpr) || ui.cv.height !== Math.round(H * dpr)) {
      ui.cv.width = Math.round(W * dpr); ui.cv.height = Math.round(H * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const COMM = ['#5eead4', '#7c9cff', '#c084fc', '#f472b6', '#fbbf24', '#38bdf8', '#a3e635', '#f97316'];
    const sel = this.sel;
    const selNode = sel != null
      ? (d.byId?.get(sel) || d.nodes.find((n) => n.id === sel)) : null;
    const selLocked = !!selNode?.locked;
    const hover = this.hover;
    const nearSel = (e) => sel != null && (e.source === sel || e.target === sel);
    const selAdj = new Map();
    if (sel != null) {
      for (const e of d.edges) {
        if (e.source === sel) selAdj.set(e.target, Number(e.score) || 0);
        else if (e.target === sel) selAdj.set(e.source, Number(e.score) || 0);
      }
    }
    const curve = (a, b, e) => {
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.hypot(dx, dy) || 1;
      const side = (e.source % 2 === 0) ? 1 : -1;
      const bend = Math.min(34, dist * (e.kind === 'candidate' ? 0.09 : 0.025)) * side;
      return { mx: (a.x + b.x) / 2 - (dy / dist) * bend, my: (a.y + b.y) / 2 + (dx / dist) * bend };
    };
    const keyOf = (e) => `${e.source}|${e.target}|${e.kind}`;
    // 普通边：只画稀疏后的旧边；候选边全部用虚线。
    for (const e of d.edges) {
      const hot = nearSel(e);
      if (e.kind === 'candidate' && hot && selLocked) continue;
      if (e.kind === 'old' && !hot && !this.sparse.has(keyOf(e))) continue;
      if (e.kind === 'candidate' && !hot && !this.showCandidates) continue;
      if (e.kind === 'candidate' && !hot && !this.candSparse?.has(keyOf(e))) continue;
      const a = this.screen(e.source), b = this.screen(e.target);
      if (!a || !b) continue;
      const c = curve(a, b, e);
      const s = Math.max(0, Math.min(1, Number(e.score || 0)));
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      const fade = Math.max(0.18, 1 - dist / (Math.max(W, H) * 1.1));
      ctx.save();
      if (sel != null && !hot) ctx.globalAlpha = 0.035;
      else if (hot) ctx.globalAlpha = 0.92;
      else if (e.kind === 'candidate') ctx.globalAlpha = sel == null ? 0.30 : 0.08;
      else ctx.globalAlpha = 0.16;
      if (e.kind === 'candidate') {
        ctx.setLineDash([4, 7]);
        ctx.lineWidth = hot ? 1.1 + s * 2.2 : 0.85 + s * 1.0;
        // 未选中：紫色系，和已有边的灰蓝、选中后的青绿明显区分
        ctx.strokeStyle = e.manual ? 'rgba(244,114,182,.62)'
          : (s >= 0.5 ? 'rgba(192,132,252,.52)' : 'rgba(251,191,36,.46)');
      } else {
        ctx.setLineDash([]);
        ctx.lineWidth = 0.7 + s * 1.2;
        ctx.strokeStyle = `rgba(128,154,192,${(0.08 + s * 0.22) * fade})`;
      }
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(c.mx, c.my, b.x, b.y);
      ctx.stroke();
      ctx.restore();
    }
    // 选中节点的边最后画：青绿→蓝紫渐变，带一层柔光。
    if (sel != null) {
      ctx.save();
      for (const e of d.edges) {
        if (!nearSel(e)) continue;
        const a = this.screen(e.source), b = this.screen(e.target);
        if (!a || !b) continue;
        const c = curve(a, b, e);
        const start = e.source === sel ? a : b;
        const end = e.source === sel ? b : a;
        const s = Math.max(0, Math.min(1, Number(e.score || 0)));
        const kk = Math.max(0, Math.min(1, (s - 0.3) / 0.7));
        const grad = ctx.createLinearGradient(start.x, start.y, end.x, end.y);
        grad.addColorStop(0, `rgba(94,234,212,${0.5 + kk * 0.42})`);
        grad.addColorStop(0.55, `rgba(124,156,255,${0.36 + kk * 0.42})`);
        grad.addColorStop(1, e.manual ? 'rgba(192,132,252,.8)' : `rgba(94,234,212,${0.28 + kk * 0.4})`);
        ctx.globalAlpha = 1;
        ctx.setLineDash(e.kind === 'candidate' && !selLocked ? [6, 6] : []);
        ctx.strokeStyle = grad;
        ctx.lineWidth = 1.5 + kk * 3.4;
        ctx.shadowColor = 'rgba(94,234,212,.45)';
        ctx.shadowBlur = 12;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(c.mx, c.my, b.x, b.y); ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = `rgba(234,255,251,${0.15 + kk * 0.3})`;
        ctx.lineWidth = 0.7;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(c.mx, c.my, b.x, b.y); ctx.stroke();
      }
      ctx.restore();
    }
    // 节点：已有节点按社区色，本批节点青色高亮。
    for (const n of d.nodes) {
      const p = this.screen(n.id);
      if (!p) continue;
      const selected = sel === n.id;
      const batch = n.batch;
      const neighbor = selAdj.has(n.id);
      const dim = sel != null && !selected && !neighbor && !batch;
      const r = (batch ? 8.5 : 4 + Math.min(5, Number(n.degree || 0) * 0.5)) * (selected ? 1.25 : 1);
      const fill = batch ? '#5eead4'
        : (selected ? '#f4fffd' : neighbor ? '#c4b5fd' : COMM[(n.community || 0) % COMM.length]);
      const batchColor = n.locked ? '#5eead4' : '#fbbf24';
      ctx.save();
      if (selected) {
        const halo = ctx.createRadialGradient(p.x, p.y, r * 0.4, p.x, p.y, r * 5);
        halo.addColorStop(0, 'rgba(94,234,212,.3)');
        halo.addColorStop(0.45, 'rgba(124,156,255,.14)');
        halo.addColorStop(1, 'rgba(94,234,212,0)');
        ctx.fillStyle = halo;
        ctx.beginPath(); ctx.arc(p.x, p.y, r * 5, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = dim ? 0.14 : (batch ? 1 : selected || neighbor ? 0.95 : 0.32);
      ctx.fillStyle = batch ? (selected ? '#f4fffd' : batchColor) : fill;
      if (batch) {
        ctx.shadowColor = n.locked ? 'rgba(94,234,212,.85)' : 'rgba(251,191,36,.8)';
        ctx.shadowBlur = selected ? 20 : 14;
      }
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
      if (batch && !selected) {
        ctx.strokeStyle = n.locked ? 'rgba(94,234,212,.9)' : 'rgba(251,191,36,.95)';
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(p.x, p.y, r + 2.5, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.restore();
      if (batch && n.locked) {
        const now = performance.now();
        ctx.save();
        ctx.shadowColor = 'rgba(94,234,212,.35)';
        ctx.shadowBlur = 5;
        // 常驻波纹：每秒扩散一圈（1 次/秒），比原来的三环错相更克制。
        {
          const q = (now % 1000) / 1000;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r + 4 + q * 30, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(94,234,212,${(1 - q) * 0.42})`;
          ctx.lineWidth = Math.max(0.7, 1.6 - q * 0.8);
          ctx.stroke();
        }
        ctx.shadowBlur = 0;
        ctx.strokeStyle = 'rgba(94,234,212,.58)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(p.x, p.y, r + 3.5, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      }
      if (batch && n.locked && !selected) {
        ctx.save();
        ctx.strokeStyle = 'rgba(94,234,212,.42)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(p.x, p.y, r + 4.5, 0, Math.PI * 2); ctx.stroke();
        if (this.lockPulse && this.lockPulse.id === n.id) {
          const age = performance.now() - this.lockPulse.t0;
          if (age >= 0 && age < 750) {
            const q = age / 750;
            ctx.beginPath(); ctx.arc(p.x, p.y, r + 5 + q * 30, 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(94,234,212,${(1 - q) * 0.55})`;
            ctx.lineWidth = 2 - q;
            ctx.stroke();
          }
        }
        ctx.restore();
      }
      if (selected) {
        ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(1.4, r * 0.35), 0, Math.PI * 2);
        ctx.fillStyle = '#5eead4'; ctx.fill();

        // 与逻辑图一致的选中环：外虚线圈 + 内实线圈 + 四向刻度
        ctx.save();
        ctx.setLineDash([3, 6]);
        ctx.beginPath(); ctx.arc(p.x, p.y, r + 9, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(94,234,212,.58)';
        ctx.lineWidth = 1.2; ctx.stroke();
        ctx.restore();

        ctx.beginPath(); ctx.arc(p.x, p.y, r + 4.2, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(124,156,255,.88)';
        ctx.lineWidth = 1.6; ctx.stroke();

        ctx.strokeStyle = 'rgba(94,234,212,.62)';
        ctx.lineWidth = 1.1;
        for (let i = 0; i < 4; i++) {
          const a = (Math.PI / 2) * i;
          const x1 = p.x + Math.cos(a) * (r + 13);
          const y1 = p.y + Math.sin(a) * (r + 13);
          const x2 = p.x + Math.cos(a) * (r + 17);
          const y2 = p.y + Math.sin(a) * (r + 17);
          ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        }
        if (this.pulse && this.pulse.id === n.id) {
          const age = performance.now() - this.pulse.t0;
          if (age >= 0 && age < 900) {
            const q = age / 900;
            ctx.beginPath();
            ctx.arc(p.x, p.y, r + 5 + q * 40, 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(94,234,212,${(1 - q) * 0.5})`;
            ctx.lineWidth = 2 - q * 1.2;
            ctx.stroke();
          }
        }
      }
      const showLabel = selected || hover === n.id || (this.showLabels && batch);
      if (showLabel) {
        ctx.save();
        ctx.fillStyle = selected ? '#f8fafc' : 'rgba(226,240,255,.9)';
        ctx.font = `${batch ? 11 : 10}px ui-sans-serif, system-ui, sans-serif`;
        ctx.textAlign = 'left';
        const label = batch ? `#${n.idx + 1} ${n.desc}` : `#${n.id} ${n.desc}`;
        ctx.fillText(label.slice(0, 34), p.x + r + 6, p.y + 4);
        ctx.restore();
      }
    }
  },

  pick(mx, my) {
    let best = null, bestD = 14;
    let bestBatch = null, bestBatchD = 18;
    for (const n of this.data?.nodes || []) {
      const p = this.screen(n.id);
      if (!p) continue;
      const dd = Math.hypot(p.x - mx, p.y - my);
      if (n.batch && dd < bestBatchD) { bestBatchD = dd; bestBatch = n.id; }
      if (!n.batch && dd < bestD) { bestD = dd; best = n.id; }
    }
    return bestBatch ?? best;
  },

  bind() {
    const cv = this.ui.cv;
    let down = null, moved = false;
    const local = (ev) => {
      const r = cv.getBoundingClientRect();
      return { mx: ev.clientX - r.left, my: ev.clientY - r.top };
    };
    cv.addEventListener('pointerdown', (ev) => {
      if (ev.button != null && ev.button !== 0) return;
      const { mx, my } = local(ev);
      const id = this.pick(mx, my);
      moved = false;
      if (id != null) {
        const p = this.pos.get(id);
        const wx = (mx - this.view.x) / this.view.k;
        const wy = (my - this.view.y) / this.view.k;
        down = { type: 'node', id, sx: mx, sy: my,
          ox: p.x - wx, oy: p.y - wy, prevSel: this.sel };
        this.sel = id;
        this.draw();
      } else {
        down = { type: 'pan', sx: mx, sy: my, vx: this.view.x, vy: this.view.y };
      }
      cv.style.cursor = 'grabbing';
      try { cv.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
    });
    cv.addEventListener('pointermove', (ev) => {
      const { mx, my } = local(ev);
      if (down) {
        if (Math.hypot(mx - down.sx, my - down.sy) > 3) moved = true;
        if (moved) {
          if (down.type === 'node') {
            const p = this.pos.get(down.id);
            if (p) {
              p.x = (mx - this.view.x) / this.view.k + down.ox;
              p.y = (my - this.view.y) / this.view.k + down.oy;
            }
          } else {
            this.view.x = down.vx + (mx - down.sx);
            this.view.y = down.vy + (my - down.sy);
          }
          this.draw();
        }
        return;
      }
      const hit = this.pick(mx, my);
      if (hit !== this.hover) {
        this.hover = hit;
        this.draw();
        const n = this.data?.byId.get(hit);
        $('#stagingTip').textContent = n ? `${n.batch ? '本批·' : ''}${n.desc || ''}` : '';
      }
    });
    cv.addEventListener('pointerup', (ev) => {
      if (down) {
        if (!moved) {
          this.select(down.type === 'node' ? down.id : null);
        } else if (down.type === 'node') {
          this.sel = down.id;
          this.draw();
          if (down.prevSel !== down.id) this.renderDrawer();
        }
      }
      down = null; moved = false;
      cv.style.cursor = 'grab';
      try { cv.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
    });
    cv.addEventListener('pointercancel', (ev) => {
      down = null; moved = false;
      cv.style.cursor = 'grab';
      try { cv.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
    });
    cv.addEventListener('pointerleave', () => {
      if (down) return;
      this.hover = null;
      this.draw();
    });
    const wheel = (ev) => {
      // 不按 Ctrl / Cmd 时放行：让页面正常滚动，避免整页被画布吃掉滚轮
      if (!ev.ctrlKey && !ev.metaKey) return;
      ev.preventDefault();
      const r = cv.getBoundingClientRect();
      const mx = ev.clientX - r.left, my = ev.clientY - r.top;
      const old = this.view.k;
      const k = Math.max(0.25, Math.min(3, old * (ev.deltaY < 0 ? 1.12 : 0.89)));
      this.view.x = mx - (mx - this.view.x) * (k / old);
      this.view.y = my - (my - this.view.y) * (k / old);
      this.view.k = k;
      this.draw();
    };
    this.ui.onWheel = wheel;
    cv.addEventListener('wheel', wheel, { passive: false });
  },

  select(id) {
    this.sel = id;
    if (id != null) {
      this.pulse = { id, t0: performance.now() };
      this.runPulse();
    } else {
      this.pulse = null;
    }
    this.draw();
    this.renderDrawer();
  },

  runPulse() {
    const ui = this.ui;
    if (!ui) return;
    if (ui.pulseRaf) {
      try { cancelAnimationFrame(ui.pulseRaf); } catch { /* ignore */ }
      ui.pulseRaf = 0;
    }
    const step = () => {
      ui.pulseRaf = 0;
      if (this.ui !== ui || !this.pulse) return;
      const age = performance.now() - this.pulse.t0;
      this.draw();
      if (age < 900) ui.pulseRaf = requestAnimationFrame(step);
      else { this.pulse = null; this.draw(); }
    };
    ui.pulseRaf = requestAnimationFrame(step);
  },

  runLockPulse() {
    const ui = this.ui;
    if (!ui) return;
    if (ui.lockRaf) {
      try { cancelAnimationFrame(ui.lockRaf); } catch { /* ignore */ }
      ui.lockRaf = 0;
    }
    const step = () => {
      ui.lockRaf = 0;
      if (this.ui !== ui || !this.lockPulse) return;
      const age = performance.now() - this.lockPulse.t0;
      this.draw();
      if (age < 750) ui.lockRaf = requestAnimationFrame(step);
      else { this.lockPulse = null; this.draw(); }
    };
    ui.lockRaf = requestAnimationFrame(step);
  },

  runRipple() {
    const ui = this.ui;
    if (!ui || ui.rippleRaf) return;
    const step = () => {
      ui.rippleRaf = 0;
      if (this.ui !== ui) return;
      const hasLocked = !!this.data?.nodes?.some((n) => n.batch && n.locked);
      if (!hasLocked) { this.draw(); return; }
      this.draw();
      ui.rippleRaf = requestAnimationFrame(step);
    };
    ui.rippleRaf = requestAnimationFrame(step);
  },

  renderDrawer() {
    const box = $('#stagingGraphDrawer');
    if (!box) return;
    const n = this.data?.byId.get(this.sel);
    if (!n) { box.style.display = 'none'; box.innerHTML = ''; return; }
    box.style.display = 'flex';
    if (!n.batch) {
      const inc = (this.data.edges || []).filter((e) => e.source === n.id || e.target === n.id);
      box.innerHTML = `<div class="sg-drawer-head"><span class="node-id">#${esc(n.id)}</span><h3>已有节点</h3><div class="spacer"></div><button class="icon-btn" data-sg-close aria-label="关闭">${icon('x', 16)}</button></div>
        <div class="sg-drawer-body"><p class="sg-desc">${esc(n.desc || '')}</p>
        <div class="sg-hint">已有节点只读。建边、改分、删边只能在本批未入图节点上进行。</div>
        <div class="sg-edge-list">${inc.map((e) => `<div class="sg-edge"><span>${e.kind === 'candidate' ? '本批' : '已有'} ${e.source === n.id ? '→ #' + e.target : '← #' + e.source}</span><b>${Number(e.score || 0).toFixed(2)}</b></div>`).join('') || '<div class="muted small">没有边</div>'}</div></div>`;
      box.querySelector('[data-sg-close]')?.addEventListener('click', () => this.select(null));
      return;
    }
    const e = n.event || {};
    const cands = Array.isArray(e.candidates) ? e.candidates : [];
    const targets = (state.staging.detail?.targets || []).filter((t) => !(t.type === 'batch' && t.index === n.idx));
    box.innerHTML = `<div class="sg-drawer-head"><span class="node-id">#${esc(n.idx + 1)}</span><h3>本批事件</h3><div class="spacer"></div><button class="icon-btn" data-sg-close aria-label="关闭">${icon('x', 16)}</button></div>
      <div class="sg-drawer-body">
        <label class="sg-field">事件描述<textarea class="textarea" data-sg-field="desc" style="min-height:62px">${esc(e.desc || '')}</textarea></label>
        <div class="sg-grid3">
          <label class="sg-field">时间<input class="input mono" data-sg-field="ts" value="${esc(e.ts || '')}"></label>
          <label class="sg-field">主体<input class="input" data-sg-field="subject" value="${esc(e.subject || '')}"></label>
          <label class="sg-field">客体<input class="input" data-sg-field="object" value="${esc(e.object || '')}"></label>
        </div>
        <label class="sg-field">原始对话<textarea class="textarea mono" data-sg-field="source_text" style="min-height:120px">${esc(e.source_text || '')}</textarea></label>
        <div class="sg-edge-title">候选边（虚线）</div>
        <div class="sg-edge-list">
          ${cands.map((c, ci) => `<div class="sg-edge-row" data-ci="${ci}" data-tt="${c.target_type}" data-ti="${c.target_type === 'batch' ? c.target_index : c.target_id}" data-manual="${c.manual ? '1' : '0'}">
            <button type="button" class="sg-target-link" data-sg-open-target data-tt="${c.target_type}" data-ti="${c.target_type === 'batch' ? c.target_index : c.target_id}">${c.target_type === 'node' ? '#' + esc(c.target_id) : '本批 #' + (Number(c.target_index) + 1)}</button>
            <span class="desc">${esc(c.target_desc || '')}</span>
            <input class="input mono" data-sg-score value="${Number(c.score || 0).toFixed(2)}">
            <button class="icon-btn" data-sg-del-edge title="删除">${icon('x', 13)}</button>
          </div>`).join('') || '<div class="muted small">还没有候选边</div>'}
        </div>
        <div class="sg-edge-add">
          <input class="input mono" data-sg-target placeholder="EU 编号，本批用 b3">
          <input class="input mono" data-sg-new-score value="0.80">
          <button class="btn small" data-sg-add-edge>${icon('plus', 13)} 连边</button>
        </div>
        <div class="sg-drawer-actions">
          <button class="btn ${e.locked ? 'primary' : 'ghost'} small" data-sg-lock>${e.locked ? '已锁定' : '锁定'}</button>
          <span class="sg-hint" style="margin:0">锁定后落盘才会入图</span>
        </div>
      </div>`;
    box.querySelector('[data-sg-close]')?.addEventListener('click', () => this.select(null));
    box.querySelector('[data-sg-lock]')?.addEventListener('click', () => {
      e.locked = !e.locked;
      this.saveEvent(n, true, { keepLayout: true, lockOnly: true });
    });
    box.querySelector('[data-sg-add-edge]')?.addEventListener('click', () => {
      const sel = box.querySelector('[data-sg-target]');
      const raw = String(sel?.value || '').trim();
      if (!raw) return toast('请输入目标 EU 编号', 'warn');
      let tt = 'node', ti = NaN;
      const bm = /^b(\d+)$/i.exec(raw);
      if (bm) { tt = 'batch'; ti = Number(bm[1]) - 1; }
      else if (/^\d+$/.test(raw)) { tt = 'node'; ti = Number(raw); }
      else return toast('编号格式：231，或本批节点 b3', 'warn');
      const target = targets.find((t) => t.type === tt && Number(tt === 'node' ? t.id : t.index) === ti);
      if (!target) return toast(`没有找到 ${tt === 'node' ? 'EU #' + ti : '本批 #' + (ti + 1)}`, 'warn');
      const score = Math.max(0, Math.min(1, Number(box.querySelector('[data-sg-new-score]')?.value || 0.8)));
      const desc = target.desc || '';
      e.candidates = Array.isArray(e.candidates) ? e.candidates : [];
      e.candidates.push({ target_type: tt, target_id: tt === 'node' ? ti : null,
        target_index: tt === 'batch' ? ti : null, target_desc: desc, score, manual: true });
      const list = box.querySelector('.sg-edge-list');
      if (list) {
        const row = document.createElement('div');
        row.className = 'sg-edge-row';
        row.dataset.ci = String(e.candidates.length - 1);
        row.dataset.tt = tt;
        row.dataset.ti = String(ti);
        row.dataset.manual = '1';
        row.innerHTML = `<button type="button" class="sg-target-link" data-sg-open-target data-tt="${tt}" data-ti="${ti}">${tt === 'node' ? '#' + esc(ti) : '本批 #' + (ti + 1)}</button>
          <span class="desc">${esc(desc)}</span>
          <input class="input mono" data-sg-score value="${score.toFixed(2)}">
          <button class="icon-btn" data-sg-del-edge title="删除">${icon('x', 13)}</button>`;
        row.querySelector('[data-sg-del-edge]')?.addEventListener('click', () => {
          row.remove();
          this.saveEvent(n, true, { edgeOnly: true });
        });
        row.querySelector('[data-sg-open-target]')?.addEventListener('click', (evt) => {
          evt.stopPropagation();
          this.showEventDetail(tt, ti);
        });
        list.appendChild(row);
      }
      this.saveEvent(n, true, { edgeOnly: true });
    });
    box.querySelectorAll('[data-sg-score]').forEach((inp) => {
      inp.addEventListener('change', () => {
        const row = inp.closest('[data-ci]');
        if (row) row.dataset.manual = '1';
      });
    });
    box.querySelectorAll('[data-sg-del-edge]').forEach((b) => {
      b.addEventListener('click', () => {
        const row = b.closest('[data-ci]');
        row?.remove();
        this.saveEvent(n, true, { edgeOnly: true });
      });
    });
    box.querySelectorAll('[data-sg-open-target]').forEach((b) => {
      b.addEventListener('click', () => this.showEventDetail(b.dataset.tt, Number(b.dataset.ti)));
    });
  },

  async showEventDetail(tt, ti) {
    let d = null;
    let title = '';
    if (tt === 'batch') {
      const ev = (state.staging.detail?.events || []).find((e) => Number(e.i) === Number(ti));
      if (!ev) return;
      d = { id: `本批 #${Number(ti) + 1}`, desc: ev.desc, time: ev.ts,
        subject: ev.subject, object: ev.object, source_text: ev.source_text,
        locked: !!ev.locked, candidates: ev.candidates || [] };
      title = `本批事件 #${Number(ti) + 1}`;
    } else {
      const id = Number(ti);
      try { d = await apiGet(`/node?id=${encodeURIComponent(id)}`); } catch { /* ignore */ }
      if (!d) {
        const n = this.data?.byId.get(id);
        d = { id, desc: n?.desc || '', time: '', subject: '', object: '', source_text: '' };
      }
      title = `事件详情 #${id}`;
    }
    const locked = d.locked ? ' · 已锁定' : (tt === 'batch' ? ' · 未锁定' : '');
    openModal({
      title,
      width: 680,
      body: `<div class="event-detail">
        <div class="event-detail-head"><span class="node-id">#${esc(d.id)}</span><span class="badge ${tt === 'batch' ? (d.locked ? 'high' : 'violet') : ''}">${tt === 'batch' ? (d.locked ? '本批·已锁定' : '本批·未锁定') : '已有节点'}</span><span class="hint">${esc(d.time || '')}${esc(locked)}</span></div>
        <div class="event-detail-desc">${esc(d.desc || d.event_desc || '（无描述）')}</div>
        <div class="event-detail-grid">
          <div><span>主体</span><b>${esc(d.subject || '—')}</b></div>
          <div><span>客体</span><b>${esc(d.object || '—')}</b></div>
          <div><span>时间</span><b class="mono">${esc(d.time || '—')}</b></div>
          <div><span>候选边</span><b>${tt === 'batch' ? `${d.candidates?.length || 0} 条` : `${d.neighbors?.length || 0} 条关联`}</b></div>
        </div>
        <div class="event-detail-title">原始对话</div>
        <pre class="event-detail-source">${esc(d.source_text || '（没有上下文）')}</pre>
      </div>`,
      actions: [{ label: '关闭', kind: 'ghost' }],
    });
  },

  syncBatchEdges(n) {
    if (!this.data || !n) return;
    const tempId = this.data.temp(n.idx);
    const base = this.data.edges.filter((e) => !(e.kind === 'candidate' && e.source === tempId));
    for (const c of (n.event?.candidates || [])) {
      const target = c.target_type === 'batch'
        ? this.data.temp(Number(c.target_index)) : Number(c.target_id);
      if (!this.data.byId.has(target) || target === tempId) continue;
      base.push({
        source: tempId, target,
        score: Number(c.score || 0), kind: 'candidate',
        manual: !!c.manual, eventIdx: n.idx,
      });
    }
    this.data.edges = base;
    const candBy = new Map();
    for (const e of base) {
      if (e.kind !== 'candidate') continue;
      if (!candBy.has(e.source)) candBy.set(e.source, []);
      candBy.get(e.source).push(e);
    }
    const sparse = new Set();
    for (const list of candBy.values()) {
      list.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
      for (const e of list.slice(0, 3)) sparse.add(`${e.source}|${e.target}|${e.kind}`);
    }
    this.candSparse = sparse;
    this.draw();
    this.updateMeta();
  },

  refreshData() {
    const sel = this.sel;
    const old = this.pos;
    const oldHover = this.hover;
    const view = { ...this.view };
    this.build();
    for (const [id, p] of old) {
      if (this.pos.has(id)) this.pos.set(id, p);
    }
    this.sel = sel;
    this.hover = oldHover;
    this.view = view;
    this.updateMeta();
    this.draw();
    this.renderDrawer();
  },

  updateMeta() {
    const el = document.querySelector('.staging-graph-page .graph-meta');
    if (!el) return;
    const evs = state.staging.detail?.events || [];
    const locked = evs.filter((e) => e.locked).length;
    el.textContent = `${evs.length} 个本批 EU · 已锁定 ${locked} · ${(state.staging.detail?.graph_edges || []).length} 条已有边 · 虚线=未入图`;
  },

  async saveEvent(n, quiet = false, opts = {}) {
    const box = $('#stagingGraphDrawer');
    const e = n.event;
    if (box) {
      box.querySelectorAll('[data-sg-field]').forEach((el) => {
        e[el.dataset.sgField] = el.value;
      });
      e.candidates = [...box.querySelectorAll('[data-ci]')].map((row) => {
        const tt = row.dataset.tt === 'batch' ? 'batch' : 'node';
        const ti = Number(row.dataset.ti);
        return {
          target_type: tt,
          target_id: tt === 'node' ? ti : null,
          target_index: tt === 'batch' ? ti : null,
          target_desc: row.querySelector('.desc')?.textContent || '',
          score: Math.max(0, Math.min(1, Number(row.querySelector('[data-sg-score]')?.value || 0))),
          manual: row.dataset.manual === '1',
        };
      });
    }
    if (!String(e.desc || '').trim()) { toast('事件描述不能为空', 'warn'); return; }
    try {
      await apiPost('/staging/update', { id: state.staging.sel, idx: n.idx, fields: {
        desc: e.desc, source_text: e.source_text, ts: e.ts, subject: e.subject,
        object: e.object, candidates: e.candidates, locked: !!e.locked,
      } });
      if (!quiet) toast(`已保存第 ${n.idx + 1} 条`, 'good', 1600);
      if (opts.lockOnly) {
        n.locked = !!e.locked;
        this.syncBatchEdges(n);
        if (n.locked) {
          this.lockPulse = { id: n.id, t0: performance.now() };
          this.runLockPulse();
        }
        this.runRipple();
        const lockBtn = box?.querySelector('[data-sg-lock]');
        if (lockBtn) {
          lockBtn.classList.toggle('primary', !!n.locked);
          lockBtn.classList.toggle('ghost', !n.locked);
          lockBtn.textContent = n.locked ? '已锁定' : '锁定';
        }
        this.updateMeta();
        this.draw();
      } else if (opts.edgeOnly) {
        this.syncBatchEdges(n);
      } else if (opts.keepLayout) this.refreshData();
      else await this.reload();
    } catch (err) {
      toast(`保存失败：${err?.message || err}`, 'bad');
    }
  },

  async reload() {
    await loadStagedBatch(state.staging.sel);
    if (state.page === 'staging') {
      state.staging.loaded = true;
      renderPage();
    }
  },
};

function pageStaging() {
  const st = state.staging;
  if (!st.loaded) return `<div class="settings-page">${loadingBlock(420)}</div>`;
  const list = st.list || [];
  const detail = st.detail;
  const events = detail?.events || [];
  const lockedCount = events.filter((e) => e.locked).length;
  const pending = detail?.status === 'pending';
  const cards = list.map((b) => `<button class="staging-item ${st.sel === b.id ? 'is-active' : ''}" type="button" data-batch-id="${esc(b.id)}">
    <div class="staging-item-top">
      ${stagingStatusBadge(b.status)}
      <time>${esc(fmtTime(b.created_at))}</time>
    </div>
    <div class="staging-item-id">${esc(b.id)}</div>
    <div class="staging-item-meta">
      <span>${fmtNum(b.event_count)} 事件</span>
      <span>${fmtNum(b.sessions)} 会话</span>
      ${b.locked_count ? `<span>${fmtNum(b.locked_count)} 锁定</span>` : ''}
      ${b.status === 'committed' && b.result ? `<span>+${fmtNum(b.result.new_eus)} / +${fmtNum(b.result.new_edges)}</span>` : ''}
    </div>
  </button>`).join('');
  return `<div class="staging-graph-layout">
    <aside class="card staging-list-card">
      <div class="card-head" style="padding:15px 16px;margin:0;border-bottom:1px solid var(--line)">
        <h3>落盘批次</h3>
        <span class="hint">${list.length} 批</span>
        <div class="spacer"></div>
        <button class="btn small ghost" type="button" data-act="refresh-staging">${icon('refresh', 14)} 刷新</button>
      </div>
      <div class="staging-items">
        ${cards || `<div class="empty" style="padding:34px 16px"><div class="empty-icon">${icon('save', 22)}</div><strong>还没有落盘批次</strong><p>先去「整备」页跑一次。</p><button class="btn small ghost" type="button" data-go="consolidate">去整备</button></div>`}
      </div>
    </aside>
    <div class="graph-page staging-graph-page">
    <div class="graph-toolbar">
      <div class="sg-batch-title">${esc(detail?.id || '—')} <span class="badge ${pending ? 'violet' : 'high'}">${stagingStatusText(detail?.status)}</span></div>
      ${pending ? `<button class="btn small primary" data-act="commit-staging">${icon('save', 14)} 确认入图</button>
        <button class="btn small ghost" data-act="discard-staging">丢弃</button>` : ''}
      <div class="spacer"></div>
      <button class="btn small ghost" data-sg-fit>${icon('target', 14)} 重置视图</button>
      <label class="switch" title="显示全部候选边">
        <input type="checkbox" id="stagingCandidates" checked>
        <span class="track"></span>候选边
      </label>
      <label class="switch" title="显示节点标签">
        <input type="checkbox" id="stagingLabels">
        <span class="track"></span>标签
      </label>
      <span class="graph-meta">${fmtNum(events.length)} 个本批 EU · 已锁定 ${lockedCount} · ${fmtNum(detail?.graph_edges?.length || 0)} 条已有边 · 虚线=未入图</span>
    </div>
    <div class="graph-stage" id="stagingGraphStage">
      <canvas id="stagingGraphCanvas" tabindex="0" aria-label="落盘候选图"></canvas>
      <div class="graph-zoom" aria-label="缩放">
        <button type="button" class="zoom-btn" data-sg-zoom="in" title="放大">${icon('plus', 15)}</button>
        <button type="button" class="zoom-btn" data-sg-zoom="out" title="缩小">−</button>
        <button type="button" class="zoom-btn" data-sg-zoom="fit" title="适应画布">${icon('target', 15)}</button>
      </div>
      <div class="graph-legend" aria-hidden="true">
        <div class="legend-row"><span class="legend-dot" style="background:#5eead4"></span>本批已锁定</div>
        <div class="legend-row"><span class="legend-dot" style="background:#fbbf24"></span>本批未锁定</div>
        <div class="legend-row"><span class="legend-dot" style="background:#94a3b8"></span>已有节点</div>
        <div class="legend-row"><span class="legend-line" style="border-top:1px dashed #c084fc"></span>紫色虚线：候选边 · 选中后转青</div>
      </div>
      <div class="graph-hint">滚轮缩放 · 拖动平移 · 点击本批节点编辑并展开虚线候选边 · 右侧可改分/连边</div>
      <div class="graph-tip" id="stagingTip"></div>
      <div class="graph-drawer" id="stagingGraphDrawer" style="display:none"></div>
    </div>
    </div>
  </div>`;
}

function mountStaging() {
  const st = state.staging;
  if (!st.loaded) return;
  StagingGraph.attach();
  $$('[data-batch-id]').forEach((b) => {
    b.addEventListener('click', async () => {
      if (b.dataset.batchId === st.sel) return;
      await loadStagedBatch(b.dataset.batchId);
      if (state.page === 'staging') renderPage();
    });
  });
  $('#stagingBatchSel')?.addEventListener('change', async (ev) => {
    await loadStagedBatch(ev.currentTarget.value);
    if (state.page === 'staging') renderPage();
  });
  $('[data-act="refresh-staging"]')?.addEventListener('click', async () => {
    await loadStaging(true); if (state.page === 'staging') renderPage();
  });
  $('[data-act="commit-staging"]')?.addEventListener('click', () => {
    const evs = state.staging.detail?.events || [];
    const unlocked = evs.filter((e) => !e.locked).length;
    const locked = evs.length - unlocked;
    openConfirm({
      title: unlocked ? `有 ${unlocked} 个节点未锁定` : '确认入图？',
      message: unlocked
        ? `只有已锁定的 ${locked} 个节点会入图；${unlocked} 个未锁定节点会被丢弃。`
        : `将把 ${locked} 个已锁定节点写入逻辑图。`,
      confirmLabel: unlocked ? '丢弃未锁定并入图' : '确认入图',
      danger: unlocked > 0,
      onConfirm: async () => {
        try {
          const r = await apiPost('/staging/commit', { id: st.sel });
          toast(r.discarded
            ? `未锁定节点已全部丢弃（${r.unlocked_dropped || 0} 个）`
            : (r.unlocked_dropped ? `已入图；丢弃 ${r.unlocked_dropped} 个未锁定节点` : '已入图'),
          r.discarded ? 'info' : 'good', 2400);
          await loadStaging(true); renderPage();
        } catch (e) { toast(`入图失败：${e?.message || e}`, 'bad'); }
      } });
  });
  $('[data-act="discard-staging"]')?.addEventListener('click', () => {
    openConfirm({ title: '丢弃这个批次？', message: '不会写进图。', confirmLabel: '丢弃', danger: true,
      onConfirm: async () => {
        try { await apiPost('/staging/discard', { id: st.sel }); await loadStaging(true); renderPage(); }
        catch (e) { toast(`丢弃失败：${e?.message || e}`, 'bad'); }
      } });
  });
  $('[data-sg-fit]')?.addEventListener('click', () => StagingGraph.fit());
  $('#stagingLabels')?.addEventListener('change', (ev) => {
    StagingGraph.showLabels = ev.target.checked;
    StagingGraph.draw();
  });
  $('#stagingCandidates')?.addEventListener('change', (ev) => {
    StagingGraph.showCandidates = ev.target.checked;
    StagingGraph.draw();
  });
  $$('[data-sg-zoom]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.sgZoom === 'fit') return StagingGraph.fit();
    const k = b.dataset.sgZoom === 'in' ? 1.2 : 1 / 1.2;
    StagingGraph.view.k = Math.max(0.25, Math.min(3, StagingGraph.view.k * k));
    StagingGraph.draw();
  }));
}


function pageData() {
  const d = state.data;
  if (!d) {
    return `<div class="settings-page"><section class="card settings-card">
      <div class="card-head"><h3>数据与存档</h3></div>
      ${state.dataError ? noticeHtml(`读取失败：${state.dataError}`, 'bad')
        : '<div class="muted small">正在读取…</div>'}
    </section></div>`;
  }
  const cur = d.current || {};
  const target = state.dataTarget || '';
  const backups = Array.isArray(d.backups) ? d.backups : [];
  const backupRows = backups.length ? backups.map((b) => `<div class="trash-item archive-item">
    <div class="archive-meta">
      <span class="archive-name">${esc(b.name.replace(/^graph_(archive_|backup_)/, ''))}</span>
      <span class="archive-sub">${fmtNum(b.eus)} EU / ${fmtNum(b.edges)} 边 · ${esc(fmtTime(b.time))}</span>
    </div>
  </div>`).join('') : '<div class="muted small" style="padding:8px 0">还没有存档。</div>';

  return `<div class="settings-page">
    <div class="settings-grid equal">
      <section class="card settings-card">
        <div class="card-head"><h3>工作目录</h3><span class="badge">${d.pending || 0} 条待整备</span></div>
        <p class="lead">整个插件数据目录：逻辑图、历史存档、pending、file 配置和 logs。代码与 models 不会移动。</p>
        <div class="kv-grid">
          ${kvItem('当前数据目录', `<span class="mono">${esc(d.dataRoot)}</span>`, true)}
          ${kvItem('代码目录', `<span class="mono">${esc(d.codeRoot)}</span>`, true)}
          ${kvItem('逻辑图', `${fmtNum(cur.eus)} EU / ${fmtNum(cur.edges)} 边`)}
          ${kvItem('存档数量', fmtNum(backups.length))}
        </div>
        <div class="field">
          <label for="dataRootInput">迁移到新目录（空目录，绝对路径）</label>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <input class="input" id="dataRootInput" style="flex:1;min-width:240px" placeholder="数据目录路径" value="${esc(target)}">
            <button class="btn small ghost" type="button" data-act="pick-data-dir">选择目录</button>
            <button class="btn small" type="button" data-act="migrate-data">迁移</button>
          </div>
          <div class="desc">迁移是复制；旧目录不会删除。复制完成后需要重启 DSH，新的 8317 才会使用新目录。</div>
        </div>
        ${state.dataMsg ? noticeHtml(state.dataMsg, 'good') : ''}
        ${state.dataError ? noticeHtml(`操作失败：${state.dataError}`, 'bad') : ''}
      </section>

      <div class="archive-column">
        <div class="archive-dock">
          <div class="archive-dock-head">
            <div>
              <span class="archive-dock-kicker">LOGIC GRAPH ARCHIVE</span>
              <div class="archive-dock-title">当前图 <b>${fmtNum(cur.eus)}</b> EU · <b>${fmtNum(cur.edges)}</b> 边</div>
            </div>
            <span class="archive-dock-count">${fmtNum(backups.length)} 个存档</span>
          </div>
          <div class="archive-dock-actions">
            <button class="archive-action primary" type="button" data-act="backup-graph">
              <span class="archive-action-icon">${icon('save', 20)}</span>
              <span class="archive-action-copy"><b>存档当前图</b><small>把当前逻辑图保存为一个存档</small></span>
            </button>
            <button class="archive-action" type="button" data-act="restore-graph">
              <span class="archive-action-icon">${icon('bookmark', 20)}</span>
              <span class="archive-action-copy"><b>从存档读档</b><small>选择已有存档并恢复</small></span>
            </button>
          </div>
        </div>

        <section class="card settings-card">
          <div class="card-head">
            <h3>逻辑图存档</h3>
            <span class="hint">列表只展示已有存档</span>
          </div>
          <p class="lead">存档和当前图在同一个数据根目录下，迁移时会一起带走。</p>
          <div class="trash-list">${backupRows}</div>
        </section>
      </div>
    </div>
  </div>`;
}

function mountData() {
  const input = $('#dataRootInput');
  if (input) {
    input.addEventListener('input', () => { state.dataTarget = input.value.trim(); });
  }
  $('[data-act="pick-data-dir"]')?.addEventListener('click', (ev) => {
    withBusy(ev.currentTarget, '选择中…', async () => {
      const r = await apiPost('/data/pick-dir', {});
      if (!r?.ok) { toast('已取消选择', 'info', 1600); return; }
      state.dataTarget = r.path || '';
      if (state.page === 'data') renderPage();
    }).catch((e) => toast(`打开目录选择器失败：${e?.message || e}`, 'bad'));
  });
  $('[data-act="migrate-data"]')?.addEventListener('click', (ev) => {
    const to = (state.dataTarget || '').trim();
    if (!to) return toast('先选择或填写新目录', 'warn');
    const btn = ev.currentTarget;
    openConfirm({
      title: '迁移数据目录？',
      message: `把整个插件数据目录复制到：<span class="mono">${esc(to)}</span><br><br>旧目录不会删除，完成后需要重启 DSH。`,
      confirmLabel: '迁移',
      onConfirm: () => withBusy(btn, '迁移中…', async () => {
        const r = await apiPost('/data/migrate', { path: to });
        state.dataError = null;
        state.dataMsg = `已复制到 ${r.to}（${(r.copied || []).length} 项）。重启 DSH 后生效；旧目录未删除。`
          + (r.serviceStopped ? ' 旧 8317 已停止。' : ' 请手动停止旧 8317。');
        toast('迁移完成，重启 DSH 后生效', 'good', 6000);
        if (state.page === 'data') renderPage();
      }).catch((e) => {
        state.dataError = e?.message || String(e);
        toast(`迁移失败：${state.dataError}`, 'bad', 6000);
        if (state.page === 'data') renderPage();
      }),
    });
  });
  $('[data-act="backup-graph"]')?.addEventListener('click', () => {
    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const defaultName = `存档_${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
    openModal({
      title: '创建存档',
      width: 460,
      body: `<div class="field">
        <label for="archiveNameInput">存档名称</label>
        <input class="input" id="archiveNameInput" maxlength="60"
          value="${esc(defaultName)}" placeholder="存档名称">
        <div class="desc">默认按当前时间生成，可直接修改。</div>
      </div>`,
      actions: [
        { label: '取消', kind: 'ghost' },
        {
          label: '存档', kind: 'primary',
          onClick: async (btn, close) => {
            const name = String($('#archiveNameInput')?.value || '').trim();
            btn.disabled = true;
            btn.textContent = '存档中…';
            const r = await apiPost('/data/backup', { name });
            close();
            toast(`已存档：${r.name.replace(/^graph_(archive_|backup_)/, '')}`, 'good', 4200);
            await loadData(true);
            if (state.page === 'data') renderPage();
          },
        },
      ],
      onMount: (el) => {
        const input = $('#archiveNameInput', el);
        if (input) { input.focus(); input.select(); }
      },
    });
  });
  $('[data-act="restore-graph"]')?.addEventListener('click', () => {
    const backups = Array.isArray(state.data?.backups) ? state.data.backups : [];
    if (!backups.length) {
      toast('还没有存档，先创建一个存档', 'warn', 2200);
      return;
    }
    let picked = '';
    const rows = backups.map((b) => `<button type="button" class="archive-option" data-pick="${esc(b.name)}">
      <span class="archive-option-name">${esc(b.name.replace(/^graph_(archive_|backup_)/, ''))}</span>
      <span class="archive-option-sub">${fmtNum(b.eus)} EU / ${fmtNum(b.edges)} 边 · ${esc(fmtTime(b.time))}</span>
    </button>`).join('');
    openModal({
      title: '读取存档',
      width: 560,
      body: `<div class="archive-picker">${rows}</div>`,
      actions: [
        { label: '取消', kind: 'ghost' },
        {
          label: '读档', kind: 'primary', close: false,
          onClick: async (btn, close) => {
            if (!picked) { toast('先在列表里选择一个存档', 'warn', 2200); return; }
            btn.disabled = true;
            btn.textContent = '读档中…';
            const r = await apiPost('/data/restore', { name: picked });
            close();
            toast(r.reloaded ? `已读档 ${r.restored} 并重载` : `已读档 ${r.restored}，重启记忆服务后生效`, 'good', 6000);
            await loadData(true);
            if (state.graph) await loadGraph(true);
            if (state.page === 'data') renderPage();
          },
        },
      ],
      onMount: (el) => {
        el.querySelectorAll('[data-pick]').forEach((row) => {
          row.addEventListener('click', () => {
            picked = row.getAttribute('data-pick') || '';
            el.querySelectorAll('[data-pick]').forEach((x) => {
              x.classList.toggle('selected', x === row);
            });
          });
        });
      },
    });
  });
}

function pagePlugin() {
  const u = state.update || {};
  const err = state.updateError || u.error;
  const has = !!u.hasUpdate;
  const badge = has ? '有新版本' : (u.ok ? '已是最新' : '检查失败');
  const when = u.checkedAt ? new Date(u.checkedAt).toLocaleString('zh-CN') : '—';
  return `<div class="settings-page">
    <section class="card settings-card">
      <div class="card-head">
        <h3>Xliens 插件详情</h3>
        <span class="badge ${has ? 'high' : u.ok ? '' : 'low'}">${badge}</span>
        <div class="spacer"></div>
        <button class="btn small primary" type="button" data-act="check-update-plugin" ${state.loading.update ? 'disabled' : ''}>${icon('refresh', 14)} ${state.loading.update ? '检查中…' : '检查更新'}</button>
      </div>
      <div class="kv-grid">
        <div class="kv-item"><div class="k">当前版本</div><div class="v">${esc(u.current || '—')}</div></div>
        <div class="kv-item"><div class="k">最新版本</div><div class="v">${esc(u.latest || '—')}</div></div>
        <div class="kv-item"><div class="k">检查时间</div><div class="v">${esc(when)}</div></div>
        <div class="kv-item"><div class="k">版本来源</div><div class="v">${u.source === 'manifest' ? '版本清单' : u.source === 'package' ? 'package.json' : '—'}</div></div>
      </div>
      ${err ? noticeHtml(`检查失败：${esc(err)}`, 'bad') : ''}
      ${has ? `<div class="notice info">
        <b>发现新版本 v${esc(u.latest || '')}</b>
        ${u.notes ? `<div class="muted" style="margin-top:6px;white-space:pre-wrap">${esc(u.notes)}</div>` : ''}
        <div class="row" style="margin-top:10px">
          <a class="btn small primary" href="${esc(u.downloadUrl || u.releaseUrl || u.repoUrl || '#')}" target="_blank" rel="noopener noreferrer">前往下载更新</a>
          <a class="btn small ghost" href="${esc(u.repoUrl || '#')}" target="_blank" rel="noopener noreferrer">打开仓库</a>
        </div>
      </div>` : ''}
      <p class="hint">只检查版本，不自动下载或覆盖安装。更新前请先备份数据。</p>
    </section>
  </div>`;
}

function mountPlugin() {
  $('[data-act="check-update-plugin"]')?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    await loadUpdate(true);
    btn.disabled = false;
    renderPage();
  });
}

function pageSystem() {
  const h = state.health || {};
  const meta = h.meta || {};
  const trash = state.trash || [];
  return `<div class="settings-page">
    <div class="settings-grid equal">
      <section class="card settings-card" id="systemHealthCard">
        <div class="card-head">
          <h3>记忆服务</h3>
          <span class="badge ${state.health ? 'high' : state.healthError ? 'low' : ''}">${state.health ? '在线' : state.healthError ? '离线' : '连接中'}</span>
          <div class="spacer"></div>
          <button class="btn small ghost" type="button" data-act="reload-health">${icon('refresh', 14)} 刷新</button>
        </div>
        ${state.healthError ? noticeHtml(`最近一次请求失败：${state.healthError}`, 'bad') : ''}
        <div class="kv-grid">
          ${kvItem('图目录', esc(h.graph || '—'), true)}
          ${kvItem('CE 设备', esc(h.device || '—'), true)}
          ${kvItem('节点', fmtNum(h.nodes))}
          ${kvItem('关联边', fmtNum(h.edges))}
          ${kvItem('打分模式', esc(modeLabel(h.ce_mode)))}
          ${kvItem('CE 远端', h.ce_remote_configured ? '已配置' : '未配置')}
          ${kvItem('召回调用', fmtNum(h.calls))}
          ${kvItem('响应延迟', state.healthLatency != null ? `${state.healthLatency} ms` : '—')}
          ${kvItem('模型', esc(meta.model || '—'))}
          ${kvItem('建图模式', esc(meta.mode || '—'))}
          ${kvItem('建边规则', esc(meta.edge_policy || '—'))}
          ${kvItem('更新时间', esc(meta.updated_at || '—'), true)}
        </div>
      </section>

      <section class="card settings-card">
        <div class="card-head">
          <h3>回收站</h3>
          <span class="hint">后进先出</span>
          <div class="spacer"></div>
          <button class="btn small ghost" type="button" data-act="reload-trash">${icon('refresh', 14)} 刷新</button>
        </div>
        <p class="lead">删除的节点会先放这里。撤销按时间倒序恢复最近一个，关联边也会一起回来。</p>
        ${state.errors.trash ? noticeHtml(`回收站读取失败：${state.errors.trash}`, 'bad') : ''}
        ${trash.length ? `<div class="trash-list">${trash.slice().reverse().slice(0, 12).map((it) => `<div class="trash-item">
          <span class="tid">#${esc(it.id)}</span>
          <span class="tdesc">${esc(it.desc || '（无描述）')}</span>
          <span class="tat">${esc(fmtTime(it.at))}</span>
        </div>`).join('')}</div>` : `<div class="muted small" style="padding:8px 0">回收站是空的。</div>`}
        <div class="settings-actions">
          <button class="btn small" type="button" id="restoreLast" ${trash.length ? '' : 'disabled'}>${icon('undo', 14)} 撤销最近一次删除</button>
        </div>
      </section>
    </div>

    <section class="card settings-card">
      <div class="card-head">
        <h3>阈值设置</h3>
        <span class="hint">边显形阈值只隐藏边，不删除边</span>
        <div class="spacer"></div>
        <button class="btn small primary" type="button" data-act="save-thresholds">${icon('check', 14)} 保存</button>
      </div>
      <div class="threshold-grid">
        <label class="threshold-field">
          <span>建边阈值</span>
          <span class="threshold-input-wrap">
            <input class="input" id="buildThresholdInput" type="number" min="0" max="1" step="0.01"
              value="${esc(state.thresholds?.build ?? 0.10)}">
            <small>新 EU 从 best 逐跳扫描时，低于它不建边、不继续该路径</small>
          </span>
        </label>
        <label class="threshold-field">
          <span>边显形阈值</span>
          <span class="threshold-input-wrap">
            <input class="input" id="edgeVisibleInput" type="number" min="0" max="1" step="0.01"
              value="${esc(state.thresholds?.edgeVisible ?? 0.10)}">
            <small>低于它的边不显示、不参与召回游走，但仍然保存</small>
          </span>
        </label>
        <label class="threshold-field">
          <span>召回阈值</span>
          <span class="threshold-input-wrap">
            <input class="input" id="recallThresholdInput" type="number" min="0" max="1" step="0.01"
              value="${esc(state.thresholds?.recall ?? 0.30)}">
            <small>机器人召回时，低于它的中心事件和结果不返回</small>
          </span>
        </label>
      </div>
      <div class="hint" id="thresholdsMsg">${esc(state.thresholdsMsg || '建边阈值影响新 EU；边显形阈值影响显示和游走；召回阈值只影响工具输出。')}</div>
    </section>

    <div class="card settings-card">
      <div class="card-head"><h3>接口与快捷键</h3><span class="hint">给排查用</span></div>
      <div class="about-grid">
        <div class="about-item"><div class="k">控制台路径</div><div class="v mono">/xliens/web</div></div>
        <div class="about-item"><div class="k">API 前缀</div><div class="v mono">/xliens/api</div></div>
        <div class="about-item"><div class="k">记忆服务</div><div class="v mono">127.0.0.1:8317</div></div>
        <div class="about-item"><div class="k">设置页入口</div><div class="v">DSH 设置 → Xliens</div></div>
        <div class="about-item"><div class="k">关闭弹窗 / 详情</div><div class="v"><span class="kbd">Esc</span></div></div>
        <div class="about-item"><div class="k">图里搜索</div><div class="v">输入 <span class="mono">#编号</span> 或事件文字后回车</div></div>
      </div>
    </div>
  </div>`;
}

function mountSystem() {
  $('[data-act="save-thresholds"]')?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    const build = Number($('#buildThresholdInput')?.value);
    const edgeVisible = Number($('#edgeVisibleInput')?.value);
    const recall = Number($('#recallThresholdInput')?.value);
    if (!Number.isFinite(build) || build < 0 || build > 1
      || !Number.isFinite(edgeVisible) || edgeVisible < 0 || edgeVisible > 1
      || !Number.isFinite(recall) || recall < 0 || recall > 1) {
      state.thresholdsMsg = '三个阈值都必须在 0~1 之间';
      renderPage();
      return;
    }
    btn.disabled = true;
    try {
      const r = await apiPost('/thresholds', { build, edgeVisible, recall });
      const saved = {
        build: Number(r?.build ?? build),
        edgeVisible: Number(r?.edgeVisible ?? edgeVisible),
        recall: Number(r?.recall ?? recall),
      };
      if (!Object.values(saved).every(Number.isFinite)) {
        throw new Error('服务返回的阈值格式不正确');
      }
      state.thresholds = { ...r, ...saved };
      state.thresholdsMsg = `已保存：建边 ${saved.build.toFixed(2)}，边显形 ${saved.edgeVisible.toFixed(2)}，召回 ${saved.recall.toFixed(2)}`;
      state.graph = null;
      toast('阈值已保存，逻辑图和召回立即生效', 'good');
    } catch (e) {
      state.thresholdsMsg = `保存失败：${e?.message || e}`;
      toast(state.thresholdsMsg, 'bad');
    }
    renderPage();
  });
  $('[data-act="reload-health"]')?.addEventListener('click', (ev) => {
    withBusy(ev.currentTarget, null, async () => {
      await loadHealth();
      if (state.page === 'system') renderPage();
      toast('状态已刷新', 'good', 1400);
    }).catch((e) => toast(e?.message || String(e), 'bad'));
  });
  $('[data-act="reload-trash"]')?.addEventListener('click', (ev) => {
    withBusy(ev.currentTarget, null, async () => {
      await loadTrash(true);
      if (state.page === 'system') renderPage();
      toast('回收站已刷新', 'good', 1400);
    }).catch((e) => toast(e?.message || String(e), 'bad'));
  });
  $('#restoreLast')?.addEventListener('click', (ev) => {
    withBusy(ev.currentTarget, '恢复中…', async () => {
      const r = await apiPost('/node/restore', {});
      toast(`已恢复 #${r.id} ${r.desc || ''}`, 'good', 4200);
      await Promise.allSettled([loadTrash(true), state.graph ? loadGraph(true) : Promise.resolve()]);
      if (state.page === 'system') renderPage();
    }).catch((e) => toast(`恢复失败：${e?.message || e}`, 'bad'));
  });
}

/* ==========================================================================
   页面挂载 / 启动
   ========================================================================== */

function renderPage() {
  const view = $('#view');
  if (!view) return;
  let html = '';
  if (state.page === 'overview') html = pageOverview();
  else if (state.page === 'graph') html = pageGraph();
  else if (state.page === 'trace') html = pageTrace();
  else if (state.page === 'access') html = pageAccess();
  else if (state.page === 'persona') html = pagePersona();
  else if (state.page === 'owner') html = pageOwner();
  else if (state.page === 'consolidate') html = pageConsolidate();
  else if (state.page === 'staging') html = pageStaging();
  else if (state.page === 'system') html = pageSystem();
  else if (state.page === 'data') html = pageData();
  else if (state.page === 'plugin') html = pagePlugin();
  else html = pageOverview();
  view.innerHTML = html;

  if (state.page === 'overview') mountOverview();
  else if (state.page === 'graph') mountGraph();
  else if (state.page === 'trace') mountTrace();
  else if (state.page === 'access') mountAccess();
  else if (state.page === 'persona') mountPersona();
  else if (state.page === 'owner') mountOwner();
  else if (state.page === 'consolidate') mountConsolidate();
  else if (state.page === 'staging') mountStaging();
  else if (state.page === 'system') {
    state.systemRenderedSig = healthSig();
    mountSystem();
  } else if (state.page === 'data') {
    mountData();
  } else if (state.page === 'plugin') {
    mountPlugin();
  }
}

function bindGlobal() {
  $('#menuBtn')?.addEventListener('click', toggleSidebar);
  $('#sidebarShade')?.addEventListener('click', closeSidebar);
  $('#refreshBtn')?.addEventListener('click', refreshCurrentPage);

  $('#nav')?.addEventListener('click', (ev) => {
    const item = ev.target.closest('.nav-item');
    if (item) {
      if (window.innerWidth <= 960) closeSidebar();
      // 让 <a href="#page"> 自己走 hashchange，避免双跳
    }
  });

  window.addEventListener('hashchange', () => {
    const id = location.hash.slice(1) || 'overview';
    if (state.page !== id) applyPage(id);
  });

  document.addEventListener('click', (ev) => {
    const focusEl = ev.target.closest('[data-focus-node]');
    if (focusEl) {
      ev.preventDefault();
      focusNodeInGraph(Number(focusEl.dataset.focusNode));
      return;
    }
    const go = ev.target.closest('[data-go]');
    if (go) {
      ev.preventDefault();
      navigate(go.dataset.go);
    }
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if (modalOpen()) { closeModal(); return; }
    if (state.graphSel) { GraphView.clearSelection(); return; }
    if ($('#sidebar')?.classList.contains('is-open')) closeSidebar();
  });

  window.addEventListener('error', (ev) => {
    if (ev.target && ev.target !== window && ev.target.tagName) return;
    console.error(ev.error || ev.message);
    toast(`页面脚本出错：${ev.message || ev.error}`, 'bad', 6000);
  });
  window.addEventListener('unhandledrejection', (ev) => {
    console.error(ev.reason);
    toast(`操作失败：${ev.reason?.message || ev.reason}`, 'bad', 6000);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') loadHealth();
  });

  setInterval(() => {
    if (document.visibilityState === 'visible') loadHealth();
  }, 10000);

  setInterval(async () => {
    if (document.visibilityState !== 'visible') return;
    if (state.page === 'trace') {
      await loadTraces(true);
      if (state.page === 'trace' && !isEditing() && !modalOpen()) renderPage();
    } else if (state.page === 'graph') {
      await loadTraces(true);
      GraphView.draw();
    }
  }, 15000);
}

function init() {
  renderNav();
  bindGlobal();
  let initial = location.hash.slice(1);
  if (!PAGES.some((p) => p.id === initial)) {
    initial = 'overview';
    try { history.replaceState(null, '', '#overview'); } catch { /* ignore */ }
  }
  applyPage(initial);
  loadHealth();
  document.documentElement.dataset.appReady = '1';
  // 给排查用：浏览器控制台里可以直接 __xliens.navigate('trace') / focusNodeInGraph(12)
  window.__xliens = {
    state,
    navigate,
    focusNodeInGraph,
    GraphView,
    G,
    refresh: refreshCurrentPage,
    render: renderPage,
  };
}

init();
