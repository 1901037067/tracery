/**
 * 布局回归：侧边栏折叠 + 紧凑头栏（标签行/笔记头）
 * 背景：拖拽过栏宽后内联 style.width 会覆盖 .collapsed{width:0}，折叠失效——
 * 本套件锁死这个场景；头栏尺寸锁 Obsidian 式紧凑（两行合计 < 70px）。
 * 使用临时 TRACERY_HOME + demo-vault，不触碰用户真实仓库。
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 9591;
const HOME = path.join(process.env.TEMP || '/tmp', 'tracery-layout-home');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });

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
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-sandbox'],
  defaultViewport: { width: 1280, height: 860 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const log = [];

function check(name, ok, detail = '') {
  log.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

await page.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle0' });
await sleep(1200);

/* ---------- 1. 侧栏折叠（含「拖拽过栏宽」这个回归场景） ---------- */
// 存一个栏宽，模拟用户拖拽过 resizer（内联 style.width 会记住它）
await page.evaluate(() => localStorage.setItem('tracery.ui.sidebarW', '400'));
await page.reload({ waitUntil: 'networkidle0' });
await sleep(1200);

const widthBefore = await page.$eval('#sidebar', (el) => getComputedStyle(el).width);
check('拖拽过的栏宽被恢复（400px）', widthBefore === '400px', widthBefore);

await page.click('#btn-toggle-left');
await sleep(500);   // 等 width 过渡动画结束
const widthCollapsed = await page.$eval('#sidebar', (el) => getComputedStyle(el).width);
const resizerHidden = await page.$eval('#resizer-left', (el) => getComputedStyle(el).display);
check('有内联栏宽时点折叠 → 宽度归零（回归：曾被内联样式压过）', widthCollapsed === '0px', widthCollapsed);
check('折叠时拖动条隐藏', resizerHidden === 'none', resizerHidden);

await page.click('#btn-toggle-left');
await sleep(500);
const widthRestored = await page.$eval('#sidebar', (el) => getComputedStyle(el).width);
check('再点一次展开 → 恢复原栏宽', widthRestored === '400px', widthRestored);

// 键盘快捷键同样路径（本版本 puppeteer 的 press 不解析组合串，修饰键要单独 down/up）
await page.keyboard.down('Control');
await page.keyboard.press('Backslash');
await page.keyboard.up('Control');
await sleep(500);
const widthByKey = await page.$eval('#sidebar', (el) => getComputedStyle(el).width);
check('Ctrl+\\ 也能折叠', widthByKey === '0px', widthByKey);
await page.keyboard.down('Control');
await page.keyboard.press('Backslash');
await page.keyboard.up('Control');
await sleep(400);

// 右栏折叠（同一 CSS 规则）
await page.click('#btn-toggle-right');
await sleep(500);
const rightCollapsed = await page.$eval('#sidebar-right', (el) => getComputedStyle(el).width);
check('右栏折叠同样有效', rightCollapsed === '0px', rightCollapsed);
await page.click('#btn-toggle-right');
await sleep(400);

/* ---------- 2. 紧凑头栏（仿 Obsidian） ---------- */
// 打开两篇笔记制造两个标签，量一下两行 chrome 的高度
await page.evaluate(() => {
  document.querySelector('[data-path="双链与反链.md"]')?.click();
});
await sleep(900);
await page.evaluate(() => {
  document.querySelector('[data-path="Markdown 语法.md"]')?.click();
});
await sleep(900);

const header = await page.evaluate(() => {
  const tabbar = document.getElementById('tabbar');
  const noteHeader = document.getElementById('note-header');
  const activeTab = document.querySelector('.tab.active');
  return {
    tabbarH: tabbar.getBoundingClientRect().height,
    noteHeaderH: noteHeader.getBoundingClientRect().height,
    tabbarBorder: getComputedStyle(tabbar).borderBottomWidth,
    tabRadius: activeTab ? getComputedStyle(activeTab).borderRadius : '',
    tabCount: document.querySelectorAll('.tab').length,
  };
});
const total = header.tabbarH + header.noteHeaderH;
check('至少两个标签（启动自开的 + 点击两篇）', header.tabCount >= 2, `tabs=${header.tabCount}`);
check('标签行 + 笔记头合计 < 70px（紧凑头栏）', total < 70, `${total.toFixed(1)}px`);
check('标签行自身 < 34px', header.tabbarH < 34, `${header.tabbarH.toFixed(1)}px`);
check('两行之间无分隔线（视觉上是一整条）', header.tabbarBorder === '0px', header.tabbarBorder);
check('活动标签底部圆角为 0（贴在笔记头上）', /0px 0px$/.test(header.tabRadius), header.tabRadius);

check('无渲染错误', errors.length === 0, errors.join(' | '));

await browser.close();
server.kill();
fs.rmSync(HOME, { recursive: true, force: true });
console.log('\n' + log.join('\n'));
process.exit(log.some((l) => l.startsWith('FAIL')) ? 1 : 0);
