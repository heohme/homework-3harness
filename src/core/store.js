import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fail, jsonSize } from './validation.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const DEFAULT_MODEL = { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3:8b', maxSteps: 6, allowRemote: false };

export class Store {
  constructor(directory) { this.directory = path.resolve(directory); }
  async init() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    if ((await fs.lstat(this.directory)).isSymbolicLink()) fail('UNSAFE_DATA_DIR', '数据目录不能是符号链接。');
    await fs.chmod(this.directory, 0o700);
    for (const name of ['plugins', 'storage']) await fs.mkdir(this.file(name), { recursive: true, mode: 0o700 });
    await this.update('registry.json', state => state, { schemaVersion: 1, plugins: [], model: DEFAULT_MODEL });
  }
  file(name) { return path.join(this.directory, name); }
  async read(name, fallback = null) {
    try {
      if ((await fs.lstat(this.file(name))).isSymbolicLink()) fail('UNSAFE_DATA_FILE', '数据文件不能是符号链接。');
      return JSON.parse(await fs.readFile(this.file(name), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return structuredClone(fallback);
      if (error instanceof SyntaxError) fail('CORRUPT_STATE', `本地 ${name} 无法解析；请先备份，不能自动覆盖。`, 500);
      throw error;
    }
  }
  async atomic(name, value) {
    const target = this.file(name);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, jsonSize(value, 4 * 1024 * 1024), { mode: 0o600, flag: 'wx' });
    try { await fs.rename(temporary, target); }
    finally { await fs.rm(temporary, { force: true }); }
  }
  async lock(lockName = 'write.lock') {
    const name = this.file(lockName);
    const owner = `${process.pid}:${randomUUID()}`;
    for (let attempt = 0; attempt < 150; attempt++) {
      try {
        const handle = await fs.open(name, 'wx', 0o600);
        await handle.writeFile(owner); await handle.close();
        return async () => { if (await fs.readFile(name, 'utf8').catch(() => '') === owner) await fs.rm(name, { force: true }); };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const previous = await fs.readFile(name, 'utf8').catch(() => '');
        const pid = Number(previous.split(':')[0]);
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); }
          catch (e) {
            if (e.code === 'ESRCH' && await fs.readFile(name, 'utf8').catch(() => '') === previous) await fs.rm(name, { force: true });
          }
        }
        await delay(20);
      }
    }
    fail('STATE_BUSY', '另一个本地进程正在修改数据，请稍后重试。', 409);
  }
  async update(name, change, fallback = null) {
    const release = await this.lock();
    try {
      const next = await change(await this.read(name, fallback));
      await this.atomic(name, next);
      return next;
    } finally { await release(); }
  }
  async registry() {
    const value = await this.read('registry.json');
    if (value?.schemaVersion !== 1 || !Array.isArray(value.plugins) || !value.model) fail('CORRUPT_STATE', '本地配置结构无效或版本不兼容。', 500);
    return value;
  }
  async remember(run) {
    const summary = { id: run.id, type: run.type, status: run.status, toolName: run.toolName, startedAt: run.startedAt, endedAt: run.endedAt, error: run.error ? { code: run.error.code, message: '运行未完成，详细信息仅在当前进程中保留。' } : undefined };
    await this.update('history.json', list => [summary, ...list.filter(item => item.id !== run.id)].slice(0, 50), []);
  }
}
