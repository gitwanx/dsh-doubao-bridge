# dsh-doubao-bridge（DSH 宿主插件）

把 `doubao_bridge/` 里的协作桥注册成 **8 个 DSH 原生工具**，任何 DSH 会话无需额外配置即可：
给豆包派活、取独立审阅意见、维护双方共用的分工任务板。

## 安装

```bat
dsh plugin --profile desktop add "C:\Users\wang'xing\Documents\deepseek-harness\default-workspace\plugins\dsh-doubao-bridge"
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
