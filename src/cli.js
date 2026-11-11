#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { Harness } from './core/harness.js';
import { createServer } from './server.js';
import { fail, errorInfo } from './core/validation.js';

const HELP = `LOOM — 本地 AI Agent Harness

  npm start                         启动 http://127.0.0.1:4317
  npm run cli -- plugins list
  npm run cli -- plugins inspect ./plugins/workspace-reader
  npm run cli -- plugins install ./plugins/workspace-reader --trust
  npm run cli -- plugins enable workspace-reader --grant all
  npm run cli -- plugins configure workspace-reader --config '{"root":"./examples/workspace","maxResults":8}'
  npm run cli -- plugins disable workspace-reader
  npm run cli -- plugins uninstall local-notes --yes  # 同时删除该插件笔记
  npm run cli -- tools list
  npm run cli -- tools run workspace-reader__search --args '{"query":"plugin"}'
  npm run cli -- agent "检索 plugin 的架构说明"
  npm run cli -- model show
  npm run cli -- model test
  npm run cli -- model set --provider ollama --base-url http://127.0.0.1:11434 --model qwen3:8b

全局 --home PATH 可隔离数据；serve --port 4317 可选择明确端口。
安装的 --trust 表示已审查可信代码，不等于安全沙箱。
Agent 写工具在交互终端逐次确认；非交互默认拒绝。--approve-writes 是显式批量授权。
远程兼容接口需 --allow-remote；密钥只使用宿主环境变量 HARNESS_MODEL_API_KEY。
`;
const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  help: { type: 'boolean', short: 'h' }, home: { type: 'string' }, port: { type: 'string' },
  trust: { type: 'boolean' }, grant: { type: 'string', multiple: true }, config: { type: 'string' }, args: { type: 'string' },
  yes: { type: 'boolean' }, 'approve-writes': { type: 'boolean' }, provider: { type: 'string' },
  'base-url': { type: 'string' }, model: { type: 'string' }, 'max-steps': { type: 'string' }, 'allow-remote': { type: 'boolean' }
} });
function json(text, name) { try { return JSON.parse(text || '{}'); } catch { fail('INVALID_JSON', `${name}需要有效 JSON。`); } }
const print = value => console.log(JSON.stringify(value, null, 2));

async function main() {
  if (values.help || !positionals.length) { console.log(HELP); return; }
  const harness = await new Harness(values.home ? { dataDir: values.home } : {}).init();
  const [command, action, target] = positionals;
  if (command === 'serve') {
    const port = Number(values.port || 4317);
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail('INVALID_PORT', '端口需为 1–65535。');
    const app = await createServer({ harness, port });
    console.log(`LOOM 已启动：http://127.0.0.1:${app.port}\n数据目录：${harness.store.directory}\n仅本机访问；Ctrl+C 停止。`);
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { if (stopping) return; stopping = true; await app.close(); process.exit(0); });
    return;
  }
  try {
    if (command === 'plugins') {
      if (action === 'list') { print((await harness.state()).plugins); return; }
      if (!target) fail('MISSING_ARGUMENT', '需要插件目录或 id。');
      if (action === 'inspect') { print(await harness.inspect(target)); return; }
      if (action === 'install') { const pkg = await harness.inspect(target); print(await harness.install({ path: pkg.path, digest: pkg.digest, trusted: values.trust === true })); return; }
      if (action === 'configure') { if (!values.config) fail('MISSING_ARGUMENT', '需要 --config JSON。'); print(await harness.configure(target, json(values.config, '配置'))); return; }
      if (action === 'enable') { const plugin = await harness.plugin(target); const grants = values.grant?.includes('all') ? plugin.manifest.permissions : values.grant || []; print(await harness.enable(target, grants)); return; }
      if (action === 'disable') { print(await harness.disable(target)); return; }
      if (action === 'uninstall') { if (!values.yes) fail('CONFIRM_REQUIRED', '卸载会删除插件代码、配置和笔记，请使用 --yes 明确确认。'); print(await harness.uninstall(target)); return; }
    }
    if (command === 'tools') {
      if (action === 'list') { print(await harness.tools()); return; }
      if (action === 'run') {
        const run = await harness.runTool(target, json(values.args, '工具参数')); await run.completion;
        if (run.status !== 'success') { print({ status: run.status, error: run.error }); process.exitCode = 1; } else print(run.result);
        return;
      }
    }
    if (command === 'agent') {
      let rl;
      if (process.stdin.isTTY && !values['approve-writes']) rl = createInterface({ input: process.stdin, output: process.stderr });
      harness.onEvent = (run, event) => {
        process.stderr.write(`[${event.type}] ${event.message}\n`);
        if (event.type === 'approval') {
          if (!rl) { harness.approve(run.id, event.data.callId, false); return; }
          rl.question(`允许 ${event.data.name} 写入？参数 ${JSON.stringify(event.data.args)} [y/N] `).then(answer => {
            try { harness.approve(run.id, event.data.callId, answer.toLowerCase() === 'y'); } catch { /* cancelled */ }
          });
        }
      };
      try {
        const run = await harness.runAgent(positionals.slice(1).join(' '), { approveWrites: Boolean(values['approve-writes']) });
        const cancel = () => { try { harness.cancel(run.id); } catch {} };
        process.once('SIGINT', cancel);
        await run.completion; process.removeListener('SIGINT', cancel);
        if (run.status === 'success') print(run.result); else { print({ status: run.status, error: run.error }); process.exitCode = 1; }
      } finally { rl?.close(); }
      return;
    }
    if (command === 'model') {
      if (action === 'show') { print((await harness.state()).model); return; }
      if (action === 'test') { print(await harness.testModel()); return; }
      if (action === 'set') {
        const current = (await harness.store.registry()).model;
        print(await harness.setModel({ provider: values.provider || current.provider, baseUrl: values['base-url'] || current.baseUrl, model: values.model || current.model, maxSteps: Number(values['max-steps'] || current.maxSteps), allowRemote: Boolean(values['allow-remote']) })); return;
      }
    }
    fail('UNKNOWN_COMMAND', '未知命令；运行 npm run cli -- --help 查看用法。');
  } finally { await harness.close(); }
}
main().catch(error => {
  const info = error.code === 'EADDRINUSE' ? { code: 'PORT_IN_USE', message: '端口已被占用；请停止旧实例，或通过 --port 明确选择其他端口。' } : errorInfo(error);
  process.stderr.write(JSON.stringify({ error: info }, null, 2) + '\n'); process.exitCode = 1;
});
