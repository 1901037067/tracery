/**
 * engine-test.mjs — CM6 内核「真实 app」冒烟测试（P4-b）
 * ------------------------------------------------------------------
 * 与 cmlab 探针（纯引擎单页）不同，本套件驱动**真实 Tracery**：
 *   1. 启动服务器（独立端口 + 全新 mkdtemp 配置目录）；
 *   2. 在临时目录里自建一个小仓库（两篇笔记）并通过 /api/vault/open 打开
 *      —— **不写仓库里的 demo-vault**（它是服务端默认仓库，直接写会污染仓库）；
 *   3. 打开页面，确认编辑区里挂的是 CodeMirror 6（`.cm-editor`）；
 *   4. 打开笔记 → CM 实时预览装饰生效；
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
  '正文段落，含 [[双链与反链]] 与 #标签X 和 [[还不存在的新笔记]] 。',
  '',
  '## 二级标题',
  '',
  '```js',
  'const a = 1;',
  '```',
  '',
].join('\n'));
fs.writeFileSync(path.join(VAULT, '双链与反链.md'), '# 目标\n\n这里是目标笔记。\n');
fs.writeFileSync(path.join(VAULT, '任务.md'), '- [ ] 甲任务\n');

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

    await page.goto(`${BASE}`, { waitUntil: 'networkidle0' });
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
    check('app 正常启动', appVisible);

    // 2. 编辑区挂的是 CM6
    const dome = await page.evaluate(() => {
      const live = document.getElementById('editor-live');
      return {
        cmEditor: live.querySelectorAll('.cm-editor').length,
        cmContent: !!live.querySelector('.cm-content'),
        editableAttr: live.getAttribute('contenteditable'),
      };
    });
    check('编辑区挂载 CodeMirror 6', dome.cmEditor === 1 && dome.cmContent, JSON.stringify(dome));
    check('编辑区外层非 contenteditable', dome.editableAttr === 'false', JSON.stringify(dome));

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

    // 4b. 撤销 / 重做（CM history 在真实 app 下生效）
    const doc0 = await page.evaluate(() => window.__editor.getContent());
    await page.keyboard.down('Control'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Control');
    await sleep(500);
    const docUndo = await page.evaluate(() => window.__editor.getContent());
    // 重做用 Ctrl+Y（Ctrl+Shift+Z 会因 Shift 让 key 变大写 Z，CM 键名不匹配）
    await page.keyboard.down('Control'); await page.keyboard.press('KeyY'); await page.keyboard.up('Control');
    await sleep(500);
    const docRedo = await page.evaluate(() => window.__editor.getContent());
    check('cm 下 Ctrl+Z / Ctrl+Y 撤销且能重做', docUndo !== doc0 && docRedo === doc0,
      `undoChanged=${docUndo !== doc0} redoRestored=${docRedo === doc0}`);

    // 5. 模式按钮三态循环：实时预览 → 源码 → 阅读 → 实时预览（2026-10-19 起加了阅读模式）
    const before = await page.evaluate(async (note) => {
      const res = await fetch('/api/note?path=' + encodeURIComponent(note));
      return (await res.json()).content || '';
    }, NOTE);
    const countHeadDeco = () => page.evaluate(() => document.getElementById('editor-live').querySelectorAll('.cm-lp-h1, .cm-lp-h2, .cm-lp-h3').length);
    await page.evaluate(() => document.getElementById('btn-mode').click());   // → 源码
    await sleep(600);
    const src = await countHeadDeco();
    const modeLabel = await page.evaluate(() => document.getElementById('btn-mode-label')?.textContent || '');
    await page.evaluate(() => document.getElementById('btn-mode').click());   // → 阅读
    await sleep(600);
    const readLabel = await page.evaluate(() => document.getElementById('btn-mode-label')?.textContent || '');
    await page.evaluate(() => document.getElementById('btn-mode').click());   // → 实时预览
    await sleep(600);
    const backDeco = await countHeadDeco();
    check('模式按钮三态循环：源码（关装饰）→ 阅读 → 实时预览（恢复装饰）',
      src === 0 && modeLabel.includes('源码') && readLabel.includes('阅读') && backDeco >= 2,
      `src=${src} back=${backDeco} labels=${modeLabel}/${readLabel}`);
    check('切模式不改 doc（内容仍含标记行）', before.includes(MARKER));

    // 5c. 行号开关（设置面板 → compartment reconfigure）
    await page.keyboard.down('Control'); await page.keyboard.press(','); await page.keyboard.up('Control');
    await sleep(500);
    await page.evaluate(() => document.querySelector('.switch[data-toggle="lineNumbers"]')?.click());
    await sleep(500);
    const linesOff = await page.evaluate(() => document.getElementById('editor-live').querySelectorAll('.cm-lineNumbers').length);
    await page.evaluate(() => document.querySelector('.switch[data-toggle="lineNumbers"]')?.click());
    await sleep(500);
    const linesOn = await page.evaluate(() => document.getElementById('editor-live').querySelectorAll('.cm-lineNumbers').length);
    await page.keyboard.press('Escape');
    await sleep(400);
    check('cm 下行号开关（设置面板 compartment）', linesOff === 0 && linesOn === 1, `off=${linesOff} on=${linesOn}`);

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

    // 7b. 真实鼠标点击（回归真实交互链路，不是合成 el.click()）：mousedown 会先把光标落到
    //     该行 → 「光标行露原始语法」的装饰规则随即拆掉 .cm-lp-wikilink span → 紧接着的
    //     click 找不到 span ——这就是「用鼠标点双链毫无反应」的根因，已在 linkEvents 里拦 mousedown。
    await page.evaluate(() => {
      [...document.querySelectorAll('#file-tree .tree-item')].find((i) => i.textContent.includes('测试笔记'))?.click();
    });
    await sleep(1000);
    const linkBox = await page.evaluate(() => {
      const span = [...document.querySelectorAll('#editor-live .cm-lp-wikilink')]
        .find((s) => s.textContent.includes('双链与反链'));
      if (!span) return null;
      const r = span.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    if (linkBox) { await page.mouse.click(linkBox.x, linkBox.y); await sleep(1000); }
    const realNav = await page.evaluate(() => document.getElementById('note-path')?.textContent || '');
    check('真实鼠标点击 [[双链]] 也能跳转', !!linkBox && realNav.includes('双链与反链'), `box=${!!linkBox} path=${realNav}`);

    // 7c. 点「还不存在的笔记」的双链 → 灰虚线 + 问一句就当场创建（demo-vault/双链与反链.md 承诺的行为）
    await page.evaluate(() => {
      [...document.querySelectorAll('#file-tree .tree-item')].find((i) => i.textContent.includes('测试笔记'))?.click();
    });
    await sleep(1000);
    const unLink = await page.evaluate(() => {
      const span = [...document.querySelectorAll('#editor-live .cm-lp-wikilink')]
        .find((s) => s.textContent.includes('还不存在的新笔记'));
      if (!span) return null;
      const r = span.getBoundingClientRect();
      const cs = getComputedStyle(span);
      return {
        x: r.left + r.width / 2, y: r.top + r.height / 2,
        unresolved: span.classList.contains('cm-lp-unresolved'),
        borderStyle: cs.borderBottomStyle, color: cs.color,
      };
    });
    check('未解析的双链显示为灰色虚线',
      !!unLink && unLink.unresolved && unLink.borderStyle === 'dashed',
      JSON.stringify(unLink));
    if (unLink) { await page.mouse.click(unLink.x, unLink.y); }
    await sleep(600);
    const askCreate = await page.evaluate(() => {
      const d = document.querySelector('.dialog-backdrop');
      return d && !d.hidden ? d.querySelector('.dialog-title').textContent : null;
    });
    check('点未解析双链会问「要不要当场创建」',
      !!askCreate && askCreate.includes('还不存在的新笔记'), String(askCreate));
    await page.evaluate(() => document.querySelector('.dialog-ok')?.click());
    await sleep(1500);
    const created = await page.evaluate(() => ({
      path: document.getElementById('note-path')?.textContent || '',
      inTree: !!document.querySelector('#file-tree .tree-item[data-path="还不存在的新笔记.md"]'),
    }));
    check('确认后当场创建并打开这篇笔记',
      created.path.includes('还不存在的新笔记') && created.inTree, JSON.stringify(created));

    // 8. Enter 续任务列表（P2 keymap 在真实 app 下生效）
    await page.evaluate(() => {
      [...document.querySelectorAll('#file-tree .tree-item')].find((i) => i.textContent.includes('任务'))?.click();
    });
    await sleep(900);
    // 光标直接落到任务行末：.cm-content 下沿有 40vh 空白内边距（供滚过文末），
    // 点击其几何中心会落进空白里的末行，Enter 就不再「续任务列表」了。
    await page.evaluate(() => {
      const ed = window.__editor;
      ed.view.dispatch({ selection: { anchor: ed.view.state.doc.line(1).to } });
      ed.view.focus();
    });
    await page.keyboard.press('Enter');
    await sleep(500);
    const taskDoc = await page.evaluate(() => window.__editor.getContent());
    check('cm 下 Enter 续任务列表（- [ ] ）', /- \[ \] 甲任务\n- \[ \] /.test(taskDoc), JSON.stringify(taskDoc));

    // 9. 阅读模式（2026-10-19 新增）：只读 + 全量渲染（剥掉源码标记）+ 任务勾选 + 双链跳转
    //    模式按钮三态循环：实时预览 → 源码 → 阅读，所以点两次到阅读
    await page.evaluate(() => document.getElementById('btn-mode').click());
    await sleep(300);
    await page.evaluate(() => document.getElementById('btn-mode').click());
    await sleep(700);
    const readMode = await page.evaluate(() => {
      const ed = window.__editor;
      const taskLine = [...document.querySelectorAll('#editor-live .cm-line')].find((l) => l.textContent.includes('甲任务'));
      return {
        mode: ed.mode,
        label: document.getElementById('btn-mode-label').textContent,
        editable: document.querySelector('#editor-live .cm-content').getAttribute('contenteditable'),
        gutter: document.querySelectorAll('#editor-live .cm-lineNumbers .cm-gutterElement').length,
        taskDash: (taskLine ? taskLine.textContent : '').includes('-'),
        taskCb: taskLine ? taskLine.querySelectorAll('input.cm-lp-cb').length : 0,
      };
    });
    check('阅读模式：只读 + 无行号 + 剥掉源码标记（任务项只剩复选框）',
      readMode.mode === 'read' && readMode.label === '阅读' && readMode.editable === 'false'
      && readMode.gutter === 0 && readMode.taskCb === 1 && !readMode.taskDash,
      JSON.stringify(readMode));

    const mdBeforeRead = await page.evaluate(() => window.__editor.getContent());
    await page.evaluate(() => document.getElementById('editor-live').click());
    await page.keyboard.type('ZZZ');
    await sleep(300);
    check('阅读模式敲键盘不改内容', mdBeforeRead === (await page.evaluate(() => window.__editor.getContent())));

    const readToggle = await page.evaluate(async () => {
      const cb = document.querySelector('#editor-live input.cm-lp-cb');
      if (!cb) return false;
      cb.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 250));
      return true;
    });
    await sleep(300);
    check('阅读模式下任务框仍可勾选（改的是 doc，不是光标）',
      readToggle && /- \[[xX]\] 甲任务/.test(await page.evaluate(() => window.__editor.getContent())),
      await page.evaluate(() => window.__editor.getContent()));

    // 阅读模式下点双链：既要跳过去，又要**留在阅读模式**（换笔记不把模式弹回实时预览）
    await page.evaluate(() => {
      [...document.querySelectorAll('#file-tree .tree-item')].find((i) => i.textContent.includes('测试笔记'))?.click();
    });
    await sleep(1000);
    const linkBoxRead = await page.evaluate(() => {
      const span = [...document.querySelectorAll('#editor-live .cm-lp-wikilink')].find((s) => s.textContent.includes('双链与反链'));
      if (!span) return null;
      const r = span.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    if (linkBoxRead) { await page.mouse.click(linkBoxRead.x, linkBoxRead.y); await sleep(1000); }
    const afterReadNav = await page.evaluate(() => ({
      path: document.getElementById('note-path')?.textContent || '',
      mode: window.__editor.mode,
      label: document.getElementById('btn-mode-label').textContent,
    }));
    check('阅读模式下点双链跳转且保持阅读模式',
      !!linkBoxRead && afterReadNav.path.includes('双链与反链') && afterReadNav.mode === 'read',
      JSON.stringify(afterReadNav));

    // 收尾：切回实时预览，免得影响后面的截图
    await page.evaluate(() => { window.__editor.setMode('live'); });
    await sleep(300);

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
