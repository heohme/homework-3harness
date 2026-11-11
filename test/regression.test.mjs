import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { setup, install, customPlugin, installCustom, until } from './helpers.mjs';
import { createBroker } from '../src/core/broker.js';

function gate() {
  let release; const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

test('queued storage.set rechecks cancellation after obtaining its write lock and cannot recreate deleted data', async t => {
  const { harness } = await setup(t); await install(harness, 'local-notes');
  const controller = new AbortController();
  const broker = createBroker(harness.store, await harness.plugin('local-notes'), () => {}, controller.signal, { allowWrites: true });
  const hold = gate(); const entered = gate(); const original = harness.store.update.bind(harness.store);
  harness.store.update = async (name, callback, fallback) => {
    if (name === 'storage/local-notes.json') { entered.release(); await hold.promise; }
    return original(name, callback, fallback);
  };
  const write = broker('storage.set', { key: 'notes', value: [{ title: 'must not survive' }] });
  const rejected = assert.rejects(write, error => error.code === 'CANCELLED');
  await entered.promise; controller.abort(); await harness.uninstall('local-notes'); hold.release(); await rejected;
  assert.equal(await fs.stat(harness.store.file('storage/local-notes.json')).catch(() => null), null);
});

test('cancelled worker retains its plugin lock until in-flight broker drains, so uninstall cannot finish early', async t => {
  const { harness, directory } = await setup(t);
  const source = await customPlugin(directory, { id: 'delayed-write', permissions: ['storage.write'], mutates: true, code: 'export default async (_,ctx) => ctx.call("storage.set",{key:"notes",value:["pending"]});' });
  await installCustom(harness, source);
  const hold = gate(); const entered = gate(); const original = harness.store.update.bind(harness.store);
  harness.store.update = async (name, callback, fallback) => {
    if (name === 'storage/delayed-write.json') { entered.release(); await hold.promise; }
    return original(name, callback, fallback);
  };
  const run = await harness.runTool('delayed-write__execute', { value: 'x' });
  await entered.promise; harness.cancel(run.id);
  let uninstalled = false;
  const removal = harness.uninstall('delayed-write').then(() => { uninstalled = true; });
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(uninstalled, false); assert.ok(await fs.stat(harness.store.file('run-delayed-write.lock')));
  hold.release(); await run.completion; await removal;
  assert.equal(run.status, 'cancelled'); assert.equal(uninstalled, true);
  assert.equal(await fs.stat(harness.store.file('storage/delayed-write.json')).catch(() => null), null);
});

test('150-entry trace limit never hides current approval or final state, and CLI receives the control event', async t => {
  const { harness } = await setup(t); const controller = new AbortController();
  const run = { id: 'long-trace', status: 'running', events: Array.from({ length: 150 }, (_, i) => ({ at: 'fixture', type: 'capability', message: String(i) })) };
  const emitted = []; harness.onEvent = (_, event) => emitted.push(event);
  const answer = harness.waitApproval(run, 'local-notes__add', { title: 'Test', content: 'Test' }, controller.signal);
  const approval = await until(() => run.events.find(event => event.type === 'approval'));
  assert.equal(run.events.length, 150); assert.equal(run.status, 'awaiting_approval'); assert.equal(run.traceTruncated, true);
  assert.equal(emitted.at(-1).type, 'approval');
  harness.approve(run.id, approval.data.callId, true); assert.equal(await answer, true);
  harness.event(run, 'success', 'finished'); assert.equal(run.events.length, 150); assert.equal(run.events.at(-1).type, 'success');
});
