# 开发接口契约 v1

本文固定本次并行实现的接口。最终用户协议另见 PLUGIN_PROTOCOL.md。

## 插件

每个目录包含 `plugin.json` 与 ESM `index.mjs`（entry 可指定其他相对 .mjs 文件）。不执行安装脚本，不安装 npm 依赖。

```json
{
  "protocolVersion": 1,
  "id": "workspace-reader",
  "name": "工作区检索",
  "version": "1.0.0",
  "description": "读取和检索明确授权的工作区",
  "author": "LOOM examples",
  "entry": "index.mjs",
  "permissions": ["workspace.read"],
  "configSchema": {
    "type": "object",
    "properties": {"root": {"type": "string", "minLength": 1, "default": "./examples/workspace", "description": "授权读取的目录"}},
    "required": ["root"],
    "additionalProperties": false
  },
  "tools": [{
    "name": "search",
    "description": "检索工作区文本",
    "mutates": false,
    "inputSchema": {"type": "object", "properties": {"query": {"type": "string", "minLength": 1}}, "required": ["query"], "additionalProperties": false}
  }]
}
```

插件入口 `export default async function execute({ tool, args, config }, ctx)`。返回可 JSON 序列化结果。`ctx.call(method, params)` 请求宿主能力；`ctx.log(message)` 发送一行非敏感摘要。

能力方法：`workspace.list({path?:'.'})` → `{files:[{path,size}],truncated:boolean}`（递归最多 100 个文本文件）；`workspace.read({path})` → `{path,content,truncated}`（最多 64 KiB）；`storage.get({key})` → JSON 值或 null；`storage.set({key,value})` → `{ok:true}`。storage 按插件 id 隔离，get 需要 `storage.read`，set 需要 `storage.write`。权限仅约束 broker 的这些能力，不是 OS 沙箱。

workspace 根目录使用 config.root，宿主将其规范化为绝对真实路径。拒绝路径越界、符号链接和敏感文件；默认忽略隐藏文件、.git、node_modules、构建和 .harness。workspace.list 对输出进行筛选，read 拒绝非文本内容。工具名暴露为 `<pluginId>__<toolName>`。

## HTTP

全部 JSON，错误非 2xx 且为 `{error:{code,message}}`。只监听回环。GET `/api/session` → `{token}`；其余 API 需要 `Authorization: Bearer <token>`，Host 与 Origin 校验，无 CORS。前端 token 仅内存保留。

GET `/api/state` →

```json
{
  "version":"0.1.0",
  "plugins":[{"manifest":{},"enabled":false,"config":{},"grants":[],"digest":"sha256","installedAt":"ISO"}],
  "catalog":[{"path":"absolute local path","manifest":{}}],
  "tools":[{"name":"plugin__tool","pluginId":"plugin-id","description":"...","inputSchema":{},"mutates":false}],
  "runs":[{"id":"uuid","type":"tool","status":"success","toolName":"...","prompt":"...","startedAt":"ISO","endedAt":"ISO","events":[{"at":"ISO","type":"info","message":"...","data":{}}],"result":{},"error":{"code":"...","message":"..."}}],
  "model":{"provider":"ollama","baseUrl":"http://127.0.0.1:11434","model":"qwen3:8b","maxSteps":6,"allowRemote":false,"apiKeyConfigured":false},
  "security":{"host":"127.0.0.1","trustedPluginsOnly":true}
}
```

缺少的 run 字段省略。历史仅持久化摘要，重启后可能没有 prompt/events/result。状态：`running`, `awaiting_approval`, `success`, `error`, `cancelled`。

- POST `/api/plugins/inspect` `{path}` → `{path,manifest,digest,filesCount}`。
- POST `/api/plugins/install` `{path,digest,trusted:true}` → 安装记录。需要先 inspect，摘要不一致拒绝。安装后禁用。
- PUT `/api/plugins/:id/config` `{config}` → 记录；配置修改后自动禁用并清除授权。
- POST `/api/plugins/:id/enable` `{grants:[全部清单权限]}` → 记录。
- POST `/api/plugins/:id/disable` `{}` → 记录，正在运行的相关任务取消。
- DELETE `/api/plugins/:id` → `{ok:true}`；删除插件代码、配置与插件存储，先在 UI 确认。
- POST `/api/tools/run` `{name,args}` → HTTP 202 `{run}`，后台运行。手动运行写工具应由 UI 事先确认。
- POST `/api/agent/run` `{prompt}` → HTTP 202 `{run}`。不使用演示假模型，未连通时记录清晰错误。
- POST `/api/runs/:id/cancel` `{}` → `{ok:true}`。
- POST `/api/runs/:id/approve` `{callId,approved:boolean}` → `{ok:true}`；pending run 事件 `type:'approval'`，data 是 `{callId,name,args}`，写工具逐次批准。
- DELETE `/api/runs` → `{ok:true}`；没有运行中任务时清空历史和内存结果。
- PUT `/api/model` `{provider,baseUrl,model,maxSteps,allowRemote}` → 脱敏模型设置。provider 为 ollama/openai；key 只读宿主 `HARNESS_MODEL_API_KEY`，不要做输入框或返回真实 key。
- POST `/api/model/test` `{}` → `{ok:true,message}`；真实 HTTP 连接检查，失败标准错误。

Web 使用 1s 轮询；保留输入、焦点和弹窗，不每次重绘全部 DOM。运行状态可以轮询更新事件。输入表单依据工具 schema 自动生成，也允许高级 JSON。初始插件零安装：catalog 是真实本地示例目录，不是在线市场。

## 两个插件的边界

workspace-reader：`list`、`read`、`search`，只读取指定目录；config.root 如上，可增加 maxResults 默认 8。local-notes：`add`、`search`、`list`，独立持久化笔记，add 是 mutates true；权限 storage.read/storage.write；config 可有 notebook 默认 Inbox 与 maxNotes 默认 200。两插件通过协议访问 broker，不导入宿主内部代码。
