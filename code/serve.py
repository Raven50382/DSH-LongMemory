"""常驻记忆服务：双召回接口。

    GET  /health
    POST /recall_semantic   {text, session, limit}
    POST /recall_logic      {text, session, hops, max_neighbors}
    POST /segmet            {text}  （调试：只看切分结果）

设计依据：
    docs/机器人集成_设计.md
    docs/双召回工具_规格.md

启动：
    python code/serve.py --port 8317 --graph graph_demo
"""
import argparse
import json
from alias import CANON  # 主客体只认对话参与者
import os
import math
import re
import sys
import threading
import time
import traceback
from collections import deque
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
sys.stdout.reconfigure(encoding="utf-8")

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_DATA_ROOT = Path(os.environ.get("XLIENS_DATA_ROOT", _PROJECT_ROOT)).resolve()


def ensure_graph_dir(graph_dir):
    g = Path(graph_dir)
    g.mkdir(parents=True, exist_ok=True)
    for name in ("eus.jsonl", "edges.jsonl"):
        f = g / name
        if not f.exists():
            f.write_text("", encoding="utf-8")
    return g

# ---------------- 可调参数（写进文档的决策） ----------------
CE_MIN = 0.40          # 逻辑召回的最低 CE 分数
SEM_MIN = 0.30         # 轻量召回的最低类型相似度（偏低是刻意的：召回优先）
BM25_PREFILTER = 60    # BM25 预筛数量，再用 CE 精排
DECAY_FLOOR = 0.70     # 时间衰减的下限权重（最老的也有 0.7）
DECAY_HALF_DAYS = 180  # 时间衰减半衰期
DEFAULT_LIMIT = 10
DEFAULT_HOPS = 1
DEFAULT_MAX_NEIGHBORS = 7
EDGE_VISIBLE_DEFAULT = 0.10   # 边显形阈值：只影响显示和游走，不删除边
RECALL_DEFAULT = 0.30         # 机器人召回结果最低分
BUILD_DEFAULT = 0.10          # 新 EU 的真实建边阈值
SEG_PROVIDER_DEFAULT = "glm"
SEG_MODEL_DEFAULT = "glm-5.3-flash"
SEG_TIMEOUT = 6.0      # 单次 HTTP 读超时（秒）
SEG_DEADLINE = 7.0     # 切分总时长硬截止（秒）：超了就跳过召回


TARGET_CTX = 6      # 上下文目标行数
MAX_CTX = 10        # 上下文上限

def pick_window(eu_desc, keywords, plain_lines, a, b, used, target, mx, persons):
    """给一个 EU 选上下文窗口。

    模型偶尔对同一块里的多个 EU 给出相同区间（都写 〔31-35〕），
    直接照抄会让后几个 EU 配到别人的上下文。这里做两件事：
      1) 区间已被人用过 -> 按这个 EU 自己的描述词在这块里重新找位置
      2) 描述词也找不到 -> 顺序往后挪，保证不与别人重复
    """
    import re as _re

    n = len(plain_lines)
    a = max(1, min(a, n))
    b = max(a, min(b, n))

    def expand(x, y):
        while y - x + 1 < 3:   # 只保证下限，不再硬凑长度
            if y < n:
                y += 1
            elif x > 1:
                x -= 1
            else:
                break
        if y - x + 1 > mx:
            y = x + mx - 1
        return max(1, x), min(y, n)

    key = (a, b)
    if key not in used:
        used.add(key)
        x, y = expand(a, b)
        return plain_lines[x - 1:y]

    # 撞车了：用描述词重新定位
    skip = {"主体", "客体", "的", "了", "着", "在", "和", "与", "对", "把", "被", "给"}
    toks = set()
    for k in (keywords or []):
        k = str(k).strip()
        if len(k) >= 2 and k not in set(persons or []):
            toks.add(k)
    for part in _re.split(r"\s+", _re.sub(
            r"主体|客体|的|了|着|在|和|与|对|把|被|给", " ", eu_desc or "")):
        part = part.strip()
        if len(part) >= 2 and part not in skip and part not in set(persons or []):
            toks.add(part)

    best, best_s = None, -1
    for i in range(n):
        s = sum(1 for t in toks if t in plain_lines[i])
        if s > best_s:
            best_s, best = s, i
    if best is not None and best_s > 0:
        cand = expand(best + 1, best + 1)
        used.add((best + 1, best + 1))
        return plain_lines[cand[0] - 1:cand[1]]

    # 还是不行就往后挪
    shift = 0
    while key in used and shift < n:
        shift += 1
        key = (a + shift, b + shift)
    used.add(key)
    x, y = expand(key[0], key[1])
    return plain_lines[x - 1:y]



def parse_time(s):
    """解析 EU 的 time 字段。支持 '2026-10-30 01:23' 等常见格式。"""
    if not s:
        return None
    s = str(s).strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d",
                "%Y/%m/%d %H:%M:%S", "%Y/%m/%d %H:%M", "%Y/%m/%d"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def time_decay(dt, now=None):
    """温和衰减：越老权重越低，但不会低于 DECAY_FLOOR。"""
    if dt is None:
        return DECAY_FLOOR
    now = now or datetime.now()
    days = max(0.0, (now - dt).total_seconds() / 86400.0)
    return DECAY_FLOOR + (1 - DECAY_FLOOR) * (0.5 ** (days / DECAY_HALF_DAYS))


def slice_context(text, idx, total, min_lines=3, max_lines=10):
    """把一段原文按顺序切成 total 份，取第 idx 份。

    同一块切出来的多个 EU 共用一个 source_text 是之前的问题：
    每个 EU 都存整块（平均 54 条消息），既占空间又没区分度。
    按顺序均分后每个 EU 拿到自己的 3~10 句。
    """
    lines = [l for l in (text or "").split("\n") if l.strip()]
    if not lines:
        return ""
    if total <= 1:
        return "\n".join(lines[:max_lines])
    n = len(lines)
    per = max(min_lines, min(max_lines, n // total or min_lines))
    start = int(idx * n / total)
    end = min(n, start + per)
    if idx == total - 1:
        end = min(n, max(start + min_lines, start + per))
    seg = lines[start:end]
    if len(seg) < min_lines:
        seg = lines[max(0, end - min_lines):end]
    return "\n".join(seg)


def clip_context(text, max_chars=300):
    """把 source_text 截到 max_chars 字，按整行断，避免截半句。"""
    s = (text or "").strip()
    if not s or len(s) <= max_chars:
        return s
    out = []
    used = 0
    for ln in s.split("\n"):
        if used + len(ln) + 1 > max_chars and out:
            break
        out.append(ln)
        used += len(ln) + 1
    return "\n".join(out) if out else s[:max_chars]


def bigrams(s):
    """字符 bigram 集合，用于算「同类事件」的相似度。"""
    s = "".join(str(s or "").split())
    if len(s) < 2:
        return {s} if s else set()
    return {s[i:i + 2] for i in range(len(s) - 1)}



def topic_contain(query, desc):
    """查询的核心词有多少被节点描述包含（0~1）。

    为什么要这个：CE 是语义模型，会被"句式相似"骗——
      「主体认为某个配置不合适」-> 节点A：质疑表述 0.972
      「主体认为某个配置不合适」-> 节点B：指出具体配置 0.421
    但字面命中率正好相反：节点B 是 0.60，节点A 是 0.00。
    所以字面命中率高时直接采信它（只对"主题逐字对应"的情况生效）。
    """
    def grams(s):
        s = "".join(c for c in str(s or "")
                    if c.isalnum() or "\u4e00" <= c <= "\u9fff")
        s = s.replace("主体", "").replace("客体", "")
        return {s[i:i + 2] for i in range(len(s) - 1)}
    bq = grams(query)
    if len(bq) < 3:
        return 0.0
    return len(bq & grams(desc)) / len(bq)


def type_similarity(a, b):
    """两个事件描述的「类型相似度」（0~1）。

    注意：这里刻意不用 CE 分数。
    CE 度量的是「逻辑关联度」——它会给「登录账号 ↔ 未登录状态」打 1.0，
    却给两个完全相同的描述打 0.22（训练集里没有自己对自己的样本）。
    而列表类查询要的是「是不是同一类事」，所以用字面类型相似度更准。
    """
    A, B = bigrams(a), bigrams(b)
    if not A or not B:
        return 0.0
    if A == B:
        return 1.0
    inter = len(A & B)
    return inter / max(len(A), len(B))


class MemoryService:
    def __init__(self, graph_dir, model_path, segments=True):
        from demo_engine import DemoEngine
        self.graph_dir = ensure_graph_dir(graph_dir)
        self.model_path = model_path
        self.engine = DemoEngine(graph_dir=self.graph_dir, model_path=model_path)
        self.segments = segments
        self.lock = threading.Lock()
        self.calls = 0
        self.traces = []
        self._reload_meta()
        self.apply_thresholds()

    def _reload_meta(self):
        p = Path(self.graph_dir) / "meta.json"
        self.meta = {}
        if p.exists():
            try:
                self.meta = json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                pass

    def read_thresholds(self):
        d = self.read_settings().get("thresholds")
        d = d if isinstance(d, dict) else {}

        def val(key, default):
            try:
                x = float(d.get(key, default))
            except Exception:
                x = default
            return max(0.0, min(1.0, x))

        return {
            "edgeVisible": val("edgeVisible", EDGE_VISIBLE_DEFAULT),
            "recall": val("recall", RECALL_DEFAULT),
            "build": val("build", BUILD_DEFAULT),
        }

    def apply_thresholds(self):
        t = self.read_thresholds()
        self.engine.set_edge_min(t["edgeVisible"])
        return t

    def set_thresholds(self, body):
        cur = self.read_thresholds()

        def val(key, default):
            if key not in body:
                return default
            try:
                x = float(body[key])
            except Exception:
                raise ValueError(f"{key} 必须是 0~1 的数字")
            if not (0.0 <= x <= 1.0):
                raise ValueError(f"{key} 必须在 0~1 之间")
            return x

        out = {
            "edgeVisible": val("edgeVisible", cur["edgeVisible"]),
            "recall": val("recall", cur["recall"]),
            "build": val("build", cur.get("build", BUILD_DEFAULT)),
        }
        self.write_settings({"thresholds": out})
        with self.lock:
            self.engine.set_edge_min(out["edgeVisible"])
        return {"ok": True, **out}

    def seg_kwargs(self):
        cur = self.read_seg().get("current") or {}
        return {
            "backend": "openai",
            "provider": cur.get("provider") or SEG_PROVIDER_DEFAULT,
            "model": cur.get("model") or SEG_MODEL_DEFAULT,
        }

    def read_seg(self):
        import segment_api
        d = self.read_settings().get("seg")
        d = d if isinstance(d, dict) else {}
        provider = str(d.get("provider") or SEG_PROVIDER_DEFAULT)
        model = str(d.get("model") or SEG_MODEL_DEFAULT)
        current = {"provider": provider, "model": model}
        try:
            info = segment_api.api_provider_info(provider)
            current.update({
                "label": info["label"],
                "keyRef": info["keyRef"],
                "ready": info["ready"],
            })
        except Exception as ex:
            current.update({"label": provider, "keyRef": "", "ready": False,
                            "error": str(ex)})
        return {
            "ok": True,
            "current": current,
            "providers": segment_api.api_providers(),
        }

    def set_seg(self, body):
        import segment_api
        provider = str((body or {}).get("provider") or "").strip()
        model = str((body or {}).get("model") or "").strip()
        try:
            info = segment_api.api_provider_info(provider)
        except Exception as ex:
            raise ValueError(str(ex))
        if not info["ready"]:
            raise ValueError(f"{info['label']} 还没有可用的 Key")
        if not model:
            raise ValueError("切分模型不能为空")
        self.write_settings({"seg": {"provider": provider, "model": model}})
        return {
            "ok": True,
            "current": {
                "provider": provider, "model": model,
                "label": info["label"], "keyRef": info["keyRef"],
                "ready": info["ready"],
            },
            "providers": segment_api.api_providers(),
        }

    # ---------- scope ----------
    def visible_nodes(self, session):
        """按会话算可见节点集合。

        规则（docs/机器人集成_设计.md 第五章）：
            所有 person:* 的节点全局可见
            group:* 只在该群可见
            没有 scope 字段的节点视为全局（向后兼容）
        """
        eus = self.engine.eus
        if not session:
            return set(eus)
        vis = set()
        for i, e in eus.items():
            sc = e.get("scope")
            if not sc:
                vis.add(i)
                continue
            for s in sc:
                s = str(s)
                if s.startswith("person:"):
                    vis.add(i)
                    break
                if s == session:
                    vis.add(i)
                    break
        return vis

    # ---------- 切分 ----------
    def segment(self, text):
        """调 MiMo 切分，返回 EU 列表。失败或超时返回 []。

        用线程做**硬截止**：urlopen 的 timeout 只管单次 socket 读，
        服务端慢慢吐字时总时长仍可能远超预算（实测见过 11 秒）。
        超过 SEG_DEADLINE 就放弃这次召回，绝不让聊天卡住。
        """
        if not self.segments:
            return []
        box = {}

        def work():
            try:
                import segment_api
                from alias import canonical_speakers
                raw, names = canonical_speakers(text)
                ppl = "、".join(names[:3]) or "（未知）"
                box["v"] = segment_api.segment_multi(
                    raw, ppl, timeout=SEG_TIMEOUT, **self.seg_kwargs())
            except Exception as ex:      # noqa: BLE001
                box["e"] = ex

        th = threading.Thread(target=work, daemon=True)
        th.start()
        th.join(SEG_DEADLINE)
        if th.is_alive():
            print(f"[warn] 切分超时（>{SEG_DEADLINE}s），本次跳过召回", flush=True)
            return []
        if "e" in box:
            print(f"[warn] 切分失败：{box['e']}", flush=True)
            return []
        return box.get("v") or []

    @staticmethod
    def _eu_event(eu):
        """把切分结果转成 DemoEngine 认识的 event 结构。"""
        return {
            "event_desc": eu.get("desc", ""),
            "subject": None,
            "object": None,
            "keywords": eu.get("ents") or [],
        }

    # ---------- 轻量召回 ----------
    def _eus_from_param(self, eu):
        """把调用方给的 EU（字符串或 {desc,ents}）整理成内部格式。"""
        if not eu:
            return []
        items = eu if isinstance(eu, list) else [eu]
        out = []
        for it in items:
            if isinstance(it, str):
                d = it.strip()
                if d:
                    out.append({"ents": [], "desc": d})
            elif isinstance(it, dict):
                d = str(it.get("desc") or it.get("event_desc") or "").strip()
                if d:
                    out.append({"ents": [str(x) for x in (it.get("ents") or [])],
                                "desc": d})
        return out

    @staticmethod
    def _fallback_eus(text):
        """切分服务超时/挂掉时的兜底：把原文当成一个 EU，至少让召回能跑。
        精度不如 MiMo，但比直接返回「没有识别出事件」更有用。
        """
        s = " ".join(str(text or "").split())
        if not s:
            return []
        return [{"ents": [], "desc": s[:120]}]

    def recall_semantic(self, text, session=None, limit=DEFAULT_LIMIT,
                        eu=None, for_bot=False):
        t0 = time.perf_counter()
        # 调用方（模型）自己给了 EU 就直接用，省掉一次切分 API 调用
        eus = self._eus_from_param(eu)
        if not eus:
            eus = self.segment(text)
        if not eus:
            eus = self._fallback_eus(text)
        t_seg = (time.perf_counter() - t0) * 1000
        if not eus:
            return {"summary": "没有识别出可检索的事件。", "events": [],
                    "mode": "semantic",
                    "ms": round((time.perf_counter() - t0) * 1000),
                    "ms_seg": round(t_seg), "eus": []}

        vis = self.visible_nodes(session)
        if not vis:
            return {"summary": "当前会话没有可见记忆。", "events": [],
                    "mode": "semantic",
                    "ms": round((time.perf_counter() - t0) * 1000), "eus": eus}

        now = datetime.now()
        best = {}          # node_id -> 最高分
        with self.lock:
            self.calls += 1
            for eu in eus:
                q = self.engine.ev(self._eu_event(eu))
                qtext = eu.get("desc", "")

                # BM25 预筛（在可见集合内）
                cand = []
                try:
                    hits = self.engine.bm25.search(qtext, topk=BM25_PREFILTER * 2)
                    cand = [self.engine.bm25_ids[h[0]] for h in hits
                            if self.engine.bm25_ids[h[1]] in vis]
                except Exception:
                    cand = []
                if not cand:
                    cand = sorted(vis)[:BM25_PREFILTER]
                cand = cand[:BM25_PREFILTER]

                # 类型相似度精排（不用 CE，理由见 type_similarity 文档串）
                for n in cand:
                    s = type_similarity(qtext, self.engine.eus[n].get("event_desc"))
                    dt = parse_time(self.engine.eus[n].get("time"))
                    final = s * time_decay(dt, now)
                    if final >= SEM_MIN and final > best.get(n, 0.0):
                        best[n] = final

        # 按时间倒序（规格第七章）
        rows = []
        for n, s in best.items():
            e = self.engine.eus[n]
            rows.append({"id": n,
                         "time": e.get("time") or "",
                         "desc": e.get("event_desc") or "",
                         # 带上真实角色绑定，否则模型不知道「主体/客体」分别是谁，
                         # 会把因果说反（实测：「主体给客体充电」被讲成「你给我充」）
                         "subject": e.get("subject"),
                         "object": e.get("object"),
                         "context": clip_context(e.get("source_text"), 200),
                         "score": round(s, 3)})
        rows.sort(key=lambda r: (r["time"] or ""), reverse=True)
        recall_min = self.read_thresholds()["recall"]
        if for_bot:
            rows = [r for r in rows if float(r.get("score") or 0.0) >= recall_min]
        rows = rows[:limit]

        if not rows:
            summary = "没有找到同类事件。" if not for_bot else (
                f"没有达到召回阈值 {recall_min:.2f} 的事件。")
        else:
            summary = (f"共找到 {len(rows)} 条同类事件，"
                       f"最近一次是 {rows[0]['time'] or '时间未知'}。")
        return {"summary": summary, "events": rows, "mode": "semantic",
                "recall_threshold": recall_min if for_bot else None,
                "eu_source": "model" if eu else "service",
                "ms": round((time.perf_counter() - t0) * 1000),
                "ms_seg": round(t_seg),
                "ms_recall": round((time.perf_counter() - t0) * 1000 - t_seg),
                "eus": [e.get("desc") for e in eus]}

    # ---------- 重量召回 ----------
    def recall_logic(self, text, session=None, hops=DEFAULT_HOPS,
                     max_neighbors=DEFAULT_MAX_NEIGHBORS, eu=None,
                     for_bot=False):
        t0 = time.perf_counter()
        thresholds = self.read_thresholds()
        self.engine.set_edge_min(thresholds["edgeVisible"])
        eus = self._eus_from_param(eu)
        if not eus:
            eus = self.segment(text)
        if not eus:
            eus = self._fallback_eus(text)
        t_seg = (time.perf_counter() - t0) * 1000
        if not eus:
            return {"center": None, "neighbors": [], "note": "没有识别出事件",
                    "mode": "logic",
                    "ms": round((time.perf_counter() - t0) * 1000),
                    "ms_seg": round(t_seg), "eus": []}

        vis = self.visible_nodes(session)
        if not vis:
            return {"center": None, "neighbors": [], "note": "当前会话没有可见记忆",
                    "mode": "logic",
                    "ms": round((time.perf_counter() - t0) * 1000), "eus": eus}

        all_bests = []
        runs = []          # 每个 EU 的章动详情，给控制台看
        with self.lock:
            self.calls += 1
            for eu in eus:
                try:
                    r = self.engine.run(self._eu_event(eu))
                except Exception as ex:
                    print(f"[warn] 章动失败：{ex}", flush=True)
                    continue
                runs.append({
                    "eu": eu.get("desc"),
                    "trace": r.get("trace") or [],
                    "entries": r.get("entries") or [],
                    "bests": [{"score": round(float(s), 3), "id": n}
                              for s, n in (r.get("bests") or [])],
                    "context": r.get("context") or [],
                })
                for s, n in (r.get("bests") or []):
                    if n in vis:
                        all_bests.append((float(s), n))

        if not all_bests:
            return {"center": None, "neighbors": [],
                    "note": "没有找到关联事件",
                    "mode": "logic",
                    "ms": round((time.perf_counter() - t0) * 1000),
                    "eus": [e.get("desc") for e in eus]}

        all_bests.sort(reverse=True)

        # 中心选择：CE 最高的未必是「用户问的那件事」——
        # CE 会把枢纽事件排前面。若存在与查询描述近乎相同的节点，优先选它。
        qtext_any = eus[0].get("desc", "") if eus else ""
        # 候选池 = 所有 Best + 它们的 1 跳邻居
        pool = {}
        for s, n in all_bests:
            pool[n] = s
            for v in self.engine.adj.get(n, ()):
                if v in vis and v not in pool:
                    pool[v] = self.engine.edge_score.get(
                        (min(n, v), max(n, v)), 0.0)
        exact, best_sim = None, 0.0
        held, best_hold = None, 0.0
        for n, s in pool.items():
            desc = self.engine.eus[n].get("event_desc")
            sim = type_similarity(qtext_any, desc)
            if sim > best_sim:
                best_sim, exact = sim, (s, n)
            hold = topic_contain(qtext_any, desc)
            if hold > best_hold:
                best_hold, held = hold, (s, n)
        # 优先级：近乎相同的描述 > CE 最高。
        #
        # 这里原来有一条「字面主题命中（topic_contain>=0.5）优先」的规则，
        # 用来救主题词面明显的题目：
        #   开启规则 80/80/57/60，关闭规则 80/80/57/60 —— 完全一样。
        # 说明模型自己学会了「口语 -> 事件」，不再需要词面拐棍，故删除。
        if exact is not None and best_sim >= 0.9:
            s_center, center = exact
        else:
            s_center, center = all_bests[0]

        # 从中心 BFS 到 hops 跳，收集邻居（带跳数与边分数）
        neighbors = {}
        seen = {center: 0}
        dq = deque([center])
        while dq:
            u = dq.popleft()
            d = seen[u]
            if d >= hops:
                continue
            for v in self.engine.adj.get(u, ()):
                if v in seen or v not in vis:
                    continue
                seen[v] = d + 1
                # 关联度 = 这条边的 CE 分数（不是中心的分）
                nbr_score = self.engine.edge_score.get(
                    (min(u, v), max(u, v)), 0.0)
                ev = self.engine.eus[v]
                neighbors[v] = {"id": v,
                                "desc": ev.get("event_desc", ""),
                                "time": ev.get("time", ""),
                                "subject": ev.get("subject"),
                                "object": ev.get("object"),
                                "context": clip_context(ev.get("source_text"), 160),
                                "score": round(nbr_score, 3),
                                "hops": d + 1}
                dq.append(v)

        # 按关联度排序，截断
        nbrs = sorted(neighbors.values(), key=lambda x: -x["score"])
        recall_min = thresholds["recall"]
        if for_bot:
            if float(s_center) < recall_min:
                return {
                    "center": None,
                    "neighbors": [],
                    "mode": "logic",
                    "confidence": "low",
                    "recall_threshold": recall_min,
                    "note": f"中心事件低于召回阈值 {recall_min:.2f}，不返回结果",
                    "ms": round((time.perf_counter() - t0) * 1000),
                    "ms_seg": round(t_seg),
                    "ms_recall": round((time.perf_counter() - t0) * 1000 - t_seg),
                    "eus": [e.get("desc") for e in eus],
                }
            nbrs = [x for x in nbrs if float(x.get("score") or 0.0) >= recall_min]
        nbrs = nbrs[:max_neighbors]

        ce = self.engine.eus[center]
        return {
            "center": {"id": center,
                       "desc": ce.get("event_desc", ""),
                       "time": ce.get("time", ""),
                       "subject": ce.get("subject"),
                       "object": ce.get("object"),
                       # 把当时那几句原话一起给模型：只有一句「主体吃客体」
                       # 它没法讲出细节，容易编。
                       "context": clip_context(ce.get("source_text"), 400),
                       "score": round(s_center, 3)},
            "neighbors": nbrs,
            "mode": "logic",
            "recall_threshold": recall_min if for_bot else None,
            "confidence": ("high" if s_center >= 0.70
                           else "medium" if s_center >= 0.55 else "low"),
            "ms": round((time.perf_counter() - t0) * 1000),
            "ms_seg": round(t_seg),
            "ms_recall": round((time.perf_counter() - t0) * 1000 - t_seg),
            "eus": [e.get("desc") for e in eus],
            "runs": runs,
        }

    def remember_trace(self, query, result):
        """留一份最近的章动详情给控制台看。"""
        # 模型调 recall_logic 时可能只传 eu、不传原文 query；别把「空查询」留在
        # 章动过程里。用切出来的 EU / 中心事件的描述兜底，控制台仍然能看出查了什么。
        q = str(query or "").strip()
        if not q:
            eus = [str(x).strip() for x in (result.get("eus") or []) if str(x).strip()]
            if eus:
                q = " / ".join(eus)
        if not q:
            center = result.get("center") or {}
            q = str(center.get("desc") or "").strip()
        item = {
            "at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "query": q[:400],
            "eus": result.get("eus") or [],
            "runs": result.get("runs") or [],
            "center": result.get("center"),
            "neighbors": result.get("neighbors") or [],
            "confidence": result.get("confidence"),
            "ms": result.get("ms"),
            "ms_seg": result.get("ms_seg"),
            "ms_recall": result.get("ms_recall"),
        }
        with self.lock:
            self.traces.append(item)
            if len(self.traces) > 20:
                del self.traces[:-20]

    # ---------- 健康 ----------
    # ---------- 给控制台用 ----------
    def graph_data(self):
        """完整逻辑图：节点 + 当前显形的边（带关联度）。"""
        thresholds = self.apply_thresholds()
        edge_min = thresholds["edgeVisible"]
        nodes = []
        # engine.eus 是 {id: record} 字典，不是列表
        for i, e in self.engine.eus.items():
            nodes.append({
                "id": i,
                "desc": e.get("event_desc") or "",
                "time": e.get("time") or "",
                "subject": e.get("subject"),
                "object": e.get("object"),
                "scope": e.get("scope"),
                "degree": len(self.engine.adj.get(i, ())),
            })
        edges = []
        hidden = 0
        # engine.edges 里每条是 {a, b, score}；低于显形阈值的仍保存，只是不返回
        for e in self.engine.edges:
            score = float(e.get("score") or 0.0)
            if score < edge_min:
                hidden += 1
                continue
            edges.append({
                "source": e["a"],
                "target": e["b"],
                "score": round(score, 3),
            })
        return {"nodes": nodes, "edges": edges,
            "total_edges": len(self.engine.edges),
            "visible_edges": len(edges),
            "hidden_edges": hidden,
            "thresholds": thresholds,
            "ce_mode": getattr(self.engine, "_ce_last_mode", "local"),
            "ce_remote": bool(self.engine._remote_url()),
        }

    # ---------- 整备（切分整理，结果暂存）----------
    def pending_dir(self):
        return Path(os.environ.get(
            "XLIENS_PENDING", str(_DATA_ROOT / "pending")))

    def _build_candidates_for(self, eu):
        """按新规则：章动找 best，再从 best 逐跳扫描建边。"""
        t = self.read_thresholds()
        self.engine.set_edge_min(t["edgeVisible"])
        event = {
            "event_desc": eu.get("desc") or eu.get("event_desc") or "",
            "subject": eu.get("subject"),
            "object": eu.get("object"),
            "keywords": eu.get("ents") or eu.get("keywords") or [],
        }
        try:
            r = self.engine.run(event)
            bests = r.get("bests") or []
            found = self.engine.scan_build(event, bests, t["build"])
        except Exception as ex:
            print(f"[warn] 新建边扫描失败：{ex}", flush=True)
            return []
        cands = []
        for nid, score in found.items():
            ev = self.engine.eus.get(nid) or {}
            cands.append({
                "target_type": "node",
                "target_id": nid,
                "target_index": None,
                "target_desc": ev.get("event_desc") or "",
                "score": round(float(score), 4),
                "manual": False,
            })
        cands.sort(key=lambda x: -x["score"])
        return cands

    def _score_staged_candidates(self, new_eus):
        """整备阶段先按建边规则生成候选，落盘页可看/改分数。"""
        for eu in new_eus:
            eu["candidates"] = self._build_candidates_for(eu)

    def consolidate(self, force=False):
        """把 pending 里的新消息切分并并入图。

        和整备脚本的区别：这里只处理 pending 目录里还没消费的消息，
        一次量级很小（一天几十条），所以可以本地 CPU 跑。
        大批量重建仍然走远程 GPU 的 consolidate_reseg.py。
        """
        import segment_api
        from alias import canonical_speakers, CANON

        pdir = self.pending_dir()
        files = sorted(pdir.glob("*.json")) if pdir.exists() else []
        todo = []
        for f in files:
            try:
                d = json.loads(f.read_text(encoding="utf-8"))
            except Exception:
                continue
            if not isinstance(d, dict):      # pending 里可能有别的 json（如已见列表）
                continue
            if d.get("consumed"):
                continue
            if d.get("messages"):
                todo.append((f, d))
        if not todo:
            return {"ok": True, "skipped": True, "reason": "没有待整备的消息",
                    "sessions": 0, "messages": 0, "new_eus": 0, "new_edges": 0}

        # 按会话汇总
        by = {}
        for f, d in todo:
            sess = d.get("session") or "unknown"
            by.setdefault(sess, {"file": f, "msgs": []})
            by[sess]["msgs"].extend(d["messages"])

        eus = self.engine.eus
        edges = list(self.engine.edges)
        next_id = (max(eus.keys()) + 1) if eus else 0
        existing = {e.get("event_desc", "").strip() for e in eus.values()}

        new_eus = []
        total_msgs = sum(len(v["msgs"]) for v in by.values())
        CHUNK = 40   # 一次喂太多会让模型退化成话题摘要（实测 169 行只出几条）

        for sess, info in by.items():
            msgs = sorted(info["msgs"], key=lambda m: m.get("ts", ""))
            for ci in range(0, len(msgs), CHUNK):
                part = msgs[ci:ci + CHUNK]
                # 单行化：消息内部换行会破坏「来源行号」对齐
                plain = "\n".join(
                    f"{m.get('speaker')}："
                    f"{str(m.get('text') or '').replace(chr(10), ' ')}"
                    for m in part)
                numbered = "\n".join(
                    f"{i + 1}| {ln}" for i, ln in enumerate(plain.split("\n")))
                raw, names = canonical_speakers(plain)
                ppl = "、".join(names[:3]) or "（未知）"
                raw_numbered, _ = canonical_speakers(numbered)
                try:
                    out = segment_api.segment_multi(
                        raw_numbered, ppl, timeout=SEG_TIMEOUT,
                        **self.seg_kwargs())
                except Exception as ex:
                    print(f"[warn] 整备切分失败 {sess} 块{ci}：{ex}", flush=True)
                    continue

                plain_lines = [l for l in raw.split("\n") if l.strip()]
                used_ranges = set()
                for ei, e in enumerate(out):
                    desc = (e.get("desc") or "").strip()
                    if not desc or desc in existing:
                        continue
                    existing.add(desc)
                    # 只允许对话参与者当主客体，不能是实体行里的梗词。
                    # 实际昵称不一定在 CANON 里，canonical_speakers()
                    # 已经从原始发言行取到了它们，必须一起放行。
                    seg = []
                    src = e.get("src")
                    ee = e.get("ents") or []
                    speakers = set(names)
                    persons_e = [x for x in ee if x in speakers or x in CANON]
                    if src:
                        seg = pick_window(eu_desc=desc, keywords=ee,
                                          plain_lines=plain_lines,
                                          a=src[0], b=src[1],
                                          used=used_ranges, target=TARGET_CTX,
                                          mx=MAX_CTX, persons=persons_e)
                    if not seg:
                        seg = [z for z in
                               slice_context(raw, ei, len(out)).split("\n") if z]

                    ents = ee
                    persons = persons_e
                    spk_ctx = [x for x in dict.fromkeys(
                        ln.split("：", 1)[0].strip()
                        for ln in seg if "：" in ln)
                        if x in speakers or x in CANON]
                    if len(persons) >= 2:
                        subj, obj = persons[0], persons[1]
                    elif len(persons) == 1:
                        subj = persons[0]
                        oth = [x for x in spk_ctx if x != subj]
                        obj = oth[0] if oth else None
                    else:
                        subj = spk_ctx[0] if spk_ctx else None
                        oth = [x for x in spk_ctx if x != subj]
                        obj = oth[0] if oth else None
                    # 私聊原始记录只有一侧发言时，另一侧就是 CANON 里的另一个角色。
                    if str(sess).startswith("private:") and len(CANON) >= 2:
                        if subj not in CANON:
                            subj = CANON[0]
                        if not obj:
                            obj = next((x for x in CANON if x != subj), None)
                    new_eus.append({
                        "session": sess,
                        "ts": part[0].get("ts", ""),
                        "subject": subj, "object": obj,
                        "desc": desc, "ents": ents,
                        "source_text": "\n".join(seg[:MAX_CTX]),
                    })

        self._score_staged_candidates(new_eus)

        if not new_eus:
            for f, _ in todo:
                self._mark_consumed(f)
            return {"ok": True, "skipped": True, "reason": "新消息里没有新事件",
                    "sessions": len(by), "messages": total_msgs,
                    "new_eus": 0, "new_edges": 0}

        # —— 暂存：先不写图，等人确认 ——
        # 事件列表按来源顺序编号，审查页里增删查改都基于这个下标
        events = []
        for k, eu in enumerate(new_eus):
            events.append({
                "i": k,
                "desc": eu["desc"],
                "source_text": eu["source_text"],
                "ts": eu["ts"],
                "session": eu["session"],
                "subject": eu.get("subject"),
                "object": eu.get("object"),
                "keywords": eu.get("keywords") or [],
                "candidates": eu.get("candidates") or [],
                "locked": False,
                "ents": eu["ents"],
            })
        batch = {
            "id": time.strftime("%Y%m%d-%H%M%S"),
            "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "status": "pending",
            "sessions": len(by),
            "messages": total_msgs,
            "events": events,
            "mode": self.consolidate_mode(),
        }
        self.save_batch(batch)
        for f, _ in todo:
            self._mark_consumed(f)

        if self.consolidate_mode() == "auto":
            r = self.commit_batch(batch["id"])
            return {"ok": True, "mode": "auto", "staged": batch["id"],
                    "sessions": len(by), "messages": total_msgs,
                    "new_eus": r.get("new_eus", 0),
                    "new_edges": r.get("new_edges", 0),
                    "nodes": r.get("nodes"), "edges": r.get("edges")}

        return {"ok": True, "mode": "review", "staged": batch["id"],
                "sessions": len(by), "messages": total_msgs,
                "new_eus": len(events), "new_edges": 0,
                "reason": "已暂存，等你在「落盘」页确认"}

        # 下面是自动入图的老路径（mode=auto 时由 commit_batch 接管）

    def _mark_consumed(self, f):
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
            d["consumed"] = True
            f.write_text(json.dumps(d, ensure_ascii=False, indent=1),
                         encoding="utf-8")
        except Exception:
            pass

    def _save_graph(self, edges, eus):
        g = Path(self.graph_dir)
        g.mkdir(parents=True, exist_ok=True)
        # 去重边
        uniq = {}
        for e in edges:
            k = (min(e["a"], e["b"]), max(e["a"], e["b"]))
            if k not in uniq or e["score"] > uniq[k]["score"]:
                uniq[k] = {"a": k[0], "b": k[1], "score": e["score"]}
        with (g / "eus.jsonl").open("w", encoding="utf-8", newline="\n") as fh:
            for i in sorted(eus):
                fh.write(json.dumps(eus[i], ensure_ascii=False) + "\n")
        with (g / "edges.jsonl").open("w", encoding="utf-8", newline="\n") as fh:
            for e in uniq.values():
                fh.write(json.dumps(e, ensure_ascii=False) + "\n")
        (g / "nodes.json").write_text(
            json.dumps(sorted(eus.keys())), encoding="utf-8")
        meta = dict(self.meta or {})
        t = self.read_thresholds()
        meta.update({
            "mode": "incremental", "n_nodes": len(eus),
            "n_edges": len(uniq),
            "threshold": t["build"],
            "edge_policy": f">= {t['build']:.2f}",
            "updated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        })
        (g / "meta.json").write_text(
            json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")

    def _reload_engine(self):
        try:
            from demo_engine import DemoEngine
            self.engine = DemoEngine(graph_dir=self.graph_dir,
                                     model_path=self.model_path)
            self._reload_meta()
            self.apply_thresholds()
            print(f"[info] 图已重载：{len(self.engine.eus)} 节点 / "
                  f"{len(self.engine.edges)} 边", flush=True)
        except Exception as ex:
            print(f"[warn] 图重载失败：{ex}", flush=True)


    # ---------- EU 编辑 ----------
    def _trash_path(self):
        return Path(os.environ.get(
            "XLIENS_TRASH", str(_DATA_ROOT / "file" / "trash.json")))

    def _read_trash(self):
        try:
            return json.loads(self._trash_path().read_text(encoding="utf-8"))
        except Exception:
            return []

    def _write_trash(self, items):
        p = self._trash_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(items[-50:], ensure_ascii=False, indent=1),
                     encoding="utf-8")

    def update_node(self, nid, fields):
        """改一个 EU。只允许改白名单字段，别让人把结构改坏。"""
        try:
            nid = int(nid)
        except Exception:
            return {"ok": False, "error": "id 不合法"}
        e = self.engine.eus.get(nid)
        if not e:
            return {"ok": False, "error": "节点不存在"}
        allow = ("event_desc", "time", "subject", "object", "source_text",
                 "session")
        changed = {}
        for k in allow:
            if k in fields and fields[k] is not None:
                old = e.get(k)
                new = fields[k]
                if k == "source_text":
                    new = str(new)
                if old != new:
                    e[k] = new
                    changed[k] = True
        if not changed:
            return {"ok": True, "changed": 0}
        self._save_graph(self.engine.edges, self.engine.eus)
        self._reload_engine()
        return {"ok": True, "changed": len(changed), "node": self.node_detail(nid)}

    def add_node(self, fields):
        """手动加一个 EU；和既有全部节点算一遍关联边。"""
        desc = str(fields.get("event_desc") or "").strip()
        if not desc:
            return {"ok": False, "error": "事件描述不能为空"}
        eus = dict(self.engine.eus)
        nid = (max(eus.keys()) + 1) if eus else 0
        rec = {
            "id": nid,
            "event_desc": desc,
            "time": fields.get("time") or time.strftime("%Y-%m-%d %H:%M:%S"),
            "subject": fields.get("subject"),
            "object": fields.get("object"),
            "keywords": fields.get("keywords") or [],
            "source_text": str(fields.get("source_text") or ""),
            "session": fields.get("session") or "manual",
        }
        eus[nid] = rec
        edges = list(self.engine.edges)
        added = 0
        if len(eus) > 1:
            try:
                build_min = self.read_thresholds()["build"]
                for c in self._build_candidates_for({
                    "desc": desc, "subject": rec["subject"],
                    "object": rec["object"], "ents": rec["keywords"],
                }):
                    target = c.get("target_id")
                    if target is None or target == nid or target not in eus:
                        continue
                    score = max(0.0, min(1.0, float(c.get("score") or 0)))
                    if score <= 0 or score < build_min:
                        continue
                    edges.append({"a": nid, "b": target, "score": round(score, 4)})
                    added += 1
            except Exception as ex:
                print(f"[warn] 新增节点算边失败：{ex}", flush=True)
        self._save_graph(edges, eus)
        self._reload_engine()
        return {"ok": True, "id": nid, "edges": added}

    def delete_node(self, nid):
        """删一个 EU（放进回收站，可撤销）。"""
        try:
            nid = int(nid)
        except Exception:
            return {"ok": False, "error": "id 不合法"}
        e = self.engine.eus.get(nid)
        if not e:
            return {"ok": False, "error": "节点不存在"}
        trash = self._read_trash()
        related = [ed for ed in self.engine.edges
                   if ed["a"] == nid or ed["b"] == nid]
        trash.append({
            "at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "node": dict(e),
            "edges": [dict(x) for x in related],
        })
        self._write_trash(trash)

        eus = {i: v for i, v in self.engine.eus.items() if i != nid}
        edges = [ed for ed in self.engine.edges
                 if ed["a"] != nid and ed["b"] != nid]
        self._save_graph(edges, eus)
        self._reload_engine()
        return {"ok": True, "id": nid, "desc": e.get("event_desc"),
                "trash": len(trash)}

    def restore_node(self):
        """撤销最近一次删除。"""
        trash = self._read_trash()
        if not trash:
            return {"ok": False, "error": "回收站是空的"}
        item = trash.pop()
        eus = dict(self.engine.eus)
        node = item["node"]
        nid = node["id"]
        if nid in eus:
            nid = (max(eus.keys()) + 1) if eus else 0
            node["id"] = nid
        eus[nid] = node
        edges = list(self.engine.edges)
        for ed in item.get("edges") or []:
            a = nid if ed["a"] == node["id"] else ed["a"]
            b = nid if ed["b"] == node["id"] else ed["b"]
            if a in eus and b in eus:
                edges.append({"a": a, "b": b, "score": ed.get("score", 0.0)})
        self._write_trash(trash)
        self._save_graph(edges, eus)
        self._reload_engine()
        return {"ok": True, "id": nid, "desc": node.get("event_desc"),
                "remaining": len(trash)}

    def trash_summary(self):
        return [{"at": it.get("at"), "id": it["node"].get("id"),
                 "desc": it["node"].get("event_desc")}
                for it in self._read_trash()]


    # ---------- 整备暂存（人工审查）----------
    def staging_dir(self):
        d = Path(os.environ.get("XLIENS_STAGING",
                                str(_DATA_ROOT / "file" / "staging")))
        d.mkdir(parents=True, exist_ok=True)
        return d

    def consolidate_mode(self):
        """auto = 整备后直接入图；review = 只暂存等人确认。"""
        try:
            cfg = self.read_settings().get("consolidate") or {}
            return str(cfg.get("mode") or "review")
        except Exception:
            return "review"

    def _stage_path(self, sid):
        return self.staging_dir() / f"{sid}.json"

    def save_batch(self, batch):
        p = self._stage_path(batch["id"])
        p.write_text(json.dumps(batch, ensure_ascii=False, indent=1),
                     encoding="utf-8")
        return batch

    def list_batches(self, limit=50):
        rows = []
        for f in self.staging_dir().glob("*.json"):
            try:
                d = json.loads(f.read_text(encoding="utf-8"))
            except Exception:
                continue
            rows.append((d.get("created_at") or "", f.stat().st_mtime, d))
        # 永远按创建时间倒序；文件修改时间只用于同时间批次的兜底。
        rows.sort(key=lambda x: (str(x[0]), x[1]), reverse=True)
        items = []
        for _, _, d in rows[:limit]:
            items.append({
                "id": d.get("id"),
                "created_at": d.get("created_at"),
                "status": d.get("status"),
                "event_count": len(d.get("events") or []),
                "locked_count": sum(1 for e in (d.get("events") or []) if e.get("locked")),
                "sessions": d.get("sessions") or 0,
                "messages": d.get("messages") or 0,
                "committed_at": d.get("committed_at"),
                "can_uncommit": d.get("node_ids") is not None,
                "result": d.get("result"),
            })
        return items

    def get_batch(self, sid):
        p = self._stage_path(sid)
        if not p.exists():
            return None
        try:
            b = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            return None
        # 旧批次只存了 desc/source；从 source_text 补说话人，让审查页能显示
        # 主体/客体，而不是一个空的信息栏。
        try:
            from alias import canonical_speakers, CANON
            for e in b.get("events") or []:
                if e.get("subject") and e.get("object"):
                    continue
                _, names = canonical_speakers(e.get("source_text") or "")
                if names:
                    if not e.get("subject"):
                        e["subject"] = names[0]
                    if not e.get("object") and len(names) > 1:
                        e["object"] = names[1]
                if str(e.get("session") or "").startswith("private:") and len(CANON) >= 2:
                    if not e.get("subject") or e["subject"] not in CANON:
                        e["subject"] = CANON[0]
                    if not e.get("object") or e["object"] == e["subject"]:
                        e["object"] = next((x for x in CANON if x != e["subject"]), None)
                e.setdefault("keywords", [])
                e.setdefault("locked", False)
        except Exception:
            pass
        # 旧批次还没有候选分：第一次打开时补算并写回
        try:
            evs = b.get("events") or []
            if evs and any("candidates" not in e for e in evs):
                self._score_staged_candidates(evs)
                self.save_batch(b)
        except Exception:
            pass
        # 给审核页手动连边提供目标列表：已有图节点 + 本批新事件
        try:
            b["targets"] = (
                [{"type": "node", "id": nid,
                  "desc": e.get("event_desc") or ""}
                 for nid, e in self.engine.eus.items()]
                + [{"type": "batch", "index": e.get("i", idx),
                    "desc": e.get("desc") or ""}
                   for idx, e in enumerate(b.get("events") or [])]
            )
        except Exception:
            b["targets"] = []
        try:
            b["graph_edges"] = [
                {"source": e["a"], "target": e["b"],
                 "score": round(float(e.get("score") or 0), 3)}
                for e in self.engine.edges
            ]
        except Exception:
            b["graph_edges"] = []
        b["locked_count"] = sum(1 for e in (b.get("events") or []) if e.get("locked"))
        b["can_uncommit"] = b.get("node_ids") is not None
        return b

    def _norm_event(self, e, idx=None):
        """把前端发来的事件整理成统一结构。"""
        desc = str((e or {}).get("desc") or "").strip()
        import re as _re
        desc = _re.sub(r"[\[〔（(][^\]〕）)]*$", "", desc).strip()
        return {
            "i": idx,
            "desc": desc,
            "source_text": str((e or {}).get("source_text") or ""),
            "ts": (e or {}).get("ts") or time.strftime("%Y-%m-%d %H:%M:%S"),
            "session": (e or {}).get("session") or "",
            "subject": (e or {}).get("subject") or None,
            "object": (e or {}).get("object") or None,
            "keywords": (e or {}).get("keywords") or [],
            "candidates": (e or {}).get("candidates") or [],
            "locked": bool((e or {}).get("locked")),
            "ents": (e or {}).get("ents") or [],
        }

    def update_staged_event(self, sid, idx, fields):
        b = self.get_batch(sid)
        if not b:
            return {"ok": False, "error": "批次不存在"}
        if b.get("status") != "pending":
            return {"ok": False, "error": "已入图或已丢弃的批次不可修改"}
        evs = b.get("events") or []
        if idx < 0 or idx >= len(evs):
            return {"ok": False, "error": "下标越界"}
        for k in ("desc", "source_text", "ts", "session", "subject", "object"):
            if k in fields and fields[k] is not None:
                evs[idx][k] = str(fields[k])
        if "keywords" in fields and isinstance(fields["keywords"], list):
            evs[idx]["keywords"] = fields["keywords"]
        if "candidates" in fields and isinstance(fields["candidates"], list):
            evs[idx]["candidates"] = fields["candidates"]
        if "locked" in fields:
            evs[idx]["locked"] = bool(fields["locked"])
        self.save_batch(b)
        return {"ok": True, "event": evs[idx]}

    def delete_staged_event(self, sid, idx):
        b = self.get_batch(sid)
        if not b:
            return {"ok": False, "error": "批次不存在"}
        if b.get("status") != "pending":
            return {"ok": False, "error": "已入图或已丢弃的批次不可修改"}
        evs = b.get("events") or []
        if idx < 0 or idx >= len(evs):
            return {"ok": False, "error": "下标越界"}
        killed = evs.pop(idx)
        # 修正本批节点的下标，并移除指向被删节点的候选边。
        for e in evs:
            kept = []
            for c in (e.get("candidates") or []):
                if c.get("target_type") == "batch":
                    try:
                        ti = int(c.get("target_index"))
                    except Exception:
                        continue
                    if ti == idx:
                        continue
                    if ti > idx:
                        c["target_index"] = ti - 1
                kept.append(c)
            e["candidates"] = kept
        for i, e in enumerate(evs):
            e["i"] = i
        self.save_batch(b)
        return {"ok": True, "deleted": killed, "remaining": len(evs)}

    def add_staged_event(self, sid, fields):
        b = self.get_batch(sid)
        if not b:
            return {"ok": False, "error": "批次不存在"}
        if b.get("status") != "pending":
            return {"ok": False, "error": "已入图或已丢弃的批次不可修改"}
        ev = self._norm_event(fields)
        if not ev["desc"]:
            return {"ok": False, "error": "事件描述不能为空"}
        b.setdefault("events", []).append(ev)
        ev["i"] = len(b["events"]) - 1
        self.save_batch(b)
        return {"ok": True, "event": ev, "count": len(b["events"])}

    def discard_batch(self, sid):
        b = self.get_batch(sid)
        if not b:
            return {"ok": False, "error": "批次不存在"}
        if b.get("status") != "pending":
            return {"ok": False, "error": "只有待审查批次可以丢弃"}
        b["status"] = "discarded"
        b["discarded_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        self.save_batch(b)
        return {"ok": True, "id": sid}

    def uncommit_batch(self, sid):
        """把已入图批次撤回为待审查：删除该批次新增的节点及关联边。"""
        b = self.get_batch(sid)
        if not b:
            return {"ok": False, "error": "批次不存在"}
        if b.get("status") != "committed":
            return {"ok": False, "error": "只有已入图批次可以出图"}
        ids = b.get("node_ids")
        if ids is None:
            return {"ok": False, "error": "旧批次未记录新增节点，无法安全出图"}
        ids = {int(x) for x in ids}
        eus = {i: e for i, e in self.engine.eus.items() if i not in ids}
        edges = [e for e in self.engine.edges
                 if e.get("a") not in ids and e.get("b") not in ids]
        removed = len(self.engine.eus) - len(eus)
        self._save_graph(edges, eus)
        self._reload_engine()
        b["status"] = "pending"
        b.pop("committed_at", None)
        b.pop("result", None)
        b.pop("node_ids", None)
        b["uncommitted_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        self.save_batch(b)
        return {"ok": True, "id": sid, "removed_nodes": removed,
                "nodes": len(self.engine.eus), "edges": len(self.engine.edges)}

    def commit_batch(self, sid):
        """把暂存批次真正写进图（建边 + 落盘 + 重载）。

        整备阶段已经算过候选分；确认入图时复用候选，并允许人工改分/连边。
        没有候选的旧批次退回原来的即时 CE 计算。
        """
        b = self.get_batch(sid)
        if not b:
            return {"ok": False, "error": "批次不存在"}
        if b.get("status") == "committed":
            return {"ok": False, "error": "这批已经入过图了"}
        if b.get("status") != "pending":
            return {"ok": False, "error": "只有待审查批次可以入图"}
        all_evs = [e for e in (b.get("events") or []) if (e.get("desc") or "").strip()]
        unlocked = [e for e in all_evs if not e.get("locked")]
        evs = [e for e in all_evs if e.get("locked")]
        if not evs:
            b["status"] = "discarded"
            b["discarded_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
            b["result"] = {"new_eus": 0, "new_edges": 0,
                           "nodes": len(self.engine.eus),
                           "edges": len(self.engine.edges),
                           "unlocked_dropped": len(unlocked)}
            self.save_batch(b)
            return {"ok": True, "discarded": True,
                    "unlocked_dropped": len(unlocked), **b["result"]}
        if not all_evs:
            return {"ok": False, "error": "没有可入图的事件"}

        eus = dict(self.engine.eus)
        next_id = (max(eus.keys()) + 1) if eus else 0
        existing = {(v.get("event_desc") or "").strip() for v in eus.values()}
        edges = list(self.engine.edges)
        edge_by_key = {
            (min(e["a"], e["b"]), max(e["a"], e["b"])): e for e in edges
        }
        build_min = self.read_thresholds()["build"]
        added_edges = 0
        added = 0
        new_ids = {}
        manual_keys = set()

        # 先给所有新事件分配 ID；候选边里 batch:<i> 用的是原始下标 i
        for pos, ev in enumerate(evs):
            desc = ev["desc"].strip()
            if desc in existing:
                continue
            nid = next_id
            next_id += 1
            new_ids[ev.get("i", pos)] = nid
            ctx = ev.get("source_text") or ""
            subj = ev.get("subject")
            obj = ev.get("object")
            if not subj or not obj:
                persons = [x for x in (ev.get("ents") or []) if x in CANON]
                spk = [s for s in dict.fromkeys(
                    ln.split("：", 1)[0].strip()
                    for ln in ctx.split("\n") if "：" in ln) if s in CANON]
                if not subj:
                    subj = (persons[0] if persons else (spk[0] if spk else None))
                if not obj:
                    oth = [x for x in (persons or spk) if x != subj]
                    obj = oth[0] if oth else None
            eus[nid] = {
                "id": nid, "event_desc": desc,
                "subject": subj, "object": obj,
                "keywords": ev.get("keywords") or ev.get("ents") or [],
                "time": ev.get("ts"),
                "source_text": ctx, "session": ev.get("session"),
            }
            existing.add(desc)
            added += 1

        for pos, ev in enumerate(evs):
            nid = new_ids.get(ev.get("i", pos))
            if nid is None:
                continue
            cands = ev.get("candidates")
            if cands is None:
                # 旧批次没有暂存候选：按新的 best + 逐跳扫描生成
                cands = self._build_candidates_for({
                    "desc": eus[nid]["event_desc"],
                    "subject": eus[nid].get("subject"),
                    "object": eus[nid].get("object"),
                    "ents": eus[nid].get("keywords") or [],
                })
            for c in cands:
                kind = c.get("target_type")
                if kind == "node":
                    target = c.get("target_id")
                elif kind == "batch":
                    target = new_ids.get(c.get("target_index"))
                else:
                    continue
                if target is None or target == nid or target not in eus:
                    continue
                try:
                    score = max(0.0, min(1.0, float(c.get("score") or 0)))
                except Exception:
                    continue
                manual = bool(c.get("manual"))
                if score <= 0 or (not manual and score < build_min):
                    continue
                key = (min(nid, target), max(nid, target))
                if key in edge_by_key:
                    e = edge_by_key[key]
                    if manual:
                        e["score"] = round(score, 4)
                        manual_keys.add(key)
                    continue
                e = {"a": nid, "b": target, "score": round(score, 4)}
                edges.append(e)
                edge_by_key[key] = e
                added_edges += 1
                if manual:
                    manual_keys.add(key)

        if added:
            self._save_graph(edges, eus)
            self._reload_engine()

        b["status"] = "committed"
        b["committed_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        b["node_ids"] = sorted(int(x) for x in new_ids.values())
        b["result"] = {"new_eus": added, "new_edges": added_edges,
                       "nodes": len(self.engine.eus),
                       "edges": len(self.engine.edges),
                       "unlocked_dropped": len(unlocked)}
        self.save_batch(b)
        return {"ok": True, "id": sid, **b["result"]}

    def node_detail(self, nid):
        """单个节点的完整记录（含 source_text 原始对话）。"""
        e = self.engine.eus.get(nid)
        if not e:
            return None
        nb = []
        for v in self.engine.adj.get(nid, ()):
            nb.append({"id": v,
                       "desc": self.engine.eus[v].get("event_desc", ""),
                       "score": round(float(self.engine.edge_score.get(
                           (min(nid, v), max(nid, v)), 0.0)), 3)})
        nb.sort(key=lambda x: -x["score"])
        return {
            "id": nid,
            "desc": e.get("event_desc", ""),
            "time": e.get("time", ""),
            "subject": e.get("subject"),
            "object": e.get("object"),
            "session": e.get("session"),
            "keywords": e.get("keywords") or [],
            "source_text": e.get("source_text") or "",
            "neighbors": nb[:20],
        }

    def settings_path(self):
        return Path(os.environ.get(
            "XLIENS_SETTINGS", str(_DATA_ROOT / "file" / "settings.json")))

    def read_settings(self):
        try:
            d = json.loads(self.settings_path().read_text(encoding="utf-8"))
            if isinstance(d, dict):
                d["self"] = self.read_self()   # 前端从 /settings 一起读走
            return d
        except Exception:
            return {"consolidate": {"enabled": True,
                                    "start": "03:00", "end": "03:30"}}

    def write_settings(self, data):
        p = self.settings_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        cur = self.read_settings()
        for k, v in (data or {}).items():
            if k == "self" and isinstance(v, dict):
                # 「我的名字」借 /api/settings 这条通道存，写进 file/self.json
                self.write_self(v)
                cur["self"] = self.read_self()
                continue
            if k == "consolidate" and isinstance(v, dict):
                c = dict(cur.get("consolidate") or {})
                for key in ("start", "end"):
                    if key in v:
                        c[key] = str(v[key] or "").strip()
                if "enabled" in v:
                    c["enabled"] = bool(v["enabled"])
                if "mode" in v:
                    c["mode"] = "auto" if str(v["mode"]) == "auto" else "review"
                # 兼容旧的 at 列表写法：有就转成窗口
                if "at" in v and v["at"]:
                    c["start"] = str(v["at"][0]).strip()
                    c.pop("at", None)
                cur["consolidate"] = c
            else:
                cur[k] = v
        p.write_text(json.dumps(cur, ensure_ascii=False, indent=2),
                     encoding="utf-8")
        return cur

    # ---------- 主人设置 ----------
    def self_path(self):
        return Path(os.environ.get(
            "XLIENS_SELF", str(_DATA_ROOT / "file" / "self.json")))

    def read_self(self):
        try:
            d = json.loads(self.self_path().read_text(encoding="utf-8"))
        except Exception:
            return {"ids": [], "names": []}
        return {
            "ids": [str(x) for x in (d.get("ids") or []) if str(x).strip()],
            "names": [str(x) for x in (d.get("names") or []) if str(x).strip()],
        }

    def write_self(self, body):
        """机器人自己的号和名字，逗号字符串或数组都收。"""
        def split(v):
            if v is None:
                return None
            if isinstance(v, str):
                return [x.strip() for x in v.replace("，", ",").split(",") if x.strip()]
            return [str(x).strip() for x in v if str(x).strip()]

        cur = self.read_self()
        ids = split(body.get("ids"))
        names = split(body.get("names"))
        out = {
            "ids": ids if ids is not None else cur["ids"],
            "names": names if names is not None else cur["names"],
        }
        p = self.self_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
        return {"ok": True, **out}

    def owner_path(self):
        return Path(os.environ.get(
            "XLIENS_OWNER", str(_DATA_ROOT / "file" / "owner.json")))

    def read_owner(self):
        try:
            d = json.loads(self.owner_path().read_text(encoding="utf-8"))
        except Exception:
            return {"ids": [], "names": []}
        return {
            "ids": [str(x) for x in (d.get("ids") or []) if str(x).strip()],
            "names": [str(x) for x in (d.get("names") or []) if str(x).strip()],
        }

    def write_owner(self, body):
        """主人可以有多个号、多个称呼；逗号字符串或数组都收。"""
        def split(v):
            if v is None:
                return None
            if isinstance(v, str):
                return [x.strip() for x in v.replace("，", ",").split(",") if x.strip()]
            return [str(x).strip() for x in v if str(x).strip()]

        cur = self.read_owner()
        ids = split(body.get("ids"))
        names = split(body.get("names"))
        out = {
            "ids": ids if ids is not None else cur["ids"],
            "names": names if names is not None else cur["names"],
        }
        p = self.owner_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
        return {"ok": True, **out}

    def persona_path(self):
        return Path(os.environ.get(
            "XLIENS_PERSONA", str(_DATA_ROOT / "file" / "persona.md")))

    def read_persona(self):
        try:
            return self.persona_path().read_text(encoding="utf-8")
        except Exception:
            return ""

    def write_persona(self, text):
        p = self.persona_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(str(text or ""), encoding="utf-8")
        return {"ok": True, "chars": len(str(text or ""))}

    def allow_path(self):
        return Path(os.environ.get(
            "LONGMEM_ALLOW",
            str(_DATA_ROOT / "file" / "allow.json")))

    def read_allow(self):
        p = self.allow_path()
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            return {"groups": [], "private": [], "allowAllWhenEmpty": False,
                    "denyUsers": []}

    def write_allow(self, data):
        p = self.allow_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        cur = self.read_allow()
        for k in ("groups", "private", "denyUsers"):
            if k in (data or {}):
                cur[k] = [str(x).strip() for x in (data[k] or []) if str(x).strip()]
        if "allowAllWhenEmpty" in (data or {}):
            cur["allowAllWhenEmpty"] = bool(data["allowAllWhenEmpty"])
        p.write_text(json.dumps(cur, ensure_ascii=False, indent=2),
                     encoding="utf-8")
        return cur

    def health(self):
        return {"ok": True,
                "graph": str(self.graph_dir),
                "data_root": os.environ.get(
                    "XLIENS_DATA_ROOT", str(_DATA_ROOT)),
                "nodes": len(self.engine.eus),
                "edges": len(self.engine.edges),
                "device": self.engine.dev,
                "calls": self.calls,
                # CE 打分走的是哪边：remote(3080Ti) / local(CPU) / local(熔断)
                "ce_mode": getattr(self.engine, "_ce_last_mode", "local"),
                "ce_remote_configured": bool(self.engine._remote_url()),
                "meta": self.meta}


SVC = None


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _html(self, path):
        try:
            data = Path(path).read_bytes()
        except Exception:
            self._send(404, {"error": "页面文件不存在"})
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        try:
            if self.path.startswith("/health"):
                self._send(200, SVC.health())
            elif self.path in ("/", "/index.html", "/console"):
                self._html(os.environ.get(
                    "LONGMEM_CONSOLE",
                    str(_PROJECT_ROOT / "public" / "console.html")))
            elif self.path.startswith("/api/graph"):
                self._send(200, SVC.graph_data())
            elif self.path.startswith("/api/trace"):
                self._send(200, {"traces": list(SVC.traces)})
            elif self.path.startswith("/api/allow"):
                self._send(200, SVC.read_allow())
            elif self.path.startswith("/api/node"):
                from urllib.parse import urlparse, parse_qs
                q = parse_qs(urlparse(self.path).query)
                try:
                    nid = int((q.get("id") or ["0"])[0])
                except Exception:
                    nid = -1
                d = SVC.node_detail(nid)
                self._send(200 if d else 404, d or {"error": "节点不存在"})
            elif self.path.startswith("/api/persona"):
                self._send(200, {"text": SVC.read_persona()})
            elif self.path.startswith("/api/settings"):
                self._send(200, SVC.read_settings())
            elif self.path.startswith("/api/thresholds"):
                self._send(200, SVC.read_thresholds())
            elif self.path.startswith("/api/seg"):
                self._send(200, SVC.read_seg())
            elif self.path.startswith("/api/trash"):
                self._send(200, {"items": SVC.trash_summary()})
            elif self.path.startswith("/api/owner"):
                self._send(200, SVC.read_owner())
            elif self.path.startswith("/api/self"):
                self._send(200, SVC.read_self())
            elif self.path.startswith("/api/staging/list"):
                self._send(200, {"items": SVC.list_batches()})
            elif self.path.startswith("/api/staging/get"):
                from urllib.parse import urlparse, parse_qs
                sid = (parse_qs(urlparse(self.path).query).get("id") or [""])[0]
                b = SVC.get_batch(sid)
                self._send(200 if b else 404, b or {"error": "批次不存在"})
            else:
                self._send(404, {"error": "not found"})
        except Exception as ex:
            traceback.print_exc()
            self._send(500, {"ok": False, "error": str(ex)})

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
        except Exception:
            self._send(400, {"error": "bad json"})
            return
        try:
            if self.path.startswith("/api/reload"):
                SVC._reload_engine()
                self._send(200, {"ok": True, "nodes": len(SVC.engine.eus)})
                return
            if self.path.startswith("/api/shutdown"):
                self._send(200, {"ok": True})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return
            if self.path.startswith("/recall_semantic"):
                self._send(200, SVC.recall_semantic(
                    body.get("text", ""), body.get("session"),
                    int(body.get("limit") or DEFAULT_LIMIT),
                    eu=body.get("eu"), for_bot=bool(body.get("for_bot"))))
            elif self.path.startswith("/recall_logic"):
                r = SVC.recall_logic(
                    body.get("text", ""), body.get("session"),
                    int(body.get("hops") or DEFAULT_HOPS),
                    int(body.get("max_neighbors") or DEFAULT_MAX_NEIGHBORS),
                    eu=body.get("eu"), for_bot=bool(body.get("for_bot")))
                try:
                    SVC.remember_trace(body.get("text", ""), r)
                except Exception:
                    pass
                self._send(200, r)
            elif self.path.startswith("/segment"):
                eus = SVC.segment(body.get("text", ""))
                self._send(200, {"eus": eus})
            elif self.path.startswith("/api/allow"):
                self._send(200, SVC.write_allow(body))
            elif self.path.startswith("/api/persona"):
                self._send(200, SVC.write_persona(body.get("text", "")))
            elif self.path.startswith("/api/settings"):
                self._send(200, SVC.write_settings(body))
            elif self.path.startswith("/api/thresholds"):
                self._send(200, SVC.set_thresholds(body))
            elif self.path.startswith("/api/seg"):
                self._send(200, SVC.set_seg(body))
            elif self.path.startswith("/api/node/update"):
                self._send(200, SVC.update_node(body.get("id"),
                                                body.get("fields") or {}))
            elif self.path.startswith("/api/node/add"):
                self._send(200, SVC.add_node(body))
            elif self.path.startswith("/api/node/delete"):
                self._send(200, SVC.delete_node(body.get("id")))
            elif self.path.startswith("/api/node/restore"):
                self._send(200, SVC.restore_node())
            elif self.path.startswith("/api/owner"):
                self._send(200, SVC.write_owner(body))
            elif self.path.startswith("/api/self"):
                self._send(200, SVC.write_self(body))
            elif self.path.startswith("/api/staging/update"):
                self._send(200, SVC.update_staged_event(
                    body.get("id"), int(body.get("idx", -1)),
                    body.get("fields") or {}))
            elif self.path.startswith("/api/staging/delete"):
                self._send(200, SVC.delete_staged_event(
                    body.get("id"), int(body.get("idx", -1))))
            elif self.path.startswith("/api/staging/add"):
                self._send(200, SVC.add_staged_event(body.get("id"), body))
            elif self.path.startswith("/api/staging/commit"):
                self._send(200, SVC.commit_batch(body.get("id")))
            elif self.path.startswith("/api/staging/uncommit"):
                self._send(200, SVC.uncommit_batch(body.get("id")))
            elif self.path.startswith("/api/staging/discard"):
                self._send(200, SVC.discard_batch(body.get("id")))
            elif self.path.startswith("/api/consolidate"):
                self._send(200, SVC.consolidate(force=True))
            else:
                self._send(404, {"error": "not found"})
        except Exception as ex:
            traceback.print_exc()
            self._send(500, {"error": str(ex)})


def main():
    global SVC
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8317)
    ap.add_argument("--graph", default="graph_demo")
    ap.add_argument("--model", default="models/reg_v69")
    ap.add_argument("--no-segment", action="store_true",
                    help="关闭 MiMo 切分，直接拿 text 当描述（离线测试用）")
    a = ap.parse_args()

    # 8317 是机器人 MCP 记忆工具的生产入口。
    # 训练/评估窗口如果临时占用 8317，这里只警告、不硬拦也不杀进程；
    # 发现被占时由人决定，机器人侧只会报「记忆工具不可用」。
    if a.port == 8317 and "reg_v69" not in str(a.model):
        print(
            f"[warn] 8317 是机器人生产端口，当前 --model {a.model} 不是 v48_s3；"
            "机器人 MCP 记忆工具会被这个实验服务顶掉，请确认是否要用 8319 等其它端口",
            flush=True,
        )

    print(f"加载 CE 模型与图：{a.graph}", flush=True)
    t0 = time.time()
    SVC = MemoryService(a.graph, a.model, segments=not a.no_segment)
    print(f"  完成 {time.time()-t0:.1f}s  "
          f"节点 {len(SVC.engine.eus)}  边 {len(SVC.engine.edges)}  "
          f"设备 {SVC.engine.dev}", flush=True)

    srv = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    print(f"服务已启动 http://127.0.0.1:{a.port}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
