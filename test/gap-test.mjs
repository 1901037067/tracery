import { launchBrowser as launchTestBrowser } from '../scripts/lib/browser.mjs';
/**
 * 实时预览「空行 / 落点」回归（2026-10-18 用户报告）
 * ------------------------------------------------------------------
 * 用户场景：源码里是「标题 + 一行空行 + 正文」，实时预览里点那条空行，
 * 结果整体跳一下、字打进去光标却跑到下一行，接着输入的字全进了下一段。
 *
 * 本套件用真实鼠标 + 真实键盘锁住这些行为：
 *   ① 空行在预览里真的占一行；
 *   ② 点空行前后布局不跳、光标落在这条空行上；
 *   ③ 空行上打字/回车，输入留在这一行、源码行数不变。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 9607;
const HOME = path.join(process.env.TEMP || '/tmp', 'tracery-gap-home');
const VAULT = path.join(HOME, 'vault');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(VAULT, { recursive: true });

const server = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), TRACERY_HOME: HOME }, stdio: 'pipe',
});
for (let i = 0; i < 40; i++) {
  try { if ((await fetch(`http://localhost:${PORT}/api/state`)).ok) break; } catch { /* wait */ }
  await sleep(250);
}

const browser = await launchTestBrowser({
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

await page.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle0' });
await sleep(1200);

let seq = 0;
async function openNote(content) {
  const name = `空行${++seq}.md`;
  const abs = path.join(VAULT, name);
  fs.writeFileSync(abs, content, 'utf8');
  await page.evaluate(async (vp) => {
    await fetch('/api/vault/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: vp }) });
  }, VAULT.replace(/\\/g, '/'));
  await sleep(900);
  await page.evaluate((p) => document.querySelector(`[data-path="${p}"]`)?.click(), name);
  await sleep(800);
  return abs;
}
async function readNote(abs) {
  await sleep(1500);   // 自动保存 900ms 防抖 + 余量
  return fs.readFileSync(abs, 'utf8');
}
/* ---------- 探针：空的 .cm-line / CM state ---------- */
/** 点第一条空行（.cm-line 里 textContent 为空的那条） */
async function clickBlank() {
  const pt = await page.evaluate(() => {
    const el = [...document.querySelectorAll('#editor-live .cm-line')].find((l) => l.textContent === '');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + 100, y: (r.top + r.bottom) / 2 };
  });
  if (!pt) throw new Error('没找到空行 .cm-line');
  await page.mouse.click(pt.x, pt.y);
  await sleep(250);
}
/** 状态：doc 文本、滚动位置、光标是否在空行、空行几何 */
const cmState = () => page.evaluate(() => {
  const ed = window.__editor;
  const st = ed.view.state;
  const scroller = document.querySelector('#editor-live .cm-scroller');
  const blanks = [...document.querySelectorAll('#editor-live .cm-line')].filter((l) => l.textContent === '');
  const b = blanks[0];
  const h1 = document.querySelector('#editor-live .cm-line.cm-lp-h1');
  return {
    doc: st.doc.toString(),
    scrollTop: scroller ? Math.round(scroller.scrollTop) : 0,
    cursorLineEmpty: st.doc.lineAt(st.selection.main.head).text.trim() === '',
    blankH: b ? Math.round(b.getBoundingClientRect().height) : 0,
    blankTop: b ? Math.round(b.getBoundingClientRect().top) : null,
    h1Bottom: h1 ? Math.round(h1.getBoundingClientRect().bottom) : null,
    tops: [...document.querySelectorAll('#editor-live .cm-line')].map((l) => Math.round(l.getBoundingClientRect().top)),
  };
});

const SOURCE = '# 02_skills位置：\n\nE:\\02_software\\06_skill\n';

/* ---------- ① 空行在预览里真的占一行 ---------- */
let abs = await openNote(SOURCE);
const s1 = await cmState();
check('空行在预览里占一行高度（空 .cm-line）', s1.blankH > 20, `height=${s1.blankH}`);
check('空行位置夹在标题和正文之间',
  s1.h1Bottom !== null && s1.blankTop >= s1.h1Bottom - 1,
  JSON.stringify({ h1Bottom: s1.h1Bottom, blankTop: s1.blankTop }));

/* ---------- ② 点空行：布局不许跳 ---------- */
await clickBlank();
const s2 = await cmState();
check('点空行前后布局完全一致（不再「点一下就位移」）',
  JSON.stringify(s1.tops) === JSON.stringify(s2.tops) && s1.scrollTop === s2.scrollTop && s1.doc === s2.doc,
  JSON.stringify({ before: s1.tops, after: s2.tops, scroll: [s1.scrollTop, s2.scrollTop] }));

/* ---------- ③ 点空行：光标就落在这一行 ---------- */
check('点空行 → 光标落在空行里', s2.cursorLineEmpty === true, JSON.stringify({ empty: s2.cursorLineEmpty }));

/* ---------- ④ 空行上打字：成为新段落，光标停在字尾，续打不会跑偏 ---------- */
await page.keyboard.type('123');
await sleep(500);
const s4 = await cmState();
check('空行打字 → 光标停在刚打的字后面', s4.doc.includes('\n123\n') && s4.cursorLineEmpty === false, JSON.stringify(s4.doc));
await page.keyboard.type('456');
// 关键契约（Obsidian 同款）：点空行打字，字就留在这一行，源码行数不变
check('空行打字 → 行数不变（不多长出空行）',
  (await readNote(abs)) === '# 02_skills位置：\n123456\nE:\\02_software\\06_skill\n',
  JSON.stringify(await readNote(abs)));

/* ---------- ⑤ 空行上回车：光标留在空行，输入不进下一段 ---------- */
abs = await openNote(SOURCE);
await clickBlank();
await page.keyboard.press('Enter');
await sleep(300);
const s5 = await cmState();
check('空行回车 → 光标仍停在一行空行上（不跳到下一段）', s5.cursorLineEmpty === true, JSON.stringify({ empty: s5.cursorLineEmpty }));
await page.keyboard.type('abc');
check('回车后输入 → 落在新空行，正文不受影响',
  (await readNote(abs)) === '# 02_skills位置：\n\nabc\nE:\\02_software\\06_skill\n',
  JSON.stringify(await readNote(abs)));

/* ---------- ⑥ 连续两行空行也能点、能打 ---------- */
const S6 = '# 标题\n\n\n正文\n';
abs = await openNote(S6);
// 第 2 行（空行）在 md 里的起点
const off6 = S6.indexOf('标题') + 2 + 1;   // '标题' 之后第一个 \n 的下一位 = 第 2 行行首
await page.evaluate((o) => { const ed = window.__editor; ed.view.dispatch({ selection: { anchor: o } }); ed.view.focus(); }, off6);
await sleep(150);
await page.keyboard.type('Y');
check('连续空行 → 能点中并输入', (await readNote(abs)) === '# 标题\nY\n\n正文\n',
  JSON.stringify(await readNote(abs)));

/* ---------- ⑦ 正文行内点击/输入不受影响 ---------- */
const S7 = '# 标题\n\n短句\n\n下一段\n';
abs = await openNote(S7);
const off7 = S7.indexOf('短句');
await page.evaluate((o) => { const ed = window.__editor; ed.view.dispatch({ selection: { anchor: o } }); ed.view.focus(); }, off7);
await sleep(200);
await page.keyboard.type('前');
check('正文行首点击 → 字插在正确位置',
  (await readNote(abs)) === '# 标题\n\n前短句\n\n下一段\n', JSON.stringify(await readNote(abs)));

check('无渲染错误', errors.length === 0, errors.join(' | '));

await browser.close();
server.kill();
fs.rmSync(HOME, { recursive: true, force: true });
console.log('\n' + log.join('\n'));
process.exit(log.some((l) => l.startsWith('FAIL')) ? 1 : 0);
