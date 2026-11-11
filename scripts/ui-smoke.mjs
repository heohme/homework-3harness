import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Harness } from '../src/core/harness.js';
import { createServer } from '../src/server.js';

const project = fileURLToPath(new URL('../', import.meta.url));
const work = path.resolve(project, '.work/previews');
await fs.mkdir(work, { recursive: true });
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-ui-'));
const harness = await new Harness({ dataDir: path.join(directory, 'data') }).init();
const app = await createServer({ harness, port: 0 });
const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = process.env.HARNESS_BROWSER || (process.platform === 'darwin' ? macChrome : undefined);
let browser;
let page;
const errors = [];
try {
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${app.port}`);
  await page.getByTestId('catalog-install-workspace-reader').waitFor();
  assert.equal(await page.locator('#stat-installed').textContent(), '0');
  await page.screenshot({ path: path.join(work, 'initial.png'), fullPage: true });
  async function install(id) {
    await page.getByTestId(`catalog-install-${id}`).click();
    await page.getByTestId('dialog-confirm').click();
    await page.getByTestId('trust-confirm').check();
    await page.getByTestId('dialog-confirm').click();
    await page.getByTestId(`plugin-${id}`).waitFor();
  }
  async function enable(id) {
    await page.getByTestId(`enable-${id}`).click();
    await page.getByTestId('grants-confirm').check();
    await page.getByTestId('dialog-confirm').click();
    await page.getByTestId(`disable-${id}`).waitFor({ timeout: 4000 });
  }
  await install('workspace-reader'); await enable('workspace-reader');
  await page.getByTestId('config-workspace-reader').click();
  await page.getByTestId('field-maxResults').fill('4');
  await page.getByTestId('dialog-confirm').click();
  await page.getByTestId('enable-workspace-reader').waitFor({ timeout: 4000 });
  await enable('workspace-reader');
  await page.getByTestId('nav-run').click(); await page.getByTestId('mode-tool').click();
  await page.getByTestId('tool-select').selectOption('workspace-reader__search');
  await page.getByTestId('field-query').fill('plugin');
  // Polling must not overwrite an in-progress field.
  await page.waitForTimeout(1300); assert.equal(await page.getByTestId('field-query').inputValue(), 'plugin');
  await page.getByTestId('tool-run').click();
  await page.waitForFunction(() => document.getElementById('execution-status').textContent === '已完成');
  assert.match(await page.getByTestId('run-result').textContent(), /matches/);
  await page.getByTestId('nav-plugins').click(); await install('local-notes'); await enable('local-notes');
  await page.getByTestId('nav-run').click(); await page.getByTestId('mode-tool').click();
  await page.getByTestId('tool-select').selectOption('local-notes__add');
  await page.getByTestId('field-title').fill('UI regression'); await page.getByTestId('field-content').fill('Actual persisted note from browser');
  await page.getByTestId('tool-run').click(); await page.getByTestId('dialog-confirm').click();
  await page.waitForFunction(() => document.getElementById('execution-status').textContent === '已完成');
  assert.match(JSON.stringify(await harness.store.read('storage/local-notes.json')), /Actual persisted note/);
  await page.getByTestId('nav-history').click(); assert.ok(Number(await page.locator('#history-count').textContent()) >= 2);
  await page.getByTestId('nav-settings').click(); await page.getByTestId('model-name').fill('unsaved-name');
  await page.waitForTimeout(1300); assert.equal(await page.getByTestId('model-name').inputValue(), 'unsaved-name');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId('nav-plugins').click();
  const sizes = await page.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth }));
  assert.ok(sizes.scroll <= sizes.viewport + 1, `Mobile layout overflows: ${JSON.stringify(sizes)}`);
  await page.screenshot({ path: path.join(work, 'mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: UI install/grants/config revoke state, direct search, confirmed persistent note, history, preserved forms, and 390px layout.');
} catch (error) {
  if (page) await page.screenshot({ path: path.join(work, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser?.close(); await app.close(); await fs.rm(directory, { recursive: true, force: true });
}
