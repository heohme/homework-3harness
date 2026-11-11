# local-notes：本地笔记

独立、无 npm 依赖的 ESM 插件，只从 Node.js 标准库导入 `randomUUID`，不导入宿主模块。全部笔记业务在本目录。持久化仅通过 `ctx.call('storage.get', {key:'notes'})` / `ctx.call('storage.set', {key:'notes',value:…})` 完成，不直接读写宿主文件。

## 安装与配置

在 `apps/local-harness` 启动宿主，选择本地目录 `./plugins/local-notes`，检查清单、摘要和代码，确认信任并授予 `storage.read`、`storage.write`，再启用。整个目录可单独复制分发；安装不运行脚本，不下载依赖。

默认配置 `{"notebook":"Inbox","maxNotes":200}`。notebook 为 1–80 字符非空名称；插件去除名称首尾空白。maxNotes 为 1–1000 整数，是**所有笔记本总量**上限，而不是每个笔记本分别计算。达到上限拒绝新增，不自动删除旧笔记。降低上限不会截掉已有数据，仍可 list/search。更改配置必须重新授权；更换 notebook 不迁移或删除旧笔记。

## 数据模型

storage 中的 `notes` 键保存一个 JSON 数组，未创建时 `storage.get` 返回 null，插件按空数组处理。每条笔记结构如下；uuid/date 由运行时生成，下面只是格式示例，不是实际用户数据。

```json
{
  "uuid": "3c9acfc1-1dc3-4e20-a8ba-ec6c6a5b5f2a",
  "date": "2026-11-11T06:00:00.000Z",
  "title": "插件检查",
  "content": "复核 plugin 与 privacy 边界。",
  "notebook": "Inbox",
  "tags": ["plugin", "privacy"]
}
```

uuid 是 v4 UUID；date 是 UTC ISO 8601 创建时间。title 最长 160 字符，content 最长 8000 字符，tags 最多 12 项，每项 1–40 字符且去除首尾空白后不重复。标题去除首尾空白，正文原样保存（但禁止全空白）。每次读取检查已有数组和笔记结构，损坏时拒绝读写，不静默清空或覆盖。整个笔记数组的 UTF-8 JSON 另受插件 96 KiB 预算限制，以适配宿主单条 IPC 消息 128 KiB 上限（broker 本身的 value 上限是 512 KiB，但不能绕过 IPC 限制）。maxNotes 是数量上限，不保证能保存那么多篇长文。

## 工具输入输出

所有工具输入 JSON Schema 根类型为 object，`additionalProperties:false`；插件还重复检查类型、长度、数量及非空白边界。

| 动态工具名 | 输入 | 输出与行为 |
| --- | --- | --- |
| `local-notes__add` | `{"title":"插件检查","content":"复核 plugin 与 privacy 边界。","tags":["plugin","privacy"]}` | `{"note":{…上述完整笔记…},"total":1}`；total 为整个插件已存数量 |
| `local-notes__search` | `{"query":"privacy","limit":20}` | `{"notebook":"Inbox","notes":[{…完整笔记…}],"total":1,"truncated":false,"query":"privacy"}` |
| `local-notes__list` | `{"limit":20}` 或 `{}` | `{"notebook":"Inbox","notes":[{…完整笔记…}],"total":1,"truncated":false}` |

add 的 title/content 必填，tags 可省略为 []。add `mutates:true`，写入需要逐次用户批准，即使插件已经授权也不能跳过批准。search/list `mutates:false`，只调用 storage.get。search 的 query 必填，1–200 字符，按不区分大小写的字面量匹配标题、正文或任一标签，不用正则。只检索当前 notebook。list/search limit 默认 20、范围 1–50，最新追加的笔记最先输出；total 是当前笔记本或搜索条件下总匹配数，truncated 表示结果被 limit 截断。空库和无匹配返回 notes:[]、total:0。

## 错误、保留与限制

输入错误抛 `INVALID_INPUT`，未知工具抛 `UNKNOWN_TOOL`，损坏存储抛 `STORAGE_CORRUPT`，满额抛 `NOTES_FULL`，超过字节上限抛 `STORAGE_LIMIT`，broker 未确认写入抛 `BROKER_RESPONSE_INVALID`。broker 权限、写入失败和超时错误交由宿主显示，不伪造成功结果。

存储按插件 id 隔离，位于应用私有 `.harness/` 中，保留到用户备份/整理或卸载插件。当前没有删除工具：卸载会删除此插件全部笔记，务必先按宿主文档备份。禁止把真实笔记放进插件分发目录、演示工作区或 Git。插件不访问网络、不主动记录正文；远程模型接收搜索结果仍需要宿主外发授权。

v1 broker 没有 compare-and-swap/事务式追加方法，add 采用 get→set 整个数组。本应用在同一宿主实例内拒绝同一插件的并发运行（`PLUGIN_BUSY`），从而保护这一调用序列。其他兼容宿主也必须串行化同一插件的新增调用；插件不能仅靠进程内锁保证多个子进程间的事务一致性。不要同时启动多个宿主实例操作同一数据目录，也不能把单次原子文件替换等同于 read-modify-write 的原子事务。

## 独立验证

```sh
node --check plugins/local-notes/index.mjs
```

可用注入的 ctx.call 验证 add→list→search、空库、额外字段、上限和损坏数据；这些属于模拟 broker 的单元验证，不代替实际宿主 IPC、授权和磁盘持久化集成测试。
