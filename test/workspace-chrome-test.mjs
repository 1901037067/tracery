/* 标签动画必须可中断且不改变当前文档；删除仅在永久移除时确认。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { launchBrowser } from './browser.mjs';
import { waitForApp, waitForNote } from './waits.mjs';
const ROOT = path.resolve(import.meta.dirname, '..'), HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tracery-chrome-'));
const VAULT = path.join(HOME, 'vault'), OUT = path.join(ROOT, 'dist/workspace-chrome');
fs.mkdirSync(VAULT); fs.mkdirSync(OUT, { recursive: true }); fs.mkdirSync(path.join(VAULT, '子目录'));
for (const rel of ['一.md', '二.md', '三.md', '待删.md', '子目录/同名.md']) fs.writeFileSync(path.join(VAULT, rel), '# ' + rel + '\n正文');
fs.copyFileSync(path.join(ROOT, 'public/icons/favicon-16.png'), path.join(VAULT, '图片.PNG'));
fs.writeFileSync(path.join(VAULT, '说明.pdf'), '%PDF-1.4\n');
fs.writeFileSync(path.join(HOME, 'tracery.config.json'), JSON.stringify({ currentVault: VAULT, settings: { startup: 'empty' } }));
const PORT = 9656, BASE = `http://127.0.0.1:${PORT}`;
const packed = process.env.TRACERY_TEST_EXE, entry = packed ? path.join(path.dirname(packed), 'resources/app.asar/server/server.js') : path.join(ROOT, 'server/server.js');
const server = spawn(packed || process.execPath, [entry], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), TRACERY_HOME: HOME, ...(packed ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }, windowsHide: true, stdio: 'pipe' });
let browser, page;
const errors = [];
try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(BASE + '/api/state')).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await launchBrowser({ width: 1440, height: 900 }); page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(BASE, { waitUntil: 'networkidle0' }); await waitForApp(page);
  await page.evaluate(() => { window.animationErrors = []; addEventListener('unhandledrejection', e => window.animationErrors.push(String(e.reason))); });
  const open = async rel => { await page.evaluate(rel => window.__tracery.openNote(rel, null, { newTab: true }), rel); await waitForNote(page, rel); };
  await open('一.md'); await open('二.md'); await open('三.md');
  await page.evaluate(async () => {
    window.__tracery.state.tabGroups = [{ id: 'motion', name: '资料', color: 'teal', collapsed: false, tabs: ['一.md', '二.md'] }];
    await window.__tracery.openNote('一.md');
  });
  const header = '.tab-group-header[data-group="motion"]';
  const settle = () => page.waitForFunction(() => !document.querySelector('.tab-motion-overlay') && !document.querySelector('#tablist').getAnimations({ subtree: true }).some(a => a.playState === 'running'));
  // 在真实中间帧暂停，确认有淡出而非仅把 hidden 改为 true。
  const collapse = await page.evaluate(selector => {
    document.querySelector(selector).click();
    const animations = document.getAnimations();
    for (const animation of animations) { animation.pause(); animation.currentTime = 100; }
    const ghost = document.querySelector('.tab-motion-overlay .tab');
    return { count: animations.length, opacity: ghost && Number(getComputedStyle(ghost).opacity), path: window.__tracery.state.currentPath };
  }, header);
  assert.ok(collapse.count > 0 && collapse.opacity > 0 && collapse.opacity < 1, JSON.stringify(collapse));
  assert.equal(collapse.path, '一.md');
  await page.screenshot({ path: path.join(OUT, 'collapse-midpoint.png') });
  // 暂停期间立刻反向，随后连续折叠/展开，不遗留克隆、动画或未处理拒绝。
  await page.$eval(header, el => { el.click(); el = document.querySelector('.tab-group-header'); el.click(); document.querySelector('.tab-group-header').click(); });
  await settle();
  assert.equal(await page.$$eval('#tablist .tab[data-group="motion"]', nodes => nodes.every(el => !el.hidden)), true);
  await page.$eval(header, el => el.click()); await settle();
  await page.$eval(header, el => el.click());
  assert.ok(await page.$eval('#tablist', el => el.getAnimations({ subtree: true }).length > 0)); await settle();
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.$eval(header, el => el.click());
  assert.equal(await page.$('.tab-motion-overlay'), null);
  assert.equal(await page.$eval('#tablist', el => el.getAnimations({ subtree: true }).length), 0);
  await page.$eval(header, el => el.click());
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
  assert.equal(await page.$('.titlebar .app-logo'), null);
  const alignment = await page.evaluate(() => {
    const box = selector => document.querySelector(selector).getBoundingClientRect();
    return { toggle: box('#btn-toggle-left').left + box('#btn-toggle-left').width / 2, ribbon: box('.ribbon-btn').left + box('.ribbon-btn').width / 2,
      workspace: box('#vault-name').left, panel: box('#sidebar .dock-tabs .icon-tab').left };
  });
  assert.ok(Math.abs(alignment.toggle - alignment.ribbon) < 1 && Math.abs(alignment.workspace - alignment.panel) < 1, JSON.stringify(alignment));
  for (const theme of ['light', 'dark']) {
    await page.evaluate(async theme => { const { updateSettings } = await import('/js/settings.js'); await updateSettings({ themeMode: theme }); }, theme);
    await open('子目录/同名.md');
    assert.equal(await page.$eval('#document-header', el => el.hidden), false);
    assert.equal(await page.$eval('#note-path', el => el.textContent), '子目录/同名.md');
    const colors = await page.evaluate(() => ['#sidebar', '#sidebar-right', '.titlebar'].map(selector => getComputedStyle(document.querySelector(selector)).backgroundColor));
    assert.equal(colors[0], colors[1]); assert.notEqual(colors[0], colors[2]);
    assert.equal(await page.$('#file-tree [data-path="图片.PNG"] .icon'), null);
    assert.equal(await page.$eval('#file-tree [data-path="图片.PNG"] .file-kind', el => el.textContent), '图片');
    const badgeEdges = await page.$$eval('#file-tree .file-kind', nodes => nodes.map(el => el.getBoundingClientRect().right));
    assert.ok(Math.max(...badgeEdges) - Math.min(...badgeEdges) < 1, 'PDF 与图片标识统一靠右对齐');
    await page.screenshot({ path: path.join(OUT, `${theme}.png`) });
  }
  await page.click('#btn-tab-new'); await page.waitForSelector('#empty-note', { visible: true });
  assert.equal(await page.$eval('#document-header', el => el.hidden), true);
  await page.evaluate(() => window.__tracery.openNote('说明.pdf', null, { newTab: true }));
  await page.waitForFunction(() => window.__tracery.state.currentPath === '说明.pdf');
  assert.equal(await page.$eval('#note-path', el => el.textContent), '说明.pdf');
  await open('三.md');
  const menu = async label => page.evaluate(label => {
    const button = [...document.querySelectorAll('.context-menu button')].find(el => el.textContent.trim() === label);
    if (!button) throw new Error('菜单缺少 ' + label);
    button.click();
  }, label);
  // 从真实文件菜单删除，不通过 API 绕开确认逻辑。
  for (const rel of ['待删.md', '图片.PNG', '子目录']) {
    await page.evaluate(rel => {
      const item = [...document.querySelectorAll('#file-tree .tree-item')].find(el => el.dataset.path === rel || (!el.dataset.path && el.textContent.trim() === rel));
      if (!item) throw new Error('文件树缺少 ' + rel);
      item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 180, clientY: 200 }));
    }, rel);
    const deleted = page.waitForResponse(response => new URL(response.url()).pathname === '/api/delete' && response.request().method() === 'POST');
    await menu('删除'); assert.ok((await deleted).ok());
    await page.waitForFunction(rel => ![...document.querySelectorAll('#file-tree .tree-item')].some(el => el.dataset.path === rel || (!el.dataset.path && el.textContent.trim() === rel)), {}, rel);
    assert.equal(fs.existsSync(path.join(VAULT, rel)), false);
    assert.equal(await page.$('.dialog-backdrop:not([hidden])'), null);
  }
  await page.evaluate(() => window.__tracery.openTrash());
  await page.waitForSelector('.trash-purge'); await page.click('.trash-purge');
  await page.waitForSelector('.dialog-backdrop:not([hidden]) .dialog-cancel');
  await page.click('.dialog-cancel'); assert.equal((await (await fetch(BASE + '/api/trash')).json()).items.length, 3);
  await page.click('.trash-purge'); await page.waitForSelector('.dialog-ok'); await page.click('.dialog-ok');
  await page.waitForFunction(() => document.querySelectorAll('.trash-item').length === 2);
  assert.deepEqual(await page.evaluate(() => window.animationErrors), []); assert.deepEqual(errors, []);
  console.log('PASS 分组动画/快速反向/减少动态、顶部对齐、明暗侧栏、文档路径、图片标识及删除确认边界');
} catch (error) { if (page) await page.screenshot({ path: path.join(OUT, 'failure.png') }); throw error; }
finally { await browser?.close(); server.kill(); }
