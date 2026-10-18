/**
 * 编辑区右键菜单 + 左侧栏折叠回归
 * ------------------------------------------------------------------
 * 2026-10-17 用户反馈：① 编辑区没有右键菜单（仿 Obsidian 的文本/图片菜单）
 * ② 左侧栏折叠按钮失效（按钮从 .titlebar-right 挪到 .titlebar-left 后
 *    丢了 no-drag，点击被当成拖窗口）。
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ENGINE, IS_CM, engineUrl, setCaretOnLineContaining } from './_engine-helpers.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 9596;
const HOME = path.join(process.env.TEMP || '/tmp', 'tracery-menu-home');
const VAULT = path.join(HOME, 'vault');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(path.join(VAULT, '附件'), { recursive: true });
// 1x1 PNG（最小有效图片）
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
fs.writeFileSync(path.join(VAULT, '附件', 'pic.png'), PNG);
// 最小 PDF（内容不重要：验证的是「点 PDF 打开阅读器浮层」这条链路）
fs.writeFileSync(path.join(VAULT, '说明文档.pdf'), [
  '%PDF-1.4',
  '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj',
  'trailer<</Root 1 0 R>>',
  '%%EOF',
].join('\n'), 'utf8');
fs.writeFileSync(path.join(VAULT, '菜单测试.md'), [
  '# 标题',
  '',
  '第一行文字',
  '',
  '![小图](附件/pic.png)',
  '',
  '![[附件/pic.png|120]]',
  '',
  '结尾段落',
  '',
].join('\n'), 'utf8');

const server = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), TRACERY_HOME: HOME },
  stdio: 'pipe',
});
for (let i = 0; i < 40; i++) {
  try { if ((await fetch(`http://localhost:${PORT}/api/state`)).ok) break; } catch { /* wait */ }
  await sleep(250);
}
const browser = await puppeteer.launch({
  executablePath: EDGE, headless: 'new', args: ['--no-sandbox'],
  defaultViewport: { width: 1280, height: 860 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const log = [];
const check = (name, ok, detail = '') => {
  log.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
};

await page.goto(engineUrl(`http://localhost:${PORT}`), { waitUntil: 'networkidle0' });   // 内核由 TRACERY_TEST_ENGINE 决定（默认 block）
console.log(`[menu] 内核：${ENGINE}`);
await sleep(1200);
await page.evaluate(async (vp) => {
  await fetch('/api/vault/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: vp }) });
}, VAULT.replace(/\\/g, '/'));
await sleep(1500);
await page.evaluate(() => document.querySelector('[data-path="菜单测试.md"]')?.click());
await sleep(900);

const NOTE = path.join(VAULT, '菜单测试.md');
// 实时预览模式下 #editor-source 不同步，直接读磁盘（顺带验证真的落盘）
const mdOf = async () => { await sleep(1400); return fs.readFileSync(NOTE, 'utf8'); };
// 菜单项现在是「图标 + 标签 + 快捷键提示」三段，取标签那一段
const menuItems = () => page.evaluate(() => [...document.querySelectorAll('.context-menu button')]
  .map((b) => (b.querySelector('.mi-label')?.textContent || b.textContent).trim()));
const clickMenuItem = async (label) => {
  const ok = await page.evaluate((l) => {
    const btn = [...document.querySelectorAll('.context-menu button')].find((b) => b.textContent.includes(l));
    if (!btn) return false;
    btn.click();
    return true;
  }, label);
  await sleep(500);
  return ok;
};
/** 在某个元素里右键 */
const rightClickOn = async (selector) => {
  const box = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + Math.min(40, r.width / 2), y: r.top + Math.min(16, r.height / 2) };
  }, selector);
  if (!box) throw new Error(`没找到 ${selector}`);
  await page.mouse.click(box.x, box.y, { button: 'right' });
  await sleep(400);
};
/** 在「含指定文字的行」上右键（块级 p / cm .cm-line） */
const rightClickTextLine = async (text) => {
  const sel = IS_CM ? '#editor-live .cm-line' : '#editor-live p:not(.md-blank)';
  const box = await page.evaluate(({ s, t }) => {
    const el = [...document.querySelectorAll(s)].find((x) => x.textContent.includes(t));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + Math.min(40, r.width / 2), y: r.top + Math.min(10, r.height / 2) };
  }, { s: sel, t: text });
  if (!box) throw new Error(`没找到含「${text}」的行`);
  await page.mouse.click(box.x, box.y, { button: 'right' });
  await sleep(400);
};

/* ---------- ① 文本右键菜单 ---------- */
// 注意选 :not(.md-blank)：空行现在是真实的一行高度，也能点/能右键，
// 用裸 p 会先命中标题下面那条空行
// cm：右键不会移动 CM 的光标（只在 state 里），「标题 1」按光标所在行执行 → 先把光标放好
await setCaretOnLineContaining(page, '第一行文字');
await rightClickTextLine('第一行文字');
const textItems = await menuItems();
check('文字右键 → 菜单出现且项齐全',
  ['新增链接', '新增外部链接', '加粗', '标题 1', '插入表格', '剪切', '复制', '粘贴', '全选'].every((l) => textItems.includes(l)),
  textItems.join(' / '));

// 标题 1：右键落在「第一行文字」上 → 变成 # 第一行文字
await clickMenuItem('标题 1');
let md = await mdOf();
check('「标题 1」把当前行转成标题', md.includes('# 第一行文字'), JSON.stringify(md.slice(0, 60)));

// 加粗：先选中文字，再在选区中心右键（选区内的右键必须保住选区）
let selCenter;
if (IS_CM) {
  // cm：在 view.state 里按偏移设选区（h1 行的「第一行文字」前 3 个字），
  // 右键不动 CM 选区 → 菜单的「加粗」读的仍是这个选区
  selCenter = await page.evaluate(() => {
    const ed = window.__editor;
    const doc = ed.view.state.doc;
    for (let n = 1; n <= doc.lines; n++) {
      const line = doc.line(n);
      const i = line.text.indexOf('第一行文字');
      if (i >= 0) {
        const from = line.from + i;
        ed.view.dispatch({ selection: { anchor: from, head: from + 3 } });
        ed.view.focus();
        // 用 CM 的字符坐标算点击点（落在选区内，右键才不会收拢选区）
        const c = ed.view.coordsAtPos(from + 1);
        return { x: (c.left + c.right) / 2 || c.left + 6, y: (c.top + c.bottom) / 2 };
      }
    }
    return null;
  });
} else {
  selCenter = await page.evaluate(() => {
    const p = document.querySelector('#editor-live h1:last-of-type');
    const tn = document.createTreeWalker(p, NodeFilter.SHOW_TEXT).nextNode();
    const r = document.createRange();
    r.setStart(tn, 0);
    r.setEnd(tn, Math.min(3, tn.textContent.length));
    const s = getSelection();
    s.removeAllRanges(); s.addRange(r);
    const rect = r.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
}
if (!selCenter) throw new Error('找不到用于加粗的选区位置');
await page.mouse.click(selCenter.x, selCenter.y, { button: 'right' });
await sleep(400);
await clickMenuItem('加粗');
md = await mdOf();
check('「加粗」给选中文字加 ** **', md.includes('**第一行**') || md.includes('**第一行文字**'), JSON.stringify(md.split('\n').slice(0, 4)));

/* ---------- ② 图片右键菜单 ---------- */
// cm 下 `![[..]]` 由 widget 渲染（.cm-lp-img img）；块级下第一张是 markdown 图片 `![小图](...)`
await rightClickOn(IS_CM ? '#editor-live .cm-lp-img img' : '#editor-live img');
const imgItems = await menuItems();
check('图片右键 → 图片菜单',
  ['复制图片', '查看大图', '复制路径', '移除图片', '删除图片文件'].every((l) => imgItems.includes(l)),
  imgItems.join(' / '));

const beforeImg = await mdOf();
await clickMenuItem('移除图片');
const afterImg = await mdOf();
const imgMark = IS_CM ? '![[附件/pic.png|120]]' : '![小图](附件/pic.png)';
check('「移除图片」从正文删掉图片标记',
  beforeImg.includes(imgMark) && !afterImg.includes(imgMark),
  JSON.stringify(afterImg.split('\n').filter(Boolean)));

/* ---------- ③ 左侧栏折叠按钮（回归：挪位置后点击失效） ---------- */
const toggleState = async () => page.evaluate(() => document.getElementById('sidebar').classList.contains('collapsed'));
const toggleBox = await page.evaluate(() => {
  const b = document.getElementById('btn-toggle-left').getBoundingClientRect();
  return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
});
await page.mouse.click(toggleBox.x, toggleBox.y);
await sleep(500);
const collapsed = await toggleState();
await page.mouse.click(toggleBox.x, toggleBox.y);
await sleep(500);
const expanded = await toggleState();
check('左侧栏折叠按钮可收起/展开', collapsed === true && expanded === false, `collapsed=${collapsed} expanded=${expanded}`);

/* ---------- ④ PDF 查看器 ---------- */
await page.evaluate(() => document.querySelector('[data-path="说明文档.pdf"]')?.click());
await sleep(800);
const pdf = await page.evaluate(() => ({
  open: !!document.querySelector('.pdf-viewer') && !document.querySelector('.pdf-viewer').hidden,
  title: document.querySelector('.pdf-title')?.textContent || '',
  src: document.querySelector('.pdf-frame')?.getAttribute('src') || '',
}));
check('点 PDF → 打开应用内阅读器浮层',
  pdf.open && pdf.title === '说明文档.pdf' && decodeURIComponent(pdf.src).includes('说明文档.pdf'),
  JSON.stringify(pdf));
await page.keyboard.press('Escape');
await sleep(400);
check('Esc 关闭 PDF 浮层', await page.evaluate(() => document.querySelector('.pdf-viewer').hidden));

/* ---------- ⑤ 文件树右键菜单（Obsidian 式） ---------- */
const fileMenu = await page.evaluate(async () => {
  const item = document.querySelector('#file-tree .tree-item[data-path="菜单测试.md"]');
  const r = item.getBoundingClientRect();
  item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 20, clientY: r.top + 8 }));
  await new Promise((res) => setTimeout(res, 300));
  return [...document.querySelectorAll('.context-menu button')]
    .map((b) => (b.querySelector('.mi-label')?.textContent || b.textContent).trim());
});
check('文件树右键 → 菜单项齐全（打开/副本/路径/重命名/删除）',
  ['在新标签页中打开', '创建副本', '复制路径', '复制相对路径', '重命名', '删除'].every((l) => fileMenu.includes(l)),
  fileMenu.join(' / '));
await page.keyboard.press('Escape');
await page.evaluate(() => document.querySelector('.context-menu')?.remove());

check('无渲染错误', errors.length === 0, errors.join(' | '));

await browser.close();
server.kill();
fs.rmSync(HOME, { recursive: true, force: true });
console.log('\n' + log.join('\n'));
process.exit(log.some((l) => l.startsWith('FAIL')) ? 1 : 0);
