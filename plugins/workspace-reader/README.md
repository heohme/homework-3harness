# workspace-reader：工作区检索

这是可复制安装的独立 ESM 插件，只有 `plugin.json`、`index.mjs` 和本说明，不依赖 npm 包，也不导入宿主内部模块。它只使用 `ctx.call('workspace.list', …)` 和 `ctx.call('workspace.read', …)`；实际文本检索逻辑全部在插件内。

## 安装与配置

在应用目录 `apps/local-harness` 启动宿主，通过本地目录安装选择 `./plugins/workspace-reader`。先检查清单、完整性摘要和代码，再确认信任、配置以及 `workspace.read` 授权。安装后不会自动启用。也可以把整个插件目录复制到其他地方，再安装那个独立目录；无需修改宿主或注册内置业务分支。

默认配置为 `{"root":"./examples/workspace","maxResults":8}`。相对 `root` 由宿主按其定义的工作目录解析（本应用默认应用根目录 `apps/local-harness`），并规范化为绝对真实路径；兼容宿主使用其他工作目录时应相应设置 root，或提供明确的绝对目录。`root` 长度 1–1024，`maxResults` 是 1–100 的整数。任何配置改变都会使旧授权失效，必须再次授权并启用。

## 工具输入输出

所有输入是 JSON 对象，禁止未声明字段。`path` 是 1–1024 字符的根目录内相对路径，禁止绝对路径、反斜杠、空字符和 `..`。安全路径、敏感文件及符号链接检查最终由宿主 broker 执行；插件的前置校验不能替代宿主鉴权。

| 动态工具名 | 输入 | 输出 |
| --- | --- | --- |
| `workspace-reader__list` | `{"path":".","limit":8}`；两字段可省略 | `{"path":".","files":[{"path":"architecture.md","size":123}],"truncated":false}`；size 为实际字节数，此处 123 仅示意 |
| `workspace-reader__read` | `{"path":"architecture.md"}`；path 必填 | `{"path":"architecture.md","content":"文件实际文本…","truncated":false}` |
| `workspace-reader__search` | `{"query":"plugin","path":".","limit":8,"caseSensitive":false}`；只有 query 必填 | `{"query":"plugin","path":".","matches":[{"path":"architecture.md","line":4,"text":"业务能力由独立 plugin 提供，宿主不包含工作区检索或笔记业务分支。","textTruncated":false}],"scannedFiles":3,"truncated":false,"errorCount":0,"errors":[]}`；此处只展示一个匹配项，实际返回所有限定范围内命中 |

`list/search` 的 limit 是 1–100，实际限制为 `min(limit, config.maxResults)`。query 是去除首尾空白后的 1–200 字符字面量，不支持正则；默认不区分大小写。search 调用 list，然后真实读取文件，按 `CRLF/LF/CR` 分行，同一行只返回一次命中，行号从 1 开始。最长片段为 512 字符，尽量围绕命中，`textTruncated` 说明该行并非完整展示。文件顺序继承 broker 的稳定列表顺序。

## 数量、异常与隐私

宿主最多列出 100 个可读取文本文件，每文件最多读 64 KiB。插件另外限制最多扫描 100 个文件、最多输出 maxResults 个命中和 8 条单文件错误摘要。`scannedFiles` 统计成功读出的文件数，`errorCount` 是全部读取失败数量；超过 8 个失败仍统计，但不继续附加错误。`truncated` 表示文件枚举、文件内容或匹配数量至少一项受限，不应把结果视为完整检索。无命中返回空 matches；部分文件读取失败不会中断其他文件，返回 errors。list 本身失败、read 失败、无权限或取消由入口抛错，由宿主显示失败。

插件不写文件、不访问网络、不记录文件正文到日志。所有工具 `mutates:false`，但读取结果进入 Agent 上下文时仍可能包含数据；远程模型必须另行明确授权外发。只将无敏感示例用于演示。

## 独立验证

```sh
node --check plugins/workspace-reader/index.mjs
```

完整宿主权限、IPC、安装快照与 Agent 集成验证由宿主测试负责。可在测试中注入假的 ctx.call 检查插件结果，但这不等于真实宿主或模型验证。
