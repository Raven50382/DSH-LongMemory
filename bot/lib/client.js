/**
 * Xliens —— 客户端半边：DSH 设置里的「Xliens」窗口。
 *
 * 三个标签页：
 *   逻辑图   —— 力导向画布，节点按关联度/中心高亮，点开看详情
 *   章动过程 —— 最近一次召回的完整跳步：入口筛选 → 每步游走 → Best → 邻域
 *   白名单   —— 放行群号 / 私聊 QQ 号 / 黑名单，改动立即生效
 *
 * 数据流：本组件 ⇄ /xliens/api/*（同源 fetch）⇄ Python 记忆服务。
 * 配置只存一份：白名单写到 file/allow.json，桥接每次读文件，不需要重启。
 */
window.__ModuleLoader__.load({
  id: "xliens",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const {
      createElement: h,
      useCallback,
      useEffect,
      useMemo,
      useRef,
      useState,
    } = React;

    const API = "/xliens/api";

    /**
     * Web 控制台的绝对地址。
     *
     * 设置页在桌面端跑在 `dsh-app://app/` 下，相对路径 `/xliens/web` 会被解析成
     * `dsh-app://app/xliens/web`；Electron 的窗口拦截只放行 http/https，
     * 所以点了没反应。这里优先取桌面注入的 `__DSH_TRANSPORT__.streamBaseUrl`，
     * 浏览器里退回 location.origin。
     */
    function webConsoleUrl() {
      // 带版本查询串：浏览器里如果还留着旧标签页，点入口也不会复用它，
      // 而是打开一个真正重新加载的新地址（否则旧 app.js 会一直缓存着旧视角逻辑）。
      const version = "20261109u";
      try {
        const base = globalThis.__DSH_TRANSPORT__?.streamBaseUrl;
        if (base) {
          const u = new URL("/xliens/web", base);
          u.searchParams.set("v", version);
          return u.href;
        }
      } catch { /* 继续用 location */ }
      try {
        if (typeof location !== "undefined"
          && (location.protocol === "http:" || location.protocol === "https:")) {
          const u = new URL("/xliens/web", location.origin);
          u.searchParams.set("v", version);
          return u.href;
        }
      } catch { /* 最后退回相对路径 */ }
      return `/xliens/web?v=${version}`;
    }

    // ---------- 小工具 ----------
    const C = {
      bg: "#12151b", panel: "#171a21", line: "#262b36",
      text: "#d7dce5", dim: "#8b93a3", accent: "#5b9dff",
      good: "#3ecf8e", warn: "#ffb454", bad: "#ff6b6b",
    };

    const S = {
      page: { padding: "4px 2px" },
      card: {
        background: C.panel, border: `1px solid ${C.line}`,
        borderRadius: 10, padding: "12px 14px", marginBottom: 12,
      },
      row: { display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" },
      muted: { color: C.dim, fontSize: 12 },
      btn: {
        background: "#232936", color: C.text, border: `1px solid ${C.line}`,
        borderRadius: 7, padding: "5px 12px", cursor: "pointer", fontSize: 12,
      },
      btnPrimary: {
        background: C.accent, color: "#08111f", border: `1px solid ${C.accent}`,
        borderRadius: 7, padding: "5px 12px", cursor: "pointer",
        fontWeight: 600, fontSize: 12,
      },
      ta: {
        width: "100%", boxSizing: "border-box", minHeight: 76,
        background: "#12151b", color: C.text, border: `1px solid ${C.line}`,
        borderRadius: 7, padding: "7px 9px", fontSize: 12,
        fontFamily: "ui-monospace, Consolas, monospace", resize: "vertical",
      },
      tab: (on) => ({
        padding: "5px 12px", borderRadius: 6, cursor: "pointer", fontSize: 12,
        color: on ? C.text : C.dim, background: on ? "#232936" : "transparent",
      }),
      step: (kind) => ({
        borderLeft: `2px solid ${
          kind === "move" ? C.accent : kind === "stop" ? C.warn
            : kind === "best" ? C.good : C.line}`,
        padding: "2px 0 2px 10px", margin: "3px 0",
        fontFamily: "ui-monospace, Consolas, monospace", fontSize: 11.5,
        lineHeight: 1.55,
      }),
      badge: (lv) => ({
        display: "inline-block", padding: "1px 7px", borderRadius: 999,
        fontSize: 11, marginRight: 6,
        background: lv === "high" ? "#14392a" : lv === "medium" ? "#3a2f16"
          : lv === "low" ? "#3a1a1a" : "#232936",
        color: lv === "high" ? C.good : lv === "medium" ? C.warn
          : lv === "low" ? C.bad : C.dim,
      }),
    };

    async function api(path) {
      const r = await fetch(API + path, { credentials: "same-origin" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }
    async function apiPost(path, body) {
      const r = await fetch(API + path, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }

    // ---------- 逻辑图 ----------
    // 坐标分两层：
    //   world  —— 节点的逻辑坐标，力导向算出来就不变
    //   view   —— 平移 + 缩放，只影响绘制
    // 拖动节点改 world；拖空白处平移 view；滚轮缩放 view。
    const LABEL_MAX = 8;   // 标签最长字数，长了看不清

    /** 把事件描述里的「主体/客体」换成真实人名，读起来才像人话。 */
    function humanDesc(nd) {
      let s = String(nd?.desc || '');
      if (nd?.subject) s = s.replace(/主体/g, nd.subject);
      if (nd?.object) s = s.replace(/客体/g, nd.object);
      return s;
    }

    function GraphTab({ traces }) {
      const ref = useRef(null);
      const [graph, setGraph] = useState({ nodes: [], edges: [] });
      const [showLabels, setShowLabels] = useState(true);
      const [sel, setSel] = useState(null);
      const [hint, setHint] = useState("");
      const [detail, setDetail] = useState(null);
      const [detailLoading, setDetailLoading] = useState(false);
      // 编辑面板的草稿
      const [draft, setDraft] = useState(null);
      const [editMsg, setEditMsg] = useState("");
      const [adding, setAdding] = useState(false);
      const [searchId, setSearchId] = useState("");
      const [ceMode, setCeMode] = useState("");
      const world = useRef(new Map());
      const keepEdges = useRef(new Set());
      const view = useRef({ x: 0, y: 0, k: 1 });
      const mode = useRef(null);        // {type:'node'|'pan', id?, wx, wy}
      const hover = useRef(null);
      const inited = useRef(false);

      // 点开节点时按需拉完整记录（含原始对话）。
      // 不放进 /graph 是因为 source_text 每条上千字，264 条会把 payload 撑到几百 KB。
      // 依赖用 sel.id 而不是 sel 对象：同一个节点被重复点击时不必重取，
      // 但换了节点必须立刻清空旧详情——否则请求慢一点或失败时，
      // 窗口里还留着上一个节点的内容（「切换节点详情不更新」就是这个）。
      const selIdForDetail = sel?.id ?? null;
      useEffect(() => {
        if (selIdForDetail == null) {
          setDetail(null); setDraft(null); setDetailLoading(false);
          return undefined;
        }
        let alive = true;
        setDetail(null);
        setDraft(null);
        setDetailLoading(true);
        setEditMsg("");
        api(`/node?id=${selIdForDetail}`)
          .then((d) => {
            if (!alive) return;
            setDetail(d);
            setDraft({
              event_desc: d.desc || "",
              time: d.time || "",
              subject: d.subject || "",
              object: d.object || "",
              source_text: d.source_text || "",
            });
            setDetailLoading(false);
          })
          .catch((e) => {
            if (!alive) return;
            setDetail(null);
            setDraft(null);
            setDetailLoading(false);
            setEditMsg(`读取节点 #${selIdForDetail} 失败：${e.message}`);
          });
        return () => { alive = false; };
      }, [selIdForDetail]);

      // 选中节点的邻居 -> 关联度。用来给边按关联度分级高亮。
      const selId = sel?.id ?? null;
      const selAdj = useMemo(() => {
        const m = new Map();
        if (selId == null) return m;
        for (const e of graph.edges || []) {
          if (e.source === selId) m.set(e.target, e.score || 0);
          else if (e.target === selId) m.set(e.source, e.score || 0);
        }
        return m;
      }, [selId, graph]);

      const last = traces.length ? traces[traces.length - 1] : null;
      const hi = useMemo(() => {
        const s = new Set();
        if (last?.center) s.add(last.center.id);
        (last?.neighbors || []).forEach((n) => s.add(n.id));
        return s;
      }, [last]);
      const hiCenter = last?.center?.id ?? null;

      const fitGraphView = useCallback((m, W, H) => {
        const pts = [...m.values()];
        if (!pts.length || !W || !H) {
          view.current = { x: 0, y: 0, k: 1 };
          return;
        }
        const xs = pts.map((p) => p.x).sort((a, b) => a - b);
        const ys = pts.map((p) => p.y).sort((a, b) => a - b);
        const q = (arr, t) => arr[Math.max(0, Math.min(
          arr.length - 1, Math.floor((arr.length - 1) * t)))];
        let minX = xs[0], maxX = xs[xs.length - 1];
        let minY = ys[0], maxY = ys[ys.length - 1];
        // 和 Web 控制台一致：忽略两端 5% 的离群节点，避免主社区被压到角落。
        if (pts.length >= 30) {
          const rx0 = q(xs, 0.05), rx1 = q(xs, 0.95);
          const ry0 = q(ys, 0.05), ry1 = q(ys, 0.95);
          if (rx1 - rx0 > (maxX - minX) * 0.2) { minX = rx0; maxX = rx1; }
          if (ry1 - ry0 > (maxY - minY) * 0.2) { minY = ry0; maxY = ry1; }
        }
        const padX = W * 0.1;
        const padY = H * 0.1;
        const k = Math.max(0.35, Math.min(1.6, Math.min(
          (W - padX * 2) / Math.max(1, maxX - minX),
          (H - padY * 2) / Math.max(1, maxY - minY),
        )));
        const cx = q(xs, 0.5);
        const cy = q(ys, 0.5);
        view.current = {
          k,
          x: W / 2 - cx * k,
          y: H / 2 - cy * k,
        };
      }, []);

      const relayout = useCallback((g) => {
        const cv = ref.current;
        const W = (cv ? cv.clientWidth : 900) || 900;
        const H = (cv ? cv.clientHeight : 600) || 600;
        const nodes = g.nodes || [];
        const edges = g.edges || [];
        const n = nodes.length || 1;

        // ---- 0. 稀疏化：每节点只留最强 K 条边 ----
        // 图有 5578 条边（264 节点，平均度数 42），直接画就是一团墨。
        // 实测保留每节点最强的 3 条 → 639 条边，能分出 24 个社区
        // （最大的才 17%），视觉上才像一个一个事件簇。
        const TOP_K = 3;
        const byNode = new Map();
        for (const nd of nodes) byNode.set(nd.id, []);
        for (const e of edges) {
          if (byNode.has(e.source)) byNode.get(e.source).push(e);
          if (byNode.has(e.target)) byNode.get(e.target).push(e);
        }
        const keep = new Set();
        for (const [, list] of byNode) {
          list.sort((x, y) => (y.score || 0) - (x.score || 0));
          for (const e of list.slice(0, TOP_K)) {
            keep.add(`${Math.min(e.source, e.target)}-${Math.max(e.source, e.target)}`);
          }
        }
        keepEdges.current = keep;
        const sparse = edges.filter((e) =>
          keep.has(`${Math.min(e.source, e.target)}-${Math.max(e.source, e.target)}`));

        // ---- 1. 社区检测（标签传播）----
        // 为什么不用连通分量：图太密（平均度数 40+），几乎全图连成一块，
        // 按连通分量只能分出 1 个簇，等于没分。
        // 标签传播在稠密图上也能找出「关系更紧的一小撮」。
        const adj = new Map();
        for (const nd of nodes) adj.set(nd.id, []);
        for (const e of sparse) {
          if (adj.has(e.source) && adj.has(e.target)) {
            const w = e.score || 0.1;
            adj.get(e.source).push([e.target, w]);
            adj.get(e.target).push([e.source, w]);
          }
        }
        const label = new Map();
        for (const nd of nodes) label.set(nd.id, nd.id);
        // 固定轮数，避免大图收敛太慢；每轮按加权邻居众数更新
        for (let round = 0; round < 12; round++) {
          let changed = 0;
          // 顺序随机化，减少振荡
          const order = nodes.map((x) => x.id);
          for (let k = order.length - 1; k > 0; k--) {
            const r = Math.floor(Math.random() * (k + 1));
            [order[k], order[r]] = [order[r], order[k]];
          }
          for (const id of order) {
            const tally = new Map();
            for (const [v, w] of adj.get(id) || []) {
              const lv = label.get(v);
              tally.set(lv, (tally.get(lv) || 0) + w);
            }
            if (!tally.size) continue;
            let bestLabel = label.get(id);
            let bestW = tally.get(bestLabel) || 0;
            for (const [lv, w] of tally) {
              if (w > bestW + 1e-9) { bestW = w; bestLabel = lv; }
            }
            if (bestLabel !== label.get(id)) {
              label.set(id, bestLabel);
              changed++;
            }
          }
          if (changed === 0) break;
        }
        // 归并成簇
        const byLabel = new Map();
        for (const nd of nodes) {
          const l = label.get(nd.id);
          if (!byLabel.has(l)) byLabel.set(l, []);
          byLabel.get(l).push(nd.id);
        }
        const comps = [...byLabel.values()].sort((a, b) => b.length - a.length);
        const comp = new Map();
        comps.forEach((ids, ci) => ids.forEach((id) => comp.set(id, ci)));

        // ---- 2. 给每个簇分配中心：单簇居中，多簇铺成一个大环 ----
        const centroids = new Map();
        const nc = comps.length;
        if (nc <= 1) {
          for (let c = 0; c < nc; c++) centroids.set(c, { x: W / 2, y: H / 2 });
        } else {
          // 环半径随簇数增大，让簇之间留出足够空隙（超出视口也没关系，图能拖）
          const base = Math.max(W, H);
          const R = base * (0.55 + 0.12 * Math.sqrt(nc));
          for (let c = 0; c < nc; c++) {
            const a = (c / nc) * Math.PI * 2 - Math.PI / 2;
            centroids.set(c, {
              x: W / 2 + Math.cos(a) * R,
              y: H / 2 + Math.sin(a) * R,
            });
          }
        }

        // ---- 3. 簇内布局：斥力 + 边引力 + 朝本簇中心收拢 ----
        const m = new Map();
        for (const c of comps) {
          const cen = centroids.get(comp.get(c[0])) || { x: W / 2, y: H / 2 };
          // 簇内初始点撒在小圆上，半径随簇规模增大
          const rr = Math.max(60, 22 * Math.sqrt(c.length));
          c.forEach((id, i) => {
            const a = (i / Math.max(1, c.length)) * Math.PI * 2;
            m.set(id, {
              x: cen.x + Math.cos(a) * rr,
              y: cen.y + Math.sin(a) * rr,
              vx: 0, vy: 0,
            });
          });
        }

        // 斥力强度随节点数放大，否则节点一多就糊成一团
        const repel = 900 * Math.max(1, n / 25);
        // 边的理想长度也随规模放大
        const ideal = 70 + Math.min(140, n * 0.5);
        const rounds = 260;

        for (let it = 0; it < rounds; it++) {
          const k = 1 - it / rounds;

          for (let a = 0; a < nodes.length; a++) {
            const pa = m.get(nodes[a].id);
            if (!pa) continue;
            for (let b = a + 1; b < nodes.length; b++) {
              const pb = m.get(nodes[b].id);
              if (!pb) continue;
              let dx = pa.x - pb.x;
              let dy = pa.y - pb.y;
              const d2 = dx * dx + dy * dy || 0.01;
              // 只算近邻斥力，远处忽略（省时间，264 节点 O(n²) 也能跑）
              if (d2 > 250000) continue;
              const f = repel / d2;
              const d = Math.sqrt(d2) || 0.01;
              dx /= d; dy /= d;
              pa.vx += dx * f; pa.vy += dy * f;
              pb.vx -= dx * f; pb.vy -= dy * f;
            }
          }

          for (const e of sparse) {
            const pa = m.get(e.source);
            const pb = m.get(e.target);
            if (!pa || !pb) continue;
            let dx = pb.x - pa.x;
            let dy = pb.y - pa.y;
            const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
            const f = (d - ideal) * 0.010 * (e.score || 0.3);
            dx /= d; dy /= d;
            pa.vx += dx * f; pa.vy += dy * f;
            pb.vx -= dx * f; pb.vy -= dy * f;
          }

          for (const nd of nodes) {
            const pp = m.get(nd.id);
            if (!pp) continue;
            const cen = centroids.get(comp.get(nd.id)) || { x: W / 2, y: H / 2 };
            // 朝本簇中心收拢（不是全局中心，这样簇才分得开）
            pp.vx += (cen.x - pp.x) * 0.004;
            pp.vy += (cen.y - pp.y) * 0.004;
            pp.x += pp.vx * k * 0.7;
            pp.y += pp.vy * k * 0.7;
            pp.vx *= 0.80; pp.vy *= 0.80;
          }
        }

        world.current = m;
        fitGraphView(m, W, H);
      }, [fitGraphView]);

      const draw = useCallback(() => {
        const cv = ref.current;
        if (!cv) return;
        const dpr = window.devicePixelRatio || 1;
        const W = cv.clientWidth || 900;
        const H = cv.clientHeight || 600;
        if (cv.width !== W * dpr || cv.height !== H * dpr) {
          cv.width = W * dpr;
          cv.height = H * dpr;
        }
        const g = cv.getContext("2d");
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, W, H);

        const v = view.current;
        const w = world.current;
        const tx = (pt) => ({ x: pt.x * v.k + v.x, y: pt.y * v.k + v.y });

        // 边：只画稀疏化保留下来的那些（外加当前召回高亮的所有边）
        const keep = keepEdges.current;
        for (const e of graph.edges) {
          const k = `${Math.min(e.source, e.target)}-${Math.max(e.source, e.target)}`;
          const active0 = hi.has(e.source) && hi.has(e.target);
          if (!keep.has(k) && !active0) continue;
          const a = w.get(e.source);
          const b = w.get(e.target);
          if (!a || !b) continue;
          const pa = tx(a);
          const pb = tx(b);
          const s = e.score || 0;
          const active = hi.has(e.source) && hi.has(e.target);
          const touchSel = selId != null
            && (e.source === selId || e.target === selId);
          if (touchSel) {
            // 选中节点的边：同一个色相，关联度越高越亮越粗
            // （不按分数分颜色档——那样看着像四类东西，而不是一个强度谱）
            const k = Math.max(0, Math.min(1, (s - 0.3) / 0.7));  // 0.3~1.0 归一
            const alpha = 0.10 + k * k * 0.90;   // 平方让差异更明显
            g.strokeStyle = `rgba(255,244,214,${alpha})`;
            g.lineWidth = 0.6 + k * 4.4;
          } else {
            g.strokeStyle = active
              ? `rgba(91,157,255,${0.28 + s * 0.72})`
              : `rgba(150,160,185,${0.08 + s * 0.24})`;
            g.lineWidth = active ? 1 + s * 2.4 : 0.6 + s * 1.1;
          }
          g.beginPath();
          g.moveTo(pa.x, pa.y);
          g.lineTo(pb.x, pb.y);
          g.stroke();
        }

        // 节点
        for (const nd of graph.nodes) {
          const p0 = w.get(nd.id);
          if (!p0) continue;
          const p = tx(p0);
          const isC = nd.id === hiCenter;
          const act = hi.has(nd.id);
          const r = (4 + Math.min(6, (nd.degree || 0) * 0.8) + (isC ? 4 : 0))
            * Math.max(0.55, v.k);
          const isSel = nd.id === selId;
          let fill = "#59637a";
          if (act) fill = isC ? "#ffd479" : C.accent;
          if (selAdj.has(nd.id)) {
            // 邻居节点同样用亮度表示关联度（越亮越相关）
            const k = Math.max(0, Math.min(1, ((selAdj.get(nd.id) || 0) - 0.3) / 0.7));
            const v = Math.round(90 + k * 150);
            fill = `rgb(${v},${Math.round(v * 0.85)},${Math.round(v * 0.5)})`;
          }
          if (isSel) fill = "#ffffff";                   // 选中节点常亮
          if (hover.current === nd.id && !isSel) fill = "#e8e8e8";
          g.beginPath();
          g.arc(p.x, p.y, r, 0, Math.PI * 2);
          g.fillStyle = fill;
          g.fill();
          if (isC) {
            g.strokeStyle = "#ffd479";
            g.lineWidth = 2;
            g.stroke();
          }
          if (isSel) {
            // 常亮环：点击选中后一直保持，直到点别的节点或空白
            g.strokeStyle = "#ffffff";
            g.lineWidth = 2.2;
            g.beginPath();
            g.arc(p.x, p.y, r + 3.5, 0, Math.PI * 2);
            g.stroke();
          }
          if (showLabels) {
            // 只在高亮节点或放大后显示标签，避免一堆小字糊在一起
            const wantLabel = act || isC || v.k >= 1.6 || hover.current === nd.id;
            if (wantLabel) {
              const txt = humanDesc(nd);
              const short = txt.length > LABEL_MAX
                ? txt.slice(0, LABEL_MAX) + "…" : txt;
              g.font = `${Math.max(10, 11 * Math.min(1.4, v.k))}px sans-serif`;
              g.fillStyle = act ? "#e6ebf5" : "rgba(170,180,200,.85)";
              g.fillText(short, p.x + r + 4, p.y + 4);
            }
          }
        }
      }, [graph, hi, hiCenter, showLabels, selId, selAdj]);

      // 编辑/增删之后重新拉图（保留已有坐标，不然一保存就全乱）
      const reloadGraph = useCallback(async () => {
        try {
          const g = await api("/graph");
          setGraph(g);
          const w = world.current;
          for (const nd of g.nodes) {
            if (!w.has(nd.id)) {
              const q = { x: 200 + Math.random() * 400,
                y: 160 + Math.random() * 320, vx: 0, vy: 0 };
              w.set(nd.id, q);
            }
          }
          requestAnimationFrame(draw);
        } catch (e) {
          setHint("刷新图失败：" + e.message);
        }
      }, [draw]);

      // 只加载一次图；之后不再重新布局（否则拖动会被重置）
      useEffect(() => {
        let alive = true;
        api("/graph").then((g) => {
          if (!alive) return;
          setGraph(g);
          relayout(g);
          inited.current = true;
          requestAnimationFrame(draw);
        }).catch((e) => setHint("图加载失败：" + e.message));
        return () => { alive = false; };
      }, [relayout]);

      // 图或高亮变了只重绘，不动坐标
      useEffect(() => { draw(); }, [draw, traces]);

      // 右侧详情出现/消失会改变画布宽度，重绘一次避免图像被拉伸。
      useEffect(() => {
        const el = ref.current;
        if (!el || typeof ResizeObserver === "undefined") return undefined;
        const ro = new ResizeObserver(() => draw());
        ro.observe(el);
        return () => ro.disconnect();
      }, [draw]);

      // CE 用的是 3080Ti 还是本地 CPU（每 10 秒刷一次）
      useEffect(() => {
        let alive = true;
        const tick = () => api("/health").then((h) => {
          if (!alive) return;
          const m = h.ce_mode || "";
          setCeMode(m === "remote" ? "CE：3080Ti" : (m ? "CE：本地" : ""));
        }).catch(() => {});
        tick();
        const tm = setInterval(tick, 10000);
        return () => { alive = false; clearInterval(tm); };
      }, []);

      const toWorld = (ev) => {
        const cv = ref.current;
        const r = cv.getBoundingClientRect();
        const v = view.current;
        return {
          x: (ev.clientX - r.left - v.x) / v.k,
          y: (ev.clientY - r.top - v.y) / v.k,
        };
      };

      const hit = (ev) => {
        const p = toWorld(ev);
        const v = view.current;
        const tol = 10 / Math.max(0.55, v.k);
        for (const nd of graph.nodes) {
          const q = world.current.get(nd.id);
          if (!q) continue;
          if ((q.x - p.x) ** 2 + (q.y - p.y) ** 2 < tol * tol) return nd;
        }
        return null;
      };

      return h("div", {
        style: {
          ...S.page,
          display: "grid",
          gridTemplateColumns: sel
            ? "minmax(0, 1fr) minmax(280px, 360px)"
            : "minmax(0, 1fr)",
          gap: 14,
          alignItems: "start",
        },
      },
        h("div", { style: { minWidth: 0 } },
          h("div", { style: { ...S.card, color: C.text } },
          h("div", { style: { ...S.row, marginBottom: 8 } },
            h("b", { style: { color: C.text } }, "逻辑关联图"),
            h("span", { style: S.muted },
              "拖空白平移 · Ctrl/⌘+滚轮缩放 · 拖节点移动 · 点节点看详情"),
            h("div", { style: { flex: 1 } }),
            h("label", { style: S.muted },
              h("input", {
                type: "checkbox",
                checked: showLabels,
                onChange: (e) => setShowLabels(e.target.checked),
                style: { marginRight: 4, verticalAlign: "middle" },
              }),
              "标签"),
            h("button", {
              style: S.btn,
              onClick: () => { relayout(graph); draw(); },
            }, "重置视图"),
          ),
          h("div", {
            style: {
              width: "100%",
              height: "clamp(420px, 62vh, 720px)",
              position: "relative",
            },
          },
          h("canvas", {
            ref,
            height: 720,
            style: {
              position: "absolute", inset: 0,
              width: "100%", height: "100%", display: "block", borderRadius: 8,
              background: "#12151b", cursor: "grab", touchAction: "none",
            },
            onMouseDown: (ev) => {
              const nd = hit(ev);
              if (nd) {
                const q = world.current.get(nd.id);
                const p = toWorld(ev);
                // 记录抓取点与节点中心的偏移，拖动时不会瞬移
                mode.current = {
                  type: "node", id: nd.id, ox: q.x - p.x, oy: q.y - p.y,
                };
              } else {
                const v = view.current;
                mode.current = {
                  type: "pan", sx: ev.clientX, sy: ev.clientY,
                  vx: v.x, vy: v.y,
                };
                if (ref.current) ref.current.style.cursor = "grabbing";
              }
            },
            onMouseMove: (ev) => {
              const m = mode.current;
              if (!m) {
                const nh = hit(ev);
                const id = nh ? nh.id : null;
                if (id !== hover.current) {
                  hover.current = id;
                  if (ref.current) {
                    ref.current.style.cursor = id !== null ? "pointer" : "grab";
                  }
                  draw();
                }
                return;
              }
              if (m.type === "node") {
                const p = toWorld(ev);
                const q = world.current.get(m.id);
                q.x = p.x + m.ox;
                q.y = p.y + m.oy;
                draw();
              } else {
                view.current.x = m.vx + (ev.clientX - m.sx);
                view.current.y = m.vy + (ev.clientY - m.sy);
                draw();
              }
            },
            onMouseUp: () => {
              mode.current = null;
              if (ref.current) ref.current.style.cursor = "grab";
            },
            onMouseLeave: () => {
              mode.current = null;
              hover.current = null;
              if (ref.current) ref.current.style.cursor = "grab";
              draw();
            },
            onWheel: (ev) => {
              // 普通滚轮留给页面滚动；按住 Ctrl/⌘ 才缩放图。
              if (!ev.ctrlKey && !ev.metaKey) return;
              ev.preventDefault();
              const cv = ref.current;
              const r = cv.getBoundingClientRect();
              const mx = ev.clientX - r.left;
              const my = ev.clientY - r.top;
              const v = view.current;
              const f = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
              const nk = Math.max(0.35, Math.min(3.5, v.k * f));
              // 以鼠标位置为锚点缩放
              v.x = mx - ((mx - v.x) / v.k) * nk;
              v.y = my - ((my - v.y) / v.k) * nk;
              v.k = nk;
              draw();
            },
            onClick: (ev) => {
              if (mode.current) return;
              const nd = hit(ev);
              if (nd) setSel(nd);
            },
          })),
          h("div", { style: { ...S.muted, marginTop: 6 } },
            `${graph.nodes.length} 节点 / ${graph.edges.length} 边`
            + (hint ? ` · ${hint}` : "")
            + (ceMode ? ` · ${ceMode}` : "")),
          h("div", { style: { ...S.row, gap: 8, marginTop: 6, fontSize: 11 } },
            h("span", { style: S.muted }, "选中后：关联度越高，连线越亮越粗"),
            h("span", {
              style: {
                width: 90, height: 6, borderRadius: 3, display: "inline-block",
                background: "linear-gradient(90deg, rgba(255,244,214,0.10),"
                  + " rgba(255,244,214,1))",
              },
            }),
            h("span", { style: { ...S.muted, fontSize: 11 } }, "低 → 高")),
        ),
        // 新增节点表单
        adding ? h("div", { style: { ...S.card, color: C.text } },
          h("div", { style: S.row },
            h("b", { style: { color: C.text } }, "新增事件"),
            h("div", { style: { flex: 1 } }),
            h("button", {
              style: S.btn,
              onClick: () => { setAdding(false); setEditMsg(""); },
            }, "取消")),
          h("div", { style: { ...S.muted, margin: "6px 0 8px" } },
            "手写一条事件。会用 CE 跟现有全部节点算关联度，自动连边。"),
          h("input", {
            value: draft?.event_desc || "",
            placeholder: "事件（主体+动作+客体，8~18 字）",
            style: { ...S.ta, minHeight: "auto", marginBottom: 8 },
            onChange: (e) => setDraft({ ...(draft || {}), event_desc: e.target.value }),
          }),
          h("textarea", {
            value: draft?.source_text || "",
            placeholder: "原始对话（可选）",
            style: { ...S.ta, minHeight: 90, marginBottom: 8 },
            onChange: (e) => setDraft({ ...(draft || {}), source_text: e.target.value }),
          }),
          h("div", { style: S.row },
            h("button", {
              style: S.btnPrimary,
              onClick: async () => {
                const desc = (draft?.event_desc || "").trim();
                if (!desc) { setEditMsg("事件不能为空"); return; }
                try {
                  const r = await apiPost("/node/add", {
                    event_desc: desc,
                    source_text: draft?.source_text || "",
                  });
                  setEditMsg(`已新增 #${r.id}，连了 ${r.edges} 条边`);
                  setAdding(false);
                  setDraft(null);
                  await reloadGraph();
                } catch (e) { setEditMsg("新增失败：" + e.message); }
              },
            }, "添加"),
            h("span", { style: { ...S.muted, flex: 1 } }, editMsg)),
        ) : null,

        // 工具条
        h("div", { style: { ...S.row, marginBottom: 10 } },
          h("input", {
            value: searchId,
            placeholder: "输入节点编号回车选中",
            style: { ...S.ta, minHeight: "auto", width: 150 },
            onChange: (e) => setSearchId(e.target.value),
            onKeyDown: (e) => {
              if (e.key !== "Enter") return;
              const n = Number(String(searchId).replace(/[^0-9]/g, ""));
              if (!Number.isFinite(n) || !String(searchId).trim()) {
                setEditMsg("编号不合法");
                return;
              }
              const found = (graph.nodes || []).find((x) => x.id === n);
              if (!found) { setEditMsg(`图里没有 #${n} 这个节点`); return; }
              setSel({ id: n, desc: found.desc, degree: found.degree });
              setEditMsg(`已选中 #${n}`);
            },
          }),
          h("button", {
            style: S.btn,
            onClick: () => {
              setAdding(true);
              setDraft({ event_desc: "", source_text: "" });
              setEditMsg("");
            },
          }, "+ 新增事件"),
          h("button", {
            style: S.btn,
            onClick: async () => {
              try {
                const r = await apiPost("/node/restore", {});
                setEditMsg(`已撤销删除：#${r.id} ${r.desc || ""}`);
                await reloadGraph();
              } catch (e) { setEditMsg("撤销失败：" + e.message); }
            },
          }, "↶ 撤销删除"),
          h("span", { style: { ...S.muted, flex: 1 } }, editMsg)),
        ),

        sel ? h("div", {
          style: {
            ...S.card, color: C.text, minWidth: 0,
            position: "sticky", top: 12,
            maxHeight: "calc(100vh - 190px)", overflow: "auto",
          },
        },
          h("div", { style: S.row },
            h("b", { style: { color: C.text } }, "节点详情（可编辑）"),
            h("div", { style: { flex: 1 } }),
            h("span", { style: S.muted }, `#${sel.id} · ${sel.degree ?? 0} 条边`),
            h("button", {
              style: S.btn, onClick: () => setSel(null),
            }, "关闭")),

          draft ? h("div", null,
            h("div", { style: { ...S.muted, margin: "8px 0 4px" } }, "事件"),
            h("input", {
              value: draft.event_desc,
              style: { ...S.ta, minHeight: "auto", marginBottom: 8 },
              onChange: (e) => setDraft({ ...draft, event_desc: e.target.value }),
            }),
            h("div", { style: { ...S.muted, margin: "0 0 4px" } }, "时间"),
            h("input", {
              value: draft.time,
              style: { ...S.ta, minHeight: "auto", marginBottom: 8 },
              onChange: (e) => setDraft({ ...draft, time: e.target.value }),
            }),
            h("div", { style: { ...S.row, gap: 8, marginBottom: 8 } },
              h("div", { style: { flex: 1 } },
                h("div", { style: { ...S.muted, marginBottom: 4 } }, "主体"),
                h("input", {
                  value: draft.subject,
                  style: { ...S.ta, minHeight: "auto", width: "100%" },
                  onChange: (e) => setDraft({ ...draft, subject: e.target.value }),
                })),
              h("div", { style: { flex: 1 } },
                h("div", { style: { ...S.muted, marginBottom: 4 } }, "客体"),
                h("input", {
                  value: draft.object,
                  style: { ...S.ta, minHeight: "auto", width: "100%" },
                  onChange: (e) => setDraft({ ...draft, object: e.target.value }),
                }))),
            h("div", { style: { ...S.muted, margin: "0 0 4px" } },
              "原始对话" + (detail?.session ? `（${detail.session}）` : "")),
            h("textarea", {
              value: draft.source_text,
              style: { ...S.ta, minHeight: 150 },
              onChange: (e) => setDraft({ ...draft, source_text: e.target.value }),
            }),
            h("div", { style: { ...S.row, marginTop: 10 } },
              h("button", {
                style: S.btnPrimary,
                onClick: async () => {
                  try {
                    await apiPost("/node/update", { id: sel.id, fields: draft });
                    setEditMsg(`已保存 #${sel.id}`);
                    await reloadGraph();
                  } catch (e) { setEditMsg("保存失败：" + e.message); }
                },
              }, "保存"),
              h("button", {
                style: S.btnDanger || S.btn,
                onClick: async () => {
                  try {
                    await apiPost("/node/delete", { id: sel.id });
                    setEditMsg(`已删除 #${sel.id}（可撤销）`);
                    setSel(null);
                    setDetail(null);
                    setDraft(null);
                    await reloadGraph();
                  } catch (e) { setEditMsg("删除失败：" + e.message); }
                },
              }, "删除这个节点"),
              h("span", { style: { ...S.muted, flex: 1 } }, editMsg)),
          ) : h("div", { style: S.muted }, detailLoading ? "读取中…" : "—"),

          // 关联邻居按关联度排序，和画布上的颜色对应
          detail?.neighbors?.length ? h("div", { style: { marginTop: 12 } },
            h("div", { style: { ...S.muted, marginBottom: 4 } },
              "关联事件（按关联度，颜色同画布）"),
            ...detail.neighbors.slice(0, 12).map((n) => {
              // 和画布一致：同一个暖色，亮度表示关联度
              const k = Math.max(0, Math.min(1, (n.score - 0.3) / 0.7));
              const col = `rgba(255,244,214,${0.35 + k * 0.65})`;
              const isCur = selIdForDetail === n.id;
              return h("div", {
                style: {
                  ...S.row, fontSize: 12, padding: "3px 6px", cursor: "pointer",
                  borderRadius: 6, gap: 8,
                  background: isCur ? "rgba(255,244,214,.10)" : "transparent",
                },
                onClick: () => setSel({ id: n.id, desc: n.desc, degree: n.score }),
                title: "点击选中这个节点",
              },
              h("span", {
                style: { color: C.dim, width: 34, fontFamily: "monospace" },
              }, `#${n.id}`),
              h("span", { style: { color: col, width: 38 } }, n.score.toFixed(2)),
              h("span", { style: { color: C.text, flex: 1 } }, n.desc));
            })) : null,
        ) : null,
      );
    }

    // ---------- 章动过程 ----------
    const KIND_NAME = {
      filter: "筛选", entry: "入口", score: "打分", move: "跳步",
      stop: "停止", entry_end: "入口结束", best: "最佳",
    };

    function TraceTab({ traces, reload }) {
      const t = traces.length ? traces[traces.length - 1] : null;
      if (!t) {
        return h("div", { style: S.page },
          h("div", { style: S.card },
            h("div", { style: S.row },
              h("b", null, "最近一次章动"),
              h("div", { style: { flex: 1 } }),
              h("button", { style: S.btn, onClick: reload }, "刷新")),
            h("div", { style: { ...S.muted, marginTop: 8 } },
              "还没有召回记录。在 QQ 里问一句需要回忆的话，这里就会出现完整的跳步过程。")));
      }

      const runs = t.runs || [];
      return h("div", { style: { ...S.page, color: C.text } },
        h("div", { style: { ...S.card, color: C.text } },
          h("div", { style: S.row },
            h("span", { style: S.badge(t.confidence) },
              t.confidence || "—"),
            h("b", null, t.query || ""),
            h("div", { style: { flex: 1 } }),
            h("button", { style: S.btn, onClick: reload }, "刷新")),
          h("div", { style: { ...S.muted, marginTop: 6 } },
            `${t.at} · 切分 ${t.ms_seg ?? "?"}ms · 召回 ${t.ms_recall ?? "?"}ms`),
          h("div", { style: { ...S.muted, marginTop: 4 } },
            `切出 EU：${(t.eus || []).join(" / ") || "（无）"}`),
        ),

        t.center ? h("div", { style: { ...S.card, background: C.bg } },
          h("div", null,
            h("span", { style: S.badge() }, "中心"),
            h("b", null, t.center.desc),
            h("span", { style: { ...S.muted, marginLeft: 8 } },
              `${t.center.time || ""} · 分数 ${t.center.score}`)),
          h("div", { style: { ...S.muted, marginTop: 4 } },
            `主体 ${t.center.subject || "—"} → 客体 ${t.center.object || "—"}`),
        ) : null,

        ...runs.map((run, i) => h("div", {
          key: i, style: { ...S.card, background: C.bg },
        },
        h("div", { style: S.muted }, `EU：${run.eu || ""}`),
        ...(run.trace || []).map((st, j) => h("div", {
          key: j, style: S.step(st.kind),
        },
        h("span", { style: S.badge() }, KIND_NAME[st.kind] || st.kind),
        st.text || "")),
        (run.bests || []).length
          ? h("div", { style: { ...S.muted, marginTop: 6 } },
            "Best：" + run.bests.map((b) => `#${b.id}(${b.score})`).join("、"))
          : null,
        )),

        (t.neighbors || []).length ? h("div", {
          style: { ...S.card, background: C.bg },
        },
        h("div", { style: S.muted }, "邻居"),
        ...t.neighbors.map((n, i) => h("div", {
          key: i, style: S.step("move"),
        }, `${n.hops} 跳 · ${n.score} · ${n.desc}`))
        ) : null,
      );
    }

    // ---------- 白名单 ----------
    function AllowTab() {
      const [g, setG] = useState("");
      const [pv, setPv] = useState("");
      const [deny, setDeny] = useState("");
      const [msg, setMsg] = useState("");
      const [loading, setLoading] = useState(true);

      const load = useCallback(async () => {
        setLoading(true);
        try {
          const a = await api("/allow");
          setG((a.groups || []).join("\n"));
          setPv((a.private || []).join("\n"));
          setDeny((a.denyUsers || []).join("\n"));
          setMsg("");
        } catch (e) {
          setMsg("读取失败：" + e.message);
        } finally {
          setLoading(false);
        }
      }, []);

      useEffect(() => { load(); }, [load]);

      const split = (s) => String(s).split(/\r?\n/).map((x) => x.trim())
        .filter(Boolean);

      const save = async () => {
        try {
          const r = await apiPost("/allow", {
            groups: split(g),
            private: split(pv),
            denyUsers: split(deny),
          });
          setMsg(`已保存：${(r.groups || []).length} 个群、`
            + `${(r.private || []).length} 个私聊（立即生效，不用重启）`);
        } catch (e) {
          setMsg("保存失败：" + e.message);
        }
      };

      const field = (label, val, set, ph) => h("div", {
        style: { marginBottom: 10 },
      },
      h("div", { style: { ...S.muted, marginBottom: 4 } }, label),
      h("textarea", {
        value: val, placeholder: ph, style: S.ta,
        onChange: (e) => set(e.target.value),
      }));

      return h("div", { style: { ...S.page, color: C.text } },
        h("div", { style: { ...S.card, color: C.text } },
          h("b", { style: { color: C.text } }, "放行白名单"),
          h("div", { style: { ...S.muted, margin: "6px 0 12px" } },
            "默认全部不放行。每行一个 ID。改动立即生效，不需要重启 DSH。"),
          field("允许的群号", g, setG, "123456789\n987654321"),
          field("允许的私聊 QQ 号", pv, setPv, "10001"),
          field("黑名单（这些人的消息一律不理）", deny, setDeny, "（一般留空）"),
          h("div", { style: S.row },
            h("button", { style: S.btnPrimary, onClick: save }, "保存"),
            h("button", { style: S.btn, onClick: load, disabled: loading },
              "重新读取"),
            h("span", { style: S.muted }, msg)),
        ));
    }

    // ---------- 外壳 ----------
    // ---------- 插件详情 ----------
    function PluginTab() {
      const [info, setInfo] = useState(null);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState("");

      const load = async (force) => {
        setLoading(true);
        setError("");
        try {
          const d = await api(`/update${force ? "?force=1" : ""}`);
          setInfo(d);
        } catch (e) {
          setError(e?.message || String(e));
        } finally {
          setLoading(false);
        }
      };

      useEffect(() => { load(false); }, []);

      const has = Boolean(info?.hasUpdate);
      const current = info?.current || "—";
      const latest = info?.latest || "—";
      const badge = has ? "有新版本" : (info?.ok ? "已是最新" : "检查失败");

      return h("div", { style: { ...S.page, color: C.text } },
        h("div", { style: { ...S.card, color: C.text } },
          h("div", { style: { ...S.row, alignItems: "center" } },
            h("b", { style: { color: C.text, fontSize: 15 } }, "Xliens 插件详情"),
            h("span", { style: S.badge(has ? "high" : undefined) }, badge),
            h("div", { style: { flex: 1 } }),
            h("button", {
              style: S.btn, disabled: loading,
              onClick: () => load(true),
            }, loading ? "检查中…" : "检查更新"),
            h("button", {
              style: has ? S.btnPrimary : S.btn,
              disabled: !has || loading,
              title: has ? "打开新版本下载页面" : "当前已是最新版本",
              onClick: () => {
                const url = info?.downloadUrl || info?.releaseUrl || info?.repoUrl;
                if (url) window.open(url, "_blank", "noopener,noreferrer");
              },
            }, has ? "更新" : "已是最新")),
          h("div", { style: { ...S.muted, marginTop: 8, lineHeight: 1.8 } },
            "当前版本：", h("b", { style: { color: C.text } }, current),
            "　最新版本：", h("b", { style: { color: C.text } }, latest)),
          info?.checkedAt
            ? h("div", { style: { ...S.muted, marginTop: 4, fontSize: 11 } },
              `检查时间：${info.checkedAt}`)
            : null,
          error || info?.error
            ? h("div", { style: { color: "#f87171", marginTop: 8, fontSize: 12 } },
              `检查失败：${error || info.error}`)
            : null,
          has ? h("div", {
            style: { ...S.card, background: C.bg, marginTop: 12, border: "1px solid #2b4563" },
          },
            h("b", { style: { color: C.text } }, `发现新版本 v${latest}`),
            info.notes ? h("div", { style: { ...S.muted, marginTop: 6, whiteSpace: "pre-wrap" } }, info.notes) : null,
            h("div", { style: { ...S.row, marginTop: 10 } },
              h("a", {
                href: info.downloadUrl || info.releaseUrl || info.repoUrl,
                target: "_blank", rel: "noopener noreferrer",
                style: { ...S.btnPrimary, display: "inline-block", textDecoration: "none" },
              }, "前往下载更新"),
              h("a", {
                href: info.repoUrl, target: "_blank", rel: "noopener noreferrer",
                style: { ...S.btn, display: "inline-block", textDecoration: "none" },
              }, "打开仓库")))
            : null,
          h("div", { style: { ...S.muted, marginTop: 12, fontSize: 11, lineHeight: 1.7 } },
            "只检查版本，不自动下载或覆盖安装。更新前请先备份数据。"),
        ));
    }

    function XliensSection() {
      const [tab, setTab] = useState("graph");
      const [traces, setTraces] = useState([]);
      const [replyEnabled, setReplyEnabled] = useState(true);
      const [replyMsg, setReplyMsg] = useState("");
      const [updateInfo, setUpdateInfo] = useState(null);

      useEffect(() => {
        let alive = true;
        api("/update").then((d) => { if (alive) setUpdateInfo(d); }).catch(() => {});
        return () => { alive = false; };
      }, []);

      const reload = useCallback(async () => {
        try {
          const d = await api("/trace");
          setTraces(d.traces || []);
        } catch { /* 记忆服务没起就算了 */ }
      }, []);

      const loadReply = useCallback(async () => {
        try {
          const s = await api("/settings");
          setReplyEnabled(s.reply?.enabled !== false);
          setReplyMsg("");
        } catch {
          setReplyMsg("回复开关读取失败");
        }
      }, []);

      useEffect(() => {
        reload();
        const timer = setInterval(reload, 5000);
        return () => clearInterval(timer);
      }, [reload]);

      useEffect(() => { loadReply(); }, [loadReply]);

      const toggleReply = async (next) => {
        setReplyEnabled(next);
        setReplyMsg("");
        try {
          const r = await apiPost("/settings", { reply: { enabled: next } });
          const on = r.reply?.enabled !== false;
          setReplyEnabled(on);
          setReplyMsg(on ? "回复已开启" : "回复已暂停");
        } catch (e) {
          setReplyEnabled(!next);
          setReplyMsg("保存失败：" + e.message);
        }
      };

      const tabBtn = (id, label) => h("div", {
        style: S.tab(tab === id),
        onClick: () => setTab(id),
      }, label);

      // color 必须显式指定：设置页外壳是浅色主题时，继承下来会是黑字压黑底
      return h("div", {
        style: {
          padding: "0 2px 24px", color: C.text,
          height: "100%", maxHeight: "calc(100vh - 90px)",
          overflowY: "auto", boxSizing: "border-box",
        },
      },
        updateInfo?.hasUpdate ? h("div", {
          style: {
            ...S.card, marginBottom: 12, border: "1px solid #a16207",
            background: "linear-gradient(100deg, rgba(251,191,36,.12), rgba(251,191,36,.03))",
            display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
          },
        },
          h("b", { style: { color: "#fbbf24" } }, `发现新版本 v${updateInfo.latest || ""}`),
          h("span", { style: S.muted }, `当前 v${updateInfo.current || ""}`),
          h("div", { style: { flex: 1 } }),
          h("button", { style: S.btnPrimary, onClick: () => setTab("plugin") }, "查看插件详情")) : null,
        // 设置页只留日常够用的部分；想铺开看图、翻召回、做召回测试时，
        // 从这里开一个独立页面。两套入口并存，不是替换。
        h("div", {
          style: {
            ...S.card,
            border: "1px solid #2b4563",
            background: "linear-gradient(120deg, #16213a 0%, #141924 58%, #12151b 100%)",
            display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap",
          },
        },
        h("div", { style: { flex: 1, minWidth: 240 } },
          h("b", { style: { color: C.text, fontSize: 13 } }, "更完整的 Web 控制台"),
          h("div", { style: { ...S.muted, marginTop: 4, lineHeight: 1.65 } },
            "逻辑图、章动过程、召回测试、白名单 / 人设 / 主人（含我的名字）/ 整备 / 落盘，"
            + "都放在一个铺得开的页面里。设置页保留原样，随时可以切回来。")),
        h("a", {
          href: webConsoleUrl(),
          target: "_blank",
          rel: "noopener noreferrer",
          style: {
            ...S.btnPrimary,
            display: "inline-block", textDecoration: "none",
            padding: "7px 14px", whiteSpace: "nowrap",
          },
        }, "打开 Web 控制台 ↗")),
        h("div", {
          style: { ...S.row, marginBottom: 12, alignItems: "center", flexWrap: "wrap" },
        },
          tabBtn("graph", "逻辑图"),
          tabBtn("trace", "章动过程"),
          tabBtn("allow", "白名单"),
          tabBtn("persona", "人设"),
          tabBtn("owner", "主人"),
          tabBtn("consolidate", "整备"),
          tabBtn("staging", "落盘"),
          tabBtn("data", "数据与备份"),
          tabBtn("plugin", "插件详情"),
          h("div", { style: { flex: 1, minWidth: 12 } }),
          h("button", {
            type: "button",
            role: "switch",
            "aria-checked": replyEnabled,
            title: "关闭后机器人只记录消息，不再回复群聊/私聊",
            onClick: () => toggleReply(!replyEnabled),
            style: {
              display: "flex", alignItems: "center", gap: 8,
              border: "none", background: "transparent", padding: 0,
              color: C.text, cursor: "pointer", whiteSpace: "nowrap",
              fontSize: 12,
            },
          },
            h("span", {
              style: {
                width: 38, height: 21, borderRadius: 999,
                background: replyEnabled ? "#34d399" : "#334155",
                position: "relative", flex: "none",
                transition: "background .18s ease",
                boxShadow: replyEnabled ? "0 0 0 3px rgba(52,211,153,.12)" : "none",
              },
            }, h("span", {
              style: {
                position: "absolute", top: 2, left: replyEnabled ? 19 : 2,
                width: 17, height: 17, borderRadius: "50%",
                background: "#f8fafc", transition: "left .18s ease",
                boxShadow: "0 1px 3px rgba(0,0,0,.35)",
              },
            })),
            h("span", { style: S.muted },
              replyEnabled ? "机器人回复：开" : "机器人回复：关")),
          replyMsg ? h("span", {
            style: { ...S.muted, marginLeft: 8, fontSize: 11 },
          }, replyMsg) : null),
        tab === "graph" ? h(GraphTab, { traces }) : null,
        tab === "trace" ? h(TraceTab, { traces, reload }) : null,
        tab === "allow" ? h(AllowTab, null) : null,
        tab === "persona" ? h(PersonaTab, null) : null,
        tab === "owner" ? h(OwnerTab, null) : null,
        tab === "consolidate" ? h(ConsolidateTab, null) : null,
        tab === "staging" ? h(StagingTab, null) : null,
        tab === "data" ? h(DataTab, null) : null,
        tab === "plugin" ? h(PluginTab, null) : null,
      );
    }

    // ---------- 数据与备份 ----------
    function DataTab() {
      const [info, setInfo] = useState(null);
      const [target, setTarget] = useState("");
      const [msg, setMsg] = useState("");
      const [busy, setBusy] = useState("");

      const load = useCallback(async () => {
        try {
          setInfo(await api("/data"));
        } catch (e) {
          setMsg("读取数据目录失败：" + e.message);
        }
      }, []);

      useEffect(() => { load(); }, [load]);

      const pick = async () => {
        setBusy("pick"); setMsg("");
        try {
          const r = await apiPost("/data/pick-dir", {});
          if (r?.ok && r.path) setTarget(r.path);
          else setMsg("已取消选择");
        } catch (e) {
          setMsg("打开目录选择器失败：" + e.message);
        } finally { setBusy(""); }
      };

      const migrate = async () => {
        const to = String(target || "").trim();
        if (!to) { setMsg("先选择或填写新目录"); return; }
        if (typeof confirm === "function"
            && !confirm(`把整个插件数据目录复制到：\n${to}\n\n旧目录不会删除，完成后需要重启 DSH。继续？`)) return;
        setBusy("migrate"); setMsg("");
        try {
          const r = await apiPost("/data/migrate", { path: to });
          setMsg(`已复制 ${(r.copied || []).length} 项到 ${r.to}；重启 DSH 后生效，旧目录未删除。`
            + (r.serviceStopped ? ' 旧 8317 已停止。' : ' 请手动停止旧 8317。'));
        } catch (e) {
          setMsg("迁移失败：" + e.message);
        } finally { setBusy(""); }
      };

      const backup = async () => {
        setBusy("backup"); setMsg("");
        try {
          const r = await apiPost("/data/backup", {});
          setMsg("已备份：" + r.name);
          await load();
        } catch (e) {
          setMsg("备份失败：" + e.message);
        } finally { setBusy(""); }
      };

      const restore = async (name) => {
        if (typeof confirm === "function"
            && !confirm(`恢复备份 ${name}？\n\n当前逻辑图会先自动备份，再替换成这个备份。`)) return;
        setBusy("restore"); setMsg("");
        try {
          const r = await apiPost("/data/restore", { name });
          setMsg(r.reloaded ? `已恢复 ${r.restored} 并重载` : `已恢复 ${r.restored}，重启记忆服务后生效`);
          await load();
        } catch (e) {
          setMsg("恢复失败：" + e.message);
        } finally { setBusy(""); }
      };

      if (!info) {
        return h("div", { style: S.card },
          h("b", { style: { color: C.text } }, "数据与备份"),
          h("div", { style: { ...S.muted, marginTop: 6 } }, msg || "正在读取…"));
      }
      const cur = info.current || {};
      const backups = info.backups || [];

      return h("div", { style: S.card },
        h("b", { style: { color: C.text } }, "工作目录"),
        h("div", { style: { ...S.muted, marginTop: 5, lineHeight: 1.65 } },
          "整个插件数据目录（逻辑图、备份、pending、file 配置、logs）。代码和 models 不动。"),
        h("div", { style: { ...S.muted, marginTop: 8, fontFamily: "Consolas, monospace", wordBreak: "break-all" } },
          "当前：" + info.dataRoot),
        h("div", { style: { ...S.muted, marginTop: 3 } },
          `${cur.eus || 0} EU / ${cur.edges || 0} 边 · ${info.pending || 0} 条待整备 · ${backups.length} 个备份`),
        h("div", { style: { ...S.row, marginTop: 10 } },
          h("input", {
            value: target,
            placeholder: "数据目录路径",
            onChange: (e) => setTarget(e.target.value),
            style: { ...S.ta, minHeight: 0, flex: 1, minWidth: 240, padding: "6px 8px" },
          }),
          h("button", { style: S.btn, onClick: pick, disabled: !!busy },
            busy === "pick" ? "选择中…" : "选择目录"),
          h("button", {
            style: S.btnPrimary, onClick: migrate,
            disabled: !!busy || !String(target || "").trim(),
          }, busy === "migrate" ? "迁移中…" : "迁移")),
        h("div", { style: { ...S.muted, marginTop: 6, fontSize: 11 } },
          "迁移是复制：旧目录不会删除；完成后重启 DSH，新的记忆服务才会用新目录。"),

        h("div", { style: { ...S.row, marginTop: 14, paddingTop: 12, borderTop: `1px solid ${C.line}` } },
          h("b", { style: { color: C.text } }, "逻辑图备份"),
          h("div", { style: { flex: 1 } }),
          h("button", { style: S.btn, onClick: backup, disabled: !!busy },
            busy === "backup" ? "备份中…" : "备份现在")),
        backups.length === 0
          ? h("div", { style: { ...S.muted, marginTop: 8 } }, "还没有备份。")
          : h("div", { style: { marginTop: 8 } }, backups.map((b) => h("div", {
            key: b.name,
            style: {
              ...S.row, padding: "7px 0", borderTop: `1px solid ${C.line}`,
              justifyContent: "space-between",
            },
          },
            h("div", { style: { minWidth: 0 } },
              h("div", { style: { color: C.text, fontFamily: "Consolas, monospace", fontSize: 11, wordBreak: "break-all" } }, b.name),
              h("div", { style: { ...S.muted, marginTop: 2 } },
                `${b.eus || 0} EU / ${b.edges || 0} 边 · ${b.time ? new Date(b.time).toLocaleString() : ""}`)),
            h("button", {
              style: S.btn, onClick: () => restore(b.name), disabled: !!busy,
            }, busy === "restore" ? "恢复中…" : "恢复")))),
        msg ? h("div", { style: { ...S.muted, marginTop: 10, color: /失败/.test(msg) ? C.bad : C.good } }, msg) : null,
      );
    }

    // ---------- 人设 ----------
    function PersonaTab() {
      const [text, setText] = useState("");
      const [msg, setMsg] = useState("");
      const [loading, setLoading] = useState(true);

      const load = useCallback(async () => {
        setLoading(true);
        try {
          const d = await api("/persona");
          setText(d.text || "");
          setMsg("");
        } catch (e) {
          setMsg("读取失败：" + e.message);
        } finally {
          setLoading(false);
        }
      }, []);

      useEffect(() => { load(); }, [load]);

      const save = async () => {
        try {
          const r = await apiPost("/persona", { text });
          setMsg(`已保存（${r.chars} 字）。下一轮对话立即生效，不用重启。`);
        } catch (e) {
          setMsg("保存失败：" + e.message);
        }
      };

      return h("div", { style: { ...S.page, color: C.text } },
        h("div", { style: { ...S.card, color: C.text } },
          h("b", { style: { color: C.text } }, "人设"),
          h("div", { style: { ...S.muted, margin: "6px 0 10px" } },
            "这是 TA 的性格、说话习惯和边界。改完保存，下一轮对话立即生效。"
            + "只作用于 Xliens 机器人工作区（.bot-workspace）的会话，"
            + "不会影响你当前的工作会话。文件在 file/persona.md。"),
          h("textarea", {
            value: text,
            style: { ...S.ta, minHeight: 420 },
            onChange: (e) => setText(e.target.value),
            spellCheck: false,
          }),
          h("div", { style: { ...S.row, marginTop: 10 } },
            h("button", { style: S.btnPrimary, onClick: save }, "保存"),
            h("button", { style: S.btn, onClick: load, disabled: loading },
              "重新读取"),
            h("span", { style: { ...S.muted, flex: 1 } }, msg),
            h("span", { style: S.muted }, `${text.length} 字`)),
        ));
    }



    // ---------- 整备（暂存审查） ----------
    function StagingTab() {
      const [mode, setMode] = useState("review");
      const [batches, setBatches] = useState([]);
      const [cur, setCur] = useState(null);        // 当前批次详情
      const [msg, setMsg] = useState("");
      const [draft, setDraft] = useState({});      // idx -> {desc, source_text}
      const [addText, setAddText] = useState("");
      const [busy, setBusy] = useState(false);

      const loadList = useCallback(async () => {
        try {
          const d = await api("/staging/list");
          setBatches(d.items || []);
          return d.items || [];
        } catch (e) {
          setMsg("读取批次失败：" + e.message);
          return [];
        }
      }, []);

      const loadOne = useCallback(async (id) => {
        if (!id) { setCur(null); setDraft({}); return; }
        try {
          const b = await api(`/staging/get?id=${encodeURIComponent(id)}`);
          setCur(b);
          const d = {};
          (b.events || []).forEach((e) => {
            d[e.i] = {
              desc: e.desc, source_text: e.source_text, ts: e.ts,
              subject: e.subject || "", object: e.object || "",
            };
          });
          setDraft(d);
          setMsg("");
        } catch (e) {
          setCur(null);
          setMsg("读取批次失败：" + e.message);
        }
      }, []);

      const loadSettings = useCallback(async () => {
        try {
          const d = await api("/settings");
          setMode((d.consolidate || {}).mode || "review");
        } catch { /* ignore */ }
      }, []);

      useEffect(() => {
        (async () => {
          await loadSettings();
          const items = await loadList();
          const pending = items.find((x) => x.status === "pending") || items[0];
          if (pending) await loadOne(pending.id);
        })();
      }, [loadList, loadOne, loadSettings]);

      const saveMode = async (m) => {
        setMode(m);
        try {
          await apiPost("/settings", { consolidate: { mode: m } });
          setMsg(m === "auto" ? "已切到自动落盘（整备完直接进图）" : "已切到手动审查");
        } catch (e) { setMsg("保存失败：" + e.message); }
      };

      const refresh = async (id) => {
        const items = await loadList();
        const target = id || (items.find((x) => x.status === "pending") || items[0] || {}).id;
        await loadOne(target);
      };

      const saveEvent = async (idx) => {
        const d = draft[idx];
        if (!d) return;
        try {
          await apiPost("/staging/update", { id: cur.id, idx,
            fields: {
              desc: d.desc, source_text: d.source_text,
              ts: d.ts, subject: d.subject, object: d.object,
            } });
          setMsg(`已保存第 ${idx + 1} 条`);
          await refresh(cur.id);
        } catch (e) { setMsg("保存失败：" + e.message); }
      };

      const toggleLock = async (e) => {
        try {
          await apiPost("/staging/update", {
            id: cur.id, idx: e.i, fields: { locked: !e.locked },
          });
          setCur((prev) => prev ? {
            ...prev,
            events: (prev.events || []).map((x) => x.i === e.i
              ? { ...x, locked: !e.locked } : x),
          } : prev);
          await loadList();
          setMsg(e.locked ? `已解锁第 ${e.i + 1} 条` : `已锁定第 ${e.i + 1} 条`);
        } catch (err) { setMsg("锁定失败：" + err.message); }
      };

      const lockAll = async (next) => {
        if (!cur) return;
        setBusy(true);
        try {
          for (const e of cur.events || []) {
            if (!!e.locked === next) continue;
            await apiPost("/staging/update", {
              id: cur.id, idx: e.i, fields: { locked: next },
            });
          }
          await refresh(cur.id);
          setMsg(next ? "已全部锁定" : "已全部解锁");
        } catch (e) { setMsg("批量锁定失败：" + e.message); }
        finally { setBusy(false); }
      };

      const removeEvent = async (idx) => {
        try {
          await apiPost("/staging/delete", { id: cur.id, idx });
          setMsg(`已删除第 ${idx + 1} 条`);
          await refresh(cur.id);
        } catch (e) { setMsg("删除失败：" + e.message); }
      };

      const addEvent = async () => {
        const desc = addText.trim();
        if (!desc) { setMsg("事件描述不能为空"); return; }
        try {
          await apiPost("/staging/add", { id: cur.id, desc, source_text: "" });
          setAddText("");
          setMsg("已追加一条");
          await refresh(cur.id);
        } catch (e) { setMsg("追加失败：" + e.message); }
      };

      const commit = async () => {
        setBusy(true);
        try {
          const r = await apiPost("/staging/commit", { id: cur.id });
          setMsg(`已入图：新增 ${r.new_eus} 个事件、${r.new_edges} 条关联；`
            + `现在 ${r.nodes} 节点 / ${r.edges} 边`);
          await refresh(cur.id);
        } catch (e) { setMsg("入图失败：" + e.message); }
        finally { setBusy(false); }
      };

      const discard = async () => {
        try {
          await apiPost("/staging/discard", { id: cur.id });
          setMsg("已丢弃这一批");
          await refresh(cur.id);
        } catch (e) { setMsg("丢弃失败：" + e.message); }
      };

      const statusTag = (s) => (s === "committed" ? "已入图"
        : s === "discarded" ? "已丢弃" : "待审查");
      const statusColor = (s) => (s === "committed" ? "#6ecd96"
        : s === "discarded" ? "#888" : "#ffc448");

      const lockedCount = cur
        ? (cur.events || []).filter((e) => e.locked).length : 0;

      return h("div", { style: { ...S.page, color: C.text } },
        // 模式
        h("div", { style: { ...S.card, color: C.text } },
          h("b", { style: { color: C.text } }, "落盘模式"),
          h("div", { style: { ...S.muted, margin: "6px 0 10px" } },
            "整备完成后怎么落盘："),
          h("div", { style: S.row },
            h("button", {
              style: mode === "review" ? S.btnPrimary : S.btn,
              onClick: () => saveMode("review"),
            }, "手动审查（推荐）"),
            h("button", {
              style: mode === "auto" ? S.btnPrimary : S.btn,
              onClick: () => saveMode("auto"),
            }, "自动落盘"),
            h("span", { style: { ...S.muted, flex: 1 } },
              mode === "review"
                ? "整备结果先暂存在这里，你确认后才写进图"
                : "整备完直接写进图，不暂存"),
          )),

        // 批次列表（含历史）
        h("div", { style: { ...S.card, color: C.text } },
          h("div", { style: S.row },
            h("b", { style: { color: C.text } }, "落盘批次"),
            h("div", { style: { flex: 1 } }),
            h("button", {
              style: S.btn,
              onClick: async () => {
                await loadList();
                setMsg("已刷新");
              },
            }, "刷新")),
          h("div", { style: { ...S.muted, margin: "6px 0 8px" } },
            `共 ${batches.length} 批（点开看详情，历史批次只读）`),
          batches.length === 0
            ? h("div", { style: S.muted }, "还没有落盘记录")
            : h("div", { style: { maxHeight: 200, overflow: "auto" } },
              ...batches.map((b) => h("div", {
                style: {
                  ...S.row, fontSize: 12, padding: "4px 6px", cursor: "pointer",
                  borderRadius: 6, gap: 8,
                  background: cur && cur.id === b.id
                    ? "rgba(255,244,214,.10)" : "transparent",
                },
                onClick: () => loadOne(b.id),
              },
                h("span", { style: { fontFamily: "monospace", width: 130 } },
                  b.id),
                h("span", { style: { color: statusColor(b.status), width: 58 } },
                  statusTag(b.status)),
                h("span", { style: { ...S.muted, width: 70 } },
                  `${b.event_count} 事件`),
                h("span", { style: { ...S.muted, width: 64, color: (b.locked_count || 0) ? "#5eead4" : undefined } },
                  `锁 ${b.locked_count || 0}`),
                h("span", { style: { ...S.muted, flex: 1 } },
                  b.status === "committed" && b.result
                    ? `入图 ${b.result.new_eus} 个 / ${b.result.new_edges} 条边`
                    : (b.created_at || "")),
              ))),
          h("div", { style: { ...S.row, marginTop: 8 } },
            h("span", { style: { ...S.muted, flex: 1 } }, msg)),
        ),

        // 详情
        cur ? h("div", { style: { ...S.card, color: C.text } },
          h("div", { style: S.row },
            h("b", { style: { color: C.text } },
              `批次 ${cur.id} · ${statusTag(cur.status)}`),
            h("div", { style: { flex: 1 } }),
            h("span", { style: { ...S.muted } },
              `${(cur.events || []).length} 个事件 · 锁定 ${lockedCount}`
              + (cur.messages ? ` · ${cur.messages} 条消息` : ""))),

          cur.status === "pending" ? h("div", {
            style: { ...S.row, margin: "8px 0", flexWrap: "wrap", gap: 8 },
          },
            h("button", { style: S.btnPrimary, onClick: commit, disabled: busy },
              busy ? "入图中…" : `确认入图（${lockedCount}）`),
            h("button", { style: S.btn, onClick: discard, disabled: busy },
              "丢弃这批"),
            h("button", {
              style: S.btn, onClick: () => lockAll(true), disabled: busy,
            }, "全部锁定"),
            h("button", {
              style: S.btn, onClick: () => lockAll(false), disabled: busy,
            }, "全部解锁"),
            h("span", {
              style: { ...S.muted, flex: 1, color: lockedCount ? undefined : "#fbbf24" },
            }, lockedCount
              ? `只有这 ${lockedCount} 条会入图，其余会丢弃`
              : "还没有锁定事件；未锁定的事件不会入图"),
          ) : h("div", { style: { ...S.warn, margin: "8px 0" } },
            cur.status === "committed"
              ? `已于 ${cur.committed_at} 入图`
              : `已于 ${cur.discarded_at || ""} 丢弃，不会再入图`),

          ...(cur.events || []).map((e, k) => {
            const d = draft[e.i] || {
              desc: e.desc, source_text: e.source_text, ts: e.ts,
              subject: e.subject || "", object: e.object || "",
            };
            const ro = cur.status !== "pending";
            const locked = !!e.locked;
            const cands = (e.candidates || []).slice(0, 4);
            return h("div", {
              style: {
                borderTop: `1px solid ${C.line}`, padding: "10px 0",
              },
            },
            h("div", { style: { ...S.row, marginBottom: 6, gap: 8, flexWrap: "wrap" } },
              h("span", { style: { ...S.muted, width: 34 } }, `#${k + 1}`),
              h("button", {
                style: {
                  ...S.btn, padding: "3px 8px",
                  color: locked ? "#5eead4" : "#fbbf24",
                  borderColor: locked ? "rgba(94,234,212,.55)" : "rgba(251,191,36,.45)",
                },
                onClick: () => toggleLock(e), disabled: ro,
              }, locked ? "已锁定" : "未锁定"),
              h("span", {
                style: {
                  ...S.muted, fontFamily: "monospace", fontSize: 11,
                  padding: "3px 6px", borderRadius: 5,
                  background: "rgba(124,156,255,.10)",
                },
              }, `CE ${Number(e.score || 0).toFixed(2)}`),
              ro
                ? h("span", { style: { color: C.text, flex: 1 } }, e.desc)
                : h("input", {
                  value: d.desc,
                  style: { ...S.ta, minHeight: "auto", flex: 1 },
                  onChange: (ev) => setDraft({
                    ...draft, [e.i]: { ...d, desc: ev.target.value },
                  }),
                }),
              ro ? null : h("button", {
                style: S.btn, onClick: () => saveEvent(e.i),
              }, "保存"),
              ro ? null : h("button", {
                style: S.btn, onClick: () => removeEvent(e.i),
              }, "删除")),

            h("div", { style: { ...S.row, gap: 8, marginBottom: 5, flexWrap: "wrap" } },
              h("div", { style: { flex: "1 1 150px" } },
                h("div", { style: { ...S.muted, fontSize: 11, marginBottom: 2 } }, "时间"),
                ro ? h("span", { style: { ...S.muted, fontSize: 12 } }, e.ts || "—")
                  : h("input", {
                    value: d.ts || "",
                    style: { ...S.ta, minHeight: "auto", width: "100%" },
                    onChange: (ev) => setDraft({
                      ...draft, [e.i]: { ...d, ts: ev.target.value },
                    }),
                  })),
              h("div", { style: { flex: "1 1 130px" } },
                h("div", { style: { ...S.muted, fontSize: 11, marginBottom: 2 } }, "主体"),
                ro ? h("span", { style: { ...S.muted, fontSize: 12 } }, e.subject || "—")
                  : h("input", {
                    value: d.subject || "",
                    style: { ...S.ta, minHeight: "auto", width: "100%" },
                    onChange: (ev) => setDraft({
                      ...draft, [e.i]: { ...d, subject: ev.target.value },
                    }),
                  })),
              h("div", { style: { flex: "1 1 130px" } },
                h("div", { style: { ...S.muted, fontSize: 11, marginBottom: 2 } }, "客体"),
                ro ? h("span", { style: { ...S.muted, fontSize: 12 } }, e.object || "—")
                  : h("input", {
                    value: d.object || "",
                    style: { ...S.ta, minHeight: "auto", width: "100%" },
                    onChange: (ev) => setDraft({
                      ...draft, [e.i]: { ...d, object: ev.target.value },
                    }),
                  }))),

            ro
              ? h("pre", {
                style: {
                  margin: 0, padding: "6px 8px", maxHeight: 90, overflow: "auto",
                  whiteSpace: "pre-wrap", fontSize: 11, background: "#12151b",
                  border: `1px solid ${C.line}`, borderRadius: 6, color: C.text,
                },
              }, e.source_text || "（没有上下文）")
              : h("textarea", {
                value: d.source_text,
                style: { ...S.ta, minHeight: 60, fontSize: 11.5 },
                onChange: (ev) => setDraft({
                  ...draft, [e.i]: { ...d, source_text: ev.target.value },
                }),
              }),
            cands.length ? h("div", {
              style: { ...S.muted, fontSize: 11, marginTop: 5, lineHeight: 1.6 },
            }, "候选边：" + cands.map((c) => {
              const target = c.target_type === "batch"
                ? `本批#${Number(c.target_index) + 1}` : `#${c.target_id}`;
              return `${target} ${Number(c.score || 0).toFixed(2)}`;
            }).join(" · ")) : null);
          }),

          cur.status === "pending" ? h("div", { style: { ...S.row, marginTop: 10 } },
            h("input", {
              value: addText,
              placeholder: "手动补一条事件",
              style: { ...S.ta, minHeight: "auto", flex: 1 },
              onChange: (e) => setAddText(e.target.value),
              onKeyDown: (e) => { if (e.key === "Enter") addEvent(); },
            }),
            h("button", { style: S.btn, onClick: addEvent }, "追加"),
          ) : null,
        ) : null,
      );
    }

    // ---------- 主人 ----------
    function OwnerTab() {
      const [ids, setIds] = useState("");
      const [names, setNames] = useState("");
      const [msg, setMsg] = useState("");
      const [loading, setLoading] = useState(true);
      // 机器人自己（我的名字 / 昵称 / ID）
      const [selfIds, setSelfIds] = useState("");
      const [selfNames, setSelfNames] = useState("");
      const [selfMsg, setSelfMsg] = useState("");

      const load = useCallback(async () => {
        setLoading(true);
        try {
          const d = await api("/owner");
          setIds((d.ids || []).join(", "));
          setNames((d.names || []).join(", "));
          setMsg("");
        } catch (e) {
          setMsg("读取失败：" + e.message);
        }
        try {
          // 「我的名字」走 /settings（这条代理早就加载了）。
          // /self 是后加的，没重启 DSH 之前那条路由不存在。
          const s = await api("/settings");
          const me = s.self || {};
          setSelfIds((me.ids || []).join(", "));
          setSelfNames((me.names || []).join(", "));
          setSelfMsg("");
        } catch (e) {
          setSelfMsg("读取失败：" + e.message);
        } finally {
          setLoading(false);
        }
      }, []);

      useEffect(() => { load(); }, [load]);

      const save = async () => {
        try {
          const r = await apiPost("/owner", { ids, names });
          setMsg(`已保存：${r.ids.length} 个号、${r.names.length} 个称呼`);
        } catch (e) {
          setMsg("保存失败：" + e.message);
        }
      };

      const saveSelf = async () => {
        try {
          const r = await apiPost("/settings", { self: { ids: selfIds, names: selfNames } });
          const me = r.self || {};
          setSelfMsg(`已保存：${(me.ids || []).length} 个号、${(me.names || []).length} 个名字`);
        } catch (e) {
          setSelfMsg("保存失败：" + e.message);
        }
      };

      return h("div", { style: { ...S.page, color: C.text } },
        h("div", { style: { ...S.card, color: C.text } },
          h("b", { style: { color: C.text } }, "主人的名字 / 昵称 / ID"),
          h("div", { style: { ...S.muted, margin: "6px 0 10px" } },
            "填了这里，主人的消息在提示里会被标成【主人】，"
            + "人设里「对主人偏心」「管理员就是主人」才有依据。"
            + "改完立即生效，不用重启。"),

          h("div", { style: { ...S.muted, marginBottom: 4 } },
            "QQ 号 / ID（多个用逗号分隔）"),
          h("input", {
            value: ids,
            placeholder: "10001, 123456789",
            style: { ...S.ta, minHeight: "auto", marginBottom: 12 },
            onChange: (e) => setIds(e.target.value),
          }),

          h("div", { style: { ...S.muted, marginBottom: 4 } },
            "名字 / 昵称（群名片或昵称，多个用逗号分隔）"),
          h("input", {
            value: names,
            placeholder: "主人, 老婆, 老板",
            style: { ...S.ta, minHeight: "auto", marginBottom: 12 },
            onChange: (e) => setNames(e.target.value),
          }),

          h("div", { style: S.row },
            h("button", { style: S.btnPrimary, onClick: save }, "保存"),
            h("button", { style: S.btn, onClick: load, disabled: loading },
              "重新读取"),
            h("span", { style: { ...S.muted, flex: 1 } }, msg)),
        ),

        // 机器人自己
        h("div", { style: { ...S.card, color: C.text } },
          h("b", { style: { color: C.text } }, "我的名字 / 昵称 / ID"),
          h("div", { style: { ...S.muted, margin: "6px 0 10px" } },
            "机器人自己的号和名字。看到这些名字，就是在叫它——"
            + "即使那条消息 @ 的是别人，它也会接话；"
            + "提示里也会告诉它「这些是在叫我」。改完立即生效。"),

          h("div", { style: { ...S.muted, marginBottom: 4 } },
            "QQ 号 / ID（多个用逗号分隔）"),
          h("input", {
            value: selfIds,
            placeholder: "10001",
            style: { ...S.ta, minHeight: "auto", marginBottom: 12 },
            onChange: (e) => setSelfIds(e.target.value),
          }),

          h("div", { style: { ...S.muted, marginBottom: 4 } },
            "名字 / 昵称（别人怎么叫它，多个用逗号分隔）"),
          h("input", {
            value: selfNames,
            placeholder: "角色A, 角色B",
            style: { ...S.ta, minHeight: "auto", marginBottom: 12 },
            onChange: (e) => setSelfNames(e.target.value),
          }),

          h("div", { style: S.row },
            h("button", { style: S.btnPrimary, onClick: saveSelf }, "保存"),
            h("button", { style: S.btn, onClick: load, disabled: loading },
              "重新读取"),
            h("span", { style: { ...S.muted, flex: 1 } }, selfMsg)),
        ));
    }

    // ---------- 整备（定时切分整理） ----------
    function ConsolidateTab() {
      const [start, setStart] = useState("03:00");
      const [end, setEnd] = useState("03:30");
      const [enabled, setEnabled] = useState(true);
      const [msg, setMsg] = useState("");
      const [running, setRunning] = useState(false);
      const [result, setResult] = useState(null);

      const load = useCallback(async () => {
        try {
          const d = await api("/settings");
          const c = d.consolidate || {};
          setStart(c.start || "03:00");
          setEnd(c.end || "03:30");
          setEnabled(c.enabled !== false);
        } catch (e) {
          setMsg("读取失败：" + e.message);
        }
      }, []);

      useEffect(() => { load(); }, [load]);

      const save = async () => {
        try {
          await apiPost("/settings", {
            consolidate: { enabled, start, end },
          });
          setMsg("已保存");
        } catch (e) {
          setMsg("保存失败：" + e.message);
        }
      };

      const runNow = async () => {
        setRunning(true);
        setResult(null);
        setMsg("");
        try {
          const r = await apiPost("/consolidate", {});
          setResult(r);
          setMsg(r.skipped ? "没有需要整备的内容" : "整备完成");
        } catch (e) {
          setMsg("整备失败：" + e.message);
        } finally {
          setRunning(false);
        }
      };

      return h("div", { style: { ...S.page, color: C.text } },
        h("div", { style: { ...S.card, color: C.text } },
          h("b", { style: { color: C.text } }, "整备时间段"),
          h("div", { style: { ...S.muted, margin: "6px 0 10px" } },
            "在这个时间段内会在专用会话里提醒 TA 调用 consolidate 工具，把这段时间的聊天"
            + "切分成事件并入图。多个时间用逗号分隔，24 小时制。"),
          h("div", { style: { ...S.row, marginBottom: 10 } },
            h("label", { style: { ...S.muted, display: "flex", gap: 6,
              alignItems: "center" } },
            h("input", {
              type: "checkbox",
              checked: enabled,
              onChange: (e) => setEnabled(e.target.checked),
            }),
            "启用定时整备")),
          h("div", { style: { ...S.row, gap: 8 } },
            h("span", { style: S.muted }, "从"),
            h("input", {
              type: "time",
              value: start,
              style: { ...S.ta, minHeight: "auto", width: 120 },
              onChange: (e) => setStart(e.target.value),
            }),
            h("span", { style: S.muted }, "到"),
            h("input", {
              type: "time",
              value: end,
              style: { ...S.ta, minHeight: "auto", width: 120 },
              onChange: (e) => setEnd(e.target.value),
            }),
            h("span", { style: S.muted },
              "（起始晚于结束表示跨夜，例如 23:30 到 00:30）")),
          h("div", { style: { ...S.row, marginTop: 10 } },
            h("button", { style: S.btnPrimary, onClick: save }, "保存"),
            h("span", { style: S.muted }, msg)),
        ),
        h("div", { style: { ...S.card, color: C.text } },
          h("b", { style: { color: C.text } }, "立刻整备"),
          h("div", { style: { ...S.muted, margin: "6px 0 10px" } },
            "把还没整备的聊天立刻切分整理（结果先暂存，等你审查）。第一次跑要加载模型，可能要一两分钟。"),
          h("button", {
            style: S.btnPrimary, onClick: runNow, disabled: running,
          }, running ? "整备中…" : "立刻整备"),
          result && !result.skipped ? h("div", {
            style: { ...S.muted, marginTop: 10 },
          }, `会话 ${result.sessions} 个、消息 ${result.messages} 条 → `
            + `新增事件 ${result.new_eus} 个、关联 ${result.new_edges} 条；`
            + `现有 ${result.nodes} 节点 / ${result.edges} 边`) : null,
        ));
    }

    // ---------- 注册 ----------
    const NAMES = { nav: "Xliens" };
    const inject = ["slots", "layout"];

    function apply(ctx) {
      function PanelIcon({ size = 18 } = {}) {
        return h("div", {
          title: "Xliens",
          onClick: () => ctx.layout.selectPanel("xliens"),
          style: {
            width: size, height: size, display: "flex",
            alignItems: "center", justifyContent: "center",
            cursor: "pointer", color: "inherit",
          },
        }, h("svg", {
          width: size, height: size, viewBox: "0 0 24 24",
          fill: "none", stroke: "currentColor", strokeWidth: 1.7,
          strokeLinecap: "round", strokeLinejoin: "round",
          "aria-hidden": "true",
        },
        h("circle", { cx: 6, cy: 6, r: 2.4 }),
        h("circle", { cx: 18, cy: 7, r: 2.4 }),
        h("circle", { cx: 12, cy: 18, r: 2.4 }),
        h("path", { d: "M8.2 7.2 15.7 8.1M7.4 8.2l3.2 7.4M16.7 9.3l-3.2 6.1" })));
      }

      ctx.effect(
        () => ctx.slots.inject(
          "main",
          () => ctx.slots.register(
            { name: "main", key: "xliens" },
            XliensSection,
          ),
          "xliens: main panel",
        ),
        "xliens: main panel",
      );

      ctx.effect(
        () => ctx.slots.inject(
          "sidebar.panellist",
          () => ctx.slots.register(
            {
              name: "sidebar.panellist",
              id: "xliens",
              order: 8,
              label: () => NAMES.nav,
            },
            PanelIcon,
          ),
          "xliens: sidebar entry",
        ),
        "xliens: sidebar entry",
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.XliensSection = XliensSection;
    return module.exports;
  },
});
