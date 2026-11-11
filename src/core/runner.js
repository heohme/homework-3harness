import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { HarnessError, jsonSize, errorInfo } from './validation.js';

export function executePlugin({ directory, manifest, tool, args, config, broker, event, signal, timeout = 15000 }) {
  if (signal?.aborted) return Promise.reject(new HarnessError('CANCELLED', '运行已取消。'));
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(new URL('../plugin-worker.js', import.meta.url)), [], {
      cwd: directory,
      execArgv: ['--max-old-space-size=96', '--disable-proto=throw'],
      env: { LANG: 'C.UTF-8', TZ: 'UTC' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      detached: process.platform !== 'win32',
      serialization: 'json'
    });
    let settled = false;
    let bytes = 0;
    let requests = 0;
    let chain = Promise.resolve();
    function stop() {
      try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
      catch { child.kill('SIGKILL'); }
    }
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      stop();
      broker.cancel?.();
      // The caller must retain its plugin lock until already-started broker work has drained.
      chain.then(() => { if (error) reject(error); else resolve(value); }, () => reject(error || new HarnessError('BROKER_ERROR', '能力请求收尾失败。')));
    }
    const cancel = () => finish(new HarnessError('CANCELLED', '运行已取消。'));
    const timer = setTimeout(() => finish(new HarnessError('PLUGIN_TIMEOUT', '插件运行超过时间限制，进程已终止。')), timeout);
    signal?.addEventListener('abort', cancel, { once: true });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 65536) finish(new HarnessError('OUTPUT_LIMIT', '插件输出超过限制，进程已终止。'));
      // stdout/stderr may contain credentials: do not forward or persist them.
    });
    child.on('error', () => finish(new HarnessError('PLUGIN_START_FAILED', '无法启动插件进程。')));
    child.on('exit', () => finish(new HarnessError('PLUGIN_CRASH', '插件异常退出，没有返回有效结果。')));
    child.on('message', message => {
      if (settled || !message || typeof message !== 'object') return;
      try { jsonSize(message); } catch (error) { finish(error); return; }
      if (message.type === 'result') { finish(null, message.value); return; }
      if (message.type === 'error') { finish(new HarnessError(message.error?.code || 'PLUGIN_ERROR', String(message.error?.message || '插件执行失败。').slice(0, 500))); return; }
      if (message.type === 'log') {
        if (++requests > 200) { finish(new HarnessError('RPC_LIMIT', '插件消息过多。')); return; }
        event('plugin', String(message.message).slice(0, 500)); return;
      }
      if (message.type === 'rpc') {
        if (++requests > 200 || typeof message.id !== 'string') { finish(new HarnessError('RPC_LIMIT', '插件能力请求过多或格式无效。')); return; }
        // Serialize broker calls so a plugin cannot race a read/write pair inside one invocation.
        chain = chain.then(async () => {
          if (settled || signal?.aborted) return;
          try {
            const value = await broker(message.method, message.params);
            if (!settled && child.connected) child.send({ type: 'rpc-result', id: message.id, value });
          } catch (error) {
            if (!settled && child.connected) child.send({ type: 'rpc-result', id: message.id, error: errorInfo(error) });
          }
        }).catch(() => finish(new HarnessError('BROKER_ERROR', '宿主能力请求失败。')));
      }
    });
    child.send({ type: 'execute', entry: path.join(directory, manifest.entry), tool, args, config });
  });
}
