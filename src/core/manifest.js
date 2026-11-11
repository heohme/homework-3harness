import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fail, validate } from './validation.js';

const schema = JSON.parse(await fs.readFile(fileURLToPath(new URL('../../schemas/plugin.schema.json', import.meta.url)), 'utf8'));

export async function snapshot(directory) {
  const root = path.resolve(directory);
  const files = [];
  let total = 0;
  async function visit(location, prefix = '') {
    const stat = await fs.lstat(location).catch(() => fail('PLUGIN_NOT_FOUND', '插件目录不存在或不可访问。', 404));
    if (stat.isSymbolicLink()) fail('SYMLINK_DENIED', '插件包不能包含符号链接。');
    if (!stat.isDirectory()) fail('INVALID_PACKAGE', '插件来源必须是一个本地目录。');
    for (const entry of (await fs.readdir(location, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') fail('INVALID_PACKAGE', '插件包不能包含隐藏文件或 node_modules；请使用独立、无依赖的分发目录。');
      const name = prefix + entry.name;
      const full = path.join(location, entry.name);
      const stat = await fs.lstat(full);
      if (stat.isSymbolicLink()) fail('SYMLINK_DENIED', '插件包不能包含符号链接。');
      if (stat.isDirectory()) { await visit(full, `${name}/`); continue; }
      if (!stat.isFile() || stat.size > 1024 * 1024) fail('INVALID_PACKAGE', '插件文件类型或大小不受支持（单文件最大 1 MiB）。');
      const content = await fs.readFile(full);
      total += content.length;
      files.push({ name, content });
      if (files.length > 64 || total > 2 * 1024 * 1024) fail('SIZE_LIMIT', '插件包最大 64 个文件、2 MiB。');
    }
  }
  await visit(root);
  const manifestFile = files.find(file => file.name === 'plugin.json');
  if (!manifestFile) fail('INVALID_MANIFEST', '目录中缺少 plugin.json。');
  let manifest;
  try { manifest = JSON.parse(manifestFile.content.toString('utf8')); }
  catch { fail('INVALID_MANIFEST', 'plugin.json 不是有效 JSON。'); }
  validate(schema, manifest, '插件清单');
  if (path.isAbsolute(manifest.entry) || manifest.entry.split('/').some(part => !part || part === '..' || part === '.')) fail('INVALID_ENTRY', '插件 entry 必须是包内相对路径，不允许路径跳转。');
  if (!files.some(file => file.name === manifest.entry)) fail('INVALID_ENTRY', '插件 entry 文件不存在。');
  if (manifest.configSchema.type !== 'object' || manifest.tools.some(tool => tool.inputSchema.type !== 'object')) fail('INVALID_SCHEMA', '配置与工具输入 schema 必须以 object 为根类型。');
  if (new Set(manifest.tools.map(tool => tool.name)).size !== manifest.tools.length) fail('DUPLICATE_TOOL', '插件工具名称不能重复。');
  // Compile schemas without requiring a valid value; schema errors must fail at install time.
  for (const current of [manifest.configSchema, ...manifest.tools.map(tool => tool.inputSchema)]) {
    try { validate(current, {}, 'Schema'); }
    catch (error) { if (error.code !== 'VALIDATION_ERROR') throw error; }
  }
  const hash = createHash('sha256');
  for (const file of files) { hash.update(file.name); hash.update('\0'); hash.update(String(file.content.length)); hash.update('\0'); hash.update(file.content); }
  return { path: root, manifest, digest: hash.digest('hex'), filesCount: files.length, files };
}

export async function writeSnapshot(source, destination) {
  await fs.mkdir(destination, { recursive: false, mode: 0o700 });
  for (const file of source.files) {
    const target = path.join(destination, file.name);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, file.content, { mode: 0o600, flag: 'wx' });
  }
}
