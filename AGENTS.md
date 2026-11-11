# LOOM 应用协作约定

修改前阅读 README、docs/USAGE.md、plan.md、docs/PLUGIN_PROTOCOL.md、TECHNICAL.md 和 SECURITY.md。

本应用是纯本地 Node.js 20.19+ ESM，不引入 Manus 托管声明、代码同步或云部署。生产依赖只有 Ajv；前端是原生 DOM/CSS，无打包步骤。保持 package-lock.json，并使用 npm ci --ignore-scripts 复现安装。

## 已有命令

```sh
npm start
npm run cli -- --help
npm run check
npm test
npm run test:ui
```

check 只验证语法和 JSON，不是类型检查。HTTP 和模型协议测试需要本机回环端口；UI 回归使用已安装 Chrome，可用 HARNESS_BROWSER 指定可执行文件。不安装全局工具来掩盖 PATH 或权限问题。

## 架构纪律

笔记和搜索逻辑属于 plugins/，宿主只能添加通用能力和协议机制，禁止按插件 id 做业务分发。插件只依赖 entry/ctx 协议，不导入宿主模块。所有必填配置在启用前验证；配置改变撤权；普通日志限制不能吞掉批准或最终状态。

跨实例插件运行锁必须覆盖 broker 收尾。storage.set 必须在全局写锁内复核取消、当前配置与权限；卸载先撤权，再等待运行锁。任何调整都补相关竞态回归。

默认不联网外发，不自动下载模型。密钥只能留在宿主环境。插件是可信代码，不是恶意代码沙箱；不得在 UI 或文档宣称任意第三方代码被安全隔离。模型 fixture 只验证协议，不能汇报成真实模型验证。

测试用临时目录，不写默认 .harness 或读取用户真实工作区。运行正文和详细事件不持久化到磁盘历史；插件主动保存的笔记是例外，应保持删除与卸载边界明确。
