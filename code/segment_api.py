"""切分接口：本地模型 / 云端 API 可切换。

核心约定（EU 是原子事件）：
    第一行：涉及的人名和物体名，逗号分隔
    之后每行：一个原子事件（8~16 字，用「主体」「客体」代替人名）
    一个事件 = 一个动作，不写因果链

返回：[(entities, desc), ...]  —— 可能返回多个 EU

用法：
    from segment_api import segment_multi
    eus = segment_multi(text, "角色A、角色B")
    # [{"ents":[...], "desc":"..."}, ...]
"""
import json
import os
import os
import re
import sys
from alias import CANON   # 模块级，clean_desc 要用
_KNOWN_NAMES = set()      # 语料里出现过的说话人，consolidate 会填

SYS_PROMPT = """把一段 QQ 聊天记录整理成若干「事件单元」。
输出格式：
第一行：涉及的人名和物体名，逗号分隔
之后每行：事件 + 来源区间
事件：8~18 字，主体+动作+客体，只写一个动作
来源区间：从第几行到第几行，写成〔起-止〕
规则：
- 只记录有信息量的事实、决定、状态变化或约定
- 同一主题合并，最多 3 条
- 描述中不写人名，统一用「主体」「客体」占位
- 实体行列出人名和物体名，宁多勿少
"""



# 模型有时写区间〔3-4〕，有时只写一行〔8〕，两种都要认。
SRC_RE = re.compile(
    r"[〔\[（(]\s*(\d+)\s*(?:[-~—－]\s*(\d+)\s*)?[〕\]）)]")


def split_src(desc):
    """把「事件 〔3-6〕」拆成 (事件, (3, 6))；没有区间就返回 (事件, None)。"""
    if not desc:
        return desc, None
    m = SRC_RE.search(desc)
    if not m:
        return desc.strip(), None
    a = int(m.group(1))
    b = int(m.group(2)) if m.group(2) else a
    if a > b:
        a, b = b, a
    return (desc[:m.start()] + desc[m.end():]).strip(), (a, b)


def clean_desc(desc):
    """把描述里残留的人名、@提及、重复占位符清掉。

    实测踩过：云端会把「@某人 和 主人 讨论…」归一成「主体客体讨论…」，
    开头两个占位符并排，读起来莫名其妙；还有「主体主人解释…」这种
    占位符后面又跟了个没换掉的名字。
    """
    d = desc or ""
    # 模型偶尔会输出 Markdown 强调（**主体闭嘴**、`实体`），一律去掉
    d = d.replace("**", "").replace("`", "").replace("###", "")
    d = d.replace("*", "").replace("#", "").strip()
    # @提及：连同后面的英文/数字/符号一起去掉，直到碰到中文
    d = re.sub(r"@[^\u4e00-\u9fa5]*", "", d)
    # 占位符后面直接跟人名 -> 去掉人名
    for nm in CANON:
        d = d.replace(f"主体{nm}", "主体").replace(f"客体{nm}", "客体")
    # normalize_desc 之后还可能漏成「主体主人」这种（主人本身就是占位符候选）
    d = d.replace("主体主人", "主体").replace("客体主人", "客体")
    d = d.replace("主体角色B", "主体").replace("客体角色B", "客体")
    # 描述里不该出现真人名：开头的是主体，其余位置一律当承受者。
    for nm in sorted(set(list(CANON) + list(_KNOWN_NAMES)), key=len, reverse=True):
        if not nm or len(nm) < 2:
            continue
        d = d.replace("主体" + nm, "主体")
        d = d.replace(nm, "客体")

    # 只合并「主体客体」这种直接相连的（云端把两个人名归一成了两个占位符）；
    # 「主体和客体」是有意义的并列，不能动
    d = re.sub(r"(主体|客体)(主体|客体)", r"\1", d)
    d = re.sub(r"(主体|客体)\1+", r"\1", d)                   # 主体主体 -> 主体
    # 一句里出现两个「主体」且没有「客体」时，第二个是动作承受者。
    if d.count("主体") >= 2 and "客体" not in d:
        first = d.find("主体")
        d = d[:first + 2] + d[first + 2:].replace("主体", "客体")
    # 模型输出被截断时会留下没闭合的括号尾巴（「主体回应一直说人话 〔2」）
    d = re.sub(r"[〔\[（(][^〕\]）)]*$", "", d)
    d = re.sub(r"\s+", " ", d).strip()
    d = d.strip("，,、。 ")
    return d


def normalize_desc(desc, persons):
    """把事件描述里的人名换成「主体」「客体」。

    CE 是在纯占位符的描述上训练的，混入真实人名会让它跑偏。
    """
    if not desc:
        return desc
    names = []
    for p in (persons or []):
        p = str(p).strip()
        if p and p not in names and len(p) <= 20:
            names.append(p)
    d = desc
    if names:
        names.sort(key=len, reverse=True)
        order = []

        def _repl(m):
            nm = m.group(0)
            if nm not in order:
                order.append(nm)
            # 中文是 SVO 语序：先出现的是施动者 → 主体
            return "主体" if len(order) == 1 else "客体"

        d = re.sub("|".join(re.escape(x) for x in names), _repl, d)
    if d.count("主体") > 1:
        i = d.find("主体")
        d = d[:i + 2] + d[i + 2:].replace("主体", "客体")
    if d.count("客体") > 1:
        i = d.find("客体")
        d = d[:i + 2] + d[i + 2:].replace("客体", "主体")
    return d


def _split_ents(line):
    line = re.sub(r"^(涉及的人名和物体名|在场人员|实体|人名和物体名)[：:]\s*",
                  "", line).strip()
    cand = [x.strip().strip("\"'「」") for x in re.split(r"[,，、]", line)
            if x.strip()]
    bad = {"主体", "客体", "「主体」", "「客体」"}
    cand = [x for x in cand if x not in bad and 0 < len(x) <= 30]
    return cand


def _is_noise_line(s):
    """云端偶尔把提示词模板/标题行当正文返回（如「=== 事件行 ===」）。
    这些不是 EU，必须在解析阶段丢掉，否则会被当成一条垃圾事件去召回。
    """
    t = str(s or "").strip()
    if not t:
        return True
    if re.match(r"^(={2,}|#{2,}|-{3,}|\*{3,})", t):
        return True
    core = re.sub(r"[主体客体\s=#*\-—:：\[\]【】`]", "", t)
    if core in {"事件行", "实体行", "事件", "实体", "描述", "输出", "格式", "示例", "注意", "要求",
                "无事件", "没有事件", "无", "空", "none", "null"}:
        return True
    return core.startswith("事件行") and len(core) <= 6


def _parse(raw, persons=None):
    """宽松解析模型输出，返回 [(ents, desc), ...]。"""
    lines = [l.strip() for l in (raw or "").split("\n")
             if l.strip() and not _is_noise_line(l)]
    if not lines:
        return []

    # 有些情况下模型会把实体行和事件行输出在同一行：
    # 先把它拆成两行再走正常解析。
    split = []
    for l in lines:
        if ("主体" in l or "客体" in l) and "," in l:
            idx = min([i for i in (l.find("主体"), l.find("客体")) if i >= 0])
            head, tail = l[:idx].strip().rstrip(",，、 "), l[idx:].strip()
            if head and tail:
                split.append(head)
                split.append(tail)
                continue
        split.append(l)
    lines = split

    ents, descs = [], []
    for i, l in enumerate(lines):
        l2 = re.sub(r"^(事件\s*\d+|事件|描述|→|\d+[\.、])\s*[：:]?\s*", "", l)
        l2 = l2.strip().strip("\"'「」")
        if not l2:
            continue
        has_slot = ("主体" in l2 or "客体" in l2)
        # 判定「这是实体行」要小心：单行输出时（云端有时只给一行、直接用人名
        # 规则：有逗号分隔 → 实体行；或很短（≤12 字）且是首行 → 实体行。
        has_sep = ("," in l2 or "，" in l2 or "、" in l2)
        if (not ents and not has_slot
                and (has_sep or (i == 0 and len(l2) <= 12))):
            l2 = l2.replace("**", "").replace("`", "").replace("*", "")
            cand = _split_ents(l2)
            if cand and all(len(x) <= 20 for x in cand):
                ents = cand
                continue
        if has_slot:
            parts = [p.strip() for p in re.split(r"[；;]", l2) if p.strip()]
            for p in parts:
                if "主体" in p or "客体" in p:
                    descs.append(p)
        elif len(l2) <= 30 and not ("," in l2 or "，" in l2) and i > 0:
            d = l2
            for nm in ents:
                if nm and nm in d:
                    d = d.replace(nm, "主体", 1)
                    break
            if "主体" not in d and "客体" not in d:
                d = "主体" + d
            descs.append(d)

    if not descs:
        # 兜底 1：整段里找带「主体」的片段
        allt = " ".join(lines)
        m = re.search(r"主体[^。\n]{0,30}", allt)
        if m:
            descs = [m.group(0).strip()]
        elif lines:
            # 兜底 2：云端有时完全不写占位符，直接用人名——
            # 取最长的一行当事件，后面 normalize_desc 会把人名换成占位符。
            cand = max(lines, key=len).strip()
            if cand:
                descs = [cand]

    # 过滤「空壳事件」：只有占位符/标点、没有实际动作的行不是事件。
    # 实测踩过：云端有时返回 "主体, 客体" 这种退化输出，被当成 EU 后
    # 召回完全跑偏（拿着空壳去章动，召回到毫不相关的节点）。
    def _has_content(s):
        core = re.sub(r"[主体客体\s,，、。！？!?「」『』（）()]", "", s or "")
        return len(core) >= 2

    def _ok(nd):
        if _is_noise_line(nd):
            return False
        if not _has_content(nd):
            return False
        # 事件描述里不该出现逗号——逗号是实体分隔符。
        # 留着会让后续章动拿着垃圾 query 乱走。
        if "," in nd or "，" in nd:
            return False
        return True

    out = []
    for d in descs:
        clean, src = split_src(d)
        nd2 = normalize_desc(clean, persons or ents)
        nd2 = clean_desc(nd2)
        if not _ok(nd2):
            continue
        if trivial_reason(nd2):
            continue          # 没营养，直接丢掉
        out.append({"ents": ents, "desc": nd2, "src": src})
    return out


# ---------------- 本地后端 ----------------
_local = {}


def _load_local(path=None):
    if "model" in _local:
        return _local["tok"], _local["model"]
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    p = path or os.environ.get("SEG_LOCAL_MODEL", "models/seg_full_fp16")
    tok = AutoTokenizer.from_pretrained(p, trust_remote_code=True)
    if tok.pad_token_id is None:
        tok.pad_token = tok.eos_token
    model = AutoModelForCausalLM.from_pretrained(
        p, torch_dtype=torch.float16, device_map="auto",
        trust_remote_code=True).eval()
    _local.update(tok=tok, model=model)
    return tok, model


def _seg_local(text, participants):
    import torch
    tok, model = _load_local()
    msgs = [
        {"role": "system", "content": SYS_PROMPT},
        {"role": "user",
         "content": f"在场人员：{participants}\n聊天记录：\n{text}\n→"},
    ]
    p = tok.apply_chat_template(msgs, tokenize=False,
                                add_generation_prompt=True)
    enc = tok(p, return_tensors="pt", truncation=True,
              max_length=1600).to("cuda")
    with torch.no_grad():
        out = model.generate(**enc, max_new_tokens=120, do_sample=False,
                             pad_token_id=tok.eos_token_id)
    return tok.decode(out[0][enc["input_ids"].shape[1]:],
                      skip_special_tokens=True)


# ---------------- API 后端 ----------------
# 关键：Windows 上 urllib 默认会读系统代理（Clash 之类），
# 而 api.xiaomimimo.com 是国内的，绕代理会慢 5 倍（实测 10s vs 2s）。
# 所以这里显式建一个「不走代理」的 opener。
_OPENER = None


def _get_opener():
    global _OPENER
    if _OPENER is None:
        import urllib.request
        _OPENER = urllib.request.build_opener(
            urllib.request.ProxyHandler({}))
    return _OPENER


def _dsh_ref(name):
    """从 DSH 的 .credentials.yaml refs 读取 key；不落盘、不回显。"""
    try:
        import yaml
        home = os.environ.get("DSH_HOME") or os.path.join(
            os.path.expanduser("~"), ".dsh")
        path = os.path.join(home, ".credentials.yaml")
        with open(path, encoding="utf-8") as f:
            doc = yaml.safe_load(f) or {}
        value = (doc.get("refs") or {}).get(name)
        return str(value).strip() if value else ""
    except Exception:
        return ""


# 只收录 OpenAI 兼容、且能用 API Key 调用的 provider。
# DSH 账号登录（如 deepseek-account）不在这里，交给 DSH 会话桥接。
_API_PROVIDERS = {
    "glm": {
        "label": "GLM",
        "base": "https://open.bigmodel.cn/api/paas/v4",
        "key_ref": "GLM_API_KEY",
        "model": "glm-5.3-flash",
    },
    "deepseek": {
        "label": "DeepSeek API",
        "base": "https://api.deepseek.com/v1",
        "key_ref": "DEEPSEEK_API_KEY",
        "model": "deepseek-chat",
    },
    "openai": {
        "label": "OpenAI",
        "base": "https://api.openai.com/v1",
        "key_ref": "OPENAI_API_KEY",
        "model": "gpt-4o-mini",
    },
}


def api_provider_info(provider):
    cfg = _API_PROVIDERS.get(str(provider or "").strip())
    if not cfg:
        raise RuntimeError(f"不支持的切分 API：{provider}")
    return {
        "provider": str(provider),
        "label": cfg["label"],
        "base": cfg["base"],
        "model": cfg["model"],
        "keyRef": cfg["key_ref"],
        "ready": bool(_dsh_ref(cfg["key_ref"]) or os.environ.get("SEG_API_KEY")),
    }


def api_providers():
    """只返回当前已经能直接调用的 API Key provider。

    DSH 账号登录（deepseek-account）不在这里；没有 key 的 provider 也不列，
    避免前端出现不可选的“缺 Key”项。
    """
    out = []
    for name in _API_PROVIDERS:
        info = api_provider_info(name)
        if info["ready"]:
            out.append(info)
    return out


def _seg_api(text, participants, timeout=60, provider=None, model=None):
    import urllib.request

    cfg = _API_PROVIDERS.get(str(provider or "").strip()) if provider else None
    if provider and not cfg:
        raise RuntimeError(f"不支持的切分 API：{provider}")
    base = (os.environ.get("SEG_API_BASE")
            or (cfg or {}).get("base") or "").rstrip("/")
    key = os.environ.get("SEG_API_KEY") or (
        _dsh_ref((cfg or {}).get("key_ref", "")) if cfg else "")
    model = (model or os.environ.get("SEG_API_MODEL")
             or (cfg or {}).get("model") or "glm-5.3-flash")
    if not base:
        raise RuntimeError("切分 API 缺少 base URL")
    if not key:
        raise RuntimeError(
            f"切分 API 缺少 Key：{((cfg or {}).get('key_ref') or 'SEG_API_KEY')}"
            "（在 DSH Models 页面添加，或设置环境变量）")

    # 参考条数随消息数对数增长：事件数增长比线性慢
    # （长对话会在同一话题上反复绕，不该按条数等比切）
    import math
    n_msg = sum(1 for line in text.split("\n") if "：" in line)
    ref = max(1, round(math.log2(max(2, n_msg))))
    lo, hi = max(1, ref - 1), ref + 2
    user = (f"在场人员：{participants}\n"
            f"本次输入 {n_msg} 条消息，通常对应 {lo}~{hi} 个事件。\n"
            f"聊天记录：\n{text}\n→")

    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYS_PROMPT},
            {"role": "user", "content": user},
        ],
        "max_tokens": 300,
        "stream": False,
    }
    # GLM 5.x 默认会先产出一大段 reasoning，切分这种抽取任务不需要。
    if (cfg or {}).get("key_ref") == "GLM_API_KEY":
        body["reasoning_effort"] = "low"
    req = urllib.request.Request(
        f"{base}/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {key}"},
        method="POST")

    last = ""
    for attempt in range(3):
        try:
            with _get_opener().open(req, timeout=timeout) as r:
                data = json.loads(r.read().decode("utf-8"))
            msg = data["choices"][0]["message"]
            content = (msg.get("content") or "").strip()
            if content:
                return content
            last = content
        except Exception as ex:
            last = f"[error] {ex}"
        # 空返回或失败：加大输出预算重试一次
        body["max_completion_tokens"] = 500
        req = urllib.request.Request(
            f"{base}/chat/completions",
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json",
                     "api-key": key,
                     "Authorization": f"Bearer {key}"},
            method="POST")
    return last


# ---------------- 统一入口 ----------------
def segment_multi(text, participants, backend=None, timeout=60,
                  provider=None, model=None):
    """返回 [{ents, desc}, ...]，每个是一��原子 EU。"""
    b = backend or os.environ.get("SEG_BACKEND", "local")
    persons = [x.strip() for x in re.split(r"[,，、]", participants or "")
               if x.strip()]
    # 云端偶发「有内容但解析不出事件」，重试 1 次
    attempts = 3 if b in ("api", "openai") else 1
    last = []
    raws = []
    for i in range(attempts):
        raw = (_seg_api(text, participants, timeout,
                        provider=provider, model=model)
               if b in ("api", "openai") else _seg_local(text, participants))
        raws.append(raw)
        last = _parse(raw, persons)
        if last:
            return last
    # 解析不出事件时把原始输出留下来，便于排查云端格式漂移
    if os.environ.get("SEG_DEBUG"):
        print("[seg] 解析失败，原始输出：", repr(raws), flush=True)
    return last


def segment(text, participants, backend=None):
    """兼容旧接口：只返回第一个 EU。"""
    eus = segment_multi(text, participants, backend)
    if not eus:
        return [], ""
    return eus[0]["ents"], eus[0]["desc"]


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    import time
    t = sys.argv[1] if len(sys.argv) > 1 else ""
    t0 = time.perf_counter()
    eus = segment_multi(t, "角色A、角色B")
    dt = (time.perf_counter() - t0) * 1000
    print(f"后端 {os.environ.get('SEG_BACKEND', 'local')}  耗时 {dt:.0f}ms")
    print(f"拆出 {len(eus)} 个 EU：")
    for k, e in enumerate(eus, 1):
        print(f"  [{k}] 实体 {e['ents']}")
        print(f"      {e['desc']}")

# ---------- 没营养的事件过滤 ----------
# 提示词里已经写了反例，但模型遵守度有限（实测「发两个表情」还是会留下），
_TRIVIAL = [
    # 只有「叫/喊 + 客体 + 为/做/成/个」这种起外号才算，不能把
    # 「叫客体进屋」当成称呼类闲聊
    (r"(称呼|叫|喊)(客体|主体)(为|做|成|个|作)", "叫称呼"),
    (r"(称呼|叫|喊)(客体|主体)$", "叫称呼"),
    (r"(表情|表情包|图片|图).{0,8}(发送|发|要|给|两个|几张)", "发表情"),
    (r"(发送|发|要|给).{0,8}(表情|表情包|图片)", "发表情"),
    (r"(问候|打招呼|冒泡|寒暄)", "问候冒泡"),
    (r"(复读|起哄|玩梗|调侃)", "玩梗"),
    (r"昵称", "换昵称"),
    (r"(戏称|称作|称为|叫成)", "叫称呼"),
    (r"单字", "单字应答"),
    (r"(回复|发送|回).{0,3}(一个字|两个字|一句)", "单字应答"),                       # 「回应客体的昵称切换」
    (r"(换|切换).{0,4}(称呼|昵称|名字)", "换昵称"),
    (r"(称呼|昵称|名字).{0,4}(切换|变化|换)", "换昵称"),
]
_IMPORTANT = re.compile(
    r"决定|约定|承诺|拒绝|答应|冲突|重要|变化|计划|项目|任务|工作|系统|接口|模型|记忆|规则")


# 空壳描述：只有动作、没有对象/内容，读者看完不知道发生了什么。
_EMPTY_SHELL = re.compile(
    r"(认下|应下|收下|获得回应|得到回应|作出回应|表示|确认|感谢|告别|退出|提及|表态)$")
_GENERIC_REF = re.compile(r"(缘由|所指|姓名|对象|内容|某事|这件事)$")


def vague_reason(desc):
    """描述太空泛（没有具体信息）时返回原因，否则 None。"""
    d = desc or ""
    m = _EMPTY_SHELL.search(d)
    if m:
        # 只有动词前面没有实质内容时才视为空壳。
        prefix = re.sub(r"主体|客体|的|了|着|在|和|与|对|把|被|给|并|且|是|向",
                        "", d[:m.start()])
        if len(prefix) <= 2:
            return "空壳动作"
    core = re.sub(r"主体|客体|的|了|着|在|和|与|对|把|被|给|并|且|是", "", d)
    if len(core) <= 3 and _GENERIC_REF.search(d):
        return "指代不明"
    return None


def trivial_reason(desc):
    """返回命中的琐碎类型；不是琐碎就返回 None。"""
    d = desc or ""
    vague = vague_reason(d)
    if vague:
        return vague
    if _IMPORTANT.search(d):
        return None
    for pat, tag in _TRIVIAL:
        if re.search(pat, d):
            return tag
    return None
