/**
 * engine-test.mjs — CM6 内核「真实 app」冒烟测试（P4-b）
 * ------------------------------------------------------------------
 * 与 cmlab 探针（纯引擎单页）不同，本套件驱动**真实 Tracery**：
 *   1. 启动服务器（独立端口 + 全新 mkdtemp 配置目录）；
 *   2. 在临时目录里自建一个小仓库（两篇笔记）并通过 /api/vault/open 打开
 *      —— **不写仓库里的 demo-vault**（它是服务端默认仓库，直接写会污染仓库）；
 *   3. 用 `?engine=cm` 打开页面，确认编辑区里挂的是 CodeMirror 6（`.cm-editor`）；
 *   4. 打开笔记 → CM 实时预览装饰生效，且旧块级 DOM 不出现；
 *   5. 真实键盘输入 → 等自动保存 → 用 API 校验内容落盘；
 *   6. 切源码模式（装饰关闭、doc 不变）→ 切回；粘贴附件（拦截→落盘→回插 ![[..]]）；
 *      点 [[双链]] 跳转目标笔记；
 *   7. 无页面错误。
 * 运行: npm run test:engine
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 9597;                       // 不占 e2e 的 9598 / dev 的 9520
const BASE = `http://localhost:${PORT}`;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tracery-engine-'));
const VAULT = path.join(HOME, 'vault');
const NOTE = '测试笔记.md';
const MARKER = 'TRACERY_CM_SMOKE_LINE';

// 自建临时仓库（不入库 demo-vault）
fs.mkdirSync(VAULT, { recursive: true });
fs.writeFileSync(path.join(VAULT, NOTE), [
  '# 标题甲',
  '',
  '正文段落，含 [[双链与反链]] 与 #标签X 。',
  '',
  '## 二级标题',
  '',
  '```js',
  'const a = 1;',
  '```',
  '',
].join('\n'));
fs.writeFileSync(path.join(VAULT, '双链与反链.md'), '# 目标\n\n这里是目标笔记。\n');

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
    // 打开自建临时仓库（避免写仓库里的 demo-vault），然后重载让文件树就位
    await page.evaluate(async (vp) => {
      await fetch('/api/vault/open', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: vp }),
      });
    }, VAULT.replace(/\\/g, '/'));
    await page.reload({ waitUntil: 'networkidle0' });
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
    await page.evaluate((nm) => {
      [...document.querySelectorAll('#file-tree .tree-item')].find((i) => i.textContent.includes(nm.replace(/\.md$/, '')))?.click();
    }, NOTE);
    await sleep(900);
    const deco = await page.evaluate(() => {
      const live = document.getElementById('editor-live');
      return {
        headingLines: live.querySelectorAll('.cm-lp-h1, .cm-lp-h2, .cm-lp-h3').length,
        lines: live.querySelectorAll('.cm-line').length,
        notePath: document.getElementById('note-path')?.textContent || '',
      };
    });
    check('打开笔记后 CM 行级渲染 + 标题行装饰', deco.headingLines >= 2 && deco.lines > 5 && deco.notePath.includes('测试笔记'),
      JSON.stringify(deco));

    // 4. 真实键盘输入 → 自动保存 → API 校验
    await page.click('#editor-live .cm-content');
    await page.keyboard.down('Control'); await page.keyboard.press('End'); await page.keyboard.up('Control');
    await typeText(page, `\n\n${MARKER}`);
    await sleep(1800);   // 自动保存（900ms 防抖 + 余量）
    const saved = await page.evaluate(async (a) => {
      const res = await fetch('/api/note?path=' + encodeURIComponent(a.note));
      const data = await res.json();
      return (data.content || '').includes(a.mk);
    }, { note: NOTE, mk: MARKER });
    check('CM 键盘输入后自动保存到磁盘', saved);

    // 5. 切源码模式 = 关装饰、doc 不变；切回
    const before = await page.evaluate(async (note) => {
      const res = await fetch('/api/note?path=' + encodeURIComponent(note));
      return (await res.json()).content || '';
    }, NOTE);
    await page.evaluate(() => document.getElementById('btn-mode').click());
    await sleep(600);
    const src = await page.evaluate(() => document.getElementById('editor-live').querySelectorAll('.cm-lp-h1, .cm-lp-h2, .cm-lp-h3').length);
    const modeLabel = await page.evaluate(() => document.getElementById('btn-mode-label')?.textContent || '');
    await page.evaluate(() => document.getElementById('btn-mode').click());
    await sleep(600);
    const backDeco = await page.evaluate(() => document.getElementById('editor-live').querySelectorAll('.cm-lp-h1, .cm-lp-h2, .cm-lp-h3').length);
    check('源码模式关掉装饰、切回恢复', src === 0 && backDeco >= 2 && modeLabel.includes('源码'), `src=${src} back=${backDeco} label=${modeLabel}`);
    check('切模式不改 doc（内容仍含标记行）', before.includes(MARKER));

    // 6. 附件粘贴：cm 拦截 → 落盘 → 回插 ![[..]]
    const pasteRes = await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'cm-smoke.png', { type: 'image/png' }));
      const ev = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'clipboardData', { value: dt });
      const target = document.querySelector('#editor-live .cm-content');
      target.dispatchEvent(ev);
      return { prevented: ev.defaultPrevented, items: dt.items.length };
    });
    await sleep(1800);
    const assetOk = await page.evaluate(async (note) => {
      const { content } = await (await fetch('/api/note?path=' + encodeURIComponent(note))).json();
      const m = /!\[\[([^\]]*cm-smoke[^\]]*)\]\]/.exec(content || '');
      if (!m) return { ok: false, tail: (content || '').slice(-60) };
      const f = await fetch('/api/file?path=' + encodeURIComponent(m[1]));
      return { ok: f.ok, path: m[1], count: (content.match(/!\[\[[^\]]*cm-smoke[^\]]*\]\]/g) || []).length };
    }, NOTE);
    check('cm 下粘贴附件：拦截 → 落盘 → 回插 ![[..]]（且只插一次）',
      assetOk.ok && assetOk.count === 1 && pasteRes.prevented, JSON.stringify({ ...assetOk, pasteRes }));

    // 7. 双链点击跳转（cm 行内 span + linkEvents → onNavigate → openNote）
    const clicked = await page.evaluate(() => {
      const span = [...document.querySelectorAll('#editor-live .cm-lp-wikilink')]
        .find((s) => s.textContent.includes('双链与反链'));
      if (!span) return false;
      span.click();
      return true;
    });
    await sleep(900);
    const navPath = await page.evaluate(() => document.getElementById('note-path')?.textContent || '');
    check('cm 下点击 [[双链]] 跳转到目标笔记', clicked && navPath.includes('双链与反链'), `clicked=${clicked} path=${navPath}`);

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
