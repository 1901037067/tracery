/**
 * 编辑器回车行为回归（实时预览模式）
 * ------------------------------------------------------------------
 * 2026-10-17 用户报告「回车换行有 bug」。复现发现两个真 bug：
 *   ① 渲染器跳过行尾空行 → 段尾回车插入的 \n 在 DOM 里不存在，
 *      下次输入序列化时被吃掉（实测：段尾打 abc→回车→打 def 落盘成 "abcdef" 一行）
 *   ② domPointToMd 的 DOM 偏移不数 <br>，inlineMapOffset 却数——
 *      含软换行的段落里光标映射整体偏移（实测：行尾回车把 "Xef" 从中间拆开）
 * 本套件用真实键盘驱动锁死这些场景，防回归。
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ENGINE, IS_CM, engineUrl, setCaretAtOffset } from './_engine-helpers.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 9597;
const HOME = path.join(process.env.TEMP || '/tmp', 'tracery-enter-home');
const VAULT = path.join(HOME, 'vault');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(VAULT, { recursive: true });

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
console.log(`[enter] 内核：${ENGINE}`);
await sleep(1200);

/** 写一篇笔记并打开，返回文件绝对路径 */
async function openNote(name, content) {
  const abs = path.join(VAULT, name);
  fs.writeFileSync(abs, content, 'utf8');
  await page.evaluate(async (vp) => {
    await fetch('/api/vault/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: vp }) });
  }, VAULT.replace(/\\/g, '/'));
  await sleep(1400);
  await page.evaluate((p) => document.querySelector(`[data-path="${p}"]`)?.click(), name);
  await sleep(1000);
  return abs;
}
/** 把光标放到指定选择器最后一个（可带文字过滤）匹配元素的末尾 */
async function caretAtEndOf(selector, textFilter = '') {
  await page.evaluate(({ sel, filter }) => {
    const els = [...document.querySelectorAll(`#editor-live ${sel}`)]
      .filter((el) => el.textContent.trim() && (!filter || el.textContent.includes(filter)));
    const last = els[els.length - 1];
    if (!last) throw new Error(`没有匹配 ${sel}${filter ? ' 含「' + filter + '」' : ''} 的元素`);
    const r = document.createRange();
    r.selectNodeContents(last); r.collapse(false);
    const s = getSelection();
    s.removeAllRanges(); s.addRange(r);
    document.getElementById('editor-live').focus();
  }, { sel: selector, filter: textFilter });
}
/** 把光标放到最后一个「有文字的 p」内第一个文本节点的 offset 处 */
async function caretAtTextOffset(off) {
  await page.evaluate((o) => {
    const ps = [...document.querySelectorAll('#editor-live p')].filter((p) => p.textContent.trim());
    const last = ps[ps.length - 1];
    const tn = document.createTreeWalker(last, NodeFilter.SHOW_TEXT).nextNode();
    const r = document.createRange();
    r.setStart(tn, o); r.collapse(true);
    const sel = getSelection();
    sel.removeAllRanges(); sel.addRange(r);
    document.getElementById('editor-live').focus();
  }, off);
}
async function readNote(abs) {
  await sleep(1500); // 等自动保存（900ms 防抖 + 余量）
  return fs.readFileSync(abs, 'utf8');
}
/** 当前场景的笔记原文：cm 分支用它算「按 md 偏移放光标」（块级仍走 DOM 定位） */
let cur = '';
/** 光标 → 原文里某段文本的末尾。cm：md 偏移；块级：DOM 选择器最后一个匹配元素末尾 */
async function caretEndOf(snippet, blockSel, filter = '') {
  if (IS_CM) await setCaretAtOffset(page, cur.indexOf(snippet) + snippet.length);
  else await caretAtEndOf(blockSel, filter);
}
/** 光标 → 原文里某段文本的第 k 个字符处。cm：md 偏移；块级：DOM 文本节点偏移 */
async function caretMidOf(snippet, k) {
  if (IS_CM) await setCaretAtOffset(page, cur.indexOf(snippet) + k);
  else await caretAtTextOffset(k);
}

/* ---------- ① 段尾回车续打：必须落到新段落（曾经的 bug：\n 被吃掉） ---------- */
cur = '# 测试\n\n第一段\n';
let abs = await openNote('场景一.md', cur);
await caretEndOf('第一段', 'p');
await page.keyboard.type('abc');
await page.keyboard.press('Enter');
await page.keyboard.type('def');
check('段尾回车后续打 → 新行接住输入（不吞字）', (await readNote(abs)) === '# 测试\n\n第一段abc\ndef\n', JSON.stringify(await readNote(abs)));

/* ---------- ② 行中回车：在光标处拆行 ---------- */
cur = '# 测试\n\nabcdef\n';
abs = await openNote('场景二.md', cur);
await caretMidOf('abcdef', 2);
await page.keyboard.press('Enter');
await page.keyboard.type('X');
// 末尾只有一个 \n：文件本来就以换行结尾，序列化原样保留（不再多补一个）
check('行中回车 → 光标处拆行', (await readNote(abs)) === '# 测试\n\nab\nXcdef\n', JSON.stringify(await readNote(abs)));

/* ---------- ③ 连续回车：空行上继续回车，打字落在空行 ---------- */
cur = '# 测试\n\n甲乙丙\n';
abs = await openNote('场景三.md', cur);
await caretEndOf('甲乙丙', 'p');
await page.keyboard.press('Enter');
await page.keyboard.press('Enter');
await page.keyboard.type('Z');
check('连续回车后打字 → 落在空行上', (await readNote(abs)) === '# 测试\n\n甲乙丙\n\nZ\n', JSON.stringify(await readNote(abs)));

/* ---------- ④ 列表项回车：智能续行带前缀 ---------- */
cur = '# 测试\n\n- 甲\n';
abs = await openNote('场景四.md', cur);
await caretEndOf('- 甲', 'li');
await page.keyboard.press('Enter');
await page.keyboard.type('乙');
// 已知差异：块级内核在「续列表项」时会多留一条文末空行（-\u3000乙\n\n），
// cm 的 doc 是权威文本，按一次回车只多一行 → 以 cm 结果为 cm 侧基线。
check('列表项回车 → 自动续 "- " 前缀',
  (await readNote(abs)) === (IS_CM ? '# 测试\n\n- 甲\n- 乙\n' : '# 测试\n\n- 甲\n- 乙\n\n'),
  JSON.stringify(await readNote(abs)));

/* ---------- ⑤ 空列表项回车：退出列表 ---------- */
cur = '# 测试\n\n- 甲\n';
abs = await openNote('场景五.md', cur);
await caretEndOf('- 甲', 'li');
await page.keyboard.press('Enter');   // 造出空项 "- "
await page.keyboard.press('Enter');   // 空项上再回车 → 退出列表
check('空列表项回车 → 退出列表', (await readNote(abs)) === '# 测试\n\n- 甲\n\n', JSON.stringify(await readNote(abs)));

/* ---------- ⑥ 含软换行的段尾回车（曾经的 bug：br 口径不一致把字拆开） ---------- */
cur = '# 测试\n\n普通段\n第二行\n';
abs = await openNote('场景六.md', cur);
await caretEndOf('第二行', 'p');
await page.keyboard.press('Enter');
await page.keyboard.type('X');
check('软换行段落尾回车 → 不拆散原有行', (await readNote(abs)) === '# 测试\n\n普通段\n第二行\nX\n', JSON.stringify(await readNote(abs)));

/* ---------- ⑦ 含软换行的行中回车：拆在正确位置 ---------- */
cur = '# 测试\n\n甲乙丙丁\n';
abs = await openNote('场景七.md', cur);
await caretMidOf('甲乙丙丁', 2);
await page.keyboard.press('Enter');
await page.keyboard.type('X');
check('软换行段落行中回车 → 拆在光标处', (await readNote(abs)) === '# 测试\n\n甲乙\nX丙丁\n', JSON.stringify(await readNote(abs)));

/* ---------- ⑧ 段尾回车（后面还有内容）：必须产生可见空行，打字落进去 ---------- */
cur = '# 测试\n\n第一段\n\n第二段\n';
abs = await openNote('场景八.md', cur);
await caretEndOf('第一段', 'p', '第一段');
await page.keyboard.press('Enter');
await page.keyboard.type('新行');
check('段尾回车（后面有内容）→ 新行接住输入',
  (await readNote(abs)) === '# 测试\n\n第一段\n新行\n\n第二段\n',
  JSON.stringify(await readNote(abs)));

/* ---------- ⑨ 点段落间空白：可以直接在那条空行上输入（变成新段落） ---------- */
cur = '# 测试\n\n正文段落。\n\n## 小标题\n\n内容\n';
abs = await openNote('场景九.md', cur);
if (IS_CM) {
  // cm：没有 .md-blank，「空行就是一行」——把光标放到那条空行（第 4 行）上，
  // 语义与「点空行」等价：字就留在这一行、不进入下一段
  const blankOffset = cur.indexOf('正文段落。') + '正文段落。'.length + 1;   // 第一个 '\n' 之后 = 那条空行
  await setCaretAtOffset(page, blankOffset);
} else {
  const gapPt = await page.evaluate(() => {
    const p = [...document.querySelectorAll('#editor-live p')].find((x) => x.textContent.includes('正文段落'));
    const h = [...document.querySelectorAll('#editor-live h2')].find((x) => x.textContent.includes('小标题'));
    const pr = p.getBoundingClientRect();
    const hr = h.getBoundingClientRect();
    return { x: pr.left + 120, y: (pr.bottom + hr.top) / 2 - 3 };
  });
  await page.mouse.click(gapPt.x, gapPt.y);
}
await sleep(300);
const onBlank = IS_CM
  ? await page.evaluate(() => {
      const st = window.__editor.view.state;
      return st.doc.lineAt(st.selection.main.head).text.trim() === '';
    })
  : await page.evaluate(() => {
      // 空行现在恒占一行高、本身就是点击目标：光标应该落在 .md-blank 里
      const a = getSelection()?.anchorNode;
      const el = a?.nodeType === Node.TEXT_NODE ? a.parentElement : a;
      return !!el?.closest?.('.md-blank');
    });
await page.keyboard.type('补字');
check('点段落间空白 → 落在空行上，输入就留在那一行',
  onBlank && (await readNote(abs)) === '# 测试\n\n正文段落。\n补字\n## 小标题\n\n内容\n',
  `blank=${onBlank} | ${JSON.stringify((await readNote(abs)).slice(0, 44))}`);

check('无渲染错误', errors.length === 0, errors.join(' | '));

await browser.close();
server.kill();
fs.rmSync(HOME, { recursive: true, force: true });
console.log('\n' + log.join('\n'));
process.exit(log.some((l) => l.startsWith('FAIL')) ? 1 : 0);
