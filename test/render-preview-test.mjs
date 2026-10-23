import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { launchBrowser } from './browser.mjs';
import { parseMarkdown } from '../public/js/markdown.js';
import { inlineMath } from '../public/js/math.js';

const ROOT = path.resolve(import.meta.dirname, '..'), HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tracery-render-preview-'));
const VAULT = path.join(HOME, 'vault'), OUT = path.join(ROOT, 'dist/render-preview'); fs.mkdirSync(VAULT); fs.mkdirSync(OUT, { recursive: true });
const md = [
  '# 实时预览', '', '| 写法 | 效果 |', '| --- | --- |', '| `<u>下划线</u>` | <u>下划线</u> |', '',
  '普通代码块：', '', '```', '# 一级标题', '## 二级标题', '', '最后一行代码', '```', '',
  '嵌套围栏示例：', '', '````text', '```python', 'def hello():', '    print("Hello")', '```', '````', '',
  '带语言代码：', '', '```python', 'def hello():', '    print("Hello")', '```', '',
  '> 这是一行引用', '> 引用可以有多行', '>', '> > 嵌套引用', '',
  '数学公式：', '', '写法 `$E = mc^2$`，渲染为 $E = mc^2$；下标 $w_1 x_1$。', '',
  '$$', '\\hat{y} = w_1 x_1 + w_2 x_2 + b', '$$', '',
  '$$', '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}', '$$', '',
  '价格 $5 和 $10；转义 \\$x\\$；`$不渲染$`。', '', '错误公式 $\\frac{a}$ 不影响后文。', '', '结尾',
].join('\n');
const blocks = parseMarkdown(md).blocks, fences = blocks.filter(block => block.type === 'fence');
assert.equal(fences.length, 3); assert.ok(fences[1].code.includes('```python')); assert.equal(fences[1].lang, 'text');
assert.equal(parseMarkdown('```\n未闭合的最后一行').blocks[0].closed, false);
assert.equal(inlineMath('价格 $5 和 $10；\\$x\\$；`$x$`').length, 0);
assert.equal(blocks.filter(block => block.type === 'math').length, 2);
fs.writeFileSync(path.join(VAULT, '预览.md'), md);
fs.writeFileSync(path.join(HOME, 'tracery.config.json'), JSON.stringify({ currentVault: VAULT }));
const PORT = 9636, BASE = `http://127.0.0.1:${PORT}`, sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const packed = process.env.TRACERY_TEST_EXE, entry = packed ? path.join(path.dirname(packed), 'resources/app.asar/server/server.js') : path.join(ROOT, 'server/server.js');
const server = spawn(packed || process.execPath, [entry], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), TRACERY_HOME: HOME, ...(packed ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }, windowsHide: true, stdio: 'pipe' });
let browser, page;
const errors = [];
try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/api/state')).ok) break; } catch {} await sleep(200); }
  browser = await launchBrowser({ width: 1440, height: 1000 }); page = await browser.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && message.text().includes('[decorations]')) errors.push(message.text()); });
  await page.goto(BASE, { waitUntil: 'networkidle0' }); await page.click('[data-path="预览.md"]');
  if (await page.$eval('html', node => node.dataset.theme === 'dark')) await page.click('#btn-theme');
  const scroll = async text => {
    await page.evaluate(async text => {
      const { EditorView } = await import('@codemirror/view'), editor = window.__tracery.editor;
      editor.view.dispatch({ selection: { anchor: 0 }, effects: EditorView.scrollIntoView(Math.max(0, editor.getContent().indexOf(text)), { y: 'start' }) });
    }, text); await sleep(100);
  };
  await page.waitForSelector('.cm-lp-underline');
  assert.ok(await page.$eval('.cm-lp-underline', node => getComputedStyle(node).textDecorationLine.includes('underline')));
  assert.ok(await page.$eval('.cm-lp-code', node => node.textContent.includes('<u>')));
  await scroll('普通代码块');
  const code = await page.$$eval('.cm-lp-code-first', nodes => nodes.map(node => ({ lang: node.dataset.language, bg: getComputedStyle(node).backgroundColor, label: getComputedStyle(node, '::after').content })));
  assert.ok(code.some(item => item.lang === 'text' && item.bg !== 'rgba(0, 0, 0, 0)' && item.label.includes('text')));
  assert.equal(await page.$eval('.cm-lp-code-line', node => getComputedStyle(node).fontFamily.includes('mono') || getComputedStyle(node).fontFamily.includes('Consolas')), true);
  assert.ok(await page.$$eval('.cm-lp-code-line', nodes => nodes.some(node => node.textContent.includes('# 一级标题') && !node.className.includes('cm-lp-h1'))));
  await page.screenshot({ path: path.join(OUT, 'code-light.png') });
  await scroll('带语言代码');
  assert.ok(await page.$$eval('.cm-lp-code-first', nodes => nodes.some(node => node.dataset.language === 'python')));
  assert.ok(await page.$('.cm-lp-code-line .tok-kw')); assert.ok(await page.$('.cm-lp-code-line .tok-str'));
  await page.evaluate(() => {
    const editor = window.__tracery.editor, at = editor.getContent().lastIndexOf('def hello():');
    editor.scrollToLine(editor.view.state.doc.lineAt(at).number);
  });
  assert.ok(await page.$$eval('.cm-lp-code-line', nodes => nodes.some(node => node.textContent.includes('```python'))));
  await scroll('> 这是一行引用');
  const quotes = await page.$$eval('.cm-lp-quote', nodes => nodes.map(node => ({ text: node.textContent, depth: getComputedStyle(node).getPropertyValue('--cm-quote-depth').trim(), bars: getComputedStyle(node, '::before').backgroundImage })));
  assert.ok(quotes.some(quote => quote.text.includes('这是一行引用') && !quote.text.startsWith('>') && quote.bars.includes('repeating-linear-gradient')));
  assert.ok(quotes.some(quote => quote.text.includes('嵌套引用') && quote.depth === '2' && !quote.text.includes('>')));
  await page.screenshot({ path: path.join(OUT, 'quotes-light.png') });
  console.log('PASS HTML 下划线与代码字面量、完整代码底色/语言/高亮、四反引号嵌套、引用竖线与层级');
  await scroll('数学公式：');
  await page.waitForSelector('.cm-math-inline .katex'); await page.waitForSelector('.cm-math-block .katex');
  assert.ok(await page.$('.cm-math-inline .katex-mathml msup'));
  assert.ok(await page.$('.cm-math-inline .katex-mathml msub'));
  assert.ok(await page.$eval('.cm-math-block', node => getComputedStyle(node).textAlign === 'center' && node.querySelector('.katex')));
  assert.equal(await page.$$eval('.cm-math-block', nodes => nodes.length), 2);
  await page.evaluate(() => document.fonts.ready);
  assert.ok(await page.evaluate(() => document.fonts.check('16px KaTeX_Main')));
  await page.screenshot({ path: path.join(OUT, 'math-light.png') });
  assert.equal(await page.evaluate(() => window.__tracery.editor.getContent()), md);
  await page.click('.cm-math-inline');
  await page.keyboard.type('z'); await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
  assert.equal(await page.evaluate(() => window.__tracery.editor.getContent()), md);
  await scroll('数学公式：');
  await page.evaluate(() => window.__tracery.editor.setMode('read')); await page.waitForSelector('.cm-math-block');
  assert.equal(await page.$eval('.cm-content', node => node.isContentEditable), false);
  await page.evaluate(() => window.__tracery.editor.setMode('source')); assert.equal(await page.$('.cm-math-block'), null);
  await page.evaluate(() => window.__tracery.editor.setMode('live')); await scroll('错误公式');
  assert.ok(await page.$('.katex-error'));
  const worker = await (await fetch(BASE + '/sw.js')).text();
  assert.ok(worker.includes('/vendor/katex/katex.mjs') && worker.includes('.woff2'));
  await page.setOfflineMode(true); await scroll('数学公式：'); assert.ok(await page.$('.cm-math-block .katex')); await page.setOfflineMode(false);
  console.log('PASS 行内上下标与独立公式、矩阵、字体、点击编辑/撤销/三模式、非法公式回退及离线资源');
  const roundtrip = await page.evaluate(async () => {
    const { renderMarkdown, serializeHtml } = await import('/js/markdown.js');
    const samples = ['<u>下划线</u>', '公式 $E=mc^2$', '$$\n\\hat{y}=w_1x_1+b\n$$', '````text\n```python\ndef x():\n    pass\n```\n````'];
    return samples.map(md => { const root = document.createElement('div'); root.append(renderMarkdown(md)); return { md, result: serializeHtml(root).trim() }; });
  });
  for (const sample of roundtrip) assert.equal(sample.result, sample.md);
  await page.evaluate(() => { const editor = window.__tracery.editor; editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: '# 空代码\n\n```python\n```' }, selection: { anchor: 0 } }); });
  await page.waitForSelector('.cm-lp-empty-code');
  assert.ok(await page.$eval('.cm-lp-empty-code', node => node.getBoundingClientRect().height >= 50 && node.dataset.language === 'python'));
  await page.evaluate(() => { const editor = window.__tracery.editor; editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: '```python\nprint("最后一行不应消失")' }, selection: { anchor: 0 } }); });
  assert.ok(await page.$$eval('.cm-lp-code-line', nodes => nodes.some(node => node.textContent.includes('最后一行不应消失'))));
  await page.click('#btn-theme'); await page.screenshot({ path: path.join(OUT, 'code-dark.png') });
  assert.deepEqual(errors, []);
  console.log('PASS 预览不改原文、下划线/公式/嵌套围栏往返保真、未闭合代码末行与暗色主题');
} catch (error) {
  if (page) { console.error('页面错误', errors); await page.screenshot({ path: path.join(OUT, 'failure.png') }); }
  throw error;
} finally { await browser?.close(); server.kill(); }
