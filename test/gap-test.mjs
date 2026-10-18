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
 */
import puppeteer from 'puppeteer-core';
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

await page.goto(`http://localhost:${PORT}/?engine=block`, { waitUntil: 'networkidle0' });   // pin 块级内核（依赖块级 DOM）
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

const SOURCE = '# 02_skills位置：\n\nE:\\02_software\\06_skill\n';

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

check('无渲染错误', errors.length === 0, errors.join(' | '));

await browser.close();
server.kill();
console.log('\n' + log.join('\n'));
process.exit(log.some((l) => l.startsWith('FAIL')) ? 1 : 0);
