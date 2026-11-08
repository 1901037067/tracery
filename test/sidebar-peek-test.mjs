import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { launchBrowser } from './browser.mjs';
import { waitForApp, waitForNote, waitForLayout } from './waits.mjs';
const ROOT = path.resolve(import.meta.dirname, '..'), HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tracery-peek-'));
const VAULT = path.join(HOME, 'vault'), OUT = path.join(ROOT, 'dist/sidebar-peek'), BASE = 'http://127.0.0.1:9713';
for (const dir of [VAULT, OUT]) fs.mkdirSync(dir, { recursive: true });
const original = '# 示例\n\n正文 #学习\n'; fs.writeFileSync(path.join(VAULT, '示例.md'), original); fs.writeFileSync(path.join(VAULT, '另一篇.md'), '# 另一篇\n\n正文');
fs.writeFileSync(path.join(HOME, 'tracery.config.json'), JSON.stringify({ currentVault: VAULT, settings: { themeMode: 'light' } }));
const server = spawn(process.execPath, [path.join(ROOT, 'server/server.js')], { env: { ...process.env, PORT: '9713', TRACERY_HOME: HOME }, windowsHide: true, stdio: 'pipe' }); let browser, page;
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/api/state')).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await launchBrowser({ width: 1440, height: 1000 }); page = await browser.newPage(); page.setDefaultTimeout(12000); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(BASE, { waitUntil: 'networkidle0' }); await waitForApp(page); await page.evaluate(() => window.__tracery.openNote('示例.md')); await waitForNote(page, '示例.md'); await waitForLayout(page);
  const rects = () => page.evaluate(() => { const r = el => { const b = el.getBoundingClientRect(); return { left: b.left, width: b.width, height: b.height }; }; return { editor: r(document.querySelector('#editor-area')), header: r(document.querySelector('#document-header')), sidebar: r(document.querySelector('#sidebar')) }; });
  const settings = () => page.evaluate(async () => (await import('/js/settings.js')).getSettings().layout);
  const hover = async name => { await page.hover('.ribbon-btn[data-panel="' + name + '"]'); await page.waitForFunction(name => document.body.classList.contains('navigation-peek') && document.querySelector('#panel-' + name).classList.contains('active') && !document.querySelector('#sidebar').getAnimations().some(animation => animation.playState === 'running'), {}, name); };
  const leave = async () => { const r = await rects(); await page.mouse.move(r.editor.left + r.editor.width / 2, 700); await page.waitForFunction(() => !document.body.classList.contains('navigation-peek')); };
  const opened = await rects();
  await page.click('#btn-toggle-left'); await page.waitForFunction(() => document.querySelector('#sidebar').classList.contains('collapsed')); await waitForLayout(page);
  const collapsed = await rects(); assert.equal(collapsed.sidebar.width, 0); assert.equal(collapsed.header.height, opened.header.height); assert.ok(collapsed.header.height < 60);
  await page.$eval('.ribbon-btn[data-panel="files"]', button => button.click()); assert.equal((await settings()).navigationVisible, false); assert.equal(await page.evaluate(() => document.body.classList.contains('navigation-peek')), false);
  await page.evaluate(async () => (await import('/js/settings.js')).flushPendingSettings());
  assert.equal((await (await fetch(BASE + '/api/state')).json()).settings.layout.navigationVisible, false);
  let writes = 0; page.on('request', request => { if (request.url().endsWith('/api/settings') && request.method() !== 'GET') writes++; });
  for (const panel of ['files', 'search', 'tags']) {
    const focus = await page.evaluate(() => document.activeElement.id);
    await hover(panel); const current = await rects(); assert.equal(current.sidebar.width, opened.sidebar.width); assert.equal(current.editor.left, collapsed.editor.left); assert.equal(current.editor.width, collapsed.editor.width); assert.equal(current.header.height, collapsed.header.height);
    assert.equal(await page.$eval('#sidebar', el => { const canvas = document.createElement('canvas'), context = canvas.getContext('2d'); context.fillStyle = getComputedStyle(el).backgroundColor; context.fillRect(0, 0, 1, 1); return context.getImageData(0, 0, 1, 1).data[3]; }), 255);
    assert.equal((await settings()).navigationVisible, false); assert.equal(await page.$eval('#sidebar', el => el.inert), false); assert.equal(await page.evaluate(() => document.activeElement.id), focus);
    await page.click('.ribbon-btn[data-panel="' + panel + '"]'); assert.equal((await settings()).navigationVisible, false);
    const r = await rects(); await page.mouse.move(r.sidebar.left + 100, 240); assert.equal(await page.evaluate(() => document.body.classList.contains('navigation-peek')), true);
    await page.screenshot({ path: path.join(OUT, 'peek-' + panel + '.png') }); await leave(); assert.equal(await page.$eval('#sidebar', el => el.inert), true);
  }
  await hover('files'); await page.click('#file-tree [data-path="另一篇.md"]'); await waitForNote(page, '另一篇.md'); assert.equal((await settings()).navigationVisible, false); await leave();
  await hover('search'); await page.click('#search-input'); await page.type('#search-input', '示例'); await page.waitForFunction(() => document.querySelector('.search-result .sr-name')?.textContent === '示例'); await page.click('.search-result'); await waitForNote(page, '示例.md'); assert.equal((await settings()).navigationVisible, false); await leave();
  await hover('tags'); await page.locator('#tag-list .tag-chip').click(); assert.equal((await settings()).navigationVisible, false); assert.equal(await page.$eval('#panel-search', el => el.classList.contains('active')), true); await leave();
  await hover('files'); await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.body.classList.contains('navigation-peek')); const hoverSettingsWrites = writes; assert.equal(hoverSettingsWrites, 0); await leave();
  // Pinning is still an explicit titlebar action, not a hover side effect.
  await hover('files'); await page.click('#btn-toggle-left'); await page.waitForFunction(() => !document.querySelector('#sidebar').classList.contains('collapsed') && !document.body.classList.contains('navigation-peek')); await waitForLayout(page); assert.equal((await settings()).navigationVisible, true);
  // Group editor: equal square swatches, aligned icons, two separators.
  await page.click('#tablist .tab.active', { button: 'right' }); await page.waitForSelector('.context-menu'); await page.evaluate(() => [...document.querySelectorAll('.context-menu button')].find(el => el.textContent.trim() === '添加到新分组').click()); await page.waitForSelector('.tab-group-editor');
  const menu = await page.$eval('.tab-group-editor', el => { const x = node => node.getBoundingClientRect().left; return { colors: [...el.querySelectorAll('.tab-group-color')].map(node => { const r = node.getBoundingClientRect(); return { width: r.width, height: r.height, radius: parseFloat(getComputedStyle(node).borderRadius) }; }), separators: el.querySelectorAll('[role="separator"]').length, icons: [...el.querySelectorAll('.group-action')].map(node => !!node.querySelector('.mi-icon svg')), left: x(el.querySelector('input')), first: x(el.querySelector('.tab-group-color')), options: [...el.querySelectorAll('.group-action .mi-icon')].map(x) }; });
  assert.equal(menu.separators, 2); assert.ok(menu.icons.length === 4 && menu.icons.every(Boolean)); assert.ok(menu.colors.every(color => color.width === color.height && color.radius > 0 && color.radius < color.width / 2)); assert.ok(Math.abs(menu.left - menu.first) <= 1); assert.ok(menu.options.every(x => Math.abs(x - menu.left) <= 1));
  await page.click('.tab-group-color[data-color="teal"]'); assert.equal(await page.$eval('.tab-group-color[data-color="teal"]', el => el.getAttribute('aria-checked')), 'true'); await page.screenshot({ path: path.join(OUT, 'group-menu.png') }); await page.keyboard.press('Escape');
  // Both panes hidden and mirrored navigation cannot inflate the document header.
  await page.evaluate(async () => { const { updateSettings } = await import('/js/settings.js'); await updateSettings({ layout: { navigationVisible: false, contextVisible: false, navigationSide: 'right' } }); }); await waitForLayout(page); assert.ok((await rects()).header.height < 60);
  const mirrored = await rects(); await hover('files'); assert.equal((await rects()).editor.width, mirrored.editor.width); assert.equal((await rects()).editor.left, mirrored.editor.left); await leave();
  await page.evaluate(async () => { const { updateSettings } = await import('/js/settings.js'); await updateSettings({ themeMode: 'dark', layout: { navigationSide: 'left' } }); }); await hover('files'); await page.screenshot({ path: path.join(OUT, 'peek-dark.png') }); await leave();
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]); await hover('files'); assert.equal(await page.$eval('#sidebar', el => getComputedStyle(el).animationName), 'none'); await leave();
  await page.setViewport({ width: 390, height: 844 }); await waitForLayout(page); await page.click('#btn-toggle-left'); await page.click('.ribbon-btn[data-panel="search"]'); assert.equal(await page.evaluate(() => document.body.classList.contains('navigation-peek')), false); assert.equal(await page.evaluate(() => document.body.classList.contains('mobile-left-open')), true);
  assert.equal(fs.readFileSync(path.join(VAULT, '示例.md'), 'utf8'), original); assert.deepEqual(errors, []); fs.writeFileSync(path.join(OUT, 'metrics.json'), JSON.stringify({ opened, collapsed, menu, hoverSettingsWrites }, null, 2));
  console.log('PASS square group swatches/icons/separators, stable collapsed header, file/search/tag hover over unchanged editor, pointer exit/Escape, no persistent opening, explicit pin, mirrored/both hidden/dark/reduced motion/mobile');
} catch (error) { if (page) await page.screenshot({ path: path.join(OUT, 'failure.png') }); throw error; }
finally { await browser?.close(); server.kill(); }
