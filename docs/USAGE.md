# LOOM — 本地 AI Agent Harness

运行在本机的插件宿主，提供 CLI 和 Web 控制台。用户可以从本地目录安装插件，查看清单，配置与授权，启用工具并直接运行；连接真实模型后，Agent 可动态组合已启用插件的工具。没有 Manus 托管、代码上传、遥测或默认远程模型调用。

## 启动

需要 Node.js 20.19+ 和 npm。在仓库根目录执行：

```sh
cd homework-3harness  # 仓库根目录
npm ci --ignore-scripts
npm start
```

打开 **http://127.0.0.1:4317**。只允许本机访问，不绑定局域网。Ctrl+C 停止。默认不安装示例插件，请在“插件管理”中预检、信任并安装，再配置与授权。

这是纯本地源码应用，前端无编译步骤，不需要桌面安装包。服务不会设置系统自启动；电脑休眠或进程停止后需再次运行启动命令。

## 两个真实不同的插件

| 插件 | 实际能力 | 权限与数据 |
| --- | --- | --- |
| [工作区检索](../plugins/workspace-reader/README.md) | 列目录、读文本、按行搜索并返回路径与行号 | workspace.read，限制到配置的 root，不持久化工作区正文 |
| [本地笔记](../plugins/local-notes/README.md) | 新增、搜索和列出笔记 | storage.read / storage.write，按插件独立持久化，新增是写工具 |

宿主没有这两个插件的业务分支，只根据清单加载工具。`test/core.test.mjs` 还现场生成第三个反转文本插件，验证不修改宿主也能扩展。清单、入口和 README 位于各自独立目录，可单独复制分发。

工作区示例默认为本应用 `examples/workspace/`，不读取你的真实个人目录。笔记默认保存在私有 `.harness/storage/local-notes.json`；卸载插件会删除笔记，务必先备份。

## CLI 快速验证

以下命令在仓库根目录执行；它们使用同一宿主和持久化配置。安装需要明确声明已经审查可信代码；启用需要授权。

```sh
npm run cli -- plugins install ./plugins/workspace-reader --trust
npm run cli -- plugins enable workspace-reader --grant all
npm run cli -- tools run workspace-reader__search --args '{"query":"plugin"}'

npm run cli -- plugins install ./plugins/local-notes --trust
npm run cli -- plugins enable local-notes --grant all
npm run cli -- tools run local-notes__add --args '{"title":"架构判断","content":"插件协议与宿主业务分离","tags":["harness"]}'
npm run cli -- tools run local-notes__search --args '{"query":"协议"}'
```

查看与管理：

```sh
npm run cli -- plugins list
npm run cli -- plugins inspect ./plugins/workspace-reader
npm run cli -- plugins configure workspace-reader --config '{"root":"./examples/workspace","maxResults":4}'
# 配置改变后自动禁用并撤销授权，需重新 enable。
npm run cli -- plugins disable workspace-reader
npm run cli -- plugins uninstall local-notes --yes
npm run cli -- --help
```

手动执行写工具是你的直接指令；Agent 写工具则默认逐次确认，不能因为插件已经启用就默默写入。

## 真实模型接入

默认 Ollama 地址为 `http://127.0.0.1:11434`，模型名 `qwen3:8b`。本应用不安装 Ollama 或下载模型。你需要另行准备一个支持 tool calling 的模型，然后在“模型设置”中填写实际名称、保存并测试连接。

```sh
npm run cli -- model test
npm run cli -- agent "检索工作区中关于 plugin 的说明，给出带路径的摘要"
```

CLI 在交互终端中对写入逐次提问；非交互终端默认拒绝写入。仅在接受本次 Agent 所有写入风险时使用 `--approve-writes`，这不是默认设置。

兼容 OpenAI 接口可配置本机服务，或显式允许远程 HTTPS 地址。API key 仅从宿主环境变量 `HARNESS_MODEL_API_KEY` 读取，启动服务前在自己的终端设置；不在 Web 输入、不写插件配置。需要远程模型时，在模型设置中选择兼容协议、明确确认允许外发，或用 CLI：

```sh
# api.example 是占位地址，必须替换成你信任的真实服务。
npm run cli -- model set --provider openai --base-url https://api.example/v1 --model your-model --allow-remote
```

开启远程模型后，提示词、工具定义和被调用工具的结果可能离开本机。本次测试使用本机协议 fixture 验证调用机制；当前环境没有实际 Ollama 或已配置模型凭据，**不宣称已经验证真实模型质量**。插件直接运行不需要模型。

## 插件开发与技术文档

- [插件协议与第三方最小例子](PLUGIN_PROTOCOL.md)
- [技术架构与取舍](TECHNICAL.md)
- [安全、隐私与可信代码边界](SECURITY.md)
- [产品范围与交互](PRODUCT.md)
- [交付与验证记录](DELIVERY.md)

插件是经审查可信的代码。独立子进程、权限 broker、文件摘要、超时和环境清理**不是恶意代码安全沙箱**。陌生插件可能自行访问本机或网络，不能仅凭清单权限判定安全。

## 验证与可复现性

```sh
npm run check  # JavaScript 语法与 JSON 解析，不是类型检查
npm test       # 核心机制、实际子进程、HTTP 与本机模型协议 fixture
npm run test:ui # 针对操作后状态与表单交互的浏览器回归，使用已安装 Chrome
```

所有测试使用临时数据目录，不修改默认插件状态或真实工作区。前端直接由 Node 服务提供，无额外 build。依赖锁文件已提交；仅运行应用时可用 `npm ci --omit=dev --ignore-scripts`。

## 数据与故障恢复

默认数据目录是本应用 `.harness/`，已被 Git 忽略。它包含代码快照、配置、插件存储和最近 50 条运行摘要；提示词、详细事件和结果仅保留在进程内存。数据是明文，本机文件权限不替代磁盘加密与备份。

可用 `HARNESS_HOME` 或任意 CLI 命令的 `--home /absolute/path` 指定隔离数据目录。端口占用时不会自动换端口，可明确运行 `npm run cli -- serve --port 4318`。模型不可达可先直接运行工具。损坏的 JSON 不会自动覆盖；应停止宿主、备份并手动恢复。取消已开始的写入不保证回滚，重试前先检查实际数据。
