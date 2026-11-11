import { pathToFileURL } from 'node:url';

const pending = new Map();
let sequence = 0;
let started = false;
process.on('message', async message => {
  if (message?.type === 'rpc-result') {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
    else request.resolve(message.value);
    return;
  }
  if (message?.type !== 'execute' || started) return;
  started = true;
  try {
    const module = await import(pathToFileURL(message.entry).href);
    if (typeof module.default !== 'function') throw new Error('插件 entry 必须 default export 一个执行函数。');
    const ctx = Object.freeze({
      call(method, params = {}) {
        return new Promise((resolve, reject) => {
          const id = String(++sequence);
          pending.set(id, { resolve, reject });
          process.send({ type: 'rpc', id, method, params });
        });
      },
      log(message) { process.send({ type: 'log', message: String(message).slice(0, 500) }); }
    });
    const value = await module.default({ tool: message.tool, args: message.args, config: message.config }, ctx);
    process.send({ type: 'result', value: value ?? null }, () => process.exit(0));
  } catch (error) {
    process.send({ type: 'error', error: { code: error.code || 'PLUGIN_ERROR', message: String(error.message || '插件运行失败').slice(0, 500) } }, () => process.exit(1));
  }
});
process.on('disconnect', () => process.exit(0));
