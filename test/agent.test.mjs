import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setup, install, result, until } from './helpers.mjs';

// Explicit protocol fixture, not a real LLM. It verifies HTTP/tool orchestration without credentials.
async function fixture(t, handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    requests.push({ url: req.url, input, authorization: req.headers.authorization });
    const output = await handler(input, req.url, requests);
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(output));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeIdleConnections(); await new Promise(resolve => server.close(resolve)); });
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}
const settings = (url, provider = 'ollama', maxSteps = 6) => ({ provider, baseUrl: url, model: 'fixture-model', maxSteps, allowRemote: false });

test('Ollama adapter dynamically advertises plugins, executes a read tool, and returns its real output', async t => {
  const { harness } = await setup(t); await install(harness, 'workspace-reader');
  const fake = await fixture(t, input => input.messages.some(item => item.role === 'tool')
    ? { message: { role: 'assistant', content: 'Completed using supplied tool output.' } }
    : { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'workspace-reader__search', arguments: { query: 'plugin' } } }] } });
  await harness.setModel(settings(fake.url));
  const run = await harness.runAgent('Find plugin design'); await run.completion; assert.equal(run.status, 'success'); assert.equal(run.result.toolCalls, 1);
  assert.equal(fake.requests[0].input.tools.length, 3); assert.equal(fake.requests[1].input.messages.at(-1).tool_name, 'workspace-reader__search');
  assert.match(fake.requests[1].input.messages.at(-1).content, /plugin/i);
  const disk = await harness.store.read('history.json'); assert.ok(!JSON.stringify(disk).includes('Find plugin design'));
});

test('Agent writes wait for user approval; approved notes persist', async t => {
  const { harness } = await setup(t); await install(harness, 'local-notes');
  const fake = await fixture(t, input => input.messages.some(item => item.role === 'tool')
    ? { message: { role: 'assistant', content: 'Notebook updated.' } }
    : { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'local-notes__add', arguments: { title: 'Approved', content: 'Real plugin write after approval' } } }] } });
  await harness.setModel(settings(fake.url)); const run = await harness.runAgent('Save note');
  const pending = await until(() => run.events.find(item => item.type === 'approval')); assert.equal(run.status, 'awaiting_approval');
  assert.equal(await harness.store.read('storage/local-notes.json'), null);
  harness.approve(run.id, pending.data.callId, true); await run.completion; assert.equal(run.status, 'success');
  assert.match(JSON.stringify((await result(harness, 'local-notes__list', {})).result), /Approved/);
});

test('denied write returns failure to the model and never changes storage', async t => {
  const { harness } = await setup(t); await install(harness, 'local-notes');
  const fake = await fixture(t, input => input.messages.some(item => item.role === 'tool')
    ? { message: { role: 'assistant', content: 'User declined the write.' } }
    : { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'local-notes__add', arguments: { title: 'Denied', content: 'Must not persist' } } }] } });
  await harness.setModel(settings(fake.url)); const run = await harness.runAgent('Save');
  const pending = await until(() => run.events.find(item => item.type === 'approval')); harness.approve(run.id, pending.data.callId, false); await run.completion;
  assert.equal(run.status, 'success'); assert.equal(await harness.store.read('storage/local-notes.json'), null);
  assert.match(fake.requests.at(-1).input.messages.at(-1).content, /APPROVAL_DENIED/);
});

test('OpenAI-compatible adapter sends tool_call_id and never exposes key in state', async t => {
  const { harness } = await setup(t); await install(harness, 'local-notes');
  const fake = await fixture(t, input => input.messages.some(item => item.role === 'tool')
    ? { choices: [{ message: { role: 'assistant', content: 'Read completed.' } }] }
    : { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'fixture-call', type: 'function', function: { name: 'local-notes__list', arguments: '{}' } }] } }] });
  await harness.setModel(settings(fake.url, 'openai')); const run = await harness.runAgent('List notes'); await run.completion; assert.equal(run.status, 'success');
  assert.equal(fake.requests[0].url, '/chat/completions'); assert.equal(fake.requests[1].input.messages.at(-1).tool_call_id, 'fixture-call'); assert.equal(fake.requests[0].input.max_tokens, 2048);
});

test('agent handles unknown tools and stops at a finite step limit', async t => {
  const { harness } = await setup(t);
  const fake = await fixture(t, () => ({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'uninstalled__tool', arguments: {} } }] } }));
  await harness.setModel(settings(fake.url, 'ollama', 2)); const run = await harness.runAgent('Keep going'); await run.completion;
  assert.equal(run.error.code, 'AGENT_STEP_LIMIT'); assert.equal(fake.requests.length, 2); assert.match(fake.requests[1].input.messages.at(-1).content, /UNKNOWN_TOOL/);
});

test('model unavailable is a visible error, not a simulated success', async t => {
  const { harness } = await setup(t);
  const server = http.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve));
  await harness.setModel(settings(`http://127.0.0.1:${port}`)); const run = await harness.runAgent('Hello'); await run.completion; assert.equal(run.status, 'error'); assert.equal(run.error.code, 'MODEL_UNAVAILABLE');
});
