import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Harness, APP_ROOT } from './core/harness.js';
import { fail, HarnessError, errorInfo, object } from './core/validation.js';

const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/manus-routes.json', ['manus-routes.json', 'application/json; charset=utf-8']]
]);
const publicRun = ({ completion, ...run }) => run;

async function body(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) fail('CONTENT_TYPE', 'API 需要 application/json。', 415);
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 131072) fail('BODY_TOO_LARGE', '请求内容超过 128 KiB。', 413);
    chunks.push(chunk);
  }
  try { return object(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
  catch (error) { if (error instanceof HarnessError) throw error; fail('INVALID_JSON', '请求不是有效的 JSON 对象。'); }
}

export async function createServer({ harness, port = 4317 } = {}) {
  harness ||= await new Harness().init();
  const token = randomBytes(32).toString('hex');
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Cache-Control', 'no-store');
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    try {
      const actualPort = server.address()?.port;
      const allowedHosts = new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`]);
      if (!allowedHosts.has(req.headers.host)) fail('HOST_DENIED', '只允许本机回环地址，拒绝未知 Host。', 403);
      const origin = req.headers.origin;
      if (origin && ![...allowedHosts].some(host => origin === `http://${host}`)) fail('ORIGIN_DENIED', '拒绝其他网页访问本地宿主。', 403);
      if (req.headers['sec-fetch-site'] === 'cross-site') fail('ORIGIN_DENIED', '拒绝跨站请求。', 403);
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET' && url.pathname === '/api/session') { send(200, { token }); return; }
      if (url.pathname.startsWith('/api/')) {
        const provided = String(req.headers.authorization || '').replace(/^Bearer /, '');
        if (provided.length !== token.length || !timingSafeEqual(Buffer.from(provided), Buffer.from(token))) fail('UNAUTHORIZED', '本地会话已失效，请刷新控制台。', 401);
        if (req.method === 'GET' && url.pathname === '/api/state') { send(200, await harness.state()); return; }
        const input = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await body(req) : {};
        if (req.method === 'POST' && url.pathname === '/api/plugins/inspect') { send(200, await harness.inspect(input.path)); return; }
        if (req.method === 'POST' && url.pathname === '/api/plugins/install') { send(201, await harness.install(input)); return; }
        const plugin = url.pathname.match(/^\/api\/plugins\/([a-z][a-z0-9-]{0,31})(?:\/(config|enable|disable))?$/);
        if (plugin) {
          const [, id, action] = plugin;
          if (req.method === 'PUT' && action === 'config') { send(200, await harness.configure(id, input.config)); return; }
          if (req.method === 'POST' && action === 'enable') { send(200, await harness.enable(id, input.grants)); return; }
          if (req.method === 'POST' && action === 'disable') { send(200, await harness.disable(id)); return; }
          if (req.method === 'DELETE' && !action) { send(200, await harness.uninstall(id)); return; }
        }
        if (req.method === 'POST' && url.pathname === '/api/tools/run') { send(202, { run: publicRun(await harness.runTool(input.name, input.args)) }); return; }
        if (req.method === 'POST' && url.pathname === '/api/agent/run') { send(202, { run: publicRun(await harness.runAgent(input.prompt)) }); return; }
        const run = url.pathname.match(/^\/api\/runs\/([a-f0-9-]{36})\/(cancel|approve)$/);
        if (run && req.method === 'POST') { send(200, run[2] === 'cancel' ? harness.cancel(run[1]) : harness.approve(run[1], input.callId, input.approved)); return; }
        if (req.method === 'DELETE' && url.pathname === '/api/runs') { send(200, await harness.clearRuns()); return; }
        if (req.method === 'PUT' && url.pathname === '/api/model') { send(200, await harness.setModel(input)); return; }
        if (req.method === 'POST' && url.pathname === '/api/model/test') { send(200, await harness.testModel()); return; }
        fail('NOT_FOUND', 'API 路径或请求方法不存在。', 404);
      }
      if (req.method === 'GET' && ASSETS.has(url.pathname)) {
        const [filename, contentType] = ASSETS.get(url.pathname);
        const content = await fs.readFile(path.join(APP_ROOT, 'public', filename));
        res.writeHead(200, { 'Content-Type': contentType }); res.end(content); return;
      }
      fail('NOT_FOUND', '页面不存在。', 404);
    } catch (error) { if (!res.headersSent) send(error.status || 500, { error: errorInfo(error) }); else res.end(); }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { server, harness, port: server.address().port, async close() { await harness.close(); server.closeIdleConnections(); await new Promise(resolve => server.close(resolve)); } };
}
