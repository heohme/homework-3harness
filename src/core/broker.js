import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { fail, object, jsonSize } from './validation.js';

const BLOCKED = new Set(['node_modules', 'dist', 'build', 'coverage', 'Pods', 'vendor']);
const TEXT_EXT = new Set(['.txt', '.md', '.json', '.js', '.mjs', '.ts', '.tsx', '.jsx', '.css', '.html', '.yml', '.yaml', '.toml', '.py', '.go', '.rs', '.csv', '.xml', '.sql']);
function allowed(relative) {
  const parts = relative.split(/[\\/]/);
  return parts.every(part => part && !part.startsWith('.') && !BLOCKED.has(part) && !/\.(pem|key|p12|pfx|jks|keystore)$/i.test(part));
}
function textFile(relative) { return TEXT_EXT.has(path.extname(relative).toLowerCase()) || ['README', 'LICENSE', 'Makefile'].includes(path.basename(relative)); }

export async function normalizeConfig(manifest, config, cwd) {
  if (manifest.permissions.includes('workspace.read')) {
    if (typeof config.root !== 'string' || !config.root.trim()) fail('WORKSPACE_REQUIRED', '需要配置并授权一个工作区根目录。');
    const original = path.resolve(cwd, config.root);
    if ((await fs.lstat(original).catch(() => fail('WORKSPACE_NOT_FOUND', '工作区目录不存在。'))).isSymbolicLink()) fail('SYMLINK_DENIED', '工作区根目录不能是符号链接。');
    config.root = await fs.realpath(original);
    if (!(await fs.stat(config.root)).isDirectory()) fail('WORKSPACE_REQUIRED', '工作区必须是目录。');
  }
  return config;
}

export function createBroker(store, plugin, event, signal, { allowWrites = false } = {}) {
  let halted = false;
  async function ensure(permission) {
    if (halted || signal?.aborted) fail('CANCELLED', '运行已取消。');
    const current = (await store.registry()).plugins.find(item => item.manifest.id === plugin.manifest.id);
    if (halted || signal?.aborted) fail('CANCELLED', '运行已取消。');
    if (!current?.enabled || current.digest !== plugin.digest || !current.grants.includes(permission) || JSON.stringify(current.config) !== JSON.stringify(plugin.config)) fail('PERMISSION_DENIED', '插件已禁用、配置已改变，或未获得请求的能力授权。', 403);
  }
  async function safePath(relative = '.', isDirectory = false) {
    if (typeof relative !== 'string' || relative.length > 1024 || path.isAbsolute(relative) || relative.includes('\0') || relative.includes('\\')) fail('PATH_DENIED', '路径必须是工作区内的相对路径。', 403);
    const root = plugin.config.root;
    const target = path.resolve(root, relative);
    const rel = path.relative(root, target);
    if (rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel)) fail('PATH_DENIED', '不能访问工作区之外的路径。', 403);
    if (rel && !allowed(rel)) fail('SENSITIVE_FILE', '隐藏文件、密钥和依赖 / 构建目录不允许读取。', 403);
    let cursor = root;
    for (const part of rel.split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, part);
      if ((await fs.lstat(cursor).catch(() => fail('FILE_NOT_FOUND', '文件或目录不存在。', 404))).isSymbolicLink()) fail('SYMLINK_DENIED', '不允许通过符号链接读取文件。', 403);
    }
    const real = await fs.realpath(target);
    const actual = path.relative(root, real);
    if (actual === '..' || actual.startsWith('..' + path.sep) || path.isAbsolute(actual)) fail('PATH_DENIED', '实际路径超出授权工作区。', 403);
    const stat = await fs.stat(real);
    if (isDirectory ? !stat.isDirectory() : !stat.isFile()) fail('INVALID_FILE', isDirectory ? '路径不是目录。' : '路径不是普通文件。');
    return { target: real, relative: actual, stat };
  }
  const broker = async (method, params) => {
    object(params);
    if (method === 'workspace.list') {
      await ensure('workspace.read');
      const start = await safePath(params.path || '.', true);
      const files = [];
      let truncated = false;
      let visited = 0;
      async function walk(directory, depth = 0) {
        if (depth > 12 || visited > 1000 || signal?.aborted) { truncated = true; return; }
        const entries = await fs.readdir(directory, { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
          if (++visited > 1000 || files.length >= 100) { truncated = true; return; }
          const full = path.join(directory, entry.name);
          const relative = path.relative(plugin.config.root, full);
          if (!allowed(relative) || entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) await walk(full, depth + 1);
          else if (entry.isFile() && textFile(relative)) {
            const { stat } = await safePath(relative);
            files.push({ path: relative, size: stat.size });
          }
        }
      }
      await walk(start.target);
      event('capability', '读取授权工作区的文件列表');
      return { files, truncated };
    }
    if (method === 'workspace.read') {
      await ensure('workspace.read');
      const file = await safePath(params.path);
      if (!textFile(file.relative)) fail('BINARY_DENIED', '仅支持已知类型的文本文件。');
      const handle = await fs.open(file.target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const buffer = Buffer.alloc(65536);
      let bytesRead;
      try { ({ bytesRead } = await handle.read(buffer, 0, buffer.length, 0)); }
      finally { await handle.close(); }
      const bytes = buffer.subarray(0, bytesRead);
      if (bytes.includes(0)) fail('BINARY_DENIED', '检测到二进制内容，已拒绝读取。');
      event('capability', '读取授权工作区中的文本文件');
      return { path: file.relative, content: bytes.toString('utf8'), truncated: file.stat.size > bytesRead };
    }
    if (method === 'storage.get' || method === 'storage.set') {
      await ensure(method === 'storage.get' ? 'storage.read' : 'storage.write');
      if (method === 'storage.set' && !allowWrites) fail('WRITE_NOT_ALLOWED', '只读工具不能请求写入存储。', 403);
      if (typeof params.key !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(params.key)) fail('INVALID_KEY', '存储 key 必须是 1–64 位字母、数字、下划线或连字符。');
      if (['__proto__', 'constructor', 'prototype'].includes(params.key)) fail('INVALID_KEY', '不允许使用保留的存储键。');
      const file = `storage/${plugin.manifest.id}.json`;
      if (method === 'storage.get') return (await store.read(file, {}))[params.key] ?? null;
      jsonSize(params.value, 512 * 1024);
      await store.update(file, async data => {
        // This callback runs with the global write lock held: revocation cannot race the commit.
        await ensure('storage.write');
        data[params.key] = params.value;
        return data;
      }, {});
      event('capability', '写入插件独立的本地存储');
      return { ok: true };
    }
    fail('UNKNOWN_CAPABILITY', '插件请求了不支持的宿主能力。', 403);
  };
  broker.cancel = () => { halted = true; };
  return broker;
}
