# 本地插件协议 v1

本文面向 LOOM / Local Agent Harness 的插件开发者。宿主只提供注册、校验、能力代理、进程执行和 Agent 循环；笔记、检索等业务属于插件。协议入口和能力方法与 [CONTRACT.md](./CONTRACT.md) 一致。运行要求 Node.js 20.19+，插件是独立 JavaScript ESM 目录，不需要也不允许导入宿主内部实现。

## 1. 分发目录与信任边界

一个插件目录至少包含 `plugin.json` 与清单 entry 指定的 `.mjs` 文件，推荐附带中文 `README.md`：

```text
my-plugin/
  plugin.json
  index.mjs
  README.md
```

entry 必须是包内相对路径，不能是绝对路径或含 `.` / `..` 路径段；入口可以使用包内其他 `.mjs` 模块和 Node.js 标准库。示例插件没有 npm 依赖。宿主不执行安装脚本、不下载依赖，不根据业务类型打补丁。分发目录不能包含符号链接、隐藏文件或 node_modules；单个文件最大 1 MiB，整个目录最多 64 个文件、2 MiB。安装的是文件快照，不是源目录链接。

**插件是经审查并信任的本机代码，独立进程不是恶意代码安全沙箱。** 插件以本机用户权限运行，Node.js 代码理论上可直接访问文件系统、网络或创建其他进程。manifest.permissions 只约束 `ctx.call` broker 方法，不能阻止恶意插件绕过 broker。进程超时、精简环境、输出限制和摘要校验只降低意外影响，不能替代 OS 隔离。不要安装陌生代码、包含秘密的目录或“看起来权限很少”但未审查的插件。

工作区内容、工具结果和插件存储都可能包含隐私。插件应只读取任务必需的数据，不把正文写入日志，不主动外发数据。默认使用本机模型；将结果发送至远程模型必须另外明确允许数据外发。模型没有连接时不允许伪造 AI 成功结果。

## 2. plugin.json 清单

清单根对象禁止额外字段。字段如下：

| 字段 | 必填 | 约束与用途 |
| --- | --- | --- |
| protocolVersion | 是 | 固定数字 `1`；其他版本拒绝安装 |
| id | 是 | `^[a-z][a-z0-9-]{0,31}$`，安装身份、隔离存储和工具名前缀；同 id 不能重复安装 |
| name | 是 | 1–80 字符的展示名称 |
| version | 是 | `数字.数字.数字`，最长 32 字符，如 `1.0.0`；不是自动更新指令 |
| description | 是 | 1–500 字符，说明功能和数据边界 |
| author | 否 | 最长 100 字符的作者标识，不表示宿主认证 |
| entry | 是 | 包内 `.mjs` 相对路径，最长 160 字符 |
| permissions | 是 | 不重复的数组，可为空；最多 3 项，当前只接受下表能力权限 |
| configSchema | 是 | 以 object 为根类型的 JSON Schema；校验持久化配置 |
| tools | 是 | 1–20 项；同一插件内 name 不重复 |

每个 tools 项同样禁止额外字段，必须包含：

| 字段 | 约束 |
| --- | --- |
| name | `^[a-z][a-z0-9_]{0,29}$`，插件内的工具名，不包含 id 前缀 |
| description | 1–500 字符；供用户和模型了解用途，不能代替权限检查 |
| inputSchema | object 根类型的 JSON Schema，描述 args |
| mutates | 必填 boolean；会写入或产生副作用的工具必须为 true |

**动态工具名为 `pluginId__name`。** 例如 `workspace-reader__search` 与 `local-notes__add`。只有已安装、完整性检查通过、已授权并启用的插件工具进入动态工具目录和模型 tools 列表。传给插件入口的 tool 是未带前缀的 `search` / `add`。第三方插件无需修改宿主业务代码或硬编码工具列表。

### JSON Schema 规范

当前使用 Ajv 校验 JSON Schema（推荐 draft-07 基本关键字），配置与工具输入均以 object 为根。给 properties 声明类型、字符串 minLength/maxLength、整数 minimum/maximum、数组 maxItems/items/uniqueItems，使用 required 指定必填，并明确 `additionalProperties:false`，包括自行引入的嵌套对象。不要通过 `$ref` 请求下载远程 schema，也不要依赖宿主安装你的 schema 扩展。

宿主会应用 `default`，再验证配置或工具输入；不会依赖 UI 隐藏字段来完成校验。`default` 不是类型转换：例如 `"20"` 不是整数 20。缺失必填字段、越界、额外字段或非法 schema 必须失败。JSON Schema 的 minLength 不排除全空白字符串，插件应再次检查业务所需的非空白及跨字段约束。示例插件也提供运行时校验，便于脱离宿主的单元测试。

配置示例：

```json
{
  "type": "object",
  "properties": {
    "root": {"type":"string","minLength":1,"maxLength":1024,"default":"./examples/workspace"},
    "maxResults": {"type":"integer","minimum":1,"maximum":100,"default":8}
  },
  "required": ["root", "maxResults"],
  "additionalProperties": false
}
```

宿主安装时应用默认值，但允许缺少必填配置或默认工作区尚不存在，插件保持禁用。用户须先补充并保存有效配置，启用时会强制校验 Schema 与工作区实际目录。相对 root 按宿主定义的工作目录解析，本应用默认是仓库根目录，之后规范化为绝对真实目录。不要按插件子进程 cwd 自行解析 root，也不要在 broker 参数中换根目录。

## 3. 入口、返回值与上下文

统一入口：

```js
export default async function execute({ tool, args, config }, ctx) {
  // tool 是插件内工具名；args/config 是经过宿主 schema 校验的 JSON 对象。
  const result = await ctx.call('workspace.read', { path: args.path });
  return { path: result.path, content: result.content, truncated: result.truncated };
}
```

该示例只解释入口形状；清单仍需声明 read 工具、path 输入和 workspace.read 权限。每次调用使用新子进程，所以模块变量和进程内缓存不能作为持久化存储。只返回实际可 JSON 序列化值，推荐明确对象，不返回 undefined、函数、BigInt、循环引用或伪造成功状态。插件返回值直接成为宿主执行结果，不必套一层 `{result:…}`，也不用写到 stdout。

`ctx.call(method, params)` 返回 Promise。params 为 JSON 对象，成功值见下一节；权限、路径、存储或其他能力错误以 Promise rejection 传入插件。`ctx.log(message)` 是非敏感摘要日志接口，最多截取 500 字符。不要用 console.log 输出正文、令牌或用户资料。stdout/stderr 不是返回结果通道，宿主不转发或持久化它们的原文。

## 4. broker 能力方法

| 方法 | 参数 | 成功返回 | 所需权限 |
| --- | --- | --- | --- |
| workspace.list | `{"path":"."}`；path 可省略，根内相对目录 | `{"files":[{"path":"architecture.md","size":123}],"truncated":false}`；size 实际字节数 | workspace.read |
| workspace.read | `{"path":"architecture.md"}` | `{"path":"architecture.md","content":"实际文件文本","truncated":false}` | workspace.read |
| storage.get | `{"key":"notes"}` | 已保存 JSON 值，未创建时 null | storage.read |
| storage.set | `{"key":"notes","value":[]}` | `{"ok":true}` | storage.write |

workspace 方法统一使用当前已授权的 config.root；参数中的 path 是相对**根目录**而非相对插件目录，list 子目录返回的文件 path 仍相对根目录，可直接传给 read。broker 拒绝越界、绝对路径、符号链接和敏感路径；过滤隐藏文件（包括 .git、.harness、.env）、密钥类型、node_modules 及依赖/构建目录，仅支持已知文本类型，read 检查二进制内容。禁止把这些过滤规则视为完整的敏感数据识别器：普通 txt 也可能包含秘密，根目录必须由用户确认。

list 递归最多输出 100 个文本文件，同时限制枚举条目和深度；read 最多读取 64 KiB。`truncated:true` 表明返回不是完整列表或完整文件，插件与 Agent 应保留此提示。workspace-reader 只通过上述方法读取，实际按行搜索发生在插件，不在宿主 broker。

storage 按插件 id 隔离，不能选择其他插件 namespace。key 必须匹配 `^[a-zA-Z0-9_-]{1,64}$`。set 覆盖指定 key，value 需可 JSON 序列化；broker 的单值上限 512 KiB，但子进程消息上限更低，不能因此发送 512 KiB IPC。local-notes 统一使用 key `notes`，为整个笔记 JSON 数组设置 96 KiB 预算以给 128 KiB IPC 信封留余量。配置中的 maxNotes 另有 1–1000 数量上限，默认 200。

每次 broker 请求重新检查插件当前启用状态、摘要、配置和授权，不能因入口启动成功就继续使用已撤销能力。`mutates:false` 的插件工具不能借已有 storage.write 授权隐蔽写入；副作用必须如实声明并走宿主写入审批。v1 不提供网络、shell、模型或任意文件写入 broker 方法。

get→set 不是事务式追加，协议没有 CAS。同一宿主拒绝同插件并发（PLUGIN_BUSY）；共享本机数据目录的 CLI / Web 实例还使用插件级运行锁覆盖完整调用及在途 broker 收尾，避免读改写交错，等待过久返回 STATE_BUSY。storage.set 在全局写锁内再次校验取消与授权；卸载先撤权，再等待插件运行锁后删除。此机制仅适用于同一台机器的本地文件系统，不是分布式事务；兼容宿主须保留串行约束或提供更强存储协议。

## 5. 安装、配置和运行生命周期

1. **独立目录预检**：用户提供本机目录，宿主读取清单、编译 schema、检查 entry、大小及文件类型，计算所有分发文件的 SHA-256 摘要，展示权限与 configSchema。仅预检不会执行插件入口。
2. **信任确认与安装**：用户审查代码，明确 `trusted:true`，同时提供预检 digest。安装时重新计算摘要，变化则拒绝。宿主复制快照到 `.harness/plugins/<id>/`，保存清单、摘要和默认配置；初始 disabled、grants:[]。不运行 npm install。
3. **配置与授权**：校验 config，工作区 root 规范化为真实路径。启用必须显式授予清单中全部 permissions，包括空权限插件的 grants:[]。授权只针对当前代码快照和配置，不代表无限期信任所有未来版本。
4. **配置变化重新授权**：无论更改 root、notebook、数量上限或其他配置，宿主都会取消相关任务、禁用插件并清空 grants。用户须重新检查配置和权限，再授权启用。旧 root 的授权不能复用于新目录。
5. **动态调用**：先确认工具存在/可用、校验 args、核验安装快照完整性，然后创建子进程。只读工具直接运行；写入工具需要逐次批准。手动调用由控制台或 CLI 在执行前确认，Agent 调用进入 awaiting_approval，不能把安装授权等同于本次写入批准。
6. **禁用与取消**：禁用移除动态工具、清空授权并取消相关活动任务。取消和超时终止插件进程，但不自动回滚已经提交的 storage.set；失败后先查看实际笔记再重试，以免重复新增。
7. **卸载与版本变化**：卸载先停止运行，删除快照、记录及该插件存储。local-notes 所有笔记会被删除，须先备份。当前不做自动更新；同 id 再安装需先卸载，不能把更新说成无损迁移。

典型 API 对应 inspect、install、config、enable、disable、uninstall，具体 HTTP 路由见 CONTRACT.md。HTTP 是本机回环服务，有会话令牌及 Host/Origin 校验；不要把进程 IPC 直接暴露给网页或公网。

## 6. 进程 IPC

宿主通过 Node.js child_process.fork 启动通用 `plugin-worker.js`，使用专用 IPC 通道和 JSON 序列化，不解析 stdout 的“协议行”。worker 的 cwd 是安装快照目录，宿主不透传模型 API 密钥等完整环境。插件开发者通常只写入口与 ctx.call；以下是当前 v1 桥接消息，便于调试兼容执行器，不要求插件自行监听 process.on('message')。

```js
// 宿主 → worker：一次调用只接收一次 execute
{ type: 'execute', entry: '/absolute/snapshot/index.mjs', tool: 'search', args: { query: 'plugin' }, config: { root: '/absolute/workspace', maxResults: 8 } }

// worker → 宿主：ctx.call 转为能力请求，id 在本进程内递增
{ type: 'rpc', id: '1', method: 'workspace.list', params: { path: '.' } }

// 宿主 → worker：对应 id 的成功或失败响应
{ type: 'rpc-result', id: '1', value: { files: [], truncated: false } }
{ type: 'rpc-result', id: '1', error: { code: 'PERMISSION_DENIED', message: '插件未授权或已禁用。' } }

// worker → 宿主：最终结果、错误或摘要日志
{ type: 'result', value: { matches: [] } }
{ type: 'error', error: { code: 'PLUGIN_ERROR', message: '插件执行失败。' } }
{ type: 'log', message: '完成有界检索' }
```

worker 等待入口 Promise 完成，将返回值发为 result 后退出；入口抛错转为 error 后退出。RPC error 恢复为带 code 的 Error，ctx.call 的 await 会抛出。宿主在单次执行内串行处理 broker 请求，收到最终结果/错误后结束进程。IPC 断连退出，不复用该 worker。

当前默认资源限额：单次插件调用 15 秒、Node.js 老生代堆 96 MiB（不是整个进程内存的硬性 OS 上限）、stdout/stderr 合计 64 KiB、每条 worker→宿主 JSON 消息 128 KiB、RPC 与 log 合计最多 200 条。限制覆盖插件导入、入口执行及等待 broker 的时间；workspace search 最多 list 1 次加 read 100 次，在消息数量限制内。兼容宿主更改限额时须明确告知插件，不要依赖无限执行或无限输出。

## 7. 错误、超时与结果语义

业务错误可以明确抛出带 code 的 Error：

```js
const error = new Error('笔记已达到上限，未写入。');
error.code = 'NOTES_FULL';
throw error;
```

不要把权限错误吞掉后返回空数据，也不要返回 `{ok:true}` 掩盖磁盘写入失败。允许的部分成功必须明确：workspace-reader.search 在 list 成功后逐文件捕捉读取错误，返回有界 errors、总 errorCount 及真实 matches；其他文件仍继续搜索。list 本身或单独 read 失败则整体失败。

| 错误类别 | 典型 code |
| --- | --- |
| schema / 输入 | INVALID_SCHEMA、VALIDATION_ERROR；插件运行时 INVALID_INPUT |
| 安装 / 完整性 | TRUST_REQUIRED、PACKAGE_CHANGED、INVALID_MANIFEST、SYMLINK_DENIED、INTEGRITY_ERROR |
| 授权 / 路径 | PERMISSION_DENIED、TOOL_UNAVAILABLE、PATH_DENIED、SENSITIVE_FILE、BINARY_DENIED |
| 插件业务 | UNKNOWN_TOOL、NOTES_FULL、STORAGE_LIMIT、STORAGE_CORRUPT、BROKER_RESPONSE_INVALID |
| 进程与限额 | PLUGIN_TIMEOUT、PLUGIN_CRASH、PLUGIN_START_FAILED、PLUGIN_ERROR、OUTPUT_LIMIT、SIZE_LIMIT、RPC_LIMIT |
| 执行状态 | CANCELLED、PLUGIN_BUSY、RUN_LIMIT |

不必依赖某一种 OS 文件错误细节。消息应简短、不包含凭据、完整正文或堆栈。宿主 HTTP 同步失败为非 2xx 与 `{"error":{"code":"…","message":"…"}}`。工具运行 API 返回 202 只是已创建后台 run，不是执行成功；最终检查 run.status 为 success/error/cancelled、run.result 或 run.error。Agent 写入可能处于 awaiting_approval。历史磁盘只保留摘要，运行结果和正文默认只在内存，重启后不保证可恢复。

超时或取消会终止进程；这不是存储回滚协议。一次 add 若已经 set 成功但结果消息随后丢失，调用方应先 list 检查再决定重试。v1 没有幂等新增键，不应自动无限重试写工具。

## 8. 第三方最小例子：tiny-echo

在任意普通本地目录建立以下三个文件，就可安装一个全新工具，**不用改宿主、package.json 或内置插件列表**。这是返回输入的纯计算工具，不请求 broker，不访问文件或网络，所以 permissions 是 []、mutates 是 false；实际新增业务可在此入口中调用已经授权的通用能力。

`plugin.json`：

```json
{
  "protocolVersion": 1,
  "id": "tiny-echo",
  "name": "本地回声",
  "version": "1.0.0",
  "description": "只回传有界文本，演示无需修改宿主的第三方扩展。",
  "entry": "index.mjs",
  "permissions": [],
  "configSchema": {"type":"object","properties":{},"additionalProperties":false},
  "tools": [{
    "name": "echo",
    "description": "回传输入文本，不产生副作用。",
    "mutates": false,
    "inputSchema": {
      "type": "object",
      "properties": {"text":{"type":"string","minLength":1,"maxLength":200}},
      "required": ["text"],
      "additionalProperties": false
    }
  }]
}
```

`index.mjs`：

```js
export default async function execute({ tool, args, config }, ctx) {
  // ctx 是宿主提供的上下文；此纯计算工具无需请求任何能力。
  if (tool !== 'echo' || !args || typeof args !== 'object' || Array.isArray(args) ||
      Object.keys(args).some((key) => key !== 'text') ||
      typeof args.text !== 'string' || args.text.length < 1 || args.text.length > 200) {
    const error = new Error('echo 输入必须是唯一字段 text，长度 1–200。');
    error.code = 'INVALID_INPUT';
    throw error;
  }
  return { echo: args.text };
}
```

`README.md` 写明：“本插件只返回最多 200 字符输入，无持久化、网络或文件访问。先审查代码，再预检、确认信任、安装并使用 grants:[] 启用。”

验证 `node --check /本地目录/tiny-echo/index.mjs`，然后在控制台通过本地目录安装流程选择 `/本地目录/tiny-echo`。配置为 `{}`，显式启用后动态目录出现 `tiny-echo__echo`。手动输入 `{"text":"plugin/privacy"}`，实际输出 `{"echo":"plugin/privacy"}`。禁用后工具从模型可用目录消失，整个过程中不修改宿主。新增 broker 之外的系统能力属于宿主协议演进，不能伪装为当前 v1 支持的方法。

## 9. 本仓库示例与验证边界

- [workspace-reader](../plugins/workspace-reader/README.md)：list/read/search，root 默认 `./examples/workspace`、maxResults 默认 8；真实读取文本、按行输出、有界匹配及读取错误。
- [local-notes](../plugins/local-notes/README.md)：add/search/list，notebook 默认 Inbox、maxNotes 默认 200；持久化 uuid/date/title/content/notebook/tags，add 写入、search/list 只读。
- [示例工作区](../examples/workspace/)：架构、privacy 与迭代的无敏感文本，包含 plugin/privacy 检索词，不是生产用户数据。

插件语法检查与注入模拟 broker 的单元检查只能证明入口和业务逻辑。实际安装快照、授权撤销、IPC、磁盘持久化、Agent 写入批准、真实模型和第三方扩展的端到端验证由宿主测试负责；未运行不得标记为已通过。
