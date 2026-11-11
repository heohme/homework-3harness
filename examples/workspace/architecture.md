# Harness 架构

LOOM 是纯本地 AI Agent Harness。宿主负责插件注册、JSON Schema 校验、授权、能力代理和有界 Agent 循环。
业务能力由独立 plugin 提供，宿主不包含工作区检索或笔记业务分支。
插件执行入口收到 tool、args、config，并通过 ctx.call 请求 broker 能力。
每次调用在独立 Node.js 子进程执行；进程隔离不是恶意代码安全沙箱。
动态工具名称采用 pluginId__name，因此新增工具不需要修改宿主。
