/**
 * 实时预览「空行 / 落点」回归（2026-10-18 用户报告）
 * ------------------------------------------------------------------
 * 用户场景：源码里是「标题 + 一行空行 + 正文」，实时预览里点那条空行，
 * 结果整体跳一下、字打进去光标却跑到下一行，接着输入的字全进了下一段。
 *
 * 三个真 bug：
 *   ① .md-blank 是零高 + 点中时临时撑开（.is-active）→ 点一下就位移，
 *      而且那一行本来点不到，光标只能靠「猜空隙」的启发式去落。
 *   ② _saveCaret 用「纯文本第几个字符」，锚点落在空块上（元素而不是文本节点）时
 *      textOffsetOf 返回整篇文本长度 → DOM 重建后光标被甩到全文末尾。
 *   ③ domOffsetBrAware 对「块级元素自己当锚点」没有特判，空块里的 <br> 被算成
 *      偏移 +1 → 回车/输入整体错位一格。
 * 本套件用真实鼠标 + 真实键盘锁住这些行为。
 *
 * 内核：TRACERY_TEST_ENGINE（默认 block）。cm 内核没有 .md-blank——「空行就是一条
 * 空的 .cm-line」，所以 cm 分支用「点空 .cm-line / 按偏移放光标」跑等价语义；
 * 纯几何启发式的两条（⑥ 点标题下外边距、⑦ 依赖 .md-blank 子元素序）按引擎门控。
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ENGINE, IS_CM, engineUrl } from './_engine-helpers.mjs';

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
console.log(`[gap] 内核：${ENGINE}`);
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
/* ---------- 块级专用探针（.md-blank / 块级 DOM） ---------- */
const caret = () => page.evaluate(() => {
  const sel = getSelection();
  const a = sel.anchorNode;
  const el = a?.nodeType === Node.TEXT_NODE ? a.parentElement : a;
  return { tag: el?.tagName || '', cls: el?.className || '', text: el?.textContent || '', off: sel.anchorOffset };
});
const layout = () => page.evaluate(() => [...document.getElementById('editor-live').children].map((el) => {
  const r = el.getBoundingClientRect();
  return { tag: el.tagName, cls: el.className, top: Math.round(r.top), bottom: Math.round(r.bottom) };
}));
async function clickBlank() {
  const pt = await page.evaluate(() => {
    const b = document.querySelector('#editor-live .md-blank');
    const r = b.getBoundingClientRect();
    return { x: r.left + 100, y: (r.top + r.bottom) / 2 };
  });
  await page.mouse.click(pt.x, pt.y);
  await sleep(250);
}
/* ---------- cm 专用探针（空的 .cm-line / CM state） ---------- */
/** 点第一条空行（.cm-line 里 textContent 为空的那条） */
async function cmClickBlank() {
  const pt = await page.evaluate(() => {
    const el = [...document.querySelectorAll('#editor-live .cm-line')].find((l) => l.textContent === '');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + 100, y: (r.top + r.bottom) / 2 };
  });
  if (!pt) throw new Error('cm：没找到空行 .cm-line');
  await page.mouse.click(pt.x, pt.y);
  await sleep(250);
}
/** cm 侧状态：doc 文本、滚动位置、光标是否在空行、空行几何 */
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

if (IS_CM) {
  /* ---------- ① 空行在预览里真的占一行 ---------- */
  let abs = await openNote(SOURCE);
  const s1 = await cmState();
  check('空行在预览里占一行高度（cm：空 .cm-line）', s1.blankH > 20, `height=${s1.blankH}`);
  check('空行位置夹在标题和正文之间',
    s1.h1Bottom !== null && s1.blankTop >= s1.h1Bottom - 1,
    JSON.stringify({ h1Bottom: s1.h1Bottom, blankTop: s1.blankTop }));

  /* ---------- ② 点空行：布局不许跳 ---------- */
  await cmClickBlank();
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
  await cmClickBlank();
  await page.keyboard.press('Enter');
  await sleep(300);
  const s5 = await cmState();
  check('空行回车 → 光标仍停在一行空行上（不跳到下一段）', s5.cursorLineEmpty === true, JSON.stringify({ empty: s5.cursorLineEmpty }));
  await page.keyboard.type('abc');
  check('回车后输入 → 落在新空行，正文不受影响',
    (await readNote(abs)) === '# 02_skills位置：\n\nabc\nE:\\02_software\\06_skill\n',
    JSON.stringify(await readNote(abs)));

  /* ---------- ⑥ 点标题下方外边距（纯几何启发式，块级专用）→ cm 下门控 ---------- */
  console.log('  ⏭ 跳过「点标题下的空隙不往标题里补字」：该断言针对块级内核的点缝隙启发式，cm 下按行落光标无对应语义');

  /* ---------- ⑦ 连续两行空行也能点、能打 ---------- */
  const S7 = '# 标题\n\n\n正文\n';
  abs = await openNote(S7);
  // 第 2 行（空行）在 md 里的起点
  const off7 = S7.indexOf('标题') + 2 + 1;   // '标题' 之后第一个 \n 的下一位 = 第 2 行行首
  await page.evaluate((o) => { const ed = window.__editor; ed.view.dispatch({ selection: { anchor: o } }); ed.view.focus(); }, off7);
  await sleep(150);
  await page.keyboard.type('Y');
  check('连续空行 → 能点中并输入', (await readNote(abs)) === '# 标题\nY\n\n正文\n',
    JSON.stringify(await readNote(abs)));

  /* ---------- ⑧ 正文行内点击/输入不受影响 ---------- */
  const S8 = '# 标题\n\n短句\n\n下一段\n';
  abs = await openNote(S8);
  const off8 = S8.indexOf('短句');
  await page.evaluate((o) => { const ed = window.__editor; ed.view.dispatch({ selection: { anchor: o } }); ed.view.focus(); }, off8);
  await sleep(200);
  await page.keyboard.type('前');
  check('正文行首点击 → 字插在正确位置',
    (await readNote(abs)) === '# 标题\n\n前短句\n\n下一段\n', JSON.stringify(await readNote(abs)));
} else {
  /* ---------- ① 空行在预览里真的占一行 ---------- */
  let abs = await openNote(SOURCE);
  const g1 = await layout();
  const blankBox = await page.evaluate(() => {
    const b = document.querySelector('#editor-live .md-blank');
    return { h: b.offsetHeight, top: b.getBoundingClientRect().top, bottom: b.getBoundingClientRect().bottom };
  });
  check('空行在预览里占一行高度（不再是零高）', blankBox.h > 20, `height=${blankBox.h}`);
  check('空行位置夹在标题和正文之间',
    g1[0].tag === 'H1' && blankBox.top >= g1[0].bottom - 1 && blankBox.bottom <= g1[2].top + 1,
    JSON.stringify(g1.map((x) => `${x.tag}@${x.top}-${x.bottom}`)));

  /* ---------- ② 点空行：布局不许跳 ---------- */
  await clickBlank();
  const g2 = await layout();
  check('点空行前后布局完全一致（不再「点一下就位移」）',
    JSON.stringify(g1) === JSON.stringify(g2),
    JSON.stringify(g2.map((x) => x.top)));

  /* ---------- ③ 点空行：光标就落在这一行 ---------- */
  const c3 = await caret();
  check('点空行 → 光标落在空行里', c3.cls.includes('md-blank'), JSON.stringify(c3));

  /* ---------- ④ 空行上打字：成为新段落，光标停在字尾，续打不会跑偏 ---------- */
  await page.keyboard.type('123');
  await sleep(500);
  const c4 = await caret();
  check('空行打字 → 光标停在刚打的字后面', c4.off === 3 && c4.text.startsWith('123'), JSON.stringify(c4));
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
  const c5 = await caret();
  check('空行回车 → 光标仍停在一行空行上（不跳到下一段）',
    (c5.tag === 'P' || c5.tag === 'DIV') && !c5.text.trim(), JSON.stringify(c5));
  await page.keyboard.type('abc');
  check('回车后输入 → 落在新空行，正文不受影响',
    (await readNote(abs)) === '# 02_skills位置：\n\nabc\nE:\\02_software\\06_skill\n',
    JSON.stringify(await readNote(abs)));

  /* ---------- ⑥ 点标题下方外边距：不许把字补进标题 ---------- */
  abs = await openNote('# 标题\n- 甲\n- 乙\n');
  const gapPt = await page.evaluate(() => {
    const h = document.querySelector('#editor-live h1').getBoundingClientRect();
    const ul = document.querySelector('#editor-live ul').getBoundingClientRect();
    return { x: h.left + 20, y: (h.bottom + ul.top) / 2 };
  });
  await page.mouse.click(gapPt.x, gapPt.y);
  await sleep(250);
  await page.keyboard.type('Q');
  const md6 = await readNote(abs);
  check('点标题下的空隙 → 不往标题里补字', !md6.includes('标题Q') && md6.includes('# 标题'), JSON.stringify(md6));

  /* ---------- ⑦ 连续两行空行也能点、能打 ---------- */
  abs = await openNote('# 标题\n\n\n正文\n');
  const blankCount = await page.evaluate(() => document.querySelectorAll('#editor-live .md-blank').length);
  const pt7 = await page.evaluate(() => {
    const el = [...document.querySelectorAll('#editor-live > *')][1];
    const r = el.getBoundingClientRect();
    return { x: r.left + 100, y: (r.top + r.bottom) / 2, h: el.offsetHeight };
  });
  await page.mouse.click(pt7.x, pt7.y);
  await sleep(250);
  await page.keyboard.type('Y');
  check('连续空行 → 能点中并输入', (await readNote(abs)) === '# 标题\nY\n\n正文\n',
    `blank=${blankCount} h=${pt7.h} | ${JSON.stringify(await readNote(abs))}`);

  /* ---------- ⑧ 正文行内点击/输入不受影响 ---------- */
  abs = await openNote('# 标题\n\n短句\n\n下一段\n');
  const mid = await page.evaluate(() => {
    const el = [...document.querySelectorAll('#editor-live p')].find((x) => x.textContent === '短句');
    const r = el.getBoundingClientRect();
    return { x: r.left + 4, y: (r.top + r.bottom) / 2 };
  });
  await page.mouse.click(mid.x, mid.y);
  await sleep(200);
  await page.keyboard.type('前');
  check('正文行首点击 → 字插在正确位置',
    (await readNote(abs)) === '# 标题\n\n前短句\n\n下一段\n', JSON.stringify(await readNote(abs)));
}

check('无渲染错误', errors.length === 0, errors.join(' | '));

await browser.close();
server.kill();
fs.rmSync(HOME, { recursive: true, force: true });
console.log('\n' + log.join('\n'));
process.exit(log.some((l) => l.startsWith('FAIL')) ? 1 : 0);
