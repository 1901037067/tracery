/**
 * engine-test.mjs — CM6 内核「真实 app」冒烟测试（P4-b1）
 * ------------------------------------------------------------------
 * 与 cmlab 探针（纯引擎单页）不同，本套件驱动**真实 Tracery**：
 *   1. 启动服务器（独立端口 + 全新临时配置目录 → 自动打开展示仓库 demo-vault）；
 *   2. 用 `?engine=cm` 打开页面，确认编辑区里挂的是 CodeMirror 6（`.cm-editor`）；
 *   3. 打开一篇笔记 → CM 实时预览装饰生效（标题行装饰等），且旧块级 DOM 不出现；
 *   4. 真实键盘输入 → 等自动保存 → 用 API 校验内容落盘；
 *   5. 切源码模式 → 装饰关闭、doc 不变 → 切回；
 *   6. 无页面错误。
 * 运行: npm run test:engine
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 9597;                       // 不占 e2e 的 9598 / dev 的 9520
const BASE = `http://localhost:${PORT}`;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const HOME = path.join(process.env.TEMP || '/tmp', 'tracery-engine-home');
const MARKER = 'TRACERY_CM_SMOKE_LINE';

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${extra ? '  — ' + extra : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function typeText(page, text) {
  for (const ch of text) {
    if (ch === '\n') { await page.keyboard.press('Enter'); continue; }
    if (ch === ' ') { await page.keyboard.press('Space'); continue; }
    const upper = ch === ch.toUpperCase() && ch !== ch.toLowerCase();
    if (upper) await page.keyboard.down('Shift');
    await page.keyboard.press(/[A-Z]/.test(ch) ? `Key${ch.toUpperCase()}` : /[0-9]/.test(ch) ? `Digit${ch}` : ch);
    if (upper) await page.keyboard.up('Shift');
  }
}

async function waitForServer(url, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { if ((await fetch(`${url}/api/state`)).ok) return; } catch { /* retry */ }
    await sleep(300);
  }
  throw new Error('服务器启动超时');
}

let exitCode = 0;
const browserErrors = [];
let server;

async function main() {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });

  server = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), TRACERY_HOME: HOME },
    stdio: 'pipe',
  });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  await waitForServer(BASE);

  const browser = await puppeteer.launch({
    executablePath: EDGE, headless: 'new',
    defaultViewport: { width: 1440, height: 900 },
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-color-profile=srgb'],
  });
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => browserErrors.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') browserErrors.push('console: ' + m.text()); });

    await page.goto(`${BASE}/?engine=cm`, { waitUntil: 'networkidle0' });
    await sleep(900);

    // 1. app 起来
    const appVisible = await page.evaluate(() => !document.getElementById('app').hidden);
    check('?engine=cm 下 app 正常启动', appVisible);

    // 2. 编辑区挂的是 CM6，且旧块级 DOM 不出现
    const dome = await page.evaluate(() => {
      const live = document.getElementById('editor-live');
      return {
        cmEditor: live.querySelectorAll('.cm-editor').length,
        cmContent: !!live.querySelector('.cm-content'),
        editableAttr: live.getAttribute('contenteditable'),
        sourceWrapHidden: document.getElementById('source-wrap')?.hidden === true,
        blankBlocks: live.querySelectorAll('.md-blank').length,
      };
    });
    check('编辑区挂载 CodeMirror 6', dome.cmEditor === 1 && dome.cmContent, JSON.stringify(dome));
    check('cm 模式收尾：外层非 contenteditable / 源码区隐藏 / 无块级占位段',
      dome.editableAttr === 'false' && dome.sourceWrapHidden && dome.blankBlocks === 0, JSON.stringify(dome));

    // 3. 打开笔记 → CM 实时预览装饰生效
    await page.evaluate(() => {
      [...document.querySelectorAll('#file-tree .tree-item')].find((i) => i.textContent.includes('Markdown 语法'))?.click();
    });
    await sleep(900);
    const deco = await page.evaluate(() => {
      const live = document.getElementById('editor-live');
      return {
        headingLines: live.querySelectorAll('.cm-lp-h1, .cm-lp-h2, .cm-lp-h3').length,
        lines: live.querySelectorAll('.cm-line').length,
        notePath: document.getElementById('note-path')?.textContent || '',
      };
    });
    check('打开笔记后 CM 行级渲染 + 标题行装饰', deco.headingLines >= 1 && deco.lines > 5, JSON.stringify(deco));

    // 4. 真实键盘输入 → 自动保存 → API 校验
    await page.evaluate(() => { document.querySelector('#editor-live .cm-content')?.focus(); });
    await page.click('#editor-live .cm-content');
    await page.keyboard.down('Control'); await page.keyboard.press('End'); await page.keyboard.up('Control');
    await typeText(page, `\n\n${MARKER}`);
    await sleep(1800);   // 自动保存（900ms 防抖 + 余量）
    const saved = await page.evaluate(async (mk) => {
      const res = await fetch('/api/note?path=' + encodeURIComponent('Markdown 语法.md'));
      const data = await res.json();
      return (data.content || '').includes(mk);
    }, MARKER);
    check('CM 键盘输入后自动保存到磁盘', saved);

    // 5. 切源码模式 = 关装饰、doc 不变；切回
    const before = await page.evaluate(async () => {
      const res = await fetch('/api/note?path=' + encodeURIComponent('Markdown 语法.md'));
      return (await res.json()).content || '';
    });
    await page.evaluate(() => document.getElementById('btn-mode').click());
    await sleep(600);
    const src = await page.evaluate(() => document.getElementById('editor-live').querySelectorAll('.cm-lp-h1, .cm-lp-h2, .cm-lp-h3').length);
    const modeLabel = await page.evaluate(() => document.getElementById('btn-mode-label')?.textContent || '');
    await page.evaluate(() => document.getElementById('btn-mode').click());
    await sleep(600);
    const backDeco = await page.evaluate(() => document.getElementById('editor-live').querySelectorAll('.cm-lp-h1, .cm-lp-h2, .cm-lp-h3').length);
    check('源码模式关掉装饰、切回恢复', src === 0 && backDeco >= 1 && modeLabel.includes('源码'), `src=${src} back=${backDeco} label=${modeLabel}`);
    check('切模式不改 doc（内容仍含标记行）', before.includes(MARKER));

    // 清理
    await page.evaluate(async (mk) => {
      const res = await fetch('/api/note?path=' + encodeURIComponent('Markdown 语法.md'));
      const { content } = await res.json();
      await fetch('/api/note', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'Markdown 语法.md', content: content.replace(new RegExp('\\n*' + mk, 'g'), '') }),
      });
    }, MARKER);

    await page.screenshot({ path: path.join(__dirname, 'screenshots', 'p4-cm-app.png') });

    const autoOk = results.every((r) => r.ok);
    console.log(`\n总体: ${autoOk ? '全过' : '有失败'} · 页面错误 ${browserErrors.length === 0 ? '无' : '有!'}`);
    if (browserErrors.length) console.log(browserErrors.slice(0, 10).join('\n'));
    if (!autoOk || browserErrors.length) exitCode = 1;
  } catch (err) {
    console.error('运行器异常:', err);
    exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().finally(() => {
  if (server) server.kill();
  fs.rmSync(HOME, { recursive: true, force: true });
  process.exit(exitCode);
});
