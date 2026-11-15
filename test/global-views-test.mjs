import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { launchBrowser } from './browser.mjs';
import { waitForApp, waitForNote } from './waits.mjs';

const ROOT = path.resolve(import.meta.dirname, '..'), HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tracery-global-views-'));
const VAULT = path.join(HOME, 'vault'), OUT = path.join(ROOT, 'dist/global-views'), BASE = 'http://127.0.0.1:9719';
for (const dir of [VAULT, OUT]) fs.mkdirSync(dir, { recursive: true });
const source = '# 阅读计划\n\n- [ ] 阅读注意力机制论文\n- [ ] 整理模型卡片 due:2099-11-20\n- [x] 完成基础复习\n';
fs.writeFileSync(path.join(VAULT, '阅读计划.md'), source);
fs.writeFileSync(path.join(VAULT, '论文摘录.md'), '---\ncourse: 机器学习\nstatus: 学习中\nmastery: 65\n---\n# 论文摘录\n\n保留正文。\n');
fs.writeFileSync(path.join(HOME, 'tracery.config.json'), JSON.stringify({ currentVault: VAULT, settings: { startup: 'empty', themeMode: 'light', accent: 'purple' } }));
const server = spawn(process.execPath, [path.join(ROOT, 'server/server.js')], { env: { ...process.env, PORT: '9719', TRACERY_HOME: HOME }, windowsHide: true, stdio: 'pipe' });
let browser, page;
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/api/state')).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await launchBrowser({ width: 1440, height: 1000 }); page = await browser.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(BASE, { waitUntil: 'networkidle0' }); await waitForApp(page);
  await page.evaluate(() => window.__tracery.openNote('阅读计划.md')); await waitForNote(page, '阅读计划.md', source);
  const layout = await page.evaluate(async () => (await window.__tracery.Api.state()).settings.layout);
  const geometry = () => page.evaluate(() => {
    const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
    const visible = document.querySelector('#editor-area[data-note-view] .note-list-sheet:not([hidden])');
    return { ribbon: rect('.ribbon'), editor: rect('#editor-area'), sheet: visible.getBoundingClientRect().toJSON(), sidebar: rect('#sidebar').width, context: rect('#sidebar-right').width,
      active: [...document.querySelectorAll('.ribbon-btn.active')].map(el => el.id), border: getComputedStyle(visible).borderWidth, kind: document.body.dataset.workspaceView };
  });
  const check = async kind => {
    await page.waitForFunction(kind => document.body.dataset.workspaceView === kind, {}, kind);
    const m = await geometry(); assert.equal(m.sidebar, 0); assert.equal(m.context, 0);
    assert.ok(m.editor.left >= m.ribbon.right && m.editor.left - m.ribbon.right <= 12, JSON.stringify(m));
    assert.ok(Math.abs(m.sheet.left - m.editor.left) < 1 && Math.abs(m.sheet.width - m.editor.width) < 1, JSON.stringify(m));
    assert.deepEqual(m.active, [kind === 'list' ? 'btn-note-list' : 'btn-task-list']);
    if (kind === 'tasks') assert.equal(m.border, '0px');
  };
  assert.equal(await page.$('#workspace-tools'), null);
  assert.equal(await page.$$eval('.ribbon > button[data-workspace-view]', els => els.length), 2);
  await page.click('#btn-note-list'); await check('list'); await page.waitForFunction(() => document.querySelector('#note-list-rows').children.length === 2);
  await page.screenshot({ path: path.join(OUT, 'notes-desktop.png') });
  await page.click('#btn-task-list'); await check('tasks'); await page.waitForFunction(() => document.querySelector('#task-rows').children.length === 2);
  assert.equal(await page.$eval('#note-list-view', el => el.hidden), true);
  await page.screenshot({ path: path.join(OUT, 'tasks-desktop.png') });
  await page.click('#task-close'); await waitForNote(page, '阅读计划.md', source);
  assert.equal(await page.evaluate(() => document.body.dataset.workspaceView), undefined);
  assert.ok(await page.$eval('#sidebar', el => el.getBoundingClientRect().width > 0));
  assert.ok(await page.$eval('#sidebar-right', el => el.getBoundingClientRect().width > 0));
  assert.deepEqual(await page.evaluate(async () => (await window.__tracery.Api.state()).settings.layout), layout);
  await page.click('#btn-note-list'); await page.click('.ribbon-btn[data-panel="files"]');
  assert.equal(await page.$eval('#note-list-view', el => el.hidden), true);
  assert.equal(await page.evaluate(() => document.body.dataset.workspaceView), undefined);
  await page.evaluate(() => { window.testFlush = window.__editor.flush; window.__editor.flush = async () => false; });
  await page.click('#btn-task-list'); assert.equal(await page.$eval('#task-list-view', el => el.hidden), true);
  await page.evaluate(() => { window.__editor.flush = window.testFlush; delete window.testFlush; });
  await page.click('#btn-task-list'); await check('tasks');
  await page.click('#task-rows .task-source'); await page.waitForFunction(() => document.querySelector('#task-list-view').hidden);
  assert.equal(await page.evaluate(() => document.body.dataset.workspaceView), undefined);
  await page.click('#btn-task-list'); await page.setViewport({ width: 390, height: 844 }); await check('tasks');
  assert.equal(await page.$eval('#task-list-view', el => el.scrollWidth > el.clientWidth), false);
  await page.evaluate(async () => { await (await import('/js/settings.js')).updateSettings({ themeMode: 'dark' }); await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))); });
  await page.screenshot({ path: path.join(OUT, 'tasks-mobile-dark.png') });
  await page.click('#btn-note-list'); await check('list');
  assert.equal(await page.$eval('#note-list-view', el => el.scrollWidth > el.clientWidth), false);
  await page.click('#note-list-close');
  assert.equal(await page.evaluate(() => document.body.dataset.workspaceView), undefined);
  assert.equal(fs.readFileSync(path.join(VAULT, '阅读计划.md'), 'utf8'), source); assert.deepEqual(errors, []);
  console.log('PASS 全库视图入口、工作区铺满、单层任务页、导航互斥、返回恢复侧栏/笔记/设置、保存失败保护、来源跳转与手机深色布局');
} catch (error) { if (page) await page.screenshot({ path: path.join(OUT, 'failure.png') }); throw error; }
finally { await browser?.close(); server.kill(); }
