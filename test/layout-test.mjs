import { launchBrowser as launchTestBrowser } from '../scripts/lib/browser.mjs';
/**
 * 布局回归：侧边栏折叠 + Tab 栏位置（标题栏模式）
 * 背景①：拖拽过栏宽后内联 style.width 会覆盖 .collapsed{width:0}，折叠失效——
 *   本套件锁死这个场景。
 * 背景②：Tab 栏已搬进标题栏（VS Code / Obsidian「Tab 标题栏」模式），
 *   与窗口按钮同一行；锁死「Tab 在编辑区上方 / 与窗口按钮同线 / 标题栏紧凑」。
 * 使用临时 TRACERY_HOME + demo-vault，不触碰用户真实仓库。
 */
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

const browser = await launchTestBrowser({
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
  document.querySelector('[data-path="欢迎使用 Tracery.md"]')?.click();
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
    documentHeaderVisible: !document.getElementById('document-header').hidden,
    documentPathMatches: document.getElementById('note-path').textContent === window.__tracery.state.currentPath,
    modeBtnInStatusbar: !!modeBtn?.closest('.statusbar'),
    modeBtnNearRight: btnRect ? (sbRect.right - btnRect.right) < 30 : false,
    modeBtnVisible: btnRect ? btnRect.width > 0 && btnRect.height > 0 : false,
  };
});
check('至少两个标签（启动自开的 + 点击两篇）', header.tabCount >= 2, `tabs=${header.tabCount}`);
check('Tab 条整体在编辑区上方（已搬进标题栏，不再是编辑区内部的行）', header.listAboveEditor, `listBottom=${header.listTop.toFixed(0)}`);
check('Tab 条贴在窗口最顶部', header.listTop < 60, `top=${header.listTop.toFixed(1)}px`);
// 卡片式标签（2026-10-19）：标签只有 33px 高、贴标题栏底边坐着，不再要求与窗口按钮同中心
check('标签卡片在标题栏内留出上下边距',
  header.tabBottom != null && header.titlebarBottom - header.tabBottom >= 3 && header.titlebarBottom - header.tabBottom <= 10,
  `tabBottom=${header.tabBottom?.toFixed(1)} titlebarBottom=${header.titlebarBottom?.toFixed(1)}`);
check('标题栏高度紧凑（30~50px）', header.titlebarH > 30 && header.titlebarH < 50, `${header.titlebarH.toFixed(1)}px`);
check('文档路径显示在编辑区上方，模式按钮仍在底部', header.noteHeaderGone && header.editorFirstChild === 'document-header' && header.documentHeaderVisible && header.documentPathMatches, `firstChild=${header.editorFirstChild}`);
check('模式切换按钮在状态栏、靠右、可见',
  header.modeBtnInStatusbar && header.modeBtnNearRight && header.modeBtnVisible,
  `inStatusbar=${header.modeBtnInStatusbar} nearRight=${header.modeBtnNearRight}`);
check('活动标签：垫纸色 + 底部强调线（标签条本身无缝）',
  header.tabActiveBg === 'sheet' && header.tabAccentLine,
  `bg=${header.tabActiveBg} accent=${header.tabAccentLine}`);

/* ---------- 2b. 缝隙配色 + 拖拽分隔条压在纸张边缘（2026-10-19 用户要求） ---------- */
const shell = await page.evaluate(() => {
  const paper = document.getElementById('editor-area').getBoundingClientRect();
  const l = document.getElementById('resizer-left').getBoundingClientRect();
  const r = document.getElementById('resizer-right').getBoundingClientRect();
  const rd = (v) => Math.round(v * 10) / 10;
  return {
    layoutBg: getComputedStyle(document.querySelector('.layout')).backgroundColor.replace(/\s+/g, ''),
    sidebarVar: getComputedStyle(document.documentElement).getPropertyValue('--bg-sidebar').trim().replace(/\s+/g, ''),
    leftCenter: rd(l.left + l.width / 2),
    rightCenter: rd(r.left + r.width / 2),
    paperLeft: rd(paper.left),
    paperRight: rd(paper.right),
  };
});
check('编辑区四周缝隙刷成侧栏底色（编辑区像浮在侧栏色页面上）',
  shell.layoutBg === shell.sidebarVar, JSON.stringify(shell));
check('拖拽分隔条压在纸张左/右边缘（±2px，与视觉边界重合）',
  Math.abs(shell.leftCenter - shell.paperLeft) <= 2 && Math.abs(shell.rightCenter - shell.paperRight) <= 2,
  JSON.stringify(shell));

/* ---------- 2c. 同底色 + 图标栏右缘与标签栏下缘的连续圆弧边界 ---------- */
const seamless = await page.evaluate(() => {
  const tb = document.querySelector('.titlebar');
  const ly = document.querySelector('.layout');
  const norm = (s) => (s || '').replace(/\s+/g, '');
  return {
    titlebarBorderBottom: getComputedStyle(tb).borderBottomWidth,
    titlebarBg: norm(getComputedStyle(tb).backgroundColor),
    layoutBg: norm(getComputedStyle(ly).backgroundColor),
    ribbonBg: norm(getComputedStyle(document.querySelector('.ribbon')).backgroundColor),
    sidebarBg: norm(getComputedStyle(document.getElementById('sidebar')).backgroundColor),
    rightBg: norm(getComputedStyle(document.getElementById('sidebar-right')).backgroundColor),
    sharedSurface: norm(getComputedStyle(ly, '::before').backgroundColor),
    sharedOpacity: getComputedStyle(ly, '::before').opacity,
  };
});
check('导航栏保持连续底色，侧栏和编辑区缝隙共用底色层',
  seamless.titlebarBorderBottom === '0px'
  && seamless.titlebarBg === seamless.layoutBg
  && seamless.ribbonBg === 'rgba(0,0,0,0)' && seamless.sidebarBg === 'rgba(0,0,0,0)' && seamless.rightBg === seamless.sidebarBg
  && seamless.sharedSurface !== 'rgba(0,0,0,0)' && seamless.sharedSurface !== seamless.layoutBg && seamless.sharedOpacity === '1',
  JSON.stringify(seamless));

for (const theme of ['light', 'dark']) {
  const boundary = await page.evaluate((theme) => {
    document.documentElement.dataset.theme = theme;
    const layout = document.querySelector('.layout');
    const line = getComputedStyle(layout, '::after');
    const rect = layout.getBoundingClientRect();
    const ribbon = document.querySelector('.ribbon').getBoundingClientRect();
    const titlebar = document.querySelector('.titlebar').getBoundingClientRect();
    return {
      left: rect.left + parseFloat(line.left), ribbonRight: ribbon.right,
      top: rect.top + parseFloat(line.top), tabBottom: titlebar.bottom,
      right: line.right, bottom: line.bottom,
      topWidth: line.borderTopWidth, leftWidth: line.borderLeftWidth,
      radius: parseFloat(line.borderTopLeftRadius), pointerEvents: line.pointerEvents,
      color: line.borderTopColor,
    };
  }, theme);
  check(`${theme} 主题：分割线对齐图标栏右缘和标签栏下缘，圆弧相连且不拦鼠标`,
    Math.abs(boundary.left - boundary.ribbonRight) < 1 && Math.abs(boundary.top - boundary.tabBottom) < 1
    && boundary.topWidth === '1px' && boundary.leftWidth === '1px' && boundary.radius >= 12
    && boundary.right === '0px' && boundary.bottom === '0px' && boundary.pointerEvents === 'none'
    && boundary.color !== 'rgba(0, 0, 0, 0)', JSON.stringify(boundary));
}
await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });

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

// ② 源码模式行号：源码模式共用同一视图，行号一直由 lineNumbers compartment 提供。

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
