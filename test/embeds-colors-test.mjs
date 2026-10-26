import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { launchBrowser } from './browser.mjs';
import { noteAnchors, selectNoteContent } from '../public/js/note-embed.js';

const ROOT = path.resolve(import.meta.dirname, '..'), HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tracery-embeds-colors-'));
const VAULT = path.join(HOME, 'vault'), OUT = path.join(ROOT, 'dist/embeds-colors-preview');
fs.mkdirSync(VAULT); fs.mkdirSync(OUT, { recursive: true });
const source = '# 源笔记\n\n## 章节甲\n\n**章节内容**\n\n![[./pixel.png|80]]\n\n[[./Next|内部链接]]\n\n### 子章节\n\n子章节内容\n\n## 章节乙\n\n不要出现在甲\n\n块内容第一行\n第二行 ^block-a\n\n' + '长正文'.repeat(1300) + '\n\n全文末尾标记\n\n```md\n## 假标题\n假块 ^fake\n```';
assert.ok(selectNoteContent(source, '章节甲').md.includes('子章节内容'));
assert.ok(!selectNoteContent(source, '章节甲').md.includes('不要出现在甲'));
assert.equal(selectNoteContent(source, '^block-a').md, '块内容第一行\n第二行');
assert.ok(selectNoteContent(source, '缺失').error);
assert.ok(!noteAnchors(source).some(item => ['假标题', '^fake'].includes(item.anchor)));
assert.equal(selectNoteContent('- one\n- two\n\n^list-id', '^list-id').md, '- one\n- two');
const host = '# 嵌入测试\n\n![[资料/Source|整篇预览]]\n\n![[资料/Source#章节甲|只看甲]]\n![[资料/Source#^block-a]]\n\n![[不存在]]\n\n![[资料/Source#缺失]]\n\n![[资料/Text.txt]]\n\n结束\n';
for (const [rel, text] of Object.entries({ 'Host.md': host, '资料/Source.md': source, '资料/Next.md': '# 下一篇', '资料/Text.txt': '纯文本嵌入',
  '甲/Host.md': '# 甲入口\n\n![[./Same]]', '甲/Same.md': '延迟的甲内容', '乙/Host.md': '# 乙入口\n\n![[./Same]]', '乙/Same.md': '即时的乙内容' })) {
  fs.mkdirSync(path.dirname(path.join(VAULT, rel)), { recursive: true }); fs.writeFileSync(path.join(VAULT, rel), text);
}
fs.copyFileSync(path.join(ROOT, 'public/icons/favicon-16.png'), path.join(VAULT, '资料/pixel.png'));
fs.writeFileSync(path.join(HOME, 'tracery.config.json'), JSON.stringify({ currentVault: VAULT }));
const PORT = 9635, BASE = `http://127.0.0.1:${PORT}`, sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const packed = process.env.TRACERY_TEST_EXE, entry = packed ? path.join(path.dirname(packed), 'resources/app.asar/server/server.js') : path.join(ROOT, 'server/server.js');
const server = spawn(packed || process.execPath, [entry], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), TRACERY_HOME: HOME, ...(packed ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }, windowsHide: true, stdio: 'pipe' });
let browser, page;
const refreshTrace = [];
try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/api/state')).ok) break; } catch {} await sleep(200); }
  browser = await launchBrowser({ width: 1360, height: 900 }); page = await browser.newPage(); const errors = [];
  await page.evaluateOnNewDocument(() => {
    const NativeSocket = window.WebSocket; window.__embedTestSockets = [];
    window.WebSocket = class extends NativeSocket { constructor(...args) { super(...args); window.__embedTestSockets.push(this); } };
  });
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  const cdp = await page.createCDPSession(); await cdp.send('Network.enable');
  cdp.on('Network.webSocketFrameReceived', event => refreshTrace.push({ type: 'ws', data: event.response.payloadData, at: Date.now() }));
  page.on('response', response => {
    if (!response.url().includes('/api/note')) return;
    response.text().then(body => refreshTrace.push({ type: 'note-response', url: response.url(), status: response.status(), body: body.slice(0, 400), at: Date.now() })).catch(() => {});
  });
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  const open = rel => page.evaluate(async rel => window.__tracery.openNote(rel, null, { newTab: true }), rel);
  await open('Host.md');
  await page.waitForFunction(() => document.querySelectorAll('.cm-lp-note').length >= 6 && !document.querySelector('.cm-lp-note-loading'));
  const cards = await page.$$eval('.cm-lp-note', nodes => nodes.map(node => ({ raw: node.dataset.name, title: node.querySelector('.cm-lp-note-title span').textContent, body: node.querySelector('.cm-lp-note-body').textContent })));
  assert.ok(cards.find(card => card.title === '整篇预览').body.includes('全文末尾标记'));
  assert.ok(cards.find(card => card.title === '只看甲').body.includes('子章节内容'));
  assert.ok(!cards.find(card => card.title === '只看甲').body.includes('不要出现在甲'));
  assert.equal(cards.find(card => card.raw.endsWith('^block-a')).body.trim(), '块内容第一行第二行');
  assert.ok(cards.find(card => card.raw === '不存在').body.includes('找不到'));
  assert.ok(cards.find(card => card.raw.endsWith('#缺失')).body.includes('标题不存在'));
  assert.ok(cards.find(card => card.raw.endsWith('Text.txt')).body.includes('纯文本嵌入'));
  await page.waitForFunction(() => [...document.querySelectorAll('.cm-embed-image')].every(img => img.naturalWidth > 0));
  assert.ok(await page.$eval('.cm-embed-image', img => new URL(img.src).searchParams.get('path') === '资料/pixel.png'));
  await page.evaluate(() => window.__tracery.editor.setMode('read'));
  assert.equal(await page.$('.cm-embed-edit'), null);
  await page.evaluate(() => window.__tracery.editor.setMode('live'));
  await page.waitForSelector('.cm-embed-edit');
  await page.screenshot({ path: path.join(OUT, 'embeds.png') });
  await page.click('.cm-lp-note[data-name="资料/Source#章节甲|只看甲"] .cm-embed-open');
  await page.waitForFunction(() => window.__tracery.state.currentPath === '资料/Source.md');
  await page.waitForFunction(() => window.__tracery.editor.view.state.doc.lineAt(window.__tracery.editor.view.state.selection.main.head).number === 3);
  console.log('PASS 整篇超 3000 字、标题子章节/别名、文本块、相对图片、纯文本、相邻嵌入、缺失提示与打开定位');

  // 在源码和实时预览中输入引用，验证下拉补全、Enter 确认和原文可编辑。
  await open('Host.md');
  const setDoc = (text, mode = 'live') => page.evaluate(({ text, mode }) => {
    const editor = window.__tracery.editor; editor.setMode(mode);
    editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: text }, selection: { anchor: text.length } }); editor.focus();
  }, { text, mode });
  const accept = async () => { await page.waitForSelector('.cm-tooltip-autocomplete li[role="option"]'); await sleep(150); await page.keyboard.press('Enter'); };
  await setDoc('# 输入\n\n'); await page.keyboard.type('![[Source');
  await accept();
  await page.waitForFunction(() => window.__tracery.editor.getContent().includes('![[资料/Source]]'));
  await page.waitForSelector('.cm-lp-note');
  await setDoc('# 输入\n\n', 'source'); await page.keyboard.type('![[资料/Source#章节');
  await accept();
  assert.ok(await page.evaluate(() => window.__tracery.editor.getContent().includes('![[资料/Source#章节甲]]')));
  await setDoc('# 输入\n\n', 'source'); await page.keyboard.type('![[资料/Source#^block');
  await accept();
  assert.ok(await page.evaluate(() => window.__tracery.editor.getContent().includes('#^block-a]]')));
  await page.evaluate(() => window.__tracery.editor.setMode('read')); await page.waitForSelector('.cm-lp-note');
  assert.equal(await page.$('.cm-embed-edit'), null);
  console.log('PASS ![[ 自动补全笔记/标题/文本块、Enter 确认、源码与阅读模式');

  // 已显示的嵌入跟随磁盘内容更新。
  await setDoc('# 更新\n\n![[资料/Next]]');
  await page.waitForFunction(() => document.querySelector('.cm-lp-note-body')?.textContent.includes('下一篇'));
  const changed = await fetch(BASE + '/api/note', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '资料/Next.md', content: '# 已修改的嵌入内容' }) });
  refreshTrace.push({ type: 'external-save', status: changed.status, body: await changed.text(), disk: fs.readFileSync(path.join(VAULT, '资料/Next.md'), 'utf8'), at: Date.now() });
  assert.equal(changed.status, 200, '外部更新必须保存成功');
  await page.waitForFunction(() => document.querySelector('.cm-lp-note-body')?.textContent.includes('已修改的嵌入内容'));
  await page.evaluate(() => window.__tracery.editor.flush());
  await page.waitForFunction(() => window.__embedTestSockets.some(socket => socket.readyState === 1));
  await page.evaluate(() => window.__embedTestSockets.forEach(socket => socket.close()));
  await page.evaluate(() => {
    const editor = window.__tracery.editor; editor.setAutosave(60000);
    editor.view.dispatch({ changes: { from: editor.view.state.doc.length, insert: '\n\n断线未保存草稿' } });
  });
  const offlineSave = await fetch(BASE + '/api/note', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '资料/Next.md', content: '# 断线期间更新' }) });
  assert.equal(offlineSave.status, 200);
  await page.waitForFunction(() => window.__embedTestSockets.length > 1 && window.__embedTestSockets.at(-1).readyState === 1);
  await page.waitForFunction(() => document.querySelector('.cm-lp-note-body')?.textContent.includes('断线期间更新'));
  assert.ok(await page.evaluate(() => window.__tracery.editor.dirty && window.__tracery.editor.getContent().includes('断线未保存草稿')));
  assert.ok(!fs.readFileSync(path.join(VAULT, 'Host.md'), 'utf8').includes('断线未保存草稿'));
  await page.evaluate(async () => { window.__tracery.editor.setAutosave(900); await window.__tracery.editor.flush(); });
  console.log('PASS 断线期间的嵌入更新在重连后自动补查');
  await page.setRequestInterception(true); let held;
  const intercept = request => {
    if (new URL(request.url()).searchParams.get('path') === '甲/Same.md') held = request;
    else request.continue();
  };
  page.on('request', intercept);
  await open('甲/Host.md'); for (let i = 0; i < 50 && !held; i++) await sleep(20); assert.ok(held);
  await open('乙/Host.md'); await page.waitForFunction(() => document.querySelector('.cm-lp-note-body')?.textContent.includes('即时的乙内容'));
  await held.continue(); await sleep(150);
  assert.ok(await page.$eval('.cm-lp-note-body', node => node.textContent.includes('即时的乙内容')));
  page.off('request', intercept); await page.setRequestInterception(false);
  console.log('PASS 文件更新刷新嵌入，异步旧笔记响应不会污染新笔记');

  await page.evaluate(() => window.__tracery.editor.setMode('live'));
  await page.click('#btn-draw'); await page.click('.draw-tool[data-tool="rect"]');
  const canvas = await page.$eval('#draw-canvas', node => node.getBoundingClientRect().toJSON());
  await page.mouse.move(canvas.left + 380, canvas.top + 220); await page.mouse.down(); await page.mouse.move(canvas.left + 500, canvas.top + 300); await page.mouse.up();
  await page.click('#draw-toggle-props');
  const hex = async (kind, value) => {
    const selector = `[data-color-kind="${kind}"] .draw-color-hex`;
    await page.$eval(selector, (input, value) => { input.value = value; }, value);
    await page.click(`[data-color-kind="${kind}"] .draw-color-apply`);
  };
  await hex('stroke', '#abc'); await hex('background', '#123456');
  await page.$eval('[data-color-kind="stroke"] .draw-color-picker', input => { input.value = '#654321'; input.dispatchEvent(new Event('change', { bubbles: true })); });
  for (let i = 0; i < 10; i++) await hex('stroke', '#' + (0x100000 + i).toString(16));
  await hex('stroke', '#654321'); await hex('stroke', '#654321');
  const colors = await page.evaluate(() => JSON.parse(localStorage.getItem('tracery.draw.recentColors')));
  assert.equal(colors.length, 8); assert.equal(new Set(colors).size, 8); assert.equal(colors[0], '#654321');
  await hex('stroke', 'zzzzzz');
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('tracery.draw.recentColors'))), colors);
  await hex('stroke', '#abc');
  assert.equal(await page.$$eval('.draw-swatch', nodes => nodes.length), 8); assert.equal(await page.$$eval('.draw-bg', nodes => nodes.length), 9);
  assert.ok(await page.$$eval('.draw-color-presets', nodes => nodes.every(node => node.getBoundingClientRect().height < 25)));
  await page.screenshot({ path: path.join(OUT, 'custom-colors.png') });
  await page.click('#draw-save'); await page.waitForFunction(() => document.querySelector('.draw-overlay').hidden);
  const assets = fs.readdirSync(VAULT, { recursive: true }).filter(file => file.endsWith('.draw.json'));
  const scene = JSON.parse(fs.readFileSync(path.join(VAULT, assets[0]), 'utf8'));
  assert.equal(scene.elements[0].stroke, '#aabbcc'); assert.equal(scene.elements[0].background, '#123456');
  await page.reload({ waitUntil: 'networkidle0' }); await page.click('#btn-draw'); await page.click('#draw-toggle-props');
  assert.ok(await page.$eval('.draw-recent-swatch', node => node.dataset.color === '#aabbcc'));
  assert.deepEqual(errors, []);
  console.log('PASS 原色紧凑保留、自定义选色/HEX/非法输入、最近 8 色去重与重启保留、选中图形颜色保存');
} catch (error) {
  if (page) console.error('页面诊断', await page.evaluate(() => ({ content: window.__tracery?.editor.getContent(), mode: window.__tracery?.editor.mode, cards: [...document.querySelectorAll('.cm-lp-note')].map(node => node.textContent), text: document.querySelector('.cm-content')?.textContent })));
  throw error;
} finally { fs.writeFileSync(path.join(OUT, 'refresh-trace.json'), JSON.stringify(refreshTrace, null, 2)); await browser?.close(); server.kill(); }
