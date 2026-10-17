/**
 * 布局回归：侧边栏折叠 + Tab 栏位置（标题栏模式）
 * 背景①：拖拽过栏宽后内联 style.width 会覆盖 .collapsed{width:0}，折叠失效——
 *   本套件锁死这个场景。
 * 背景②：Tab 栏已搬进标题栏（VS Code / Obsidian「Tab 标题栏」模式），
 *   与窗口按钮同一行；锁死「Tab 在编辑区上方 / 与窗口按钮同线 / 标题栏紧凑」。
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
  // Electron 布局：窗口按钮只在 body.electron 下显示，加上类再量才是用户实见的样式
  document.body.classList.add('electron');
  const list = document.getElementById('tablist');
  const titlebar = document.querySelector('.titlebar');
  const noteHeader = document.getElementById('note-header');
  const editorArea = document.getElementById('editor-area');
  const activeTab = document.querySelector('.tab.active');
  const winClose = document.getElementById('win-close');
  const listRect = list.getBoundingClientRect();
  const editorRect = editorArea.getBoundingClientRect();
  const tabRect = activeTab?.getBoundingClientRect();
  const winRect = winClose?.getBoundingClientRect();
  return {
    tabCount: document.querySelectorAll('.tab').length,
    titlebarH: titlebar.getBoundingClientRect().height,
    listTop: listRect.top,
    listAboveEditor: listRect.bottom <= editorRect.top + 1,
    tabCenterY: tabRect ? tabRect.top + tabRect.height / 2 : null,
    winCenterY: winRect ? winRect.top + winRect.height / 2 : null,
    tabRadius: activeTab ? getComputedStyle(activeTab).borderRadius : '',
    noteHeaderH: noteHeader.getBoundingClientRect().height,
  };
});
check('至少两个标签（启动自开的 + 点击两篇）', header.tabCount >= 2, `tabs=${header.tabCount}`);
check('Tab 条整体在编辑区上方（已搬进标题栏，不再是编辑区内部的行）', header.listAboveEditor, `listBottom=${header.listTop.toFixed(0)}`);
check('Tab 条贴在窗口最顶部', header.listTop < 60, `top=${header.listTop.toFixed(1)}px`);
check('Tab 与窗口关闭按钮同一水平线（垂直中心差 < 6px）',
  header.tabCenterY != null && header.winCenterY != null && Math.abs(header.tabCenterY - header.winCenterY) < 6,
  `tab=${header.tabCenterY?.toFixed(1)} win=${header.winCenterY?.toFixed(1)}`);
check('标题栏高度紧凑（30~50px）', header.titlebarH > 30 && header.titlebarH < 50, `${header.titlebarH.toFixed(1)}px`);
check('笔记头仍紧凑（< 34px）', header.noteHeaderH < 34, `${header.noteHeaderH.toFixed(1)}px`);
check('活动标签圆角统一 7px', header.tabRadius === '7px', header.tabRadius);

check('无渲染错误', errors.length === 0, errors.join(' | '));

await browser.close();
server.kill();
fs.rmSync(HOME, { recursive: true, force: true });
console.log('\n' + log.join('\n'));
process.exit(log.some((l) => l.startsWith('FAIL')) ? 1 : 0);
