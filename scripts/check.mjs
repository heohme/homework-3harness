import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
let count = 0;
let failed = false;
async function check(directory) {
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, item.name);
    if (item.isDirectory()) await check(full);
    else if (/\.(js|mjs)$/.test(item.name)) {
      const result = spawnSync(process.execPath, ['--check', full], { encoding: 'utf8' });
      count++;
      if (result.status !== 0) { failed = true; process.stderr.write(result.stderr); }
    } else if (item.name.endsWith('.json')) {
      try { JSON.parse(await fs.readFile(full, 'utf8')); }
      catch (error) { failed = true; console.error(full, error.message); }
    }
  }
}
for (const directory of ['src', 'public', 'plugins', 'schemas', 'scripts', 'test']) {
  const full = path.join(root, directory);
  if (await fs.stat(full).catch(() => null)) await check(full);
}
console.log(`${failed ? 'FAIL' : 'PASS'}: ${count} JavaScript modules syntax checked; JSON files parsed. This is not a typecheck or behavioral test.`);
process.exitCode = failed ? 1 : 0;
