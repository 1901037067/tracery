/**
 * 界面修复验证：Windows 窗口按钮 / 主题图标 / 欢迎页浮层与仓库管理
 * 使用临时 TRACERY_HOME + demo-vault，不触碰用户真实仓库。
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 9551;
const HOME = path.join(process.env.TEMP || '/tmp', 'tracery-uicheck-home');
const SHOTS = path.join(ROOT, 'test', 'screenshots');
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
  args: ['--no-sandbox', '--force-device-scale-factor=2'],
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

// 1. 主题图标：暗色只显示月亮
const icons = await page.evaluate(() => {
  const sun = document.querySelector('.ic-sun');
  const moon = document.querySelector('.ic-moon');
  return {
    theme: document.documentElement.dataset.theme,
    sun: getComputedStyle(sun).display,
    moon: getComputedStyle(moon).display,
  };
});
check('暗色模式只显示月亮图标', icons.theme === 'dark' && icons.sun === 'none' && icons.moon === 'block', JSON.stringify(icons));

await page.evaluate(() => {
  const btn = document.getElementById('btn-theme');
  btn.click(); // 切到亮色
});
await sleep(500);
const iconsLight = await page.evaluate(() => {
  const sun = document.querySelector('.ic-sun');
  const moon = document.querySelector('.ic-moon');
  return { theme: document.documentElement.dataset.theme, sun: getComputedStyle(sun).display, moon: getComputedStyle(moon).display };
});
check('亮色模式只显示太阳图标', iconsLight.theme === 'light' && iconsLight.sun === 'block' && iconsLight.moon === 'none', JSON.stringify(iconsLight));
// 切回暗色（截图用）
await page.evaluate(() => document.getElementById('btn-theme').click());
await sleep(400);

// 2. 窗口按钮结构（浏览器下隐藏，Electron 下显示）
const winBtns = await page.evaluate(() => ({
  exists: ['win-min', 'win-max', 'win-close'].every((id) => document.getElementById(id)),
  parent: document.querySelector('.win-controls')?.parentElement?.className || '',
  traffic: !!document.querySelector('.traffic-lights'),
}));
check('窗口按钮在右上角、旧红绿灯已移除', winBtns.exists && /titlebar-right/.test(winBtns.parent) && !winBtns.traffic, JSON.stringify(winBtns));

// 3. 工作区下拉（2026-10-19 起：点工作区名先出下拉，不再直接跳管理页）
const openVaultMenu = async () => {
  await page.evaluate(() => document.getElementById('vault-name').click());
  await sleep(400);
};
const openManage = async () => {
  if (!await page.$eval('#vault-name', (el) => el.getAttribute('aria-expanded') === 'true')) await openVaultMenu();
  await page.evaluate(() => [...document.querySelectorAll('.context-menu button')]
    .find((b) => b.textContent.includes('管理仓库'))?.click());
  await sleep(500);
};
await page.screenshot({ path: path.join(SHOTS, 'ui-app-dark.png') });
await openVaultMenu();
const menu = await page.evaluate(() => ({
  open: !!document.querySelector('.context-menu'),
  items: [...document.querySelectorAll('.context-menu button')].map((b) => b.textContent.trim()),
  welcomeStillHidden: document.getElementById('welcome').hidden,
  checked: document.querySelectorAll('.context-menu .mi-icon svg').length,
}));
check('点工作区名先弹下拉（不直接跳管理页）',
  menu.open && menu.welcomeStillHidden && menu.items.some((t) => t.includes('管理仓库')), JSON.stringify(menu));
check('下拉里列出最近仓库（当前仓库有标记）', menu.items.length >= 2 && menu.checked >= 1, menu.items.join(' / '));
await page.screenshot({ path: path.join(SHOTS, 'ui-vault-menu-dark.png') });
await page.click('#vault-name');
check('再次点击仓库名收起下拉菜单', await page.evaluate(() => !document.querySelector('.context-menu')));
await page.evaluate(() => { const btn = document.getElementById('vault-name'); btn.click(); btn.click(); });
await sleep(500);
check('快速双击不会被迟到的响应重新展开菜单', await page.evaluate(() =>
  !document.querySelector('.context-menu') && document.getElementById('vault-name').getAttribute('aria-expanded') === 'false'));
await openManage();
const overlay = await page.evaluate(() => ({
  welcomeOpen: !document.getElementById('welcome').hidden,
  appVisible: !document.getElementById('app').hidden,
  closeVisible: !document.getElementById('btn-welcome-close').hidden,
  recentCount: document.querySelectorAll('#recent-list .recent-item').length,
  currentBadge: document.querySelectorAll('.recent-badge').length,
  removeBtns: document.querySelectorAll('.recent-remove').length,
}));
check('仓库浮层打开且应用仍在背后', overlay.welcomeOpen && overlay.appVisible, JSON.stringify(overlay));
check('浮层有关闭按钮 + 最近仓库 + 当前标记', overlay.closeVisible && overlay.recentCount >= 1 && overlay.currentBadge === 1 && overlay.removeBtns === overlay.recentCount);
await page.screenshot({ path: path.join(SHOTS, 'ui-vault-switcher-dark.png') });

// 4. Esc 关闭浮层
await page.keyboard.press('Escape');
await sleep(400);
const afterEsc = await page.evaluate(() => ({
  welcomeOpen: !document.getElementById('welcome').hidden,
  appVisible: !document.getElementById('app').hidden,
  editorVisible: !!document.querySelector('#editor-live .cm-editor .cm-content'),
}));
check('Esc 可退出浮层并回到编辑器', !afterEsc.welcomeOpen && afterEsc.appVisible && afterEsc.editorVisible, JSON.stringify(afterEsc));

// 5. 关闭按钮（切换仓库入口统一收敛到左上角工作区名称）
await openManage();
await page.evaluate(() => document.getElementById('btn-welcome-close').click());
await sleep(300);
const afterClose = await page.evaluate(() => !document.getElementById('welcome').hidden);
check('关闭按钮可退出浮层', !afterClose);

// 6. 移除最近仓库（临时配置，安全）
await openManage();
const before = await page.evaluate(() => document.querySelectorAll('#recent-list .recent-item').length);
// 建第二个临时仓库并打开，制造两条记录
const secondVault = path.join(HOME, 'second-vault');
fs.mkdirSync(secondVault, { recursive: true });
fs.writeFileSync(path.join(secondVault, '另一仓库.md'), '# 第二个仓库\n\n用来测试仓库切换。\n', 'utf8');
await page.evaluate(async (vp) => {
  const r = await fetch('/api/vault/open', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: vp }),
  });
  return r.status;
}, secondVault.replace(/\\/g, '/'));
await sleep(1500);
await openManage();
const twoItems = await page.evaluate(() => document.querySelectorAll('#recent-list .recent-item').length);
check('最近仓库列表随打开新增', twoItems >= 2, `items=${twoItems} (之前 ${before})`);
check('切换仓库后标题栏同步', await page.evaluate(() => document.getElementById('vault-name').textContent.includes('second-vault')));

// 移除第一个（当前仓库）
const removeResult = await page.evaluate(async () => {
  const first = document.querySelector('#recent-list .recent-item .recent-remove');
  first.click();
  await new Promise((r) => setTimeout(r, 700));
  return document.querySelectorAll('#recent-list .recent-item').length;
});
check('可从最近列表移除仓库（不删文件）', removeResult === twoItems - 1, `剩下 ${removeResult}`);

// 7. 亮色浮层截图
await page.evaluate(() => document.getElementById('btn-theme').click());
await sleep(500);
await page.screenshot({ path: path.join(SHOTS, 'ui-vault-switcher-light.png') });

check('无渲染错误', errors.length === 0, errors.join(' | '));

await browser.close();
server.kill();
fs.rmSync(HOME, { recursive: true, force: true });
console.log('\n' + log.join('\n'));
process.exit(log.some((l) => l.startsWith('FAIL')) ? 1 : 0);
