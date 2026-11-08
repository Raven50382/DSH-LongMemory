"""说话人别名映射：把聊天记录里的「她」「私聊」等标签换成规范名。

这是外层数据准备，不该让模型去猜。

⚠️ 真实昵称不写死在这里：
    从 file/alias.json 读（不进 git），格式：
        {"alias": {"她": "角色B", "私聊": "角色A"},
         "canon": ["角色A", "角色B"]}
    没有该文件时用下面的通用占位名，保证仓库本身是脱敏的。
"""
import json
import os
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

_DATA_ROOT = Path(os.environ.get(
    "XLIENS_DATA_ROOT", Path(__file__).resolve().parent.parent
)).resolve()
_CFG = _DATA_ROOT / "file" / "alias.json"

# 兜底：仓库自带的通用占位名（不含任何真实昵称）
_DEFAULT_ALIAS = {"她": "角色B", "私聊": "角色A"}
_DEFAULT_CANON = ["角色A", "角色B"]


def _load():
    try:
        d = json.loads(_CFG.read_text(encoding="utf-8"))
        alias = {str(k): str(v) for k, v in (d.get("alias") or {}).items()}
        canon = [str(x) for x in (d.get("canon") or [])]
        if not alias:
            alias = dict(_DEFAULT_ALIAS)
        if not canon:
            canon = list(dict.fromkeys(alias.values()))
        # 规范名自己映射到自己
        for c in canon:
            alias.setdefault(c, c)
        return alias, canon
    except Exception:
        a = dict(_DEFAULT_ALIAS)
        for c in _DEFAULT_CANON:
            a.setdefault(c, c)
        return a, list(_DEFAULT_CANON)


ALIAS, CANON = _load()

# 注意：主体/客体是【语义角色】，不是固定身份。
#   主体 = 动作的发出者
#   客体 = 动作的接受者（可以是人，也可以是物体）
# 同一句里谁做动作谁就是主体，不能写死某个身份一定是主体。


def canonical_speakers(text):
    """把文本里的说话人标签换成规范名，返回 (新文本, 在场人员列表)。"""
    out = []
    names = []
    for line in text.split("\n"):
        if "：" in line:
            sp, rest = line.split("：", 1)
            sp = sp.strip()
            real = ALIAS.get(sp, sp)
            if real not in names:
                names.append(real)
            out.append(f"{real}：{rest}")
        else:
            out.append(line)
    return "\n".join(out), names


if __name__ == "__main__":
    txt = sys.argv[1] if len(sys.argv) > 1 else "她：你好\n私聊：在"
    t, n = canonical_speakers(txt)
    print(t)
    print("在场人员:", n)
