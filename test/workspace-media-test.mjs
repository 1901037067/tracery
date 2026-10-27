/** 绘图、窄桌面标题栏、引用卡片、提示及编辑区 PDF 的真实交互回归。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { launchBrowser } from './browser.mjs';

const ROOT = path.resolve(import.meta.dirname, '..'), HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tracery-media-'));
const VAULT = path.join(HOME, 'vault'), OUT = path.join(ROOT, 'dist/workspace-media');
fs.mkdirSync(VAULT); fs.mkdirSync(OUT, { recursive: true });
// 小型有效 PDF，原生阅读器也能显示实际文字，不能仅用一个 .pdf 文件名冒充。
const content = 'BT /F1 24 Tf 50 700 Td (Tracery PDF preview) Tj ET';
const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
let pdf = '%PDF-1.4\n'; const offsets = [0];
objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
for (const name of ['说明.pdf', '第二份.pdf']) fs.writeFileSync(path.join(VAULT, name), pdf);
const names = ['笔记.md', ...Array.from({ length: 7 }, (_, i) => `课程资料_${i}.md`)];
const original = '# 主笔记\n\n![[引用]]\n\n正文保持不变。\n\n![[说明.pdf]]\n';
for (const name of names) fs.writeFileSync(path.join(VAULT, name), name === names[0] ? original : `# ${name}\n正文`);
fs.writeFileSync(path.join(VAULT, '引用.md'), '# 项目乙的同名笔记\n\n乙唯一关键词：海豚乙。');
fs.writeFileSync(path.join(HOME, 'tracery.config.json'), JSON.stringify({ currentVault: VAULT, settings: { themeMode: 'light' } }));
const PORT = 9647, BASE = `http://127.0.0.1:${PORT}`, sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const packed = process.env.TRACERY_TEST_EXE;
const entry = packed ? path.join(path.dirname(packed), 'resources/app.asar/server/server.js') : path.join(ROOT, 'server/server.js');
const server = spawn(packed || process.execPath, [entry], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), TRACERY_HOME: HOME, ...(packed ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }, windowsHide: true, stdio: 'pipe' });
let browser, page, blockSave = false; const errors = [], pdfNoteRequests = [];
try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/api/state')).ok) break; } catch {} await sleep(200); }
  browser = await launchBrowser({ width: 1440, height: 1000 }); page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/api/note' && /\.pdf$/i.test(url.searchParams.get('path') || '')) pdfNoteRequests.push(request.url());
    if (blockSave && url.pathname === '/api/note' && request.method() === 'PUT') request.respond({ status: 503, contentType: 'application/json', body: '{"error":"模拟保存失败"}' });
    else request.continue();
  });
  await page.goto(BASE, { waitUntil: 'networkidle0' }); await page.click('[data-path="笔记.md"]');
  await page.waitForSelector('.cm-lp-note-body');
  const card = await page.$eval('.cm-lp-note', el => { const s = getComputedStyle(el); return { left: s.borderLeftWidth, right: s.borderRightWidth, lc: s.borderLeftColor, rc: s.borderRightColor }; });
  assert.equal(card.left, card.right); assert.equal(card.lc, card.rc);
  await page.screenshot({ path: path.join(OUT, 'reference-light.png') });
  await page.hover('.ribbon-btn[data-panel="files"]'); await page.waitForSelector('#app-tooltip:not([hidden])');
  assert.equal(await page.$eval('#app-tooltip', el => el.textContent), '文件');
  assert.equal(await page.$eval('.ribbon-btn[data-panel="files"]', el => el.getAttribute('aria-describedby')), 'app-tooltip');
  assert.equal(await page.$eval('.ribbon-btn[data-panel="files"]', el => el.hasAttribute('title')), false);
  await page.screenshot({ path: path.join(OUT, 'tooltip-light.png') });
  await page.mouse.move(650, 60); await page.waitForSelector('#app-tooltip[hidden]');
  assert.equal(await page.$eval('.ribbon-btn[data-panel="files"]', el => el.title), '文件');
  await page.focus('.ribbon-btn[data-panel="files"]'); await page.keyboard.press('Tab');
  await page.waitForFunction(() => !document.querySelector('#app-tooltip').hidden && document.querySelector('#app-tooltip').textContent.includes('搜索'));
  assert.ok(await page.$('#app-tooltip kbd')); await page.keyboard.press('Escape');
  await page.waitForSelector('#app-tooltip[hidden]');
  await page.click('#btn-draw'); await page.waitForSelector('.draw-overlay:not([hidden])'); await page.click('#draw-toggle-props');
  const strokes = [];
  for (const dash of ['solid', 'dashed', 'dotted']) {
    await page.click(`.draw-dash[data-dash="${dash}"]`);
    strokes.push(await page.$eval(`.draw-dash[data-dash="${dash}"] span`, el => { const s = getComputedStyle(el); return { width: s.borderTopWidth, style: s.borderTopStyle, bg: s.backgroundColor }; }));
  }
  assert.deepEqual(strokes.map(s => s.width), ['2px', '2px', '2px']);
  assert.deepEqual(strokes.map(s => s.style), ['solid', 'dashed', 'dotted']);
  assert.ok(strokes.every(s => s.bg === 'rgba(0, 0, 0, 0)'));
  await page.evaluate(() => document.body.classList.add('electron'));
  for (const width of [2048, 1440, 1024, 901, 800, 760, 390]) {
    await page.setViewport({ width, height: 1000 }); await sleep(160);
    const geometry = await page.evaluate(() => {
      const tool = document.querySelector('.draw-tools'), r = tool.getBoundingClientRect();
      return { left: r.left, right: r.right, scroll: tool.scrollWidth, client: tool.clientWidth,
        rows: [...new Set([...tool.querySelectorAll('button')].map(el => el.offsetTop))].length };
    });
    assert.ok(geometry.left >= 0 && geometry.right <= width + 1 && geometry.scroll <= geometry.client + 1, JSON.stringify(geometry));
    if (width >= 760) assert.equal(geometry.rows, 1, `${width}px 有空间时工具栏应为一行`);
    await page.screenshot({ path: path.join(OUT, `drawing-${width}.png`) });
  }
  await page.setViewport({ width: 1440, height: 1000 }); await page.click('#draw-cancel');
  await page.waitForSelector('.draw-overlay[hidden]');
  for (const name of names) await page.evaluate(name => window.__tracery.openNote(name, null, { newTab: true }), name);
  await page.evaluate(names => { const s = window.__tracery.state; s.tabGroups = [{ id: 'g1', name: '新分组', color: 'teal', collapsed: false, tabs: names.slice(0, 5) }, { id: 'g2', name: '你好', color: 'red', collapsed: false, tabs: names.slice(5) }]; return window.__tracery.openNote(names[3]); }, names);
  for (const width of [901, 900, 800, 760]) {
    await page.setViewport({ width, height: 900 }); await sleep(150);
    const geometry = await page.evaluate(() => {
      const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
      return { bar: rect('.titlebar'), active: rect('.tab.active'), strip: rect('.tab-strip'), more: rect('.tab-more'), right: rect('.titlebar-right'), leftButton: rect('#btn-toggle-left') };
    });
    assert.equal(geometry.bar.height, 46); assert.ok(geometry.active.top >= geometry.bar.top && geometry.active.bottom <= geometry.bar.bottom + 1, JSON.stringify(geometry));
    const center = rect => rect.top + rect.height / 2;
    for (const rect of [geometry.active, geometry.more, geometry.leftButton]) assert.ok(Math.abs(center(rect) - center(geometry.bar)) < 1, JSON.stringify(geometry));
    assert.ok(geometry.strip.right <= geometry.more.left + 1 && geometry.more.right <= geometry.right.left + 1, JSON.stringify(geometry));
    assert.ok(geometry.leftButton.height <= 32);
    await page.screenshot({ path: path.join(OUT, `tabs-${width}.png`) });
  }
  await page.setViewport({ width: 1440, height: 1000 });
  await page.evaluate(() => window.__tracery.openNote('笔记.md'));
  // 保存失败不能被 PDF 导航绕过。
  blockSave = true;
  await page.evaluate(() => { const v = window.__editor.view; v.dispatch({ changes: { from: v.state.doc.length, insert: '未保存测试' } }); });
  await page.click('[data-path="说明.pdf"]'); await page.waitForFunction(() => !document.querySelector('#save-notice').hidden);
  assert.equal(await page.evaluate(() => window.__tracery.state.currentPath), '笔记.md');
  blockSave = false; await page.click('#save-retry'); await page.waitForFunction(() => !window.__editor.dirty);
  page.removeAllListeners('request'); await page.setRequestInterception(false);
  page.on('request', request => { const url = new URL(request.url()); if (url.pathname === '/api/note' && /\.pdf$/i.test(url.searchParams.get('path') || '')) pdfNoteRequests.push(request.url()); });
  await page.click('[data-path="说明.pdf"]'); await page.waitForFunction(() => window.__tracery.state.currentPath === '说明.pdf');
  const inline = await page.evaluate(() => {
    const el = document.querySelector('.pdf-viewer'), r = el.getBoundingClientRect(), host = el.parentElement.getBoundingClientRect();
    return { inline: !!el.closest('#editor-area'), position: getComputedStyle(el).position, width: r.width, hostWidth: host.width, top: r.top, hostTop: host.top, hidden: document.querySelector('#editor-live').hidden, path: window.__editor.path, dirty: window.__editor.dirty };
  });
  assert.ok(inline.inline && inline.position === 'absolute' && inline.hidden && !inline.dirty && !inline.path);
  assert.equal(await page.$eval('#document-header', el => el.hidden), true);
  assert.ok(Math.abs(inline.width - inline.hostWidth) < 1 && Math.abs(inline.top - inline.hostTop) < 1);
  assert.ok(await page.$eval('.tab.active', el => el.textContent.includes('说明.pdf')));
  assert.equal(fs.readFileSync(path.join(VAULT, '笔记.md'), 'utf8'), original + '未保存测试');
  assert.equal((await fetch(BASE + '/api/file?path=' + encodeURIComponent('说明.pdf'))).status, 200);
  await page.screenshot({ path: path.join(OUT, 'pdf-editor.png') });
  await page.evaluate(() => window.__tracery.openNote('笔记.md'));
  assert.equal(await page.$eval('.pdf-viewer', el => el.hidden), true);
  assert.equal(await page.$eval('.pdf-frame', el => el.getAttribute('src')), null);
  await page.click('.cm-lp-img.embed-file'); await page.waitForFunction(() => window.__tracery.state.currentPath === '说明.pdf');
  await page.evaluate(() => window.__tracery.openNote('第二份.pdf', null, { newTab: true }));
  await page.evaluate(() => window.__tracery.openNote('说明.pdf', null, { newTab: true }));
  assert.equal(await page.evaluate(() => window.__tracery.state.tabs.filter(p => p === '说明.pdf').length), 1);
  const session = await page.evaluate(async () => { const { normalizeSession } = await import('/js/layout-presets.js'); return normalizeSession({ tabs: window.__tracery.state.tabs, active: '说明.pdf' }); });
  assert.ok(session.tabs.includes('说明.pdf') && session.tabs.includes('第二份.pdf'));
  // 内置 PDF 阅读器有独立加载周期，页面恢复以实际活动文件为准，不等待所有插件网络请求静止。
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => window.__tracery?.state.currentPath === '说明.pdf');
  await page.click('.pdf-close'); await page.waitForFunction(() => window.__tracery.state.currentPath !== '说明.pdf');
  assert.deepEqual(pdfNoteRequests, [], '不能把 PDF 交给 Markdown API 读取或保存');
  assert.equal(fs.readFileSync(path.join(VAULT, '说明.pdf'), 'utf8'), pdf);
  assert.deepEqual(errors, []);
  console.log('PASS 线型不增粗、工具栏单行、窄桌面标签、中性引用、提示交互与 PDF 标签/保存保护/刷新');
} catch (error) {
  if (page) await page.screenshot({ path: path.join(OUT, 'failure.png') });
  throw error;
} finally {
  if (page && !page.isClosed()) await page.evaluate(async () => { const { hidePdfViewer } = await import('/js/pdf-viewer.js'); hidePdfViewer(); }).catch(() => {});
  await browser?.close(); server.kill();
}
