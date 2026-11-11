# 技术资料与采用边界

Ollama 官方工具调用文档明确了 `/api/chat` 的 `tools` 参数、assistant.tool_calls 中对象格式的 arguments，以及 role=tool 的 tool_name 和结果回传。宿主使用真实 HTTP、有界循环与动态插件工具列表，不引入固定业务路由。[1]

Node.js 20.19.6 官方权限文档明确指出 Node 信任所运行代码，权限模型不是恶意代码安全防线。因此本项目只面向可信插件；独立进程与宿主能力代理不是 OS 级安全沙箱，也不承诺能阻止恶意插件自行访问网络或文件。[2]

## References

[1]: https://docs.ollama.com/capabilities/tool-calling "Ollama Tool calling"
[2]: https://nodejs.org/download/release/v20.19.6/docs/api/permissions.html "Node.js 20.19.6 Permissions"
