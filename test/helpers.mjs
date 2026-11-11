import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Harness, APP_ROOT } from '../src/core/harness.js';

export async function setup(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-test-'));
  const harness = await new Harness({ dataDir: path.join(directory, 'data'), ...options }).init();
  t.after(async () => { await harness.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { harness, directory };
}
export async function install(harness, id) {
  const pkg = await harness.inspect(path.join(APP_ROOT, 'plugins', id));
  await harness.install({ path: pkg.path, digest: pkg.digest, trusted: true });
  await harness.enable(id, pkg.manifest.permissions);
}
export async function result(harness, name, args) {
  const run = await harness.runTool(name, args); await run.completion; return run;
}
export async function customPlugin(directory, { id = 'third-party', permissions = [], mutates = false, code = 'export default async ({args}) => ({echo: args.value});', inputSchema = { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } } = {}) {
  const target = path.join(directory, id);
  await fs.mkdir(target);
  const manifest = { protocolVersion: 1, id, name: '独立扩展测试', version: '1.0.0', description: '与两个示例无关的第三方扩展', entry: 'index.mjs', permissions, configSchema: { type: 'object', properties: {}, additionalProperties: false }, tools: [{ name: 'execute', description: '执行独立逻辑', mutates, inputSchema }] };
  await fs.writeFile(path.join(target, 'plugin.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(target, 'index.mjs'), code);
  return target;
}
export async function installCustom(harness, directory) {
  const pkg = await harness.inspect(directory);
  await harness.install({ path: pkg.path, digest: pkg.digest, trusted: true });
  await harness.enable(pkg.manifest.id, pkg.manifest.permissions);
  return pkg;
}
export async function until(predicate, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Condition did not complete in time');
}
