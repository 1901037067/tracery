/** 支持格式的浏览边界、普通/虚拟文件树标识，以及分组内外统一的活动标签。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { launchBrowser } from './browser.mjs';
import { Vault } from '../server/vault.js';
const ROOT = path.resolve(import.meta.dirname, '..'), HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tracery-file-surface-'));
const SMALL = path.join(HOME, 'small'), LARGE = path.join(HOME, 'large'), OUT = path.join(ROOT, 'dist/file-surface');
fs.mkdirSync(SMALL); fs.mkdirSync(LARGE); fs.mkdirSync(OUT, { recursive: true });
const hidden = ['slides.ppt', 'slides.pptx', 'word.doc', 'word.docx', 'table.csv', 'table.xlsx', 'archive.zip', 'picture.draw.json'];
for (const root of [SMALL, LARGE]) {
  for (const name of ['普通.md', '组内.md', '同名.md', '文本.txt', '长扩展名.markdown']) fs.writeFileSync(path.join(root, name), '# ' + name);
  fs.writeFileSync(path.join(root, '同名.pdf'), '%PDF-1.4\n');
  fs.copyFileSync(path.join(ROOT, 'public/icons/favicon-16.png'), path.join(root, 'image.PNG'));
  for (const name of hidden) fs.writeFileSync(path.join(root, name), '保留的文件字节');
}
for (let i = 0; i < 430; i++) fs.writeFileSync(path.join(LARGE, `large-${i}.md`), '# 大库');
const vault = new Vault(SMALL); await vault.open();
assert.ok(hidden.every(name => vault.files.has(name)), '隐藏不影响完整文件清单');
assert.ok(hidden.every(name => !vault.tree().files.some(file => file.path === name)));
fs.writeFileSync(path.join(HOME, 'tracery.config.json'), JSON.stringify({ currentVault: SMALL, settings: { themeMode: 'light', startup: 'empty' } }));
const PORT = 9649, BASE = `http://127.0.0.1:${PORT}`, sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const packed = process.env.TRACERY_TEST_EXE;
const entry = packed ? path.join(path.dirname(packed), 'resources/app.asar/server/server.js') : path.join(ROOT, 'server/server.js');
const server = spawn(packed || process.execPath, [entry], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), TRACERY_HOME: HOME, ...(packed ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }, windowsHide: true, stdio: 'pipe' });
let browser, page;
try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/api/state')).ok) break; } catch {} await sleep(200); }
  browser = await launchBrowser({ width: 1440, height: 900 }); page = await browser.newPage(); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(BASE, { waitUntil: 'networkidle0' }); await page.waitForSelector('[data-path="普通.md"]');
  assert.equal(await page.$('#file-tree [data-path="普通.md"] .icon'), null);
  assert.equal(await page.$eval('#file-tree [data-path="同名.pdf"] .file-kind', el => el.textContent), 'PDF');
  const visible = await page.$$eval('#file-tree [data-path]', nodes => nodes.map(node => node.dataset.path));
  assert.ok(hidden.every(name => !visible.includes(name)));
  await page.screenshot({ path: path.join(OUT, 'files-light.png') });
  await page.evaluate(() => { const s = window.__tracery.state; localStorage.setItem(`tracery.shortcuts:${s.vault.root}`, JSON.stringify({ pinned: ['普通.md', '同名.pdf', 'word.docx'], recent: ['同名.pdf', '普通.md', 'word.docx'] })); });
  await page.reload({ waitUntil: 'networkidle0' }); await page.click('#tab-pinned');
  assert.equal(await page.$$('#pinned-list [data-path]').then(nodes => nodes.length), 2);
  assert.ok(await page.$('#pinned-list [data-path="同名.pdf"] .file-kind'));
  assert.equal(await page.$('#pinned-list [data-path="普通.md"] .icon'), null);
  await page.click('#tab-library');
  await page.evaluate(() => window.__tracery.openNote('普通.md', null, { newTab: true }));
  await page.evaluate(() => window.__tracery.openNote('组内.md', null, { newTab: true }));
  await page.evaluate(() => { window.__tracery.state.tabGroups = [{ id: 'g', name: '一组', color: 'teal', collapsed: false, tabs: ['组内.md'] }]; return window.__tracery.openNote('普通.md'); });
  const look = () => page.$eval('.tab.active', el => {
    const s = getComputedStyle(el), line = getComputedStyle(el, '::after');
    return { height: s.height, radius: s.borderRadius, border: s.border, bg: s.backgroundColor, shadow: s.boxShadow, line: line.backgroundColor, bottom: line.bottom };
  });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(async theme => { const { updateSettings } = await import('/js/settings.js'); await updateSettings({ themeMode: theme }); }, theme); await sleep(180);
    await page.evaluate(() => window.__tracery.openNote('普通.md')); const ordinary = await look();
    await page.evaluate(() => window.__tracery.openNote('组内.md')); const grouped = await look();
    assert.deepEqual(grouped, ordinary, '分组内外活动标签使用同一容器与强调线');
    assert.ok(parseFloat(grouped.radius) >= 8);
    await page.screenshot({ path: path.join(OUT, `tabs-${theme}.png`), clip: { x: 0, y: 0, width: 1200, height: 90 } });
    await page.click('#btn-tab-new'); assert.deepEqual(await look(), ordinary, '空白标签同样使用统一选中样式');
  }
  const response = await fetch(BASE + '/api/vault/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: LARGE }) }); assert.ok(response.ok);
  await page.waitForFunction(root => window.__tracery.state.vault?.root === root && !!document.querySelector('.virtual-tree-row'), {}, LARGE);
  assert.ok(await page.evaluate(hidden => hidden.every(name => !window.__tracery.state.files.has(name)), hidden));
  const download = await fetch(BASE + '/api/file?path=word.docx'); assert.equal(await download.text(), '保留的文件字节');
  assert.ok(hidden.every(name => fs.readFileSync(path.join(LARGE, name), 'utf8') === '保留的文件字节'));
  assert.deepEqual(errors, []);
  console.log('PASS 支持格式列表、MD 无图标/PDF 标记、收藏过滤、大库虚拟树、原文件保留和统一标签选中态');
} catch (error) { if (page) await page.screenshot({ path: path.join(OUT, 'failure.png') }); throw error; }
finally { await browser?.close(); server.kill(); }
