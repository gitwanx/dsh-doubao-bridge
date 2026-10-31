# dsh-doubao-bridge（DSH 宿主插件）

## 这是什么 / 谁在用 / 怎么开始

DSH 宿主插件：把 `doubao_bridge/` 协作桥注册成 DSH 原生工具——给豆包派活、取独立审阅、维护双方共用的分工任务板。
谁在用：本机 DSH 桌面版会话（出规格+验收）+ 豆包桌面端（干活的执行体）。
怎么开始：装好插件 → `doubao_status` 探活 → `doubao_dispatch` 派第一单。

## 安装

```bat
dsh plugin --profile desktop add "%USERPROFILE%\Documents\deepseek-harness\default-workspace\plugins\dsh-doubao-bridge"
```

装完自动进 profile bundles、HMR 生效（刷新页面，工具出现在下一个回合）。不要再手工往 profile patch 里插一次——重复 id 会让加载器崩。

## 怎么用

- 派活：`doubao_dispatch {title, detail}` → 立刻拿 `task_id`，不阻塞；`detail` 落成 spec 文件，豆包读它。
- 跟进：`doubao_task_status` 看 phase / `result_file`；`doubao_task_result` 取交付（长文给 `result_file`，直接 read）。
- 豆包反问：`doubao_task_answer {task_id, choice}`。
- 旁路：`doubao_ask`、`doubao_review`、`doubao_brief`、`doubao_chats` / `doubao_read`、`doubao_mode` / `doubao_account`、`doubao_image` / `doubao_video`（媒体要一次一票授权）。
- 账本：`coop_board`（`list` / `add` / `claim` / `done` / `inbox`）。

## 配置

依赖三件：豆包桌面端 + 本地桥服务（`127.0.0.1:8765`，插件挂载时自动检查并拉起）+ 任务板 SQLite。
路径都在 `%LOCALAPPDATA%\DSHDoubaoBridge\`：

| 路径 | 是什么 |
| --- | --- |
| `specs\<task_id>.md` | 任务书，豆包读这份 |
| `results\` | 交付报告，即 `result_file` |
| `tasks\<task_id>.json` | 任务状态 |
| `board.sqlite3` | 分工任务板 |
| `server.log` | 桥日志 |

env 覆盖：`DOUBAO_BRIDGE_URL` / `DOUBAO_BRIDGE_DIR` / `DOUBAO_BRIDGE_PYTHON`。

## 已知限制 / 不在这里放什么

- 生视频 / 图生视频不派给豆包（桥直接 403），走其他渠道。
- 桥没起来时工具报错：先 `doubao_status`，它会顺手把桥拉起来。
- 仓库不含任何密钥/账号数据；豆包登录态是本机设备级的，不随仓库走。

## 版本与时间

v0.1.0 · 2026-11-01

---

## 原文档（保留）

把 `doubao_bridge/` 里的协作桥注册成 **8 个 DSH 原生工具**，任何 DSH 会话无需额外配置即可：
给豆包派活、取独立审阅意见、维护双方共用的分工任务板。

## 安装

```bat
dsh plugin --profile desktop add "%USERPROFILE%\Documents\deepseek-harness\default-workspace\plugins\dsh-doubao-bridge"
```

安装后 DSH 会热加载（无需重启），工具出现在下一个回合的工具列表里。

## 工具

| 工具 | 用途 |
| --- | --- |
| `doubao_status` | 探活：桥服务 / 豆包登录态 / 任务板统计 |
| `doubao_ask` | 问一句；`mode=new` 新对话、`mode=keep` 沿用本会话协作对话 |
| `doubao_dispatch` | 分工主入口：建任务→派给豆包→等交付→回填任务板 |
| `doubao_review` | 独立审阅（代码/diff/方案/文档） |
| `doubao_brief` | 往本会话协作对话灌背景简报 |
| `doubao_chats` / `doubao_read` | 列 / 读豆包会话 |
| `coop_board` | 任务板：`list` / `add` / `claim` / `done` / `inbox` |

## 运行前提

桥服务会在插件挂载时自动检查并拉起；桥接豆包实例由 `doubao_bridge/doubao_driver.py`
用独立 profile 启动，登录态是本机设备级的（通常自动完成）。

若插件找不到桥脚本，按顺序找：`%DOUBAO_BRIDGE_DIR%` → 工作区 `doubao_bridge/` →
插件目录 `py/`。也可以用环境变量显式指定：

```
DOUBAO_BRIDGE_DIR=C:\...\default-workspace\doubao_bridge
DOUBAO_BRIDGE_URL=http://127.0.0.1:8765
DOUBAO_BRIDGE_PYTHON=python
```

详见 `doubao_bridge/README.md`。
