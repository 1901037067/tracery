/** 图片预览、折叠块与真实正文行的行号几何回归；仅使用临时笔记库。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { launchBrowser } from './browser.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tracery-line-numbers-'));
const VAULT = path.join(HOME, 'vault'), OUT = path.join(ROOT, 'dist/line-numbers');
fs.mkdirSync(VAULT); fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(VAULT, 'wide.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="240"><rect width="720" height="240" fill="#dbeafe"/><text x="20" y="120" font-size="32">Image preview</text></svg>');
fs.writeFileSync(path.join(VAULT, 'tall.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="400"><rect width="240" height="400" fill="#dcfce7"/></svg>');
fs.writeFileSync(path.join(VAULT, '引用.md'), '# 引用笔记\n\n嵌入正文。');
fs.writeFileSync(path.join(VAULT, '附件.pdf'), 'test attachment');
const source = ['行号定位基线', '', '![[wide.svg|470]]', '图片后的正文甲', '',
  '![[wide.svg]]', '![[tall.svg|180]]', '图片后的正文乙', '', '',
  '![[wide.svg|304]]', '图片后的正文丙', '', '', '', '', '末尾正文', '',
  '```js', 'const value = 1;', '```', '', '## 标题', '',
  '前缀 ![[wide.svg|120]] 后缀', '', '![[引用]]', '卡片后的正文', '',
  '![[附件.pdf]]', '附件后的正文', '', '![[不存在.svg]]', '缺失图片后的正文', '',
  ...Array.from({ length: 45 }, (_, i) => `后续正文 ${i + 1}`)].join('\n');
fs.writeFileSync(path.join(VAULT, '行号.md'), source);
fs.writeFileSync(path.join(HOME, 'tracery.config.json'), JSON.stringify({ currentVault: VAULT }));
const PORT = 9645, BASE = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const packed = process.env.TRACERY_TEST_EXE;
const entry = packed ? path.join(path.dirname(packed), 'resources/app.asar/server/server.js') : path.join(ROOT, 'server/server.js');
const server = spawn(packed || process.execPath, [entry], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), TRACERY_HOME: HOME, ...(packed ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }, windowsHide: true, stdio: 'pipe',
});
let browser, page;
const errors = [];
try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/api/state')).ok) break; } catch {} await sleep(200); }
  browser = await launchBrowser({ width: 1440, height: 1100 }); page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.click('[data-path="行号.md"]');
  await page.waitForFunction(() => window.__editor?.path === '行号.md');
  await page.waitForFunction(() => [...document.querySelectorAll('.cm-lp-img img')].every(img => img.complete && img.naturalWidth));
  await sleep(350);
  async function geometry(label) {
    const data = await page.evaluate(() => {
      const v = window.__editor.view;
      const gutters = new Map([...v.dom.querySelectorAll('.cm-lineNumbers .cm-gutterElement')]
        .filter(el => el.style.visibility !== 'hidden').map(el => [Number(el.textContent), el.getBoundingClientRect().top]));
      return [...v.contentDOM.querySelectorAll('.cm-line')].map(el => {
        const pos = v.posAtDOM(el), n = v.state.doc.lineAt(pos).number, r = el.getBoundingClientRect();
        return { n, text: el.textContent, top: r.top, gutter: gutters.get(n), height: r.height,
          model: v.lineBlockAt(pos).top + v.documentTop };
      });
    });
    fs.writeFileSync(path.join(OUT, `${label}.json`), JSON.stringify(data, null, 2));
    await page.screenshot({ path: path.join(OUT, `${label}.png`) });
    console.log(`${label}: ${data.length} 个正文行`);
    for (const row of data) {
      if (row.gutter != null) assert.ok(Math.abs(row.top - row.gutter) < 1, `${label}: 第 ${row.n} 行行号偏移 ${row.gutter - row.top}px`);
      assert.ok(Math.abs(row.top - row.model) < 1, `${label}: 第 ${row.n} 行高度映射偏移 ${row.model - row.top}px`);
    }
  }
  await geometry('live');
  await page.evaluate(() => window.__editor.setMode('source')); await sleep(150);
  await geometry('source');
  await page.evaluate(() => window.__editor.setMode('read')); await sleep(150);
  assert.equal(await page.$('.cm-gutters'), null, '阅读模式隐藏行号');
  await geometry('read');
  await page.evaluate(() => { window.__editor.setMode('live'); window.__editor.view.scrollDOM.scrollTop = 0; }); await sleep(150);
  // 真实鼠标拖宽，确保尺寸变化后行号和点击映射仍正确。
  const grip = await page.$eval('.cm-lp-img-grip', el => {
    const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(grip.x - 20, grip.y - 20); await page.mouse.move(grip.x, grip.y); await sleep(200);
  await page.mouse.down(); await page.mouse.move(grip.x + 80, grip.y, { steps: 8 }); await page.mouse.up(); await sleep(200);
  const resized = source.replace('wide.svg|470', 'wide.svg|550');
  assert.equal(await page.evaluate(() => window.__editor.getContent()), resized);
  await geometry('resized');
  // 不用 CM 的高度模型制造点击坐标，以实际 DOM 中图片后的文字行定位。
  await page.evaluate(() => {
    const v = window.__editor.view, el = [...v.contentDOM.querySelectorAll('.cm-line')].find(el => el.textContent === '图片后的正文丙');
    const r = el.getBoundingClientRect(), s = v.scrollDOM.getBoundingClientRect(); v.scrollDOM.scrollTop += r.top - s.top - 120;
  }); await sleep(150);
  const point = await page.evaluate(() => {
    const v = window.__editor.view, el = [...v.contentDOM.querySelectorAll('.cm-line')].find(el => el.textContent === '图片后的正文丙');
    const r = el.getBoundingClientRect(); return { x: r.left + 60, y: r.top + r.height / 2 };
  });
  await page.mouse.click(point.x, point.y);
  assert.equal(await page.evaluate(() => { const v = window.__editor.view; return v.state.doc.lineAt(v.state.selection.main.head).number; }), 12, '点击图片后的正文落在正确源码行');
  await page.keyboard.press('End'); await page.keyboard.type('_GUTTER_HIT');
  await page.evaluate(() => window.__editor.flush());
  assert.equal(fs.readFileSync(path.join(VAULT, '行号.md'), 'utf8'), resized.replace('图片后的正文丙', '图片后的正文丙_GUTTER_HIT'));
  await page.evaluate(() => window.__editor.undo());
  await page.evaluate(() => { window.__editor.setLineNumbers(false); });
  assert.equal(await page.$('.cm-gutters'), null);
  await page.evaluate(() => { window.__editor.setLineNumbers(true); }); await sleep(100);
  await geometry('numbers-restored');
  // 滚至下方，覆盖图片、异步笔记卡片、附件及缺失图片之后的行。
  await page.evaluate(() => window.__editor.scrollToLine(36)); await sleep(200);
  await page.waitForSelector('.cm-lp-note-body');
  await geometry('scrolled');
  await page.click('#btn-theme'); await sleep(200);
  await geometry('light');
  await page.evaluate(async () => { const { updateSettings } = await import('/js/settings.js'); await updateSettings({ fontSize: 20, layout: { lineHeight: 2 } }); }); await sleep(200);
  await geometry('typography');
  await page.setViewport({ width: 390, height: 844 }); await sleep(200);
  await geometry('mobile');
  assert.equal(await page.evaluate(() => window.__editor.getContent()), resized);
  assert.deepEqual(errors, []);
  console.log('PASS 图片/卡片/附件行号、模式切换、真实拖宽与点击输入、主题排版与窄屏');
} finally { await browser?.close(); server.kill(); }
