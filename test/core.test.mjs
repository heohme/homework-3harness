import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Harness, APP_ROOT } from '../src/core/harness.js';
import { setup, install, result, customPlugin, installCustom } from './helpers.mjs';

const rejectsCode = (promise, code) => assert.rejects(promise, error => error.code === code);

test('installation requires trust, matching digest and explicit grants; disabled tools cannot run', async t => {
  const { harness } = await setup(t);
  const pkg = await harness.inspect(path.join(APP_ROOT, 'plugins/workspace-reader'));
  await rejectsCode(harness.install({ path: pkg.path, digest: pkg.digest, trusted: false }), 'TRUST_REQUIRED');
  await rejectsCode(harness.install({ path: pkg.path, digest: 'wrong', trusted: true }), 'PACKAGE_CHANGED');
  await harness.install({ path: pkg.path, digest: pkg.digest, trusted: true });
  assert.equal((await harness.tools()).length, 0);
  assert.equal((await result(harness, 'workspace-reader__list', {})).error.code, 'TOOL_UNAVAILABLE');
  await rejectsCode(harness.enable('workspace-reader', []), 'PERMISSION_REQUIRED');
  await harness.enable('workspace-reader', ['workspace.read']);
  assert.equal((await harness.tools()).length, 3);
  await rejectsCode(harness.install({ path: pkg.path, digest: pkg.digest, trusted: true }), 'ALREADY_INSTALLED');
  const search = await result(harness, 'workspace-reader__search', { query: 'plugin' });
  assert.equal(search.status, 'success'); assert.ok(JSON.stringify(search.result).toLowerCase().includes('plugin'));
  await harness.disable('workspace-reader'); assert.equal((await harness.tools()).length, 0);
});

test('configuration is schema-validated, revokes grants and survives restart', async t => {
  const { harness } = await setup(t); await install(harness, 'workspace-reader');
  await rejectsCode(harness.configure('workspace-reader', { root: './examples/workspace', maxResults: -1 }), 'VALIDATION_ERROR');
  const record = await harness.configure('workspace-reader', { root: './examples/workspace', maxResults: 4 });
  assert.equal(record.enabled, false); assert.deepEqual(record.grants, []);
  const restarted = await new Harness({ dataDir: harness.store.directory }).init(); t.after(() => restarted.close());
  assert.equal((await restarted.plugin('workspace-reader')).config.maxResults, 4);
  assert.equal((await restarted.plugin('workspace-reader')).enabled, false);
});

test('workspace denies traversal, absolute paths, secrets and symlinks; reads real text', async t => {
  const { harness, directory } = await setup(t); await install(harness, 'workspace-reader');
  const workspace = path.join(directory, 'workspace'); await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, 'guide.md'), 'plugin architecture\nprivacy first\n');
  await fs.writeFile(path.join(workspace, '.env'), 'SECRET=not-real-test-value');
  await fs.symlink(path.join(workspace, 'guide.md'), path.join(workspace, 'link.md'));
  await harness.configure('workspace-reader', { root: workspace, maxResults: 8 }); await harness.enable('workspace-reader', ['workspace.read']);
  for (const [file, code] of [['../outside.md', 'INVALID_INPUT'], [path.join(workspace, 'guide.md'), 'INVALID_INPUT'], ['.env', 'SENSITIVE_FILE'], ['link.md', 'SYMLINK_DENIED']]) {
    const run = await result(harness, 'workspace-reader__read', { path: file }); assert.equal(run.error?.code, code);
  }
  const read = await result(harness, 'workspace-reader__read', { path: 'guide.md' }); assert.equal(read.status, 'success'); assert.match(JSON.stringify(read.result), /privacy first/);
  const list = await result(harness, 'workspace-reader__list', {}); assert.doesNotMatch(JSON.stringify(list.result), /\.env|link.md/);
  const invalid = await result(harness, 'workspace-reader__search', { query: '', extra: true }); assert.equal(invalid.error.code, 'VALIDATION_ERROR');
});

test('notes are real persistent plugin storage; uninstall removes its data', async t => {
  const { harness } = await setup(t); await install(harness, 'local-notes');
  const add = await result(harness, 'local-notes__add', { title: 'Iteration', content: 'plugin privacy checklist', tags: ['architecture'] }); assert.equal(add.status, 'success');
  const disk = await fs.readFile(harness.store.file('storage/local-notes.json'), 'utf8'); assert.match(disk, /plugin privacy checklist/);
  const restarted = await new Harness({ dataDir: harness.store.directory }).init(); t.after(() => restarted.close());
  const search = await result(restarted, 'local-notes__search', { query: 'privacy' }); assert.equal(search.status, 'success'); assert.match(JSON.stringify(search.result), /Iteration/);
  const history = await fs.readFile(harness.store.file('history.json'), 'utf8'); assert.doesNotMatch(history, /plugin privacy checklist|Iteration/);
  await restarted.uninstall('local-notes'); assert.equal((await restarted.tools()).length, 0);
  assert.equal(await fs.stat(harness.store.file('storage/local-notes.json')).catch(() => null), null);
});

test('multiple host instances serialize note read-modify-write without losing updates', async t => {
  const { harness } = await setup(t); await install(harness, 'local-notes');
  const second = await new Harness({ dataDir: harness.store.directory }).init(); t.after(() => second.close());
  const runs = await Promise.all([result(harness, 'local-notes__add', { title: 'One', content: 'first' }), result(second, 'local-notes__add', { title: 'Two', content: 'second' })]);
  assert.ok(runs.every(run => run.status === 'success'));
  const list = await result(harness, 'local-notes__list', {}); const text = JSON.stringify(list.result); assert.match(text, /One/); assert.match(text, /Two/);
});

test('a third plugin installs dynamically with no host changes, and package tampering is rejected', async t => {
  const { harness, directory } = await setup(t);
  const source = await customPlugin(directory, { code: 'export default async ({args}) => ({reversed: args.value.split(\'\').reverse().join(\'\')});' });
  await installCustom(harness, source);
  const run = await result(harness, 'third-party__execute', { value: 'loom' }); assert.deepEqual(run.result, { reversed: 'mool' });
  await fs.appendFile(harness.store.file('plugins/third-party/index.mjs'), '\n// tampered');
  assert.equal((await result(harness, 'third-party__execute', { value: 'loom' })).error.code, 'INTEGRITY_ERROR');
});

test('plugin package rejects incompatible protocol, invalid entry, missing files and symlinks', async t => {
  const { harness, directory } = await setup(t); const source = await customPlugin(directory);
  const file = path.join(source, 'plugin.json'); const manifest = JSON.parse(await fs.readFile(file));
  await fs.writeFile(file, JSON.stringify({ ...manifest, protocolVersion: 2 })); await rejectsCode(harness.inspect(source), 'VALIDATION_ERROR');
  await fs.writeFile(file, JSON.stringify({ ...manifest, entry: '../escape.mjs' })); await rejectsCode(harness.inspect(source), 'INVALID_ENTRY');
  await fs.writeFile(file, JSON.stringify(manifest)); await fs.symlink(file, path.join(source, 'alias.json')); await rejectsCode(harness.inspect(source), 'SYMLINK_DENIED');
});

test('plugins cannot use undeclared broker permissions or write from a read-only tool', async t => {
  const { harness, directory } = await setup(t);
  const denied = await customPlugin(directory, { id: 'denied-plugin', code: 'export default async (_,ctx) => ctx.call("storage.get",{key:"notes"});' });
  await installCustom(harness, denied); assert.equal((await result(harness, 'denied-plugin__execute', { value: 'x' })).error.code, 'PERMISSION_DENIED');
  const readonly = await customPlugin(directory, { id: 'readonly-plugin', permissions: ['storage.read','storage.write'], code: 'export default async (_,ctx) => ctx.call("storage.set",{key:"notes",value:[]});' });
  await installCustom(harness, readonly); assert.equal((await result(harness, 'readonly-plugin__execute', { value: 'x' })).error.code, 'WRITE_NOT_ALLOWED');
});

test('plugin infinite loop is terminated and in-flight cancellation works', async t => {
  const { harness, directory } = await setup(t, { pluginTimeout: 250 });
  const loop = await customPlugin(directory, { code: 'export default async () => { while(true) {} };' }); await installCustom(harness, loop);
  const timed = await result(harness, 'third-party__execute', { value: 'x' }); assert.equal(timed.error.code, 'PLUGIN_TIMEOUT');
  const run = await harness.runTool('third-party__execute', { value: 'x' }); harness.cancel(run.id); await run.completion; assert.equal(run.status, 'cancelled');
});

test('host environment secrets are not inherited by plugin processes', async t => {
  const { harness, directory } = await setup(t); process.env.LOOM_TEST_SECRET = 'test-only-secret'; t.after(() => delete process.env.LOOM_TEST_SECRET);
  const source = await customPlugin(directory, { code: 'export default async () => ({secret:process.env.LOOM_TEST_SECRET ?? null,nodeOptions:process.env.NODE_OPTIONS ?? null});' }); await installCustom(harness, source);
  const run = await result(harness, 'third-party__execute', { value: 'x' }); assert.deepEqual(run.result, { secret: null, nodeOptions: null });
});

test('third-party plugins can install before supplying mandatory configuration', async t => {
  const { harness, directory } = await setup(t);
  const source = await customPlugin(directory);
  const filename = path.join(source, 'plugin.json'); const manifest = JSON.parse(await fs.readFile(filename));
  manifest.configSchema = { type: 'object', properties: { prefix: { type: 'string', minLength: 1 } }, required: ['prefix'], additionalProperties: false };
  await fs.writeFile(filename, JSON.stringify(manifest)); const pkg = await harness.inspect(source);
  const installed = await harness.install({ path: source, digest: pkg.digest, trusted: true }); assert.equal(installed.enabled, false);
  await rejectsCode(harness.enable('third-party', []), 'VALIDATION_ERROR');
  await harness.configure('third-party', { prefix: 'Configured' }); await harness.enable('third-party', []);
  assert.equal((await result(harness, 'third-party__execute', { value: 'value' })).status, 'success');
});

test('broker itself rejects path escape independently of the example plugin validation', async t => {
  const { harness, directory } = await setup(t);
  const source = await customPlugin(directory, { permissions: ['workspace.read'], code: 'export default async ({args},ctx) => ctx.call("workspace.read", {path:args.value});' });
  const filename = path.join(source, 'plugin.json'); const manifest = JSON.parse(await fs.readFile(filename));
  manifest.configSchema = { type: 'object', properties: { root: { type: 'string', default: './examples/workspace' } }, required: ['root'], additionalProperties: false };
  await fs.writeFile(filename, JSON.stringify(manifest)); await installCustom(harness, source);
  assert.equal((await result(harness, 'third-party__execute', { value: '../escape.md' })).error.code, 'PATH_DENIED');
  assert.equal((await result(harness, 'third-party__execute', { value: '.env' })).error.code, 'SENSITIVE_FILE');
});
