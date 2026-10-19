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

const ENGINE = process.env.TRACERY_TEST_ENGINE || 'block';   // 内核：默认 block，cm 用 TRACERY_TEST_ENGINE=cm
const IS_CM = ENGINE === 'cm';
await page.goto(`http://localhost:${PORT}/?engine=${ENGINE}`, { waitUntil: 'networkidle0' });
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
  const statusbar = document.querySelector('.statusbar');
  const modeBtn = document.getElementById('btn-mode');
  const editorArea = document.getElementById('editor-area');
  const activeTab = document.querySelector('.tab.active');
  const winClose = document.getElementById('win-close');
  const listRect = list.getBoundingClientRect();
  const editorRect = editorArea.getBoundingClientRect();
  const tabRect = activeTab?.getBoundingClientRect();
  const winRect = winClose?.getBoundingClientRect();
  const titlebarRect = titlebar.getBoundingClientRect();
  const accentLine = activeTab ? getComputedStyle(activeTab, '::after') : null;
  const sbRect = statusbar.getBoundingClientRect();
  const btnRect = modeBtn?.getBoundingClientRect();
  return {
    tabCount: document.querySelectorAll('.tab').length,
    titlebarH: titlebar.getBoundingClientRect().height,
    listTop: listRect.top,
    listAboveEditor: listRect.bottom <= editorRect.top + 1,
    tabCenterY: tabRect ? tabRect.top + tabRect.height / 2 : null,
    winCenterY: winRect ? winRect.top + winRect.height / 2 : null,
    tabBottom: tabRect ? tabRect.bottom : null,
    titlebarBottom: titlebarRect.bottom,
    tabAccentLine: accentLine ? (parseFloat(accentLine.height) || 0) >= 2 && accentLine.backgroundColor !== 'rgba(0, 0, 0, 0)' : false,
    tabRadius: activeTab ? getComputedStyle(activeTab).borderRadius : '',
    tabActiveBg: (() => {
      if (!activeTab) return '';
      const tabBg = getComputedStyle(activeTab).backgroundColor;
      const paperBg = getComputedStyle(document.getElementById('editor-area')).backgroundColor;
      return tabBg === paperBg ? 'sheet' : tabBg;
    })(),
    noteHeaderGone: !noteHeader,
    editorFirstChild: editorArea.firstElementChild?.className || '',
    modeBtnInStatusbar: !!modeBtn?.closest('.statusbar'),
    modeBtnNearRight: btnRect ? (sbRect.right - btnRect.right) < 30 : false,
    modeBtnVisible: btnRect ? btnRect.width > 0 && btnRect.height > 0 : false,
  };
});
check('至少两个标签（启动自开的 + 点击两篇）', header.tabCount >= 2, `tabs=${header.tabCount}`);
check('Tab 条整体在编辑区上方（已搬进标题栏，不再是编辑区内部的行）', header.listAboveEditor, `listBottom=${header.listTop.toFixed(0)}`);
check('Tab 条贴在窗口最顶部', header.listTop < 60, `top=${header.listTop.toFixed(1)}px`);
// 卡片式标签（2026-10-19）：标签只有 33px 高、贴标题栏底边坐着，不再要求与窗口按钮同中心
check('标签卡片底边贴着标题栏底边（±2px）',
  header.tabBottom != null && Math.abs(header.tabBottom - header.titlebarBottom) <= 2,
  `tabBottom=${header.tabBottom?.toFixed(1)} titlebarBottom=${header.titlebarBottom?.toFixed(1)}`);
check('标题栏高度紧凑（30~50px）', header.titlebarH > 30 && header.titlebarH < 50, `${header.titlebarH.toFixed(1)}px`);
check('笔记头行已删除（界面不再显示文件名+模式那一行）', header.noteHeaderGone && header.editorFirstChild === 'editor-wrap', `firstChild=${header.editorFirstChild}`);
check('模式切换按钮在状态栏、靠右、可见',
  header.modeBtnInStatusbar && header.modeBtnNearRight && header.modeBtnVisible,
  `inStatusbar=${header.modeBtnInStatusbar} nearRight=${header.modeBtnNearRight}`);
check('活动标签：垫纸色 + 底部强调线（标签条本身无缝）',
  header.tabActiveBg === 'sheet' && header.tabAccentLine,
  `bg=${header.tabActiveBg} accent=${header.tabAccentLine}`);

/* ================= 3. 图片查看 / 行号 / 折叠图标 ================= */

// ① 文件树点图片 → 灯箱查看（以前会尝试当笔记打开，报「笔记不存在」）
await page.evaluate(() => document.querySelector('[data-path="附件/图谱示例.png"]')?.click());
await sleep(1000);
const imgView = await page.evaluate(() => ({
  open: !!document.querySelector('.lightbox') && !document.querySelector('.lightbox').hidden,
  src: document.querySelector('.lb-img')?.getAttribute('src') || '',
}));
check('文件树点图片 → 灯箱打开', imgView.open && decodeURIComponent(imgView.src).includes('图谱示例'), JSON.stringify(imgView));
await page.keyboard.press('Escape');
await sleep(400);

// ② 源码模式行号（实时预览模式不显示）
if (IS_CM) {
  // cm 的源码模式是「同一个 view 关掉装饰」，没有独立的 #source-wrap / textarea / 行号槽
  // （行号一直由 lineNumbers compartment 提供）→ 该条按引擎门控（见 7.9-C）
  console.log('  ⏭ 跳过「源码模式独立行号槽」：cm 源码模式共用同一视图，无 #source-wrap');
} else {
  const srcMode = await page.evaluate(async () => {
    document.getElementById('btn-mode').click();   // 切源码
    await new Promise((r) => setTimeout(r, 500));
    const gutter = document.getElementById('source-gutter');
    const wrap = document.getElementById('source-wrap');
    const src = document.getElementById('editor-source');
    const sourceState = { wrapVisible: !wrap.hidden, count: gutter.childElementCount, lines: src.value.split('\n').length };
    document.getElementById('btn-mode').click();   // 切回实时
    await new Promise((r) => setTimeout(r, 400));
    return { ...sourceState, liveHidden: wrap.hidden };
  });
  check('源码模式显示行号且数量=文本行数', srcMode.wrapVisible && srcMode.count === srcMode.lines, `gutter=${srcMode.count} lines=${srcMode.lines}`);
  check('实时预览模式不显示行号', srcMode.liveHidden);
}

// ③ 折叠/展开全部图标随状态变化
const iconState = await page.evaluate(async () => {
  const btn = document.getElementById('btn-collapse-tree');
  const pathOf = () => btn.querySelector('path')?.getAttribute('d') || '';
  const before = { d: pathOf(), title: btn.title };
  btn.click();                                   // 全折叠
  await new Promise((r) => setTimeout(r, 400));
  const collapsed = { d: pathOf(), title: btn.title };
  btn.click();                                   // 再展开
  await new Promise((r) => setTimeout(r, 400));
  return { before, collapsed, after: { d: pathOf(), title: btn.title } };
});
check('折叠后图标切换为「展开」', iconState.before.d !== iconState.collapsed.d && iconState.collapsed.title === '展开全部文件夹', iconState.collapsed.title);
check('展开后图标切回「折叠」', iconState.collapsed.d !== iconState.after.d && iconState.after.title === '折叠全部文件夹', iconState.after.title);

check('无渲染错误', errors.length === 0, errors.join(' | '));

await browser.close();
server.kill();
fs.rmSync(HOME, { recursive: true, force: true });
console.log('\n' + log.join('\n'));
process.exit(log.some((l) => l.startsWith('FAIL')) ? 1 : 0);
