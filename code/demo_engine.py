"""演示引擎：把当前完整链路包装成 GUI 可回放的 trace。

链路：
    入口筛选（BM25 + CE 重排 RRF，每块 N/K + dist>N + 兜底）
    → 每个入口章动（单跳 + 实体粗筛 + FLOOR）
    → Best > 0.10 进排序池 → TopN → 各自的 1 跳邻域 = 上下文
"""
import json
import math
import sys
from collections import deque
from pathlib import Path

sys.path.insert(0, "code")

TH_BUILD = 0.10     # 排序池 / 建边门槛
FLOOR = 0.4         # 章动迁移门槛
TOPN = 3            # Best 取前几个
CTX_TOPN = None     # 上下文邻居上限：None = 只做实体粗筛，不限数量（N 待 2.0 定）
RECALL = 20


def tokenize(text):
    toks, buf = [], []
    for ch in text:
        if ch.isalnum() and ord(ch) < 128:
            buf.append(ch)
        else:
            if buf:
                toks.append("".join(buf).lower())
                buf = []
            if "\u4e00" <= ch <= "\u9fff":
                toks.append(ch)
    if buf:
        toks.append("".join(buf).lower())
    han = [t for t in toks if len(t) == 1 and "\u4e00" <= t <= "\u9fff"]
    for i in range(len(han) - 1):
        toks.append(han[i] + han[i + 1])
    return toks


class BM25:
    def __init__(self, docs, k1=1.5, b=0.75):
        from collections import Counter
        self.k1, self.b, self.N = k1, b, len(docs)
        self.tfs, self.lens = [], []
        df = Counter()
        for d in docs:
            tf = Counter(tokenize(d))
            self.tfs.append(tf)
            self.lens.append(len(tokenize(d)))
            for t in tf:
                df[t] += 1
        self.avgdl = (sum(self.lens) / self.N) if self.N else 1
        self.idf = {t: math.log(1 + (self.N - f + 0.5) / (f + 0.5))
                    for t, f in df.items()}
        self.inv = {}
        for i, tf in enumerate(self.tfs):
            for t, f in tf.items():
                self.inv.setdefault(t, []).append((i, f))

    def search(self, query, topk=20):
        scores = {}
        for t in set(tokenize(query)):
            if t not in self.inv:
                continue
            idf = self.idf[t]
            for doc_id, f in self.inv[t]:
                dl = self.lens[doc_id] or 1
                den = f + self.k1 * (1 - self.b + self.b * dl / (self.avgdl or 1))
                scores[doc_id] = scores.get(doc_id, 0.0) + idf * f * (self.k1 + 1) / den
        return sorted(scores.items(), key=lambda x: -x[1])[:topk]


class DemoEngine:
    """完整链路的演示封装。"""

    def __init__(self, graph_dir="graph_main", model_path="models/reg_v48_s3"):
        from transformers import (AutoModelForSequenceClassification,
                                  AutoTokenizer)
        import torch
        from ce_train import build_pair_text

        self.torch = torch
        self.build_pair_text = build_pair_text
        self.graph_dir = Path(graph_dir)

        # 数据
        self.eus = {}
        for line in (self.graph_dir / "eus.jsonl").read_text(
                encoding="utf-8").splitlines():
            if line.strip():
                r = json.loads(line)
                self.eus[r["id"]] = r
        self.edges = [json.loads(l) for l in
                      (self.graph_dir / "edges.jsonl").read_text(
                          encoding="utf-8").splitlines() if l.strip()]

        # 邻接表：all_adj 保留所有已存边（建边扫描用），adj 只放显形边（召回游走用）
        self.edge_score = {}
        self.all_adj = {i: set() for i in self.eus}
        self.edge_min = TH_BUILD
        for e in self.edges:
            a, b = e["a"], e["b"]
            if a in self.all_adj and b in self.all_adj:
                self.all_adj[a].add(b)
                self.all_adj[b].add(a)
            self.edge_score[(min(a, b), max(a, b))] = e["score"]
        self.set_edge_min(self.edge_min)

        # 模型
        self.dev = "cuda" if torch.cuda.is_available() else "cpu"
        self.tok = AutoTokenizer.from_pretrained(model_path)
        self.model = AutoModelForSequenceClassification.from_pretrained(
            model_path).to(self.dev).eval()
        if self.dev == "cuda":
            self.model = self.model.half()

        self.model_path = model_path

        # BM25（节点级：整段 desc + 上下文）
        self.bm25 = BM25([self.text_of(i) for i in sorted(self.eus)])
        self.bm25_ids = sorted(self.eus)

        # BM25（行级：每一行单独一个文档，指回所属节点）
        # 为什么要多这一层：一句话埋在 5 行上下文里时，整段当文档会稀释关键词，
        # 词频拼不过别的节点，候选池就捞不到它（实测节点 16 就是这样漏的）。
        self.line_docs = []
        self.line_owner = []
        for i in sorted(self.eus):
            for ln in (self.eus[i].get("source_text") or "").split("\n"):
                ln = ln.strip()
                if len(ln) >= 4:
                    self.line_docs.append(ln)
                    self.line_owner.append(i)
        self.line_bm25 = BM25(self.line_docs) if self.line_docs else None

    def set_edge_min(self, value):
        """只重建游走邻接表；edges 本身不删除，调低阈值即可显形。"""
        try:
            v = float(value)
        except Exception:
            v = TH_BUILD
        self.edge_min = max(0.0, min(1.0, v))
        self.adj = {i: set() for i in self.eus}
        for e in self.edges:
            if float(e.get("score") or 0.0) < self.edge_min:
                continue
            a, b = e["a"], e["b"]
            if a in self.adj and b in self.adj:
                self.adj[a].add(b)
                self.adj[b].add(a)

    def scan_build(self, new_event, bests, build_min, max_hops=8):
        """从章动 best 出发，按建边阈值逐跳扫描，返回应建边的节点分数。

        - best 自身分数低于阈值：放弃该 best
        - 只沿已存边分数 >= build_min 的路径继续
        - 新 EU 与节点分数 < build_min：该分支停止
        - 不限制每节点边数，也不做实体粗筛
        """
        q = self.ev(new_event)
        found = {}
        for item in bests or []:
            try:
                s_best, best = float(item[0]), int(item[1])
            except Exception:
                continue
            if s_best < build_min or best not in self.eus:
                continue
            if s_best > found.get(best, -1):
                found[best] = s_best
            seen = {best}
            dq = deque([(best, 0)])
            while dq:
                u, depth = dq.popleft()
                if depth >= max_hops:
                    continue
                for v in self.all_adj.get(u, ()):
                    if v in seen:
                        continue
                    seen.add(v)
                    edge_s = float(self.edge_score.get(
                        (min(u, v), max(u, v)), 0.0))
                    if edge_s < build_min:
                        continue
                    score = float(self._ce(q, [v])[0])
                    if score < build_min:
                        continue
                    if score > found.get(v, -1):
                        found[v] = score
                    dq.append((v, depth + 1))
        return found

    # ---------- 工具 ----------
    def text_of(self, i):
        r = self.eus[i]
        return r["event_desc"] + " " + (r.get("source_text") or "")

    def ev(self, raw):
        return {"event_desc": raw["event_desc"], "subject": raw.get("subject"),
                "object": raw.get("object"),
                "keywords": raw.get("keywords") or []}

    def ents(self, raw):
        s = set()
        for k in ("subject", "object"):
            if raw.get(k):
                s.add(raw[k])
        for k in raw.get("keywords") or []:
            if k:
                s.add(k)
        return s

    # ---- 远端 CE 状态（优先 3080Ti，不通快速回退本地）----
    _ce_remote_url = None
    _ce_fails = 0
    _ce_skip_until = 0.0
    _ce_last_mode = "local"

    def _remote_url(self):
        import os as _os
        if self._ce_remote_url is None:
            self._ce_remote_url = _os.environ.get("CE_REMOTE_URL", "").rstrip("/")
        return self._ce_remote_url

    def _ce_remote(self, texts):
        """走 3080Ti 打分。失败返回 None，由调用方退回本地。

        超时 3 秒：本地一批也就 1~2 秒，等久了反而拖慢召回。
        连续失败 2 次熔断 60 秒，期间不白等。
        """
        import json as _json
        import time as _t
        import urllib.request as _u
        base = self._remote_url()
        if not base:
            self._ce_last_mode = "local"
            return None
        if _t.time() < self._ce_skip_until:
            self._ce_last_mode = "local(熔断)"
            return None
        try:
            req = _u.Request(base + "/score",
                             data=_json.dumps({"texts": texts}).encode(),
                             headers={"Content-Type": "application/json"},
                             method="POST")
            opener = _u.build_opener(_u.ProxyHandler({}))
            with opener.open(req, timeout=3) as r:
                scores = _json.loads(r.read()).get("scores")
            if scores is None:
                raise ValueError("no scores")
            self._ce_fails = 0
            self._ce_last_mode = "remote"
            return scores
        except Exception:
            self._ce_fails += 1
            if self._ce_fails >= 2:
                # 熔断 60 秒，避免每批都白等 3 秒
                self._ce_skip_until = _t.time() + 60
                self._ce_fails = 0
                print("[warn] 远端 CE 不通，60 秒内走本地", flush=True)
            self._ce_last_mode = "local(远端失败)"
            return None

    def _score_texts(self, texts):
        if not texts:
            return []
        # 有远端就走远端（快两个数量级），失败自动退回本地
        if getattr(self, "use_remote_ce", True):
            _s = self._ce_remote(texts)
            if _s is not None and len(_s) == len(texts):
                return _s
        enc = self.tok(texts, truncation=True, max_length=64, padding=True,
                       return_tensors="pt").to(self.dev)
        with self.torch.no_grad():
            out = self.torch.sigmoid(self.model(**enc).logits.squeeze(-1))
        if out.dim() == 0:
            out = out.unsqueeze(0)
        return out.tolist()

    def _ce(self, q, nodes):
        if not nodes:
            return []
        texts = [self.build_pair_text(q, self.ev(self.eus[n]), True, False,
                                      "desc") for n in nodes]
        return self._score_texts(texts)

    def score_events(self, q, events):
        """给任意 EU 记录打分（不要求已经在图里），用于整备阶段预打分。"""
        if not events:
            return []
        texts = [self.build_pair_text(q, e, True, False, "desc")
                 for e in events]
        return self._score_texts(texts)

    # ---------- 混合打分（排序用，置信度仍报 CE）----------
    W_CE = 0.72
    W_LEX = 0.28

    def lex_norm(self, qtext):
        """BM25 分数归一化到 0~1，按 id 返回。"""
        if getattr(self, "_lex_cache_q", None) == qtext:
            return self._lex_cache
        hits = self.bm25.search(qtext, topk=min(len(self.eus), 200))
        if not hits:
            self._lex_cache_q, self._lex_cache = qtext, {}
            return {}
        # bm25.search 返回的是 (节点id, 分数)，别解包反了
        top = max(sc for _, sc in hits) or 1.0
        d = {nid: (sc / top) for nid, sc in hits}
        self._lex_cache_q, self._lex_cache = qtext, d
        return d

    def _rank_scores(self, q, ids, qtext):
        """排序分：语义 + 词面。返回与 ids 等长的列表。"""
        ce = self._ce(q, ids)
        lex = self.lex_norm(qtext) if qtext else {}
        out = []
        for nid, s in zip(ids, ce):
            out.append(self.W_CE * float(s) + self.W_LEX * lex.get(nid, 0.0))
        return out

    def components(self):
        seen, comps = set(), []
        for i in sorted(self.eus):
            if i in seen:
                continue
            q, blk = deque([i]), []
            seen.add(i)
            while q:
                u = q.popleft()
                blk.append(u)
                for v in self.adj[u]:
                    if v not in seen:
                        seen.add(v)
                        q.append(v)
            comps.append(sorted(blk))
        return comps

    def dist(self, a, b):
        if a == b:
            return 0
        seen = {a: 0}
        q = deque([a])
        while q:
            u = q.popleft()
            for v in self.adj[u]:
                if v not in seen:
                    seen[v] = seen[u] + 1
                    if v == b:
                        return seen[v]
                    q.append(v)
        return math.inf

    @staticmethod
    def comp_nk(v, e):
        deg = (2 * e / v) if v else 0
        k = min(v, max(3, min(10, math.ceil(math.log2(max(v, 1) / 10)))))
        if v <= 1:
            n = 0
        elif deg <= 1:
            n = 1
        else:
            n = max(1, math.ceil(math.log(max(v / k, 1.0001)) / math.log(deg))) \
                if deg > 1 else 1
        return n, k

    @staticmethod
    def global_k(V):
        return max(3, min(10, math.ceil(math.log2(max(V, 1) / 10))))

    # ---------- 入口筛选 ----------
    def select_entries(self, q, qtext):
        comps = self.components()
        entries = {}
        detail = []
        for ci, blk in enumerate(comps):
            v = len(blk)
            e_in = sum(1 for x in blk for y in self.adj[x] if y in blk and x < y)
            n_c, k_c = self.comp_nk(v, e_in)
            # 行级命中和节点级命中**交替合并**。
            # 之前写成"行级全部排前面 + 上限 40"，结果 60 条行级命中把候选池塞满，
            # 节点级 BM25 的第 0 名反而被截掉（实测某些题 BM25 前列仍可能落选）。
            line_ids = []
            if self.line_bm25 is not None:
                for d, _ in self.line_bm25.search(qtext, topk=RECALL * 3):
                    if d < len(self.line_owner):
                        line_ids.append(self.line_owner[d])
            node_ids = [d for d, _ in self.bm25.search(qtext, topk=RECALL * 2)]
            raw = []
            for k in range(max(len(line_ids), len(node_ids))):
                if k < len(node_ids):
                    raw.append(node_ids[k])
                if k < len(line_ids):
                    raw.append(line_ids[k])
            seen = set()
            recall = []
            for d in raw:
                if d in blk and d not in seen:
                    seen.add(d)
                    recall.append(d)
            recall = recall[:RECALL * 3]
            if recall:
                ce_s = self._ce(q, recall)
                r_bm = {d: r for r, d in enumerate(recall)}
                order_ce = [d for _, d in sorted(zip(ce_s, recall), reverse=True)]
                r_ce = {d: r for r, d in enumerate(order_ce)}
                fused = sorted(((1 / (60 + r_bm[d]) + 1 / (60 + r_ce[d]), d)
                                for d in recall), reverse=True)
                # 先把 CE 最高的 2 个无条件放进来：
                # 分散规则是为了覆盖不同话题，不能把「最相关」本身挤掉
                # （实测 86 号 CE 0.844 被跳过，而 CE 0.162 的进了入口）。
                # 强制保留"融合排名"前 2（语义 + 词面一起看）。
                # 之前只保 CE 前 2，导致词面第 0 名、但语义分不高的节点进不了入口
                # （实测有题目 BM25 排名靠前，但 CE 分数偏低被挡在外面）。
                fused_order = [d for _, d in fused]
                picked = []
                for d in fused_order[:2]:
                    if d not in picked:
                        picked.append(d)
                target = max(k_c, len(picked))
                for _, d in fused:
                    if d in picked:
                        continue
                    if all(self.dist(p, d) > n_c for p in picked):
                        picked.append(d)
                    if len(picked) >= target:
                        break
                entries[ci] = picked
            else:
                entries[ci] = []
            detail.append((ci, v, n_c, k_c, len(recall), entries[ci]))

        K = self.global_k(len(self.eus))
        total = sum(len(v) for v in entries.values())
        empty = [ci for ci, v in entries.items() if not v]
        fallback = total < K and bool(empty)
        if fallback:
            for ci in empty:
                blk = comps[ci]
                v = len(blk)
                e_in = sum(1 for x in blk for y in self.adj[x] if y in blk and x < y)
                n_c, k_c = self.comp_nk(v, e_in)
                order = sorted(blk, key=lambda x: -len(self.adj[x]))
                picked = []
                for d in order:
                    if all(self.dist(p, d) > n_c for p in picked):
                        picked.append(d)
                    if len(picked) >= k_c:
                        break
                entries[ci] = picked

        flat = [n for v in entries.values() for n in v]
        return flat, detail, {"K": K, "total": total, "fallback": fallback,
                              "empty": empty}

    # ---------- 章动 + 完整 trace ----------
    def run(self, new_event, entries=None):
        q = self.ev(new_event)
        qent = self.ents(new_event)
        qtext = new_event["event_desc"] + " " + (new_event.get("source_text") or "")
        trace = []

        if entries:
            entry_list = list(entries)
            trace.append({"kind": "entry", "node": entry_list[0],
                          "text": f"手工指定入口 {entry_list}"})
        else:
            entry_list, detail, info = self.select_entries(q, qtext)
            trace.append({"kind": "filter", "dropped": [],
                          "text": f"入口筛选：全局 K={info['K']}，"
                                  f"各块入口共 {info['total']} 个，"
                                  f"兜底={'是' if info['fallback'] else '否'}"})
            for ci, v, n_c, k_c, n_rec, picked in detail:
                trace.append({"kind": "filter", "dropped": [],
                              "text": f"  块{ci}：{v} 节点，N={n_c} K={k_c}，"
                                      f"召回 {n_rec} → 入口 {picked}"})
            if entry_list:
                trace.append({"kind": "entry", "node": entry_list[0],
                              "text": f"共 {len(entry_list)} 个入口: {entry_list}"})

        bests = []
        for e in entry_list:
            focus = e
            s_focus = self._ce(q, [focus])[0]
            visited = {focus}
            path = [(focus, s_focus)]
            trace.append({"kind": "entry", "node": focus,
                          "text": f"从入口 [{focus}] 开始，"
                                  f"CE={s_focus:.3f}  {self.eus[focus]['event_desc']}"})
            for _ in range(8):
                nbrs = sorted(self.adj[focus] - visited)
                if not nbrs:
                    trace.append({"kind": "stop", "text": "没有未访问的邻居，停下"})
                    break
                passed = [n for n in nbrs if self.ents(self.eus[n]) & qent]
                dropped = [n for n in nbrs if n not in passed]
                if dropped:
                    trace.append({"kind": "filter", "dropped": dropped,
                                  "text": f"   实体粗筛：{len(dropped)} 个邻居无共同实体，"
                                          f"排除 {dropped}"})
                if not passed:
                    trace.append({"kind": "stop", "text": "   粗筛后无候选，停下"})
                    break
                scores = self._ce(q, passed)
                cand = sorted(zip(scores, passed), reverse=True)
                trace.append({"kind": "score", "node": focus, "candidates": cand,
                              "text": f"   给 {len(passed)} 个邻居打分"})
                s_best, n_best = cand[0]
                if s_best > s_focus and s_best >= FLOOR:
                    trace.append({"kind": "move", "from": focus, "to": n_best,
                                  "text": f"   迁移到 [{n_best}] "
                                          f"{s_best:.3f} > {s_focus:.3f}"
                                          f"  {self.eus[n_best]['event_desc']}"})
                    focus, s_focus = n_best, s_best
                    visited.add(focus)
                    path.append((focus, s_focus))
                else:
                    trace.append({"kind": "stop",
                                  "text": f"   最高 {s_best:.3f} 不高于当前 "
                                          f"{s_focus:.3f}（或低于 {FLOOR}），停在 [{focus}]"})
                    break
            bests.append((s_focus, focus, path))
            trace.append({"kind": "entry_end",
                          "text": f"该入口的 Best = [{focus}] {s_focus:.3f}"})

        # ---- 最终选中心：CE 排名 + 词面排名做 RRF ----
        # 纯 CE 会被"句式相似"骗（「质疑表述」压过「具体事实」），
        # RRF 只看排名，对词面证据更敏感。
        lex_rank = {}
        if bests:
            lex = self.lex_norm(qtext) if qtext else {}
            ordered = sorted(lex.items(), key=lambda x: -x[1])
            lex_rank = {nid: r for r, (nid, _) in enumerate(ordered)}
        ce_sorted = sorted(bests, key=lambda x: -x[0])
        ce_rank = {f: r for r, (_, f, _) in enumerate(ce_sorted)}
        K_RRF = 12

        def rrf(f):
            return (1.0 / (K_RRF + ce_rank.get(f, 999))
                    + 1.0 / (K_RRF + lex_rank.get(f, 999)))

        bests = sorted(bests, key=lambda x: -rrf(x[1]))
        trace.append({"kind": "rerank",
                      "text": "中心重排（RRF）：" + "，".join(
                          f"[{f}] ce_rank={ce_rank.get(f)} lex_rank={lex_rank.get(f)}"
                          for _, f, _ in bests[:4])})

        # 阈值过滤 + TopN（Best 层）
        # 注意：这里不能再按 s 排序，否则会把上面的 RRF 顺序冲掉
        pool = [(s, f, p) for s, f, p in bests if s > self.edge_min]
        chosen = pool[:TOPN]
        trace.append({"kind": "filter", "dropped": [],
                      "text": f"阈值过滤：{len(pool)} 个 Best > {self.edge_min}，"
                              f"取 Top{TOPN}"})

        # ---- 上下文组装：1 跳邻域 → 实体粗筛 → 打分排序 → TopN ----
        ctx = set()
        if chosen:
            best_nodes = {f for _, f, _ in chosen}
            nbrs = set()
            for _, f, _ in chosen:
                nbrs |= self.adj[f]
            nbrs -= best_nodes

            # 实体粗筛：与新 EU 有共同实体（新 EU 没实体时跳过，无法筛）
            if qent:
                passed = sorted(n for n in nbrs
                                if self.ents(self.eus[n]) & qent)
            else:
                passed = sorted(nbrs)
            dropped = sorted(n for n in nbrs if n not in set(passed))
            if dropped:
                trace.append({"kind": "filter", "dropped": dropped,
                              "text": f"上下文粗筛：{len(dropped)} 个邻居无共同实体，"
                                      f"排除 {dropped}"})
            elif not qent:
                trace.append({"kind": "filter", "dropped": [],
                              "text": "新事件没有实体信息，跳过实体粗筛"})

            # 按 CE 分数排序（只用于排序展示；数量上限 N 待 2.0 定，现在不截断）
            if passed:
                scores = self._ce(q, passed)
                ranked = sorted(zip(scores, passed), reverse=True)
                take = ranked if CTX_TOPN is None else ranked[:CTX_TOPN]
                cap = "不设上限（N 待 2.0）" if CTX_TOPN is None \
                    else f"Top{CTX_TOPN}"
                trace.append({"kind": "filter", "dropped": [],
                              "text": f"上下文候选 {len(ranked)} 个（{cap}）："
                                      + ", ".join(f"[{n}]{s:.2f}"
                                                  for s, n in take[:10])
                                      + (" …" if len(take) > 10 else "")})
                ctx = best_nodes | {n for _, n in take}
            else:
                trace.append({"kind": "filter", "dropped": [],
                              "text": "粗筛后没有邻居，上下文只有 Best 本身"})
                ctx = best_nodes

            s, f, path = chosen[0]
            trace.append({"kind": "best", "node": f, "neighbors": sorted(ctx),
                          "path": path})
        else:
            trace.append({"kind": "stop",
                          "text": "所有 Best 都 ≤ 阈值 → 上下文为空，作为孤立节点存入"})

        return {
            "trace": trace,
            "entries": entry_list,
            "bests": [(s, f) for s, f, _ in bests],
            "chosen": [(s, f) for s, f, _ in chosen],
            "context": sorted(ctx),
        }
