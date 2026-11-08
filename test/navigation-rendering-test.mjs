import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { launchBrowser } from './browser.mjs';
import { waitForApp, waitForNote, waitForLayout } from './waits.mjs';
import { markdownLinks, localMarkdownTarget } from '../public/js/external-link.js';
import { inlineToHtml } from '../public/js/markdown.js';
import { pdfFixture } from './pdf-fixture.mjs';
const ROOT = path.resolve(import.meta.dirname, '..'), HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tracery-navigation-rendering-'));
const VAULT = path.join(HOME, 'vault'), OUT = path.join(ROOT, 'dist/navigation-rendering'), BASE = 'http://127.0.0.1:9717';
const NOTE = '课程/面试学习资料/02_一个完整案例走通项目.md';
const SOURCE = '# 02 一个完整案例走通项目\n\n[阅读导航](00_阅读导航.md) · 前篇：[从零理解](01_项目从零理解.md) · 下一篇：[技术取舍](03_技术选型与关键难点.md)\n\n[上层](../上层.md#分节) · [空格](<带 空格.md>) · [PDF](阅读.pdf)\n\n`[代码](00_阅读导航.md)` · [危险](javascript:alert(1)) · [网页](https://example.com/a_(b))\n\n## 编辑验证\n';
const write = (name, text) => { fs.mkdirSync(path.dirname(path.join(VAULT, name)), { recursive: true }); fs.writeFileSync(path.join(VAULT, name), text); };
write(NOTE, SOURCE); write('00_阅读导航.md', '# 错误的根目录同名文件'); write('课程/上层.md', '# 上层\n\n## 分节\n\n目标');
for (const name of ['00_阅读导航.md', '01_项目从零理解.md', '03_技术选型与关键难点.md', '带 空格.md']) write('课程/面试学习资料/' + name, '# ' + name + '\n\n正文');
write('课程/面试学习资料/阅读.pdf', pdfFixture()); fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(HOME, 'tracery.config.json'), JSON.stringify({ currentVault: VAULT, settings: { startup: 'empty', themeMode: 'light' } }));
assert.equal(markdownLinks('[阅读导航](00_阅读导航.md)')[0].href, './00_阅读导航.md');
assert.equal(markdownLinks('[空格](<带 空格.md>)')[0].href, './带 空格.md');
assert.equal(localMarkdownTarget('javascript:alert(1)'), null); assert.equal(localMarkdownTarget('//example.com'), null); assert.equal(localMarkdownTarget('%0A坏.md'), null);
assert.match(inlineToHtml('[A & B](阅读导航.md)'), />A &amp; B<\/a>/); assert.match(inlineToHtml('[**导航**](阅读导航.md)'), /<strong>导航<\/strong>/);
assert.match(inlineToHtml('[网页](https://example.com/a_(b))'), /href="https:\/\/example.com\/a_\(b\)"/);
assert.match(inlineToHtml('[邮件](mailto:test@example.com)'), /href="mailto:test@example.com"/);
const server = spawn(process.execPath, [path.join(ROOT, 'server/server.js')], { env: { ...process.env, PORT: '9717', TRACERY_HOME: HOME }, windowsHide: true, stdio: 'ignore' });
let browser, page;
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/api/state')).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await launchBrowser({ width: 1440, height: 1000 }); page = await browser.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(BASE, { waitUntil: 'networkidle0' }); await waitForApp(page);
  const open = async () => { await page.evaluate(note => window.__tracery.openNote(note), NOTE); await waitForNote(page, NOTE, SOURCE); };
  const link = target => '.cm-lp-md-link[data-target="' + target + '"]';
  await open(); await page.waitForSelector(link('./00_阅读导航.md'));
  assert.equal(await page.$$eval('.cm-lp-md-link', els => els.length), 6); assert.equal(await page.$$eval('.cm-lp-external-link', els => els.length), 1);
  await page.screenshot({ path: path.join(OUT, 'local-links-live.png') });
  await page.click(link('./00_阅读导航.md')); await waitForNote(page, '课程/面试学习资料/00_阅读导航.md');
  await open(); await page.click(link('../上层.md#分节')); await waitForNote(page, '课程/上层.md');
  await open(); await page.click(link('./带 空格.md')); await waitForNote(page, '课程/面试学习资料/带 空格.md');
  await open(); await page.click(link('./阅读.pdf')); await page.waitForFunction(() => window.__tracery.state.currentPath.endsWith('/阅读.pdf'));
  await open(); await page.evaluate(() => window.__editor.setMode('read')); await page.waitForSelector(link('./01_项目从零理解.md'));
  await page.focus(link('./01_项目从零理解.md')); await page.keyboard.press('Enter'); await waitForNote(page, '课程/面试学习资料/01_项目从零理解.md');
  await open(); await page.evaluate(() => window.__editor.setMode('source')); assert.equal(await page.$('.cm-lp-md-link'), null);
  await page.evaluate(() => window.__editor.setMode('live'));
  // Cursor-line syntax returns for editing; leaving the line restores its links.
  await page.evaluate(() => { const v = window.__editor.view; v.dispatch({ selection: { anchor: v.state.doc.line(3).from } }); });
  assert.equal(await page.$(link('./00_阅读导航.md')), null);
  await page.evaluate(() => { window.__editor.view.dispatch({ selection: { anchor: 0 } }); }); await page.waitForSelector(link('./00_阅读导航.md'));
  // Folder icons remain clickable and keyboard operable without disclosure chevrons.
  assert.equal(await page.$('#file-tree [data-dir] .tw'), null);
  assert.ok(await page.$eval('#file-tree .tree-children', el => parseFloat(getComputedStyle(el).borderLeftWidth) === 1));
  await page.focus('#file-tree [data-dir="课程"]'); await page.keyboard.press('Enter'); await page.waitForFunction(() => document.querySelector('#file-tree [data-dir="课程"]').getAttribute('aria-expanded') === 'false');
  await page.focus('#file-tree [data-dir="课程"]'); await page.keyboard.press('Space'); await page.waitForSelector('#file-tree [data-dir="课程/面试学习资料"]');
  await page.screenshot({ path: path.join(OUT, 'folder-guides.png') });
  await page.click('#btn-command');
  assert.equal(await page.$$eval('#palette-list .pi-icon', els => els.every(el => !!el.querySelector('svg') && !el.textContent.trim())), true);
  await page.screenshot({ path: path.join(OUT, 'palette-line-icons.png') }); await page.keyboard.press('Escape');
  const measures = [];
  for (const themeMode of ['light', 'dark']) for (const view of ['note', 'list', 'tasks']) {
    await page.evaluate(async themeMode => { await (await import('/js/settings.js')).updateSettings({ themeMode }); }, themeMode);
    if (view === 'list') await page.click('#btn-note-list'); if (view === 'tasks') await page.click('#btn-task-list'); await waitForLayout(page);
    const m = await page.evaluate(() => {
      const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { top: r.top, center: r.top + r.height / 2, height: r.height }; };
      const tools = rect('#workspace-tools'), settings = rect('#btn-settings'), list = rect('#btn-note-list'), tasks = rect('#btn-task-list');
      const footer = [...document.querySelectorAll('#editor-area .statusbar,#editor-area .note-list-footer')].find(el => el.getBoundingClientRect().height > 0).getBoundingClientRect();
      const previous = document.querySelector('#editor-area[data-note-view="list"] .note-list-footer button, #editor-area[data-note-view="tasks"] .note-list-footer button');
      return { tools, settings, list, tasks, footer: footer.top, previous: previous ? previous.getBoundingClientRect().top + previous.getBoundingClientRect().height / 2 : null, size: getComputedStyle(document.querySelector('#btn-note-list')).fontSize };
    });
    assert.ok(Math.abs(m.tools.top - m.footer) < 1, JSON.stringify(m));
    assert.ok(Math.abs(m.list.center - m.settings.center) < 1 && Math.abs(m.tasks.center - m.settings.center) < 1, JSON.stringify(m));
    if (m.previous) assert.ok(Math.abs(m.list.center - m.previous) < 1, JSON.stringify(m));
    assert.equal(m.size, '14px'); assert.ok(m.list.height >= 40); measures.push({ themeMode, view, ...m });
    await page.screenshot({ path: path.join(OUT, `footer-${view}-${themeMode}.png`) });
    if (view === 'list') await page.click('#note-list-close'); if (view === 'tasks') await page.click('#task-close');
  }
  // Exercise the virtual path too, using the same folder hierarchy.
  for (let i = 0; i < 410; i++) write('课程/面试学习资料/批量-' + i + '.md', '# ' + i);
  await page.reload({ waitUntil: 'networkidle0' }); await waitForApp(page); await page.waitForSelector('.virtual-tree-row');
  assert.equal(await page.$('.virtual-tree-row[data-dir] .tw'), null);
  assert.ok(await page.$eval('.virtual-tree-row[data-path]', el => getComputedStyle(el, '::before').backgroundImage.includes('linear-gradient')));
  await page.screenshot({ path: path.join(OUT, 'virtual-folder-guides.png') });
  assert.equal(fs.readFileSync(path.join(VAULT, NOTE), 'utf8'), SOURCE); assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(OUT, 'metrics.json'), JSON.stringify(measures, null, 2));
  console.log('PASS relative Markdown links/live/read/source/cursor/real clicks/keyboard/PDF, safe destinations, unchanged source, folder toggle/guides including virtual tree, all SVG palette icons and footer size/center/divider alignment');
} catch (error) { if (page) await page.screenshot({ path: path.join(OUT, 'failure.png') }); throw error; }
finally { await browser?.close(); server.kill(); }
