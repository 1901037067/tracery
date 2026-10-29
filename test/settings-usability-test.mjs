import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { launchBrowser } from './browser.mjs';
import { waitForApp } from './waits.mjs';
const ROOT = path.resolve(import.meta.dirname, '..'), HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tracery-settings-'));
const VAULT = path.join(HOME, 'vault'), OUT = path.join(ROOT, 'dist/settings-usability');
fs.mkdirSync(VAULT); fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(VAULT, '笔记.md'), '# 设置验证');
fs.writeFileSync(path.join(HOME, 'tracery.config.json'), JSON.stringify({ currentVault: VAULT, settings: { themeMode: 'light', startup: 'empty' } }));
const BASE = 'http://127.0.0.1:9697';
const server = spawn(process.execPath, [path.join(ROOT, 'server/server.js')], { env: { ...process.env, PORT: '9697', TRACERY_HOME: HOME }, windowsHide: true, stdio: 'pipe' });
let browser, page;
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/api/state')).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await launchBrowser({ width: 1440, height: 1000 }); page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(BASE, { waitUntil: 'networkidle0' }); await waitForApp(page);
  await page.click('#btn-settings');
  await page.keyboard.press('End');
  assert.equal(await page.$eval('.settings-nav [aria-selected="true"]', el => el.dataset.pane), 'about');
  await page.keyboard.press('Home'); await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'set-done');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'settings-tab-appearance');
  await page.click('#settings-tab-general');
  await page.evaluate(async () => { const { askConfirm } = await import('/js/dialog.js'); window.dialogResult = 'pending'; void askConfirm({ title: '删除测试内容？', desc: '仅用于键盘验证。', danger: true }).then(value => { window.dialogResult = value; }); });
  assert.equal(await page.evaluate(() => document.activeElement.className), 'dialog-cancel btn-ghost');
  await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
  assert.ok(await page.evaluate(() => document.activeElement.classList.contains('dialog-ok')));
  await page.keyboard.press('Tab');
  assert.ok(await page.evaluate(() => document.activeElement.classList.contains('dialog-cancel')));
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => window.dialogResult), false);
  assert.equal(await page.$eval('#settings', el => el.hidden), false, 'Escape must close only the nested confirmation');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'settings-tab-general');
  await page.evaluate(async () => { const { askText } = await import('/js/dialog.js'); void askText({ title: '新名称' }); });
  await page.keyboard.press('Enter');
  assert.equal(await page.$eval('.dialog-input', el => el.getAttribute('aria-invalid')), 'true');
  await page.keyboard.type('输入后清除错误');
  assert.equal(await page.$eval('.dialog-input', el => el.hasAttribute('aria-invalid')), false);
  await page.keyboard.press('Escape');

  await page.click('#full-backup-create');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'full-backup-destination');
  assert.equal(await page.$eval('#full-backup-destination', el => el.getAttribute('aria-invalid')), 'true');
  let starts = 0, cancellations = 0, cancelled = false;
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    const respond = data => request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
    if (url.pathname === '/api/backup/create') { starts++; return void respond({ id: 'ui-state-job' }); }
    if (url.pathname === '/api/backup/cancel') { cancellations++; cancelled = true; return void respond({ ok: true }); }
    if (url.pathname === '/api/backup/status') return void respond(cancelled ? { status: 'cancelled', phase: '已取消', kind: 'create' } : { status: 'running', phase: '正在复制', total: 3, completed: 1, bytes: 2048, kind: 'create' });
    void request.continue();
  });
  await page.evaluate(async () => {
    const { configureFullBackup } = await import('/js/full-backup.js'); window.prepareCalls = 0;
    configureFullBackup({ prepare: async () => { window.prepareCalls++; await new Promise(resolve => setTimeout(resolve, 250)); return {}; } });
    document.querySelector('#full-backup-destination').value = 'test-backup-location';
    document.querySelector('#full-backup-create').onclick(); document.querySelector('#full-backup-create').onclick();
  });
  await page.waitForSelector('#full-backup-progress:not([hidden])');
  assert.equal(starts, 1); assert.equal(await page.evaluate(() => window.prepareCalls), 1);
  assert.deepEqual(await page.$eval('#full-backup-progress', el => [el.value, el.max]), [1, 3]);
  assert.equal(await page.$eval('#full-backup-restore', el => el.disabled), true);
  await page.screenshot({ path: path.join(OUT, 'running.png') });
  await page.click('#full-backup-cancel');
  await page.waitForFunction(() => document.querySelector('#full-backup-result').textContent.includes('已取消'));
  assert.equal(cancellations, 1);
  assert.equal(await page.$eval('#full-backup-cancel', el => el.hidden), true);
  assert.equal(await page.$eval('#full-backup-create', el => el.disabled), false);
  await page.click('#set-done');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'btn-settings');
  await page.click('#file-tree [data-path="笔记.md"]', { button: 'right' });
  assert.equal(await page.$eval('.context-menu', el => el.getAttribute('role')), 'menu');
  await page.keyboard.press('End');
  assert.ok(await page.evaluate(() => document.activeElement === document.querySelector('.context-menu button:last-child')));
  await page.keyboard.press('Home'); await page.keyboard.press('ArrowDown');
  assert.ok(await page.evaluate(() => document.activeElement.closest('.context-menu')));
  await page.keyboard.press('Escape'); assert.equal(await page.$('.context-menu'), null);
  for (const mode of ['light', 'dark']) for (const width of [1440, 768, 390]) {
    await page.setViewport({ width, height: 1000 });
    await page.evaluate(async mode => { const { openSettings, updateSettings } = await import('/js/settings.js'); await updateSettings({ themeMode: mode }); openSettings('general'); }, mode);
    await page.$eval('#full-backup-create', el => el.scrollIntoView({ block: 'center' }));
    assert.ok(await page.$eval('#full-backup-create', el => el.getBoundingClientRect().height >= (innerWidth < 600 ? 44 : 36)));
    assert.equal(await page.$eval('.settings-pane.active', pane => [...pane.querySelectorAll('*')].some(el => el.getBoundingClientRect().right > innerWidth)), false);
    await page.screenshot({ path: path.join(OUT, `${width}-${mode}.png`) });
  }
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.evaluate(async () => { const { askConfirm } = await import('/js/dialog.js'); void askConfirm({ title: '减少动态效果' }); });
  assert.equal(await page.$eval('.dialog-card', el => getComputedStyle(el).animationName), 'none');
  await page.keyboard.press('Escape'); assert.deepEqual(errors, []);
  console.log('PASS settings tab/focus containment and return, nested Escape, dialog validation, single async backup start, truthful progress/cancel, keyboard menus, six responsive theme renders and reduced motion');
} catch (error) { if (page) await page.screenshot({ path: path.join(OUT, 'failure.png') }); throw error; }
finally { await browser?.close(); server.kill(); }
