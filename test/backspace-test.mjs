/**
 * 跨行删除回归：行首 Backspace / 行尾 Delete / 跨块选区删除（2026-10-18 用户报告）
 * ------------------------------------------------------------------
 * 用户场景（实时预览，8 行文档）：光标放第 7 行开头，连续 Backspace 向前删，
 * 视觉上 1-7 行合并成一行，但——
 *   ① 行号槽 2-8 残留成点不动的死区；
 *   ② Ctrl+Z 提示无可撤销；
 *   ③ 切源码模式发现内容完好无损——删除只发生在 DOM 层，没进模型。
 * 根因：浏览器原生跨块合并只在 DOM 层发生，序列化按 data-md-line-* 旧偏移
 * 「gap 补换行」把原结构重建 → md 不变 → _onInput 跳过重渲染 → 视图/模型分裂。
 * 修法：跨行删除全部在模型层做（和 Enter 一条路子），外加「md 没变但 DOM 结构
 * 变了就强制重渲染」的安全网。本套件用真实键盘锁住行为。
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 9609;
const HOME = path.join(process.env.TEMP || '/tmp', 'tracery-bs-home');
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
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) process.exitCode = 1;
};

await page.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle0' });
await sleep(1200);

let seq = 0;
async function openNote(content) {
  const name = `跨删${++seq}.md`;
  fs.writeFileSync(path.join(VAULT, name), content, 'utf8');
  await page.evaluate(async (vp) => {
    await fetch('/api/vault/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: vp }) });
  }, VAULT.replace(/\\/g, '/'));
  await sleep(900);
  // 注意：name 必须作为参数传进页面——puppeteer 不序列化闭包，
  // 直接在函数里引用会静默解析成 window.name（空串），选择器匹配不到、点击静默失效
  await page.evaluate((n) => document.querySelector(`[data-path="${n}"]`)?.click(), name);
  await sleep(700);
  return name;
}
const md = () => page.evaluate(() => window.__tracery.editor.getContent());
const caretAt = (offset) => page.evaluate((o) => {
  const ed = window.__tracery.editor;
  ed.liveEl.focus();
  ed._restoreCaretMd(o);
}, offset);
const caretOffset = () => page.evaluate(() => window.__tracery.editor._caretOffset());
/** 行号槽体检：数量 = md 行数、无越界数字、最后一个号在内容高度内（死区检测） */
const gutterHealth = () => page.evaluate(() => {
  const g = document.querySelector('.live-gutter');
  const nums = g ? [...g.querySelectorAll('.ln')] : [];
  const live = document.querySelector('#editor-live');
  const md = window.__tracery.editor.getContent();
  const lineCount = md.split('\n').length;
  const last = nums[nums.length - 1];
  return {
    count: nums.length,
    lineCount,
    maxNo: nums.length ? Math.max(...nums.map((d) => Number(d.textContent))) : 0,
    lastTop: last ? parseFloat(last.style.top) : -1,
    contentH: live ? live.scrollHeight : 0,
  };
});
const undo = async () => {
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
  await sleep(400);
};

/* ---------- ① 用户的 exact 场景：段落 + 5 空行 + 末行，行首连续 Backspace ---------- */
await openNote('我做的这个系统是中文法律问答 RAG 链路。\n\n\n\n\n\n123123123\n');
// 第 7 行（123123123）行首的 md 偏移
const line7Start = '我做的这个系统是中文法律问答 RAG 链路。'.length + 6;
await caretAt(line7Start);
await page.keyboard.press('Backspace');
await sleep(500);
let g = await gutterHealth();
check('第1次 Backspace：空行合并进模型', (await md()) === '我做的这个系统是中文法律问答 RAG 链路。\n\n\n\n\n123123123\n', JSON.stringify(await md()));
check('第1次 Backspace：行号槽数量 = 模型行数（无死区）', g.count === g.lineCount && g.maxNo <= g.lineCount, JSON.stringify(g));

for (let i = 0; i < 5; i++) { await page.keyboard.press('Backspace'); await sleep(350); }
g = await gutterHealth();
check('连续 Backspace 全部合并进模型', (await md()) === '我做的这个系统是中文法律问答 RAG 链路。123123123\n', JSON.stringify(await md()));
check('合并后行号槽无残留死区', g.count === g.lineCount && g.lastTop < g.contentH, JSON.stringify(g));
check('合并后光标在接缝处', (await caretOffset()) === '我做的这个系统是中文法律问答 RAG 链路。'.length, `caret=${await caretOffset()}`);

/* ---------- ② 撤销 / 重做（必须在切模式之前测——切源码模式按设计重置撤销栈） ---------- */
await undo();
check('Ctrl+Z 能撤销（不再提示无可撤销）', (await md()) === '我做的这个系统是中文法律问答 RAG 链路。\n123123123\n', JSON.stringify(await md()));
await undo();
check('再撤一步回到更早的结构', (await md()) === '我做的这个系统是中文法律问答 RAG 链路。\n\n123123123\n', JSON.stringify(await md()));
await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.keyboard.press('z'); await page.keyboard.up('Shift'); await page.keyboard.up('Control');
await sleep(500);
check('Ctrl+Shift+Z 重做', (await md()) === '我做的这个系统是中文法律问答 RAG 链路。\n123123123\n', JSON.stringify(await md()));

/* ---------- ②b 源码模式一致性（用户当初就是靠这个发现模型没变的） ---------- */
await page.keyboard.down('Control'); await page.keyboard.press('e'); await page.keyboard.up('Control');
await sleep(500);
const srcVal = await page.evaluate(() => document.querySelector('#editor-source').value);
check('源码模式与实时预览一致（都进了模型）', srcVal === (await md()), JSON.stringify(srcVal));
await page.keyboard.down('Control'); await page.keyboard.press('e'); await page.keyboard.up('Control');
await sleep(500);

/* ---------- ③ 普通行合并（无标记前缀） ---------- */
await openNote('# 标题\n\n甲\n乙\n');
const line3Start = '# 标题\n\n甲\n'.length;
await caretAt(line3Start);
await page.keyboard.press('Backspace');
await sleep(450);
check('普通行首 Backspace 合并到上一行', (await md()) === '# 标题\n\n甲乙\n', JSON.stringify(await md()));
check('合并后光标在接缝', (await caretOffset()) === '# 标题\n\n甲'.length, `caret=${await caretOffset()}`);

/* ---------- ④ 列表 Outdent / 标题后合并（Obsidian 行为） ----------
 * 注：列表/标题的标记（- 、# ）靠 CSS 渲染不在 DOM 文本里，「标记前」的位置
 * 放不进光标；能放到的最前位置是内容起点，Backspace 在那里 = 去掉标记（outdent）。
 * 引用块（> ）的正文整体剥离前缀重渲染，行首位置在块级模型里不可表示，不拦。 */
await openNote('- 甲\n- 乙\n');
await caretAt('- 甲\n'.length + '- '.length);   // 第二条的内容起点（标记之后）
await page.keyboard.press('Backspace');
await sleep(450);
check('列表内容起点 Backspace：去掉标记（outdent）', (await md()) === '- 甲\n乙\n', JSON.stringify(await md()));

await openNote('# 标题\n正文\n');
await caretAt('# 标题\n'.length);
await page.keyboard.press('Backspace');
await sleep(450);
check('标题后一行 Backspace：标题文本直接相接', (await md()) === '# 标题正文\n', JSON.stringify(await md()));

/* ---------- ⑤ 空行上 Backspace：空行消失、后续行上移 ---------- */
await openNote('甲\n\n乙\n');
await caretAt('甲\n'.length);   // 第 2 行（空行）行首
await page.keyboard.press('Backspace');
await sleep(450);
check('空行行首 Backspace：空行被吸收、乙 上移一行', (await md()) === '甲\n乙\n', JSON.stringify(await md()));

/* ---------- ⑥ Delete 在行尾：下一行并进来 ---------- */
await openNote('甲\n乙\n');
await caretAt('甲'.length);     // 第 1 行行尾
await page.keyboard.press('Delete');
await sleep(450);
check('行尾 Delete 把下一行并进来', (await md()) === '甲乙\n', JSON.stringify(await md()));

/* ---------- ⑦ 跨块选区删除 ---------- */
await openNote('甲\n\n乙\n');
await page.evaluate(() => {
  const ed = window.__tracery.editor;
  ed.liveEl.focus();
  ed._selectRange(0, '甲\n\n乙'.length);
});
await sleep(300);
await page.keyboard.press('Backspace');
await sleep(500);
check('跨块选区删除走模型层', (await md()) === '\n', JSON.stringify(await md()));
g = await gutterHealth();
check('跨块删除后行号槽无死区', g.count === g.lineCount, JSON.stringify(g));

/* ---------- ⑧ 普通打字不受影响 ---------- */
await openNote('hello');
await caretAt(0);
await page.keyboard.type('X');
await sleep(600);
check('普通打字照常', (await md()) === 'Xhello', JSON.stringify(await md()));

check('无页面错误', errors.length === 0, errors.join('; '));
console.log(process.exitCode ? '\n有失败项' : '\n全部通过');
await browser.close();
server.kill();
process.exit(process.exitCode || 0);
