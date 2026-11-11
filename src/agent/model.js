import { fail, HarnessError, validate } from '../core/validation.js';

const modelSchema = {
  type: 'object', additionalProperties: false,
  required: ['provider', 'baseUrl', 'model', 'maxSteps', 'allowRemote'],
  properties: {
    provider: { enum: ['ollama', 'openai'] },
    baseUrl: { type: 'string', minLength: 1, maxLength: 300 },
    model: { type: 'string', minLength: 1, maxLength: 120 },
    maxSteps: { type: 'integer', minimum: 1, maximum: 12 },
    allowRemote: { type: 'boolean' }
  }
};

export function checkModel(config) {
  validate(modelSchema, config, '模型配置');
  let url;
  try { url = new URL(config.baseUrl); } catch { fail('INVALID_MODEL_URL', '模型地址不是有效 URL。'); }
  if (url.username || url.password || url.search || url.hash) fail('INVALID_MODEL_URL', '模型地址不能包含凭据、查询参数或片段。');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!['http:', 'https:'].includes(url.protocol) || (!local && url.protocol !== 'https:')) fail('INVALID_MODEL_URL', '远程模型必须使用 HTTPS；本机模型可使用 HTTP。');
  if (!local && (config.provider === 'ollama' || !config.allowRemote)) fail('REMOTE_NOT_ALLOWED', '默认禁止数据外发；远程模型需要明确允许，Ollama 仅支持回环地址。');
  config.baseUrl = config.baseUrl.replace(/\/+$/, '');
  return config;
}

async function request(config, route, body, signal) {
  checkModel(config);
  const headers = { 'Content-Type': 'application/json' };
  if (config.provider === 'openai' && process.env.HARNESS_MODEL_API_KEY) headers.Authorization = `Bearer ${process.env.HARNESS_MODEL_API_KEY}`;
  const timeout = AbortSignal.timeout(45000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response;
  try {
    response = await fetch(`${config.baseUrl}${route}`, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, signal: combined, redirect: 'error' });
  } catch {
    if (signal?.aborted) throw new HarnessError('CANCELLED', '运行已取消。');
    throw new HarnessError('MODEL_UNAVAILABLE', '模型连接失败或超时。请启动本机 Ollama，确认地址、模型和工具调用支持；也可先直接运行插件。', 503);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new HarnessError('MODEL_HTTP_ERROR', `模型服务返回 HTTP ${response.status}。请检查模型名称、服务版本和认证配置。`, 502);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > 2 * 1024 * 1024) { await reader.cancel(); fail('MODEL_OUTPUT_LIMIT', '模型响应超过 2 MiB 限制。', 502); }
    chunks.push(Buffer.from(value));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('MODEL_FORMAT_ERROR', '模型没有返回有效 JSON。', 502); }
}

export async function testModel(config, signal) {
  const data = await request(config, config.provider === 'ollama' ? '/api/tags' : '/models', null, signal);
  if (config.provider === 'ollama') {
    if (!Array.isArray(data.models)) fail('MODEL_FORMAT_ERROR', 'Ollama 未返回模型列表。', 502);
    if (!data.models.some(item => item.name === config.model || item.model === config.model)) fail('MODEL_NOT_FOUND', `服务已连接，但未发现 ${config.model}。请先在 Ollama 安装或选择已有模型。`, 404);
  } else if (!Array.isArray(data.data)) fail('MODEL_FORMAT_ERROR', '兼容接口未返回标准 models 列表。', 502);
  return { ok: true, message: '模型服务已连接。工具调用能力仍取决于所选模型；请运行任务验证。' };
}

export async function chat(config, messages, tools, signal) {
  const payload = { model: config.model, messages, stream: false };
  if (tools.length) payload.tools = tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }));
  if (config.provider === 'openai') payload.max_tokens = 2048;
  const data = await request(config, config.provider === 'ollama' ? '/api/chat' : '/chat/completions', payload, signal);
  const message = config.provider === 'ollama' ? data.message : data.choices?.[0]?.message;
  if (!message || message.role !== 'assistant' || (!('content' in message) && !Array.isArray(message.tool_calls))) fail('MODEL_FORMAT_ERROR', '模型回复格式不符合 chat / tool-calling 协议。', 502);
  if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) fail('MODEL_FORMAT_ERROR', '模型 tool_calls 必须是数组。', 502);
  return message;
}
