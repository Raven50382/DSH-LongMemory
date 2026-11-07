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
import re
import sys
from alias import CANON   # 模块级，clean_desc 要用
_KNOWN_NAMES = set()      # 语料里出现过的说话人，consolidate 会填

SYS_PROMPT = """把一段 QQ 聊天记录整理成若干「事件单元」。

输出格式：
第一行：涉及的人名和物体名，逗号分隔
之后每行：一个事件 + 来源区间
    事件：8~18 字，用「主体」「客体」代替人名
    来源区间：这件事是从记录里第几行到第几行看出来的，写成 〔起-止〕
    例：
      主体帮客体上传会议材料 〔1-2〕
      主体排查接口配置 〔4-5〕

输入每行前面都有行号，形如 `3| 角色A：...`，那个 3 就是行号。

来源区间怎么标（很重要）：
- 要覆盖这件事**完整的来回**，一般 3~10 行；太短会丢掉前因后果
- **但不许跨到别的话题**：这个话题结束了就停，哪怕只有 2 行
- 宁可短一点，也不要为了凑行数把后面无关的聊天框进去
- 判断标准：这几行单独拿出来看，读者能明白发生了什么

**硬约束：描述必须完全来自你标的那几行。**
不许拿别处的信息凑进来——标了 〔10-12〕 就只能写 10~12 行里发生的事。
写完自己回读一遍：这个描述，光看那几行能不能证出来？不能就改区间或改描述。

例：
  1| 角色A：明天九点的会你来得及吗
  2| 角色B：来得及，我八点半到
  3| 角色A：那先把材料发我
  4| 角色A：对了，下午还要去取快递      ← 这里换话题了
  → 主体询问客体能否赶上会议 〔1-3〕      ✅ 停在话题结束处
  → 主体询问客体能否赶上会议 〔1-4〕      ❌ 多带了一句无关的

【什么算一个事件 - 最重要】
一个事件 = 一件「值得长期记住、以后可能被问到」的事。
**不是「某人说了一句话」。**

只记录有信息量的事：做了某个动作、发生了某个状况、达成了某个共识。

**无论如何，事件行至少要有一行。** 哪怕是很短的一句（"主体询问是否提交材料"），
也不允许只输出实体行就结束。只有整段全是"嗯""好""在吗"这类纯应答时才允许没有事件。

以下**不单独成条**：
- 寒暄、应答、调侃、语气词（"嗯""好""在吗""哈哈"）
- 同一话题下的小来回（要合并成一条）

**下面这些「没营养」的事，直接丢掉，别记：**
- 只是叫了个昵称 / 换了个称呼    ✗ 主体给客体起外号、主体要求客体改称呼
- 让它发表情 / 发几张图          ✗ 主体要求客体发送两个表情
- 打招呼 / 冒泡 / 催它上线       ✗ 主体呼唤客体冒泡
- 单纯的吐槽、起哄、复读、玩梗    ✗ 主体调侃客体的外号
- 一句半句的应答、确认、附和      ✗ 主体确认收到、客体说好

判断标准：**一个月后想起这段，这件事有用吗？**
  有用 = 做了决定、说了事实、发生了状态变化、达成了约定、聊到具体的东西
  没用 = 只是叫了个称呼、发了个表情、打了个招呼、嘴上互怼了两句
拿不准就丢掉——漏记一件小事，比记一堆垃圾更划算。

判断方法：假设一个月后回想这段对话，你会怎么跟别人概括？
  例：那天他跟我聊了项目排期，后来又改了需求，最后我加班到很晚
  → 这是 3 个事件，不是十几条。

【一个事件只能有一个动作】
- 每条只写一个动作，不能出现两个动词短语
- 禁止用「并」「和」「并且」「同时」「又」把两个动作连起来
    错：主体把文件放错目录并提及会议
    对：主体把文件放错目录  ＋  主体提及会议（拆成两条）
- 禁止嵌套从句（描述里不能再套一个"谁做了什么"）
    错：主体抱怨客体回复太慢
    对：主体抱怨客体的回复速度
- 状态和动作要分开
    错：主体无法打开附件要求重发
    对：主体无法打开附件
- 不要写因果链，不要用「但」「所以」「然后」串两件事

【合并规则】
判断是不是同一个事件，看「说的是不是同一个话题」：
- 同一个话题，来回十几句 → 合并成 1 条
- 话题换了（聊的东西变了）→ 分成新的一条
- 不要按消息条数切，要按话题切
- 也不要为了少输出几条，把不同话题硬揉在一起

【话题内条数上限】
同一个话题**最多 3 条**。超过 3 条说明你在按对话回合切，必须合并。
  错（同一话题切了 5 条）：
    主体催客体交报告
    主体指出报告格式有问题
    客体说还在改
    主体说今晚必须发出
    客体答应加班
  对（合并成 2 条）：
    主体催客体交报告并指出格式问题
    客体答应今晚改完发出

【角色】
描述里不要出现人名，统一用「主体」「客体」：
- **主体 = 做出这个动作的人**
- **客体 = 承受这个动作的人或物**
例：角色B提醒角色A交周报 → 「主体提醒客体交周报」
    角色A给手机充电 → 「主体给客体充电」

【实体行】
- 人名：对话里出现的人。代词（她/他/你/我）必须换成在场人员里的真实昵称
- 物体名：手机、耳机、插件、外卖、电脑、游戏名、网站名、系统名 等具体名词都要列
- 宁多勿少

示例1
在场人员：角色A、角色B
聊天记录：
角色A：明天九点开会，材料你带了吗
角色B：带了，U 盘和打印版都在包里
角色A：好，那我先过一遍流程
→ 角色A, 角色B, 会议, 材料, U盘
主体询问客体是否带会议材料 〔1-2〕
主体准备过会议流程 〔3〕

示例2
在场人员：角色B、角色A
聊天记录：
角色B：快递到了，放门口了
角色A：好，我下班去取
角色B：记得带伞，晚上有雨
→ 角色B, 角色A, 快递, 伞
主体告知客体快递已放门口 〔1〕
主体提醒客体下班带伞 〔3〕"""


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
    # 描述里不该出现真人名：开头的是主体，其余位置一律当承受者（客体）
    #   主体纠正角色C对会议时间的错误 -> 主体纠正客体对会议时间的错误
    #   主体角色C分享项目文档 -> 主体分享项目文档
    for nm in sorted(set(list(CANON) + list(_KNOWN_NAMES)), key=len, reverse=True):
        if not nm or len(nm) < 2:
            continue
        d = d.replace("主体" + nm, "主体")
        d = d.replace(nm, "客体")

    # 只合并「主体客体」这种直接相连的（云端把两个人名归一成了两个占位符）；
    # 「主体和客体」是有意义的并列，不能动
    d = re.sub(r"(主体|客体)(主体|客体)", r"\1", d)
    d = re.sub(r"(主体|客体)\1+", r"\1", d)                   # 主体主体 -> 主体
    # 一句里出现两个「主体」且没有「客体」时，第二个其实是动作的承受者：
    # 「主体向主体同步进度」->「主体向客体同步进度」
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
    #   "角色A, 主体询问是否提交材料"
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
        # 写事件，如「角色A告知角色B材料已提交」，第一行不能无脑当实体行。
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
            # 形如「角色A告知角色B项目已延期」——归一成占位符后接受
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
            #   "角色A告知角色B材料已提交"
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
        # 实测踩过：云端退化成 "我, 肚子" 这种「实体行伪装成事件行」，
        # 留着会让后续章动拿着垃圾 query 乱走。
        if "," in nd or "，" in nd:
            return False
        return True

    out = []
    for d in descs:
        # 云端会在事件后面标来源行号，形如「主体帮客体上传会议材料 〔1-2〕」
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


# ---------------- 统一入口 ----------------
def segment_multi(text, participants, timeout=60):
    """本地切分，返回 [{ents, desc}, ...]，每个是一个原子 EU。"""
    persons = [x.strip() for x in re.split(r"[,，、]", participants or "")
               if x.strip()]
    raw = _seg_local(text, participants)
    last = _parse(raw, persons)
    if not last and os.environ.get("SEG_DEBUG"):
        print("[seg] 解析失败，原始输出：", repr(raw), flush=True)
    return last


def segment(text, participants):
    """兼容旧接口：只返回第一个 EU。"""
    eus = segment_multi(text, participants)
    if not eus:
        return [], ""
    return eus[0]["ents"], eus[0]["desc"]


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    import time
    t = sys.argv[1] if len(sys.argv) > 1 else (
        "角色A：明天九点的会你来得及吗\n角色B：来得及，我八点半到\n"
        "角色A：那先把材料发我")
    t0 = time.perf_counter()
    eus = segment_multi(t, "角色A、角色B")
    dt = (time.perf_counter() - t0) * 1000
    print(f"本地切分  耗时 {dt:.0f}ms")
    print(f"拆出 {len(eus)} 个 EU：")
    for k, e in enumerate(eus, 1):
        print(f"  [{k}] 实体 {e['ents']}")
        print(f"      {e['desc']}")

# ---------- 没营养的事件过滤 ----------
# 提示词里已经写了反例，但模型遵守度有限（实测「发两个表情」还是会留下），
# 所以再兜一层规则。**含重要信号的一律不删**，避免误伤「项目上线发庆祝表情」这种。
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
    r"答应|拒绝|约定|承诺|决定|吵架|生气|难过|伤心|哭|生病|疼|"
    r"钱|token|模型|接口|系统|群|删|加|装|买|卖|工作|加班|睡|回家|见面|"
    r"离开|道歉|原谅|同意|反对|担心|害怕|记忆|人设|"
    r"唱歌|游戏|考试|上班|下班|吃药|医院")


# 空壳描述：只有动作、没有对象/内容，读者看完不知道发生了什么。
# 「主体认下」「主体获得回应」「主体追问缘由」都属于这种。
_EMPTY_SHELL = re.compile(
    r"(认下|应下|收下|获得回应|得到回应|作出回应|表示|确认|感谢|告别|退出|"
    r"追问缘由|否认所指|报出姓名|提及周末|确认进度|提及|表态)$")
_GENERIC_REF = re.compile(r"(缘由|所指|姓名|对象|内容|某事|这件事)$")


def vague_reason(desc):
    """描述太空泛（没有具体信息）时返回原因，否则 None。"""
    d = desc or ""
    m = _EMPTY_SHELL.search(d)
    if m:
        # 只有「动词前面没有实质内容」才算空壳：
        #   主体认下        -> 前面是空的      -> 拒
        #   主体下班后向客体确认进度 -> 前面有「下班后」-> 留
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
