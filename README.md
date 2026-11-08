# Xliens

> 不会遗忘的记忆机器人：**EU 事件单元 + CE 逻辑关联图 + 章动召回**。

Xliens 是 DeepSeek Harness（DSH）的长期记忆插件，也是一个可运行的 QQ 机器人桥接层。它把聊天整理成「主体 + 动作 + 客体」的事件单元（EU），用 Cross-Encoder 判断事件之间的逻辑关联，而不是只靠字面相似度或 top-k 截断。

- GitHub：<https://github.com/Raven50382/DSH-LongMemory>
- Gitee：<https://gitee.com/Raven50382/deep-seek-harness-long-memory>
- License：GPL-3.0

---

## 特性

- **不淘汰记忆**：所有 EU 都进入图，不做容量淘汰
- **不截断 top-k**：从入口沿关联边走，能走到哪算哪
- **逻辑关联**：CE 对事件单元之间的逻辑关系打分，不依赖词重叠
- **QQ 桥接**：SnowLuma → DSH 会话，支持群聊 / 私聊白名单
- **可视化管理**：DSH 设置页和 Web 控制台
- **数据管理**：工作目录迁移、逻辑图备份与恢复
- **群聊参与**：不是只等点名，也能在自然讨论中接话

---

## 一键安装

### 前置条件

- Windows 10/11
- DeepSeek Harness（DSH）已安装并至少启动过一次
- Node.js 20+（DSH 自带运行时也可以）
- Python 3.10+
- SnowLuma 已安装并登录过 QQ
- 能访问 GitHub / PyPI；国内网络可先配置代理

### 安装

```powershell
git clone https://github.com/Raven50382/DSH-LongMemory.git
cd DSH-LongMemory

powershell -ExecutionPolicy Bypass -File .\install.ps1
```

也可以直接双击 `install.cmd`。

安装脚本会：

1. 检查 Node / Python
2. 安装 Python 依赖（torch、transformers、numpy）
3. 安装插件依赖（MCP SDK、SnowLuma SDK、zod）
4. 从模板生成 `bot/cordis.patch.yml`
5. 初始化 `file/alias.json`
6. 把插件注册进 DSH profile，并备份原 `package.json`

装完后**完整重启 DSH**，打开 **设置 → Xliens**。

---

## CE 模型

CE 模型（v48_s3，约 2.1GB）在 GitHub Release：

<https://github.com/Raven50382/DSH-LongMemory/releases/tag/ce-model-v48-s3>

下载分片和 `.sha256` 后合并：

```powershell
cmd /c copy /b ce_model_v48_s3.tar.part00+ce_model_v48_s3.tar.part01+ce_model_v48_s3.tar.part02 ce_model_v48_s3.tar
# Linux/macOS:
# cat ce_model_v48_s3.tar.part* > ce_model_v48_s3.tar
# sha256sum -c ce_model_v48_s3.sha256
tar xf ce_model_v48_s3.tar
```

解压后把 `ce_model_v48_s3/` 重命名为 `models/reg_v48_s3/`（或把里面的文件放进该目录）。
目录名要和 `bot/lib/index.js` 里的 `memory.model` 一致。

仓库不附带任何逻辑图；首次启动会创建一个空的 `graph_main/`，你可以导入自己的图或从整备开始。

---

## 配置

### SnowLuma

在 SnowLuma 里登录 QQ，然后在 DSH 设置页的 Xliens「白名单」里填入允许的群号 / 私聊 QQ 号并保存。

**默认不响应任何消息。** 只有加入白名单的会话才会进入机器人桥接。

SnowLuma 路径用 `-SnowlumaHome` 指定（不传则用 `%LOCALAPPDATA%\SnowLuma2`）：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -SnowlumaHome "<SNOWLUMA_HOME>"
```

---

## 运行

插件会随 DSH 启动自动拉起：

- SnowLuma（如未运行）
- Python 记忆服务 `127.0.0.1:8317`
- MCP 记忆工具

使用入口：

- **QQ 群 / 私聊**：只处理白名单会话
- **Web 控制台**：设置页里的「打开 Web 控制台」，默认 `http://127.0.0.1:<DSH端口>/xliens/web`
- **独立控制台**：直接运行 Python 服务时，`http://127.0.0.1:8317` 是自带页面
- **设置页**：DSH → 设置 → Xliens

---

## Web 控制台

控制台和 DSH 使用同一个本地 Web 服务，不需要单独启动前端。打开后左侧是功能区，顶部显示当前页面标题和记忆服务状态。

### 总览

显示记忆服务、节点与边数量、CE 运行方式，以及整备和落盘入口。

### 逻辑图

查看逻辑图节点与边。可以搜索节点、查看邻居和节点详情，也可以使用页面上的阈值设置控制边的显示。

### 章动过程

查看章动召回的运行记录和关联路径。

### 整备

配置定时整备、切分服务与切分模型。

- 「立刻整备」会处理尚未整备的消息，结果先进入落盘页，不直接写图
- 没有产生新落盘批次时，按钮保持灰色，直到出现新批次
- 自动模式会跳过人工审查，直接入图

### 落盘

审查整备产生的批次，确认后再写进逻辑图。

批次列表：

- 永远按创建时间倒序
- 状态分为待审查、已入图、已丢弃
- 点击批次切换当前审查对象

待审查批次：

- 点击图中的本批节点打开右侧详情
- 可以修改描述、时间、主体、客体和原始对话
- 修改后点「保存」写入批次
- 「锁定」决定确认入图时是否保留该节点
- 「删除」会从当前批次永久移除该节点，不能撤销
- 候选边可以改分、删除或手动连边

确认入图：

- 只写入已锁定节点
- 未锁定节点在确认时会被丢弃
- 入图后批次变为只读，不能修改、删除节点或丢弃

出图：

- 只对已入图批次可用
- 会移除该批次新增的节点及关联边
- 批次恢复为待审查，之后可以继续修改并重新入图
- 旧批次如果没有新增节点记录，出图会禁用，避免误删

候选边：

- 图上的虚线只连接达到「边显形阈值」的候选边
- 低于阈值的候选默认折叠
- 右侧候选列表底部有「展开隐藏边 / 收起隐藏边」，只影响列表，不改变图上的阈值
- 展开或收起不会重置列表滚动位置

### 白名单

管理允许机器人参与的群和私聊。未加入白名单的会话不会进入桥接。

### 人设

编辑机器人的人设内容。

### 主人

配置主人身份、称呼和机器人自己的名字。

### 系统

查看记忆服务、回收站、阈值和接口状态。边显形阈值在这里调整。

### 数据与存档

查看当前工作目录，迁移数据目录，备份和恢复逻辑图。

### 插件详情

查看插件版本、检查更新和仓库入口。

### 推荐操作顺序

1. 在「白名单」加入需要参与的会话
2. 在「人设」和「主人」完成基础配置
3. 在「整备」确认切分服务和定时窗口
4. 需要手动处理时，在「落盘」审查批次
5. 锁定需要保留的节点后确认入图
6. 已入图批次需要调整时，先「出图」再修改，最后重新入图

---

## 数据目录

```text
graph_main/          真实 EU 图
graph_backup_*/      逻辑图备份
pending/             未整备的聊天
file/                配置、凭证、人设、别名
logs/                运行日志
models/              CE 模型
```

这些目录都不进 git。

设置页的「数据与备份」可以：

- 查看当前数据目录
- 选择新目录并迁移（复制，旧目录保留）
- 备份当前逻辑图
- 从历史备份恢复

迁移后需要重启 DSH；旧的 8317 会自动停止。

---

## 手动安装

```powershell
py -3 -m pip install -r requirements.txt

cd bot
npm install
cd ..

Copy-Item bot\cordis.patch.yml.example bot\cordis.patch.yml
# 把模板里的 {{NODE}}、{{ROOT}}、{{SNOWLUMA_HOME}} 换成你机器上的路径
```

然后把 `xliens` 以 `link:<仓库>/bot` 加进 DSH profile 的 `dependencies` 与 `dsh.profile.bundles`，重启 DSH。

模板在 [`bot/cordis.patch.yml.example`](bot/cordis.patch.yml.example)。

---

## 仓库结构

```text
bot/                    DSH 插件
  lib/index.js          插件入口：会话、桥接、启动服务
  lib/bridge.js         QQ 消息 → 唤醒判定 → DSH 会话
  lib/client.js         DSH 设置页 UI
  lib/web-console.js    Web 控制台静态服务
  lib/api-routes.js     /xliens/api 安全转发
  lib/mcp-memory.js     recall_semantic / recall_logic / consolidate
  presets/chat.patch.yml
  web/                  Web 控制台前端

code/                   Python 记忆服务
  serve.py              8317 记忆服务
  demo_engine.py        CE + 图召回
  segment_api.py        EU 切分
  alias.py              说话人别名

file/                   *.example 配置模板
install.ps1             一键安装
install.cmd
requirements.txt
```

---

## 版本记录

版本更新记录见 [CHANGELOG.md](CHANGELOG.md)。

**每次里程碑改动都必须追加更新记录。**

---

## 安全

- 不要提交真实聊天记录、QQ 号、昵称、API Key、SSH 密码
- `file/`、`graph_main/`、`pending/`、`logs/`、`models/` 已在 `.gitignore`
- 凭证放在本地 `file/snowluma.ws`，不要提交
- 如果发现自己的 Key 曾经泄露，请立即轮换

---

## License

GPL-3.0，见 [LICENSE](LICENSE)。
