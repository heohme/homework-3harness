import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../src/server.js';
import { setup, until } from './helpers.mjs';

async function app(t) {
  const { harness } = await setup(t);
  const service = await createServer({ harness, port: 0 }); t.after(() => service.close());
  const base = `http://127.0.0.1:${service.port}`;
  const token = (await (await fetch(`${base}/api/session`)).json()).token;
  const api = async (route, method = 'GET', input, extraHeaders = {}) => {
    const response = await fetch(base + route, { method, headers: { Authorization: `Bearer ${token}`, ...(input !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders }, body: input !== undefined ? JSON.stringify(input) : undefined });
    return { status: response.status, data: await response.json(), response };
  };
  return { base, api, service };
}

test('HTTP serves UI, route manifest and rejects cross-origin/unauthenticated API requests', async t => {
  const { base, api, service } = await app(t);
  assert.equal(service.server.address().address, '127.0.0.1');
  const page = await fetch(base); assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const routes = await (await fetch(base + '/manus-routes.json')).json(); assert.deepEqual(routes.routes.map(item => item.path), ['/']);
  const denied = await fetch(base + '/api/state'); assert.equal(denied.status, 401);
  assert.equal((await api('/api/state', 'GET', undefined, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await api('/api/plugins/inspect', 'POST', { path: './plugins/local-notes' }, { Origin: 'https://evil.example' })).status, 403);
  const wrongHost = await new Promise(resolve => {
    http.get({ hostname: '127.0.0.1', port: service.port, path: '/api/session', headers: { Host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); });
  }); assert.equal(wrongHost, 403);
  assert.equal((await api('/api/state')).status, 200);
});

test('API supports inspect/install/configure/enable/run/disable/uninstall without hard-coded dispatch', async t => {
  const { api } = await app(t);
  const initial = (await api('/api/state')).data; assert.equal(initial.plugins.length, 0); assert.equal(initial.catalog.length, 2);
  const pkg = (await api('/api/plugins/inspect', 'POST', { path: './plugins/local-notes' })).data;
  const installed = await api('/api/plugins/install', 'POST', { path: pkg.path, digest: pkg.digest, trusted: true }); assert.equal(installed.status, 201); assert.equal(installed.data.enabled, false);
  assert.equal((await api('/api/plugins/local-notes/config', 'PUT', { config: { notebook: 'HTTP', maxNotes: 200 } })).status, 200);
  assert.equal((await api('/api/plugins/local-notes/enable', 'POST', { grants: ['storage.read','storage.write'] })).status, 200);
  const started = await api('/api/tools/run', 'POST', { name: 'local-notes__add', args: { title: 'Actual', content: 'Persisted via HTTP' } }); assert.equal(started.status, 202);
  const run = await until(async () => { const state = (await api('/api/state')).data; const run = state.runs.find(item => item.id === started.data.run.id); return ['success','error'].includes(run?.status) ? run : null; });
  assert.equal(run.status, 'success'); assert.match(JSON.stringify(run.result), /Actual/);
  assert.equal((await api('/api/plugins/local-notes/disable', 'POST', {})).status, 200);
  assert.equal((await api('/api/state')).data.tools.length, 0);
  assert.equal((await api('/api/plugins/local-notes', 'DELETE')).status, 200);
  assert.equal((await api('/api/runs', 'DELETE')).status, 200);
});

test('API rejects bad JSON, oversized input, unsupported content type and unsafe model URLs', async t => {
  const { api, base } = await app(t);
  assert.equal((await api('/api/model', 'PUT', { provider: 'openai', baseUrl: 'https://api.example/v1', model: 'example', maxSteps: 6, allowRemote: false })).data.error.code, 'REMOTE_NOT_ALLOWED');
  assert.equal((await api('/api/model', 'PUT', { provider: 'openai', baseUrl: 'http://api.example/v1', model: 'example', maxSteps: 6, allowRemote: true })).data.error.code, 'INVALID_MODEL_URL');
  assert.equal((await api('/api/model', 'PUT', { provider: 'openai', baseUrl: 'https://secret:password@example.com/v1', model: 'example', maxSteps: 6, allowRemote: true })).data.error.code, 'INVALID_MODEL_URL');
  const token = (await (await fetch(base + '/api/session')).json()).token;
  const malformed = await fetch(base + '/api/agent/run', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{broken' }); assert.equal(malformed.status, 400);
  const contentType = await fetch(base + '/api/agent/run', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: '{}' }); assert.equal(contentType.status, 415);
  const oversized = await api('/api/agent/run', 'POST', { prompt: 'x'.repeat(140000) }); assert.equal(oversized.status, 413);
  const state = (await api('/api/state')).data; assert.equal(state.model.apiKeyConfigured, Boolean(process.env.HARNESS_MODEL_API_KEY)); assert.ok(!('apiKey' in state.model));
});
