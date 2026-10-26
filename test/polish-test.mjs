import { launchBrowser as launchTestBrowser } from '../scripts/lib/browser.mjs';
/**
 * 编辑器体验回归：撤销/重做、实时预览行号、右键菜单紧凑化 + 无 emoji
 * ------------------------------------------------------------------
 * 2026-10-18 用户报的一批「手感」问题：
 *   ① 没有撤销（要求 Ctrl+Z）——contenteditable 每次重渲染都会重建 DOM，
 *      浏览器原生 undo 栈跟着节点一起没了，只能自己按 Markdown 存快照。
 *   ② 右键菜单用 emoji 当图标 + 选项间距太大（22 项排成一长条）。
 *   ③ 实时预览没有行号，且设置里要能关。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { caretAtEndOfText, gutterNumbers, gutterVisible } from './_engine-helpers.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 9608;
const HOME = path.join(process.env.TEMP || '/tmp', 'tracery-polish-home');
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

// 欢迎页文案（首启动没有 vault，欢迎页可见）
const welcomeText = await page.evaluate(() => document.getElementById('welcome')?.textContent || '');
check('欢迎页不再写「Obsidian 复刻学习版」', !welcomeText.includes('复刻学习版'), welcomeText.slice(0, 60).replace(/\s+/g, ' '));

// 建一个临时仓库并进入主界面
fs.writeFileSync(path.join(VAULT, '占位.md'), '# 占位\n', 'utf8');
await page.evaluate(async (vp) => {
  await fetch('/api/vault/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: vp }) });
}, VAULT.replace(/\\/g, '/'));
await page.reload({ waitUntil: 'networkidle0' });
await sleep(1200);

let seq = 0;
async function openNote(content) {
  const name = `体验${++seq}.md`;
  const abs = path.join(VAULT, name);
  // 只创建测试笔记，等树更新后实际点击；反复重开同仓库会与草稿恢复流程竞争。
  await page.evaluate(async ({ name, content }) => {
    await window.__editor.flush(); await window.__tracery.Api.createNote(name, content);
  }, { name, content });
  await page.waitForSelector(`#file-tree [data-path="${name}"]`);
  await page.click(`#file-tree [data-path="${name}"]`);
  await page.waitForFunction(({ name, content }) => window.__tracery.state.currentPath === name && window.__editor.getContent() === content, {}, { name, content });
  return abs;
}
const md = () => page.evaluate(() => window.__tracery.editor.getContent());
/** 光标落到最后一个非空行的行尾（cm：view.dispatch） */
async function caretEnd() { await caretAtEndOfText(page); }

/* ---------- ① 打字 → Ctrl+Z 撤销 ---------- */
let abs = await openNote('# 测试\n\n第一段\n');
await caretEnd();
await page.keyboard.type('abc');
await sleep(800);
check('打字后内容已变', (await md()).includes('第一段abc'), JSON.stringify(await md()));
await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
await sleep(300);
check('Ctrl+Z 撤销这次输入', !(await md()).includes('abc'), JSON.stringify(await md()));
await sleep(1400);
check('撤销结果已落盘', !fs.readFileSync(abs, 'utf8').includes('abc'), JSON.stringify(fs.readFileSync(abs, 'utf8')));

/* ---------- ② 重做（cm：Ctrl+Y） ---------- */
await page.keyboard.down('Control'); await page.keyboard.press('KeyY'); await page.keyboard.up('Control');
await sleep(300);
check('Ctrl+Y 重做（cm：Mod-Shift-z 被 Shift 大写坑掉）',
  (await md()).includes('第一段abc'), JSON.stringify(await md()));

await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
await sleep(250);
await page.keyboard.down('Control'); await page.keyboard.press('y'); await page.keyboard.up('Control');
await sleep(250);
check('Ctrl+Y 也能重做', (await md()).includes('第一段abc'), JSON.stringify(await md()));

/* ---------- ③ 连续输入合并成一步 ---------- */
abs = await openNote('# 测试\n\n起点\n');
await caretEnd();
await page.keyboard.type('1234567890');
await sleep(800);
await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
await sleep(300);
check('连续输入一次撤销干净', !(await md()).includes('123'), JSON.stringify(await md()));

/* ---------- ④ 结构操作（回车）单独一步 ---------- */
abs = await openNote('# 测试\n\n甲\n');
await caretEnd();
await page.keyboard.type('A');
await sleep(700);
await page.keyboard.press('Enter');
await page.keyboard.type('B');
await sleep(800);
const before = await md();
await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
await sleep(300);
const afterUndo = await md();
check('回车 / 输入分开记步（第一次撤销只退最后一段输入）',
  afterUndo.includes('A') && !afterUndo.includes('B'), `${JSON.stringify(before)} → ${JSON.stringify(afterUndo)}`);

/* ---------- ⑤ 撤销后再输入 → redo 失效 ---------- */
await page.keyboard.type('C');
await sleep(800);
const canRedo = await page.evaluate(() => window.__tracery.editor.canRedo());
check('撤销后新输入会砍掉 redo 分支', canRedo === false, `canRedo=${canRedo}`);

/* ---------- ⑥ 实时预览行号 ---------- */
abs = await openNote('# 一级标题\n\n第一段\n\n- 甲\n- 乙\n\n```js\nconst a = 1;\nconst b = 2;\n```\n');
// cm：行号槽是 CM 的 lineNumbers gutter（每行都有号，含文末空行），
// 注意过滤掉 CM 用来测宽度的 9999 元素。
const nums = await gutterNumbers(page);
check('实时预览出现行号槽（cm .cm-lineNumbers）', (await gutterVisible(page)) && nums.length > 0, nums.join(','));
check('行号从 1 开始', nums[0] === 1, JSON.stringify(nums[0]));
check('行号覆盖列表项与代码块每一行',
  nums.includes(5) && nums.includes(6) && nums.includes(9) && nums.includes(10), nums.join(','));
check('文末空行也编号（与 Obsidian 一致）',
  nums.includes(12) && Math.max(...nums) === 12, nums.join(','));
const align = await page.evaluate(() => {
  const max = window.__editor.view.state.doc.lines;
  const g = [...document.querySelectorAll('#editor-live .cm-lineNumbers .cm-gutterElement')]
    .filter((e) => { const n = Number(e.textContent.trim()); return n >= 1 && n <= max; });
  const h1 = document.querySelector('#editor-live .cm-line.cm-lp-h1');
  if (!g[0] || !h1) return null;
  const a = g[0].getBoundingClientRect(), b = h1.getBoundingClientRect();
  return Math.round(Math.abs((a.top + a.height / 2) - (b.top + b.height / 2)));
});
check('首行行号与标题行对齐', align !== null && align < 6, `Δ=${align}px`);

/* ---------- ⑦ 设置里关掉行号 ---------- */
await page.keyboard.down('Control'); await page.keyboard.press(','); await page.keyboard.up('Control');
await sleep(500);
const hasSwitch = await page.evaluate(() => !!document.querySelector('.switch[data-toggle="lineNumbers"]'));
check('设置→编辑器里有「行号」开关', hasSwitch);
await page.evaluate(() => {
  document.querySelector('.settings-nav button[data-pane="editor"]')?.click();
});
await sleep(200);
await page.evaluate(() => document.querySelector('.switch[data-toggle="lineNumbers"]')?.click());
await sleep(400);
const offState = await page.evaluate(() => ({
  on: document.querySelector('.switch[data-toggle="lineNumbers"]')?.classList.contains('on'),
}));
check('关掉开关 → 行号槽消失', (await gutterVisible(page)) === false && offState.on === false,
  JSON.stringify({ ...offState, visible: await gutterVisible(page) }));
await page.evaluate(() => document.querySelector('.switch[data-toggle="lineNumbers"]')?.click());
await sleep(900);
const onState = await page.evaluate(() => ({
  on: document.querySelector('.switch[data-toggle="lineNumbers"]')?.classList.contains('on'),
}));
check('再打开 → 行号回来', (await gutterVisible(page)) === true && onState.on === true,
  JSON.stringify({ ...onState, visible: await gutterVisible(page) }));
await page.evaluate(() => document.querySelector('#set-done')?.click());
await sleep(300);

/* ---------- ⑧ 右键菜单：无 emoji + 紧凑 ---------- */
const menuInfo = await page.evaluate(() => {
  const item = document.querySelector('#file-tree .tree-item');
  const r = item.getBoundingClientRect();
  item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 20, clientY: r.top + 8 }));
  const menu = document.querySelector('.context-menu');
  if (!menu) return null;
  const btns = [...menu.querySelectorAll('button')];
  const heights = btns.map((b) => Math.round(b.getBoundingClientRect().height));
  return {
    labels: btns.map((b) => b.textContent.trim()),
    maxHeight: Math.max(...heights),
    emoji: btns.filter((b) => /\p{Extended_Pictographic}/u.test(b.textContent)).map((b) => b.textContent.trim()),
    hasSvgIcon: btns.every((b) => !!b.querySelector('.mi-icon svg') || !!b.querySelector('.mi-icon .mi-txt')),
    menuH: Math.round(menu.getBoundingClientRect().height),
  };
});
check('文件右键菜单没有 emoji', menuInfo && menuInfo.emoji.length === 0, JSON.stringify(menuInfo?.emoji));
check('每项都有图标（SVG / 字型）', menuInfo?.hasSvgIcon === true);
check('菜单项高度紧凑（≤ 30px）', menuInfo && menuInfo.maxHeight <= 30, `max=${menuInfo?.maxHeight}px menu=${menuInfo?.menuH}px`);

const textMenu = await page.evaluate(() => {
  document.body.click();
  const ed = document.getElementById('editor-live');
  // 编辑区正文行：cm 的 .cm-line
  const p = [...ed.querySelectorAll('.cm-line')].find((x) => x.textContent.trim());
  if (!p) return null;
  const r = p.getBoundingClientRect();
  p.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 8, clientY: r.top + 8 }));
  const menu = document.querySelector('.context-menu');
  return menu ? {
    labels: [...menu.querySelectorAll('button')].map((b) => b.textContent.trim()),
    height: Math.round(menu.getBoundingClientRect().height),
    emoji: [...menu.querySelectorAll('button')].filter((b) => /\p{Extended_Pictographic}/u.test(b.textContent)).length,
  } : null;
});
check('编辑区菜单含「撤销 / 重做」', !!textMenu && textMenu.labels[0].includes('撤销') && textMenu.labels[1].includes('重做'),
  textMenu?.labels.slice(0, 3).join(' | '));
check('编辑区菜单无 emoji', textMenu?.emoji === 0);
check('编辑区菜单高度收紧（< 620px）', textMenu && textMenu.height < 620, `height=${textMenu?.height}px`);

check('无渲染错误', errors.length === 0, errors.join(' | '));

await browser.close();
server.kill();
console.log('\n' + log.join('\n'));
process.exit(log.some((l) => l.startsWith('FAIL')) ? 1 : 0);
