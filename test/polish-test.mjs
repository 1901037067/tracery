/**
 * 编辑器体验回归：撤销/重做、实时预览行号、右键菜单紧凑化 + 无 emoji
 * ------------------------------------------------------------------
 * 2026-10-18 用户报的一批「手感」问题：
 *   ① 没有撤销（要求 Ctrl+Z）——contenteditable 每次重渲染都会重建 DOM，
 *      浏览器原生 undo 栈跟着节点一起没了，只能自己按 Markdown 存快照。
 *   ② 右键菜单用 emoji 当图标 + 选项间距太大（22 项排成一长条）。
 *   ③ 实时预览没有行号，且设置里要能关。
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

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
  fs.writeFileSync(abs, content, 'utf8');
  await page.evaluate(async (vp) => {
    await fetch('/api/vault/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: vp }) });
  }, VAULT.replace(/\\/g, '/'));
  await sleep(900);
  await page.evaluate((p) => document.querySelector(`[data-path="${p}"]`)?.click(), name);
  await sleep(800);
  return abs;
}
const md = () => page.evaluate(() => window.__tracery.editor.getContent());
async function caretEnd() {
  await page.evaluate(() => {
    const root = document.getElementById('editor-live');
    const last = [...root.children].filter((el) => el.textContent.trim()).pop();
    const r = document.createRange();
    r.selectNodeContents(last);
    r.collapse(false);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
    root.focus();
  });
}

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

/* ---------- ② 重做（Ctrl+Shift+Z / Ctrl+Y） ---------- */
await page.keyboard.down('Control'); await page.keyboard.down('Shift');
await page.keyboard.press('z');
await page.keyboard.up('Shift'); await page.keyboard.up('Control');
await sleep(300);
check('Ctrl+Shift+Z 重做', (await md()).includes('第一段abc'), JSON.stringify(await md()));

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
const gutter = await page.evaluate(() => {
  const g = document.querySelector('.live-gutter');
  const nums = g ? [...g.querySelectorAll('.ln')].map((d) => ({ n: Number(d.textContent), top: d.style.top })) : [];
  const h1 = document.querySelector('#editor-live h1').getBoundingClientRect();
  return { hidden: !g || g.hidden, nums, h1Top: h1.top };
});
check('实时预览出现行号槽', !gutter.hidden && gutter.nums.length > 0, JSON.stringify(gutter.nums.slice(0, 8)));
check('行号从 1 开始且首行对着标题',
  gutter.nums[0]?.n === 1, JSON.stringify(gutter.nums[0]));
const numbers = gutter.nums.map((x) => x.n);
check('行号覆盖列表项与代码块每一行',
  numbers.includes(5) && numbers.includes(6) && numbers.includes(9) && numbers.includes(10), numbers.join(','));
// 2026-10-18 用户报：Obsidian 里「段落 + 5 个 \n」显示 1-6，Tracery 只显示 1-5。
// 根因是 _collectLineNumbers 跳过了文末空行；CM6/Obsidian 对每一行都编号（含文末空行）。
// 本夹具共 12 行（文件以 \n 结尾，第 12 行是文末空行），修后末行必须拿到号。
// 注意：围栏行（8/11）在块级模型里本来就没有可见行可挂号（上一轮的既定行为，
// 「跳号 7→9 属正常」），CM6 的行号槽与渲染解耦后这类问题才根治——不断言 8/11。
check('文末空行也编号（与 Obsidian 一致）',
  numbers.includes(12) && Math.max(...numbers) === 12, numbers.join(','));

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
  hidden: document.querySelector('.live-gutter')?.hidden,
  on: document.querySelector('.switch[data-toggle="lineNumbers"]')?.classList.contains('on'),
}));
check('关掉开关 → 行号槽消失', offState.hidden === true && offState.on === false, JSON.stringify(offState));
await page.evaluate(() => document.querySelector('.switch[data-toggle="lineNumbers"]')?.click());
await sleep(900);
const onState = await page.evaluate(() => ({
  hidden: document.querySelector('.live-gutter')?.hidden,
  on: document.querySelector('.switch[data-toggle="lineNumbers"]')?.classList.contains('on'),
}));
check('再打开 → 行号回来', onState.hidden === false && onState.on === true, JSON.stringify(onState));
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
  const p = [...ed.querySelectorAll('p')].find((x) => x.textContent.trim());
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
