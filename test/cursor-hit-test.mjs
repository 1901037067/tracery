/**
 * 用真实鼠标验证长笔记中的点击落点，防止装饰行的实际布局与 CM 高度映射偏离。
 * 仓库与配置全部建在临时目录，绝不修改用户笔记。
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const ROOT = path.resolve(import.meta.dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tracery-cursor-hit-'));
const VAULT = path.join(HOME, 'vault');
const PORT = 9618;
const BASE = `http://localhost:${PORT}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
fs.mkdirSync(VAULT);
// 保留截图的结构：前方有多行 Callout、表格，第 32 行是标题、第 33 行为空行。
const lines = ['# 点击定位', '', '> [!note] 背景', '> 第一段 **加粗内容**',
  '> 第二段内容', '> 第三段内容', '', '## 表格', '',
  '| 名称 | 内容 |', '| --- | --- |', '| 本地笔记 | Markdown |', ''];
while (lines.length < 31) lines.push(`前置正文 ${lines.length + 1}`);
lines.push('## 未实现（已知限制）', '', '- [ ] 插件系统', '- [ ] 移动端 App', '',
  '> [!tip] 单行提示', '', '> [!warning] 另一提示', '> 多行正文', '',
  '## 第二个定位标题', '', '后续普通正文', '', ...Array.from({ length: 100 }, (_, i) => `末尾正文 ${i}`));
const source = lines.join('\n');
fs.writeFileSync(path.join(VAULT, '点击定位.md'), source);
// 可选：让打包的 Electron 以 Node 模式加载 asar 中的服务与静态资源，同样使用临时仓库。
const packedExe = process.env.TRACERY_TEST_EXE;
const serverScript = packedExe
  ? path.join(path.dirname(packedExe), 'resources/app.asar/server/server.js')
  : path.join(ROOT, 'server/server.js');
const server = spawn(packedExe || process.execPath, [serverScript], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), TRACERY_HOME: HOME,
    ...(packedExe ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }, stdio: 'pipe', windowsHide: true,
});
let browser;
try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/api/state`)).ok) break; } catch { /* 等服务启动 */ }
    await sleep(250);
  }
  await fetch(`${BASE}/api/vault/open`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: VAULT }),
  });
  const profile = path.join(HOME, 'browser');
  spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { windowsHide: true, stdio: 'ignore' });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(200);
  if (!fs.existsSync(portFile)) throw new Error('Edge 未在 20 秒内启动调试端口');
  const [port, endpoint] = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
  browser = await puppeteer.connect({ browserWSEndpoint: `ws://127.0.0.1:${port}${endpoint}`,
    defaultViewport: { width: 1440, height: 900 } });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-path="点击定位.md"]');
  await page.click('[data-path="点击定位.md"]');
  await page.waitForFunction(() => window.__editor?.path === '点击定位.md');
  async function clickLine(n, cursor = n + 1) {
    await page.evaluate(cursor => {
      const v = window.__editor.view;
      v.dispatch({ selection: { anchor: v.state.doc.line(cursor).from }, scrollIntoView: true });
      v.focus();
    }, cursor);
    await sleep(120);
    // 以显示的行 DOM 为准滚到视口中间，不能拿待验证的 CM 高度模型来造点击坐标。
    await page.evaluate(n => {
      const v = window.__editor.view;
      const el = [...v.contentDOM.querySelectorAll('.cm-line')]
        .find(e => v.state.doc.lineAt(v.posAtDOM(e)).number === n);
      if (!el) throw new Error('目标行尚未渲染');
      const r = el.getBoundingClientRect(), s = v.scrollDOM.getBoundingClientRect();
      v.scrollDOM.scrollTop += (r.top + r.bottom - s.top - s.bottom) / 2;
    }, n);
    await sleep(120);
    const pt = await page.evaluate(n => {
      const v = window.__editor.view;
      const el = [...v.contentDOM.querySelectorAll('.cm-line')]
        .find(e => v.state.doc.lineAt(v.posAtDOM(e)).number === n);
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const x = r.left + 80;
      const y = (r.top + parseFloat(style.borderTopWidth) + r.bottom - parseFloat(style.borderBottomWidth)) / 2;
      return { x, y, mapped: v.state.doc.lineAt(v.posAtCoords({ x, y })).number,
        drift: Math.abs(r.top - (v.lineBlockAt(v.posAtDOM(el)).top + v.documentTop)) };
    }, n);
    assert.equal(pt.mapped, n, `屏幕第 ${n} 行的坐标映射错误`);
    assert.ok(pt.drift < 1, `第 ${n} 行高度映射偏差 ${pt.drift}px`);
    await page.mouse.click(pt.x, pt.y);
    await sleep(80);
    const actual = await page.evaluate(() => {
      const st = window.__editor.view.state;
      return st.doc.lineAt(st.selection.main.head).number;
    });
    assert.equal(actual, n, `点击第 ${n} 行后光标落点错误`);
  }
  for (const config of [
    { theme: 'light', font: 16, numbers: true, mode: 'live', width: 1440 },
    { theme: 'dark', font: 20, numbers: false, mode: 'live', width: 1100 },
    { theme: 'light', font: 16, numbers: true, mode: 'source', width: 1440 },
    { theme: 'light', font: 16, numbers: true, mode: 'live', width: 1440 },
  ]) {
    await page.setViewport({ width: config.width, height: 900 });
    await page.evaluate(c => {
      document.documentElement.dataset.theme = c.theme;
      document.documentElement.style.setProperty('--editor-font-size', `${c.font}px`);
      window.__editor.setLineNumbers(c.numbers);
      window.__editor.setMode(c.mode);
    }, config);
    // 第 32 行标题、空行、任务、单行/多行提示块，以及多块后的正文；往返滚动。
    for (const n of [32, 33, 34, 37, 39, 40, 42, 44, 32]) await clickLine(n);
    console.log(`PASS 点击落点：${config.mode} / ${config.theme} / ${config.font}px / 行号${config.numbers}`);
  }
  await clickLine(33, 32);
  await page.keyboard.type('CURSOR_HIT');
  assert.equal(await page.evaluate(() => window.__editor.view.state.doc.line(33).text), 'CURSOR_HIT');
  await page.evaluate(() => window.__editor.flush());
  assert.equal(fs.readFileSync(path.join(VAULT, '点击定位.md'), 'utf8'), source.replace('已知限制）\n\n', '已知限制）\nCURSOR_HIT\n'));
  await page.keyboard.down('Control');
  await page.keyboard.press('z');
  await page.keyboard.up('Control');
  assert.equal(await page.evaluate(() => window.__editor.getContent()), source);
  console.log('PASS 空行真实输入、落盘与撤销');
  await clickLine(3, 7);
  const clip = await page.$eval('.cm-lp-callout-first', e => getComputedStyle(e).backgroundClip);
  assert.equal(clip, 'padding-box', '透明留白不能被类型配色覆盖');
  fs.mkdirSync(path.join(ROOT, 'dist/cursor-fix'), { recursive: true });
  await page.screenshot({ path: path.join(ROOT, 'dist/cursor-fix/callout.png') });
  assert.deepEqual(errors, [], '页面不应产生错误');
  console.log('PASS 提示块留白及页面错误检查');
} finally {
  await browser?.close();
  server.kill();
  // HOME 是本次 mkdtemp 创建的独占目录。
  try { fs.rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
  catch (e) { console.error('临时目录清理失败:', e.message); }
}
