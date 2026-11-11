import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { snapshot, writeSnapshot } from './manifest.js';
import { normalizeConfig, createBroker } from './broker.js';
import { executePlugin } from './runner.js';
import { fail, validate, object, errorInfo } from './validation.js';
import { checkModel, testModel } from '../agent/model.js';
import { agentLoop } from '../agent/loop.js';

export const APP_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export class Harness {
  constructor({ dataDir = process.env.HARNESS_HOME || path.join(APP_ROOT, '.harness'), cwd = APP_ROOT, pluginTimeout = 15000 } = {}) {
    this.store = new Store(dataDir);
    this.cwd = cwd;
    this.pluginTimeout = pluginTimeout;
    this.runs = new Map();
    this.controllers = new Map();
    this.approvals = new Map();
    this.activePlugins = new Set();
  }
  async init() { await this.store.init(); return this; }
  async catalog() {
    const directory = path.join(APP_ROOT, 'plugins');
    const output = [];
    for (const item of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (!item.isDirectory()) continue;
      try { const pkg = await this.inspect(path.join(directory, item.name)); output.push({ path: pkg.path, manifest: pkg.manifest }); }
      catch { /* An invalid example must not break the whole control panel. */ }
    }
    return output;
  }
  async inspect(directory) {
    if (typeof directory !== 'string' || directory.length > 2048) fail('INVALID_PATH', '提供一个本地插件目录。');
    const pkg = await snapshot(path.resolve(this.cwd, directory));
    return { path: pkg.path, manifest: pkg.manifest, digest: pkg.digest, filesCount: pkg.filesCount };
  }
  async install({ path: directory, digest, trusted }) {
    if (trusted !== true) fail('TRUST_REQUIRED', '只有审查并信任插件代码后才能安装。独立进程不是恶意代码沙箱。', 403);
    if (typeof directory !== 'string' || !directory.trim() || directory.length > 2048) fail('INVALID_PATH', '提供一个本地插件目录。');
    const pkg = await snapshot(path.resolve(this.cwd, directory));
    if (digest !== pkg.digest) fail('PACKAGE_CHANGED', '插件内容与预检时不同，请重新预检并确认。', 409);
    const release = await this.store.lock();
    const destination = this.store.file(`plugins/${pkg.manifest.id}`);
    let created = false;
    try {
      const state = await this.store.registry();
      if (state.plugins.some(item => item.manifest.id === pkg.manifest.id)) fail('ALREADY_INSTALLED', '这个插件已经安装。请先卸载再安装新版本。', 409);
      if (await fs.stat(destination).catch(() => null)) fail('ORPHAN_PACKAGE', '发现未登记的插件目录，请备份后手动检查，不能覆盖。', 409);
      const config = {};
      try {
        validate(pkg.manifest.configSchema, config, '默认配置');
        await normalizeConfig(pkg.manifest, config, this.cwd);
      } catch (error) {
        if (!['VALIDATION_ERROR', 'WORKSPACE_NOT_FOUND', 'WORKSPACE_REQUIRED', 'SYMLINK_DENIED'].includes(error.code)) throw error;
        // Required settings may lack defaults. Install disabled; enable must validate after configuration.
      }
      await writeSnapshot(pkg, destination); created = true;
      const record = { manifest: pkg.manifest, digest: pkg.digest, config, enabled: false, grants: [], installedAt: new Date().toISOString() };
      state.plugins.push(record);
      await this.store.atomic('registry.json', state);
      return record;
    } catch (error) { if (created) await fs.rm(destination, { recursive: true, force: true }); throw error; }
    finally { await release(); }
  }
  async plugin(id) {
    const plugin = (await this.store.registry()).plugins.find(item => item.manifest.id === id);
    if (!plugin) fail('PLUGIN_NOT_INSTALLED', '插件未安装。', 404);
    return plugin;
  }
  async configure(id, input) {
    const plugin = await this.plugin(id);
    const config = validate(plugin.manifest.configSchema, structuredClone(object(input, '配置')), '插件配置');
    await normalizeConfig(plugin.manifest, config, this.cwd);
    this.cancelPlugin(id);
    const state = await this.store.update('registry.json', state => {
      const current = state.plugins.find(item => item.manifest.id === id);
      if (!current || current.digest !== plugin.digest) fail('PLUGIN_CHANGED', '插件已变更，请重试。', 409);
      current.config = config; current.enabled = false; current.grants = []; return state;
    });
    return state.plugins.find(item => item.manifest.id === id);
  }
  async enable(id, grants) {
    const plugin = await this.plugin(id);
    if (!Array.isArray(grants) || grants.length !== plugin.manifest.permissions.length || new Set(grants).size !== grants.length || plugin.manifest.permissions.some(permission => !grants.includes(permission))) fail('PERMISSION_REQUIRED', '需要显式授权插件清单中的全部能力。', 403);
    validate(plugin.manifest.configSchema, structuredClone(plugin.config), '插件配置（请先配置后启用）');
    const normalized = await normalizeConfig(plugin.manifest, structuredClone(plugin.config), this.cwd);
    if (JSON.stringify(normalized) !== JSON.stringify(plugin.config)) fail('CONFIG_REQUIRED', '请先保存工作区配置，确认规范化后的实际授权目录。');
    const installed = await snapshot(this.store.file(`plugins/${id}`));
    if (installed.digest !== plugin.digest) fail('INTEGRITY_ERROR', '已安装插件内容被修改，请重新审查并安装。', 409);
    const state = await this.store.update('registry.json', state => {
      const current = state.plugins.find(item => item.manifest.id === id);
      if (!current || current.digest !== plugin.digest || JSON.stringify(current.config) !== JSON.stringify(plugin.config)) fail('PLUGIN_CHANGED', '插件配置或版本已变更，请重新确认。', 409);
      current.enabled = true; current.grants = grants; return state;
    });
    return state.plugins.find(item => item.manifest.id === id);
  }
  async disable(id) {
    await this.plugin(id); this.cancelPlugin(id);
    const state = await this.store.update('registry.json', state => {
      const plugin = state.plugins.find(item => item.manifest.id === id);
      if (!plugin) fail('PLUGIN_NOT_INSTALLED', '插件未安装。', 404);
      plugin.enabled = false; plugin.grants = []; return state;
    });
    return state.plugins.find(item => item.manifest.id === id);
  }
  async uninstall(id) {
    await this.disable(id);
    const releaseRun = await this.store.lock(`run-${id}.lock`);
    let release;
    try {
      release = await this.store.lock();
      const state = await this.store.registry();
      await fs.rm(this.store.file(`plugins/${id}`), { recursive: true, force: true });
      await fs.rm(this.store.file(`storage/${id}.json`), { force: true });
      state.plugins = state.plugins.filter(item => item.manifest.id !== id);
      await this.store.atomic('registry.json', state);
    } finally { await release?.(); await releaseRun(); }
    return { ok: true };
  }
  async tools() {
    return (await this.store.registry()).plugins.filter(item => item.enabled).flatMap(plugin => plugin.manifest.tools.map(tool => ({ ...tool, name: `${plugin.manifest.id}__${tool.name}`, pluginId: plugin.manifest.id })));
  }
  async execute(name, args, run, signal) {
    const tool = (await this.tools()).find(item => item.name === name);
    if (!tool) fail('TOOL_UNAVAILABLE', '工具不存在、未安装或已禁用。', 404);
    const plugin = await this.plugin(tool.pluginId);
    const input = validate(tool.inputSchema, structuredClone(object(args, '工具参数')), '工具参数');
    if (this.activePlugins.has(tool.pluginId)) fail('PLUGIN_BUSY', '该插件正在处理另一个请求，请稍后重试。', 409);
    this.activePlugins.add(tool.pluginId);
    const event = (type, message, data) => this.event(run, type, message, data);
    let release;
    try {
      release = await this.store.lock(`run-${tool.pluginId}.lock`);
      if (signal?.aborted) fail('CANCELLED', '运行已取消。');
      const current = await this.plugin(tool.pluginId);
      if (!current.enabled || current.digest !== plugin.digest || JSON.stringify(current.config) !== JSON.stringify(plugin.config)) fail('PLUGIN_CHANGED', '插件状态已经改变，请重新运行。', 409);
      const installed = await snapshot(this.store.file(`plugins/${tool.pluginId}`));
      if (installed.digest !== plugin.digest) fail('INTEGRITY_ERROR', '插件文件与安装摘要不一致，拒绝执行。', 409);
      event('plugin-start', `在独立进程运行 ${name}`);
      return await executePlugin({ directory: this.store.file(`plugins/${tool.pluginId}`), manifest: plugin.manifest, tool: name.slice(tool.pluginId.length + 2), args: input, config: plugin.config, broker: createBroker(this.store, plugin, event, signal, { allowWrites: tool.mutates }), event, signal, timeout: this.pluginTimeout });
    } finally { await release?.(); this.activePlugins.delete(tool.pluginId); }
  }
  event(run, type, message, data) {
    if (!run) return;
    if (run.events.length >= 150) {
      const controls = new Set(['start', 'approval', 'success', 'error', 'cancelled', 'complete']);
      const oldestLog = run.events.findIndex(entry => !controls.has(entry.type));
      run.events.splice(oldestLog < 0 ? 0 : oldestLog, 1);
      run.traceTruncated = true;
    }
    const entry = { at: new Date().toISOString(), type, message };
    if (data !== undefined) entry.data = data;
    run.events.push(entry);
    this.onEvent?.(run, entry);
  }
  async start(type, fields, task) {
    if (this.controllers.size >= 4) fail('RUN_LIMIT', '最多同时运行 4 个任务。', 429);
    const run = { id: randomUUID(), type, status: 'running', ...fields, startedAt: new Date().toISOString(), events: [] };
    const controller = new AbortController();
    this.controllers.set(run.id, controller); this.runs.set(run.id, run);
    while (this.runs.size > 50) {
      const old = [...this.runs.values()].find(item => !this.controllers.has(item.id));
      if (!old) break;
      this.runs.delete(old.id);
    }
    this.event(run, 'start', type === 'agent' ? 'Agent 任务开始' : '工具运行开始');
    const timeout = setTimeout(() => controller.abort(), 180000);
    run.completion = Promise.resolve().then(() => task(run, controller.signal)).then(result => {
      if (controller.signal.aborted) fail('CANCELLED', '运行已取消，已开始的写入可能已完成。');
      run.result = result; run.status = 'success'; this.event(run, 'success', '运行成功');
    }).catch(error => {
      run.status = controller.signal.aborted || error.code === 'CANCELLED' ? 'cancelled' : 'error';
      run.error = errorInfo(error); this.event(run, run.status, run.error.message);
    }).finally(async () => {
      clearTimeout(timeout); run.endedAt = new Date().toISOString(); this.controllers.delete(run.id);
      try { await this.store.remember(run); }
      catch { this.event(run, 'warning', '历史摘要写入失败；本次结果仍在内存。'); }
    });
    return run;
  }
  async runTool(name, args) {
    if (typeof name !== 'string') fail('VALIDATION_ERROR', '需要提供工具名称。');
    return this.start('tool', { toolName: name }, (run, signal) => this.execute(name, args, run, signal));
  }
  async runAgent(prompt, { approveWrites = false } = {}) {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 12000) fail('INVALID_PROMPT', '任务内容需要 1–12000 个字符。');
    const config = (await this.store.registry()).model;
    checkModel(config);
    const tools = await this.tools();
    return this.start('agent', { prompt }, (run, signal) => agentLoop({ prompt, config, tools, signal,
      event: (type, message, data) => this.event(run, type, message, data),
      execute: (name, args) => this.execute(name, args, run, signal),
      approve: (name, args) => approveWrites ? Promise.resolve(true) : this.waitApproval(run, name, args, signal)
    }));
  }
  waitApproval(run, name, args, signal) {
    return new Promise(resolve => {
      const callId = randomUUID();
      run.status = 'awaiting_approval';
      const finish = approved => {
        clearTimeout(timer); signal.removeEventListener('abort', cancel);
        this.approvals.delete(callId); run.status = 'running'; resolve(approved);
      };
      const cancel = () => finish(false);
      const timer = setTimeout(() => { this.event(run, 'warning', '批准等待超时，本次写入已拒绝'); finish(false); }, 120000);
      this.approvals.set(callId, { runId: run.id, finish });
      signal.addEventListener('abort', cancel, { once: true });
      this.event(run, 'approval', `需要批准写入工具 ${name}`, { callId, name, args });
    });
  }
  approve(id, callId, approved) {
    const request = this.approvals.get(callId);
    if (!request || request.runId !== id || typeof approved !== 'boolean') fail('APPROVAL_NOT_FOUND', '批准请求已过期或不存在。', 404);
    request.finish(approved); return { ok: true };
  }
  cancel(id) {
    const controller = this.controllers.get(id);
    if (!controller) fail('RUN_NOT_ACTIVE', '任务不存在或已经结束。', 409);
    controller.abort(); return { ok: true };
  }
  cancelPlugin(id) {
    for (const run of this.runs.values()) if (this.controllers.has(run.id) && (run.type === 'agent' || run.toolName?.startsWith(`${id}__`))) this.controllers.get(run.id).abort();
  }
  async clearRuns() {
    if (this.controllers.size) fail('RUN_ACTIVE', '请先结束所有任务，再清空历史。', 409);
    await this.store.update('history.json', () => [], []); this.runs.clear(); return { ok: true };
  }
  async setModel(input) {
    const model = checkModel(structuredClone(object(input, '模型配置')));
    await this.store.update('registry.json', state => { state.model = model; return state; });
    return { ...model, apiKeyConfigured: Boolean(process.env.HARNESS_MODEL_API_KEY) };
  }
  async testModel() { return testModel((await this.store.registry()).model); }
  async state() {
    const registry = await this.store.registry();
    const current = [...this.runs.values()].reverse().map(({ completion, ...run }) => run);
    const persisted = (await this.store.read('history.json', [])).filter(item => !this.runs.has(item.id));
    return { version: '0.1.0', plugins: registry.plugins, catalog: await this.catalog(), tools: await this.tools(), runs: [...current, ...persisted].slice(0, 50), model: { ...registry.model, apiKeyConfigured: Boolean(process.env.HARNESS_MODEL_API_KEY) }, security: { host: '127.0.0.1', trustedPluginsOnly: true } };
  }
  async close() { for (const controller of this.controllers.values()) controller.abort(); await Promise.all([...this.runs.values()].map(run => run.completion)); }
}
