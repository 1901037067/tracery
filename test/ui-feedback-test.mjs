import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { launchBrowser } from './browser.mjs';
import { waitForApp, waitForNote, waitForLayout } from './waits.mjs';
import { pdfFixture } from './pdf-fixture.mjs';
const ROOT = path.resolve(import.meta.dirname, '..'), HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tracery-feedback-'));
const VAULT = path.join(HOME, 'vault'), OUT = path.join(ROOT, 'dist/ui-feedback'), BASE = 'http://127.0.0.1:9710';
for (const dir of [VAULT, OUT]) fs.mkdirSync(dir, { recursive: true });
const original = '# 基础名词\n\n| 英文 | 中文 | 说明 |\n| --- | --- | --- |\n| variable | 变量 | `x = 1` 里的 x |\n| **constant** | 常量 | 值不再改变 |\n\n## 标题含 ~~删除~~ 和 <u>下划线</u>\n\n正文 **粗体**、*斜体*、~~删除线~~、<u>下划线</u>、[外部链接](https://example.com)、`code`。\n\n> [!NOTE] 提示\n> 正文。\n';
fs.writeFileSync(path.join(VAULT, '表格.md'), original);
for (const name of ['另一篇', '第三篇', '第四篇']) fs.writeFileSync(path.join(VAULT, name + '.md'), '# ' + name + '\n\n- [ ] 复习 due:2020-01-01\n');
fs.writeFileSync(path.join(VAULT, '阅读.pdf'), pdfFixture());
fs.writeFileSync(path.join(HOME, 'tracery.config.json'), JSON.stringify({ currentVault: VAULT, settings: { startup: 'empty', themeMode: 'light' } }));
const server = spawn(process.execPath, [path.join(ROOT, 'server/server.js')], { env: { ...process.env, PORT: '9710', TRACERY_HOME: HOME }, windowsHide: true, stdio: 'pipe' });
let browser, page;
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/api/state')).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await launchBrowser({ width: 1440, height: 1000 }); page = await browser.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE, { waitUntil: 'networkidle0' }); await waitForApp(page);
  const open = async (name, newTab = false) => { await page.evaluate(({ name, newTab }) => window.__tracery.openNote(name, null, { newTab }), { name, newTab }); await waitForNote(page, name); };
  const clickFile = async (name, options) => { await page.click('#file-tree [data-path="' + name + '"]', options); await page.waitForFunction(name => window.__tracery.state.currentPath === name, {}, name); };
  const tabs = () => page.evaluate(() => [...window.__tracery.state.tabs]);
  const menu = async label => { await page.waitForSelector('.context-menu', { visible: true }); await page.evaluate(label => { const item = [...document.querySelectorAll('.context-menu button')].find(el => el.textContent.trim() === label); if (!item) throw Error('菜单缺少 ' + label); item.click(); }, label); };
  const set = (selector, value) => page.$eval(selector, (el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); }, value);
  await open('表格.md'); await page.waitForSelector('.cm-lp-cell');
  const header = await page.$$eval('.cm-lp-tbl-head .cm-lp-cell, .cm-lp-tbl-head .cm-lp-cell *', els => els.map(el => ({ decoration: getComputedStyle(el).textDecorationLine, border: parseFloat(getComputedStyle(el).borderBottomWidth) })));
  assert.ok(header.every(el => !el.decoration.includes('underline'))); assert.ok(header.every(el => el.border <= 1));
  assert.equal(await page.$eval('.cm-lp-h2 .cm-lp-del', el => getComputedStyle(el).textDecorationLine.includes('line-through')), true);
  assert.equal(await page.$eval('.cm-lp-h2 .cm-lp-underline', el => getComputedStyle(el).textDecorationLine.includes('underline')), true);
  assert.equal(await page.$eval('.cm-lp-external-link', el => getComputedStyle(el).textDecorationLine.includes('underline')), true);
  assert.equal(await page.$eval('#outline-list', el => el.textContent.includes('<u>')), false);
  assert.ok(await page.$eval('#outline-list', el => el.textContent.includes('下划线')));
  // The real editable table still maps clicks to its source cell.
  const cell = await page.$$eval('.cm-lp-cell', els => { const el = els.find(el => el.textContent.includes('variable')), r = el.getBoundingClientRect(); return { x: r.left + 25, y: r.top + r.height / 2 }; });
  await page.mouse.click(cell.x, cell.y); await page.keyboard.type('Z'); assert.ok((await page.evaluate(() => window.__editor.getContent())).split('\n')[4].includes('Z'));
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control'); await page.evaluate(() => window.__editor.flush()); assert.equal(fs.readFileSync(path.join(VAULT, '表格.md'), 'utf8'), original);
  await page.click('#btn-command'); await page.waitForSelector('#palette-list .pi-icon svg');
  assert.equal(await page.$$eval('#palette-list li', els => els.some(el => el.textContent.includes('<svg') || el.getBoundingClientRect().height > 70)), false);
  assert.equal(await page.$eval('#palette-list', el => el.scrollHeight > el.clientHeight), true);
  await page.screenshot({ path: path.join(OUT, 'palette-light.png') });
  const selected = await page.$eval('#palette-input', el => el.getAttribute('aria-activedescendant')); await page.keyboard.press('ArrowDown');
  assert.notEqual(await page.$eval('#palette-input', el => el.getAttribute('aria-activedescendant')), selected);
  await set('#palette-input', '打开笔记列表'); await page.keyboard.press('Enter'); await page.waitForSelector('#note-list-view', { visible: true });
  assert.equal(await page.$eval('#workspace-tools', el => el.closest('#sidebar') !== null), true);
  assert.equal(await page.$eval('#panel-note-tags', el => !!el.querySelector('#btn-note-list, #btn-task-list')), false);
  await page.waitForFunction(() => document.querySelector('#note-list-rows').children.length === 4);
  assert.equal(await page.$$eval('#note-list-view th', els => els.some(el => el.getBoundingClientRect().height > 50)), false);
  await page.screenshot({ path: path.join(OUT, 'note-list-light.png') }); await page.click('#note-list-close');
  await clickFile('另一篇.md'); assert.deepEqual(await tabs(), ['另一篇.md']);
  await page.keyboard.down('Control'); await clickFile('表格.md'); await page.keyboard.up('Control'); assert.deepEqual(await tabs(), ['另一篇.md', '表格.md']);
  await clickFile('第三篇.md', { button: 'middle' }); assert.equal((await tabs()).length, 3);
  await clickFile('另一篇.md'); assert.equal((await tabs()).length, 3);
  await clickFile('阅读.pdf'); assert.equal((await tabs()).length, 3); assert.ok(!(await tabs()).includes('另一篇.md'));
  await page.click('#file-tree [data-path="第四篇.md"]', { button: 'right' }); await menu('在新标签页中打开'); await waitForNote(page, '第四篇.md'); assert.equal((await tabs()).length, 4);
  // A failed save must refuse replacement, retaining both the active tab and text.
  await open('第三篇.md'); await page.evaluate(() => { window.__editor.setAutosave(60000); window.__editor.insertText('未保存内容'); }); const before = await tabs();
  await page.setRequestInterception(true); const intercept = request => request.url().endsWith('/api/note') && request.method() === 'PUT' ? request.respond({ status: 507, contentType: 'application/json', body: JSON.stringify({ error: '验收保存失败' }) }) : request.continue(); page.on('request', intercept);
  await page.click('#file-tree [data-path="另一篇.md"]'); await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('验收保存失败'));
  assert.deepEqual(await tabs(), before); assert.equal(await page.evaluate(() => window.__editor.path), '第三篇.md'); assert.ok(await page.evaluate(() => window.__editor.getContent().includes('未保存内容')));
  page.off('request', intercept); await page.setRequestInterception(false); await page.evaluate(() => window.__editor.flush());
  // Recent files and search results use the same replacement convention.
  const pdfIndex = (await tabs()).indexOf('阅读.pdf'); await page.click('#tablist .tab[data-index="' + pdfIndex + '"] .tab-close'); await page.waitForFunction(() => !window.__tracery.state.tabs.includes('阅读.pdf'));
  const recentCount = (await tabs()).length; await page.click('#tab-recent'); await page.click('#recent-notes [data-path="阅读.pdf"]'); await page.waitForFunction(() => window.__tracery.state.currentPath === '阅读.pdf'); assert.equal((await tabs()).length, recentCount);
  await page.evaluate(() => window.__tracery.switchPanel('search')); await page.type('#search-input', '另一篇'); await page.waitForFunction(() => document.querySelectorAll('.search-result').length === 1 && document.querySelector('.search-result .sr-name')?.textContent === '另一篇'); await page.click('.search-result'); await waitForNote(page, '另一篇.md'); assert.equal((await tabs()).length, recentCount);
  await page.evaluate(() => window.__tracery.switchPanel('files')); await page.click('#tab-library'); await open('第三篇.md', true);
  await open('表格.md'); let index = (await tabs()).indexOf('表格.md'); await page.click('#tablist .tab[data-index="' + index + '"]', { button: 'right' }); await menu('添加到新分组'); await page.waitForSelector('.tab-group-editor input'); await set('.tab-group-editor input', '学习'); await page.focus('.tab-group-editor input'); await page.keyboard.press('Enter');
  index = (await tabs()).indexOf('第三篇.md'); await page.click('#tablist .tab[data-index="' + index + '"]', { button: 'right' }); await menu('移入「学习」');
  const group = '.tab-group-header'; await page.waitForSelector(group + '[aria-expanded="true"]'); assert.equal(await page.$(group + ' .tab-group-count'), null);
  await page.screenshot({ path: path.join(OUT, 'group-expanded.png') }); await page.click(group);
  await page.waitForFunction(() => document.querySelector('.tab-group-header')?.getAttribute('aria-expanded') === 'false' && !document.querySelector('.tab-motion-overlay'));
  assert.equal(await page.$eval(group + ' .tab-group-count', el => el.textContent), '2'); assert.equal(await page.$$eval('.tab[data-group]', els => els.every(el => el.hidden)), true);
  await page.screenshot({ path: path.join(OUT, 'group-collapsed.png') }); await page.keyboard.press('Enter'); await page.waitForSelector(group + '[aria-expanded="true"]');
  await page.click(group); await page.waitForFunction(() => !document.querySelector('.tab-motion-overlay')); await page.reload({ waitUntil: 'networkidle0' }); await waitForApp(page); await page.waitForSelector(group + '[aria-expanded="false"]');
  await open('表格.md');
  const metrics = [];
  for (const themeName of ['apple', 'obsidian']) for (const themeMode of ['light', 'dark']) {
    await page.evaluate(async settings => { const { updateSettings } = await import('/js/settings.js'); await updateSettings(settings); }, { themeName, themeMode });
    for (const width of [1440, 900, 390]) {
      await page.setViewport({ width, height: 950 }); await waitForLayout(page);
      const data = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth - innerWidth, shadow: getComputedStyle(document.querySelector('#editor-area')).boxShadow })); assert.ok(data.overflow <= 1); assert.notEqual(data.shadow, 'none'); metrics.push({ themeName, themeMode, width, ...data });
      await page.screenshot({ path: path.join(OUT, `editor-${themeName}-${themeMode}-${width}.png`) });
    }
  }
  await page.setViewport({ width: 1440, height: 950 }); await page.click('#btn-note-list'); await page.waitForSelector('#note-list-view', { visible: true });
  await page.setViewport({ width: 1000, height: 950 }); await waitForLayout(page); assert.equal(await page.$eval('#note-list-view .note-list-scroll', el => el.scrollWidth > el.clientWidth), true);
  await page.setViewport({ width: 390, height: 950 }); await waitForLayout(page); assert.equal(await page.$eval('#note-list-view', el => el.scrollWidth > el.clientWidth), false); await page.screenshot({ path: path.join(OUT, 'note-list-mobile-dark.png') });
  assert.deepEqual(errors, []); assert.equal(fs.readFileSync(path.join(VAULT, '表格.md'), 'utf8'), original); fs.writeFileSync(path.join(OUT, 'metrics.json'), JSON.stringify(metrics, null, 2));
  console.log('PASS palette SVG/keyboard, semantic text styles and editable table, file replacement/new-tab/save protection, group states/reload, global tool placement, two skins/light-dark/narrow layouts and paper shadows');
} catch (error) { if (page) await page.screenshot({ path: path.join(OUT, 'failure.png') }); throw error; }
finally { await browser?.close(); server.kill(); }
