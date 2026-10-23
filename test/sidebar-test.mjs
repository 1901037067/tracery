/** 用临时仓库和真实鼠标验证精简侧栏、背景菜单、重复标题定位及跨仓库状态归属。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { launchBrowser } from './browser.mjs';
import { phoneAccess } from '../server/access.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tracery-sidebar-'));
const VAULT = path.join(HOME, 'one'), OTHER = path.join(HOME, 'two');
const PORT = 9624, BASE = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const screenshot = name => path.join(ROOT, 'dist/sidebar-preview', `${name}.png`);
fs.mkdirSync(VAULT); fs.mkdirSync(OTHER);
fs.mkdirSync(path.dirname(screenshot('desktop')), { recursive: true });
fs.writeFileSync(path.join(VAULT, '主笔记.md'), '# 项目\n\n## 同名\n\n第一段\n\n### 子标题\n\n## 同名\n\n第二段 [[目标]] [[尚未创建]] #计划\n');
fs.writeFileSync(path.join(VAULT, '目标.md'), '# 目标\n\n#资料\n');
fs.writeFileSync(path.join(VAULT, '来源.md'), '# 来源\n\n参考 [[主笔记]]\n');
fs.writeFileSync(path.join(OTHER, '主笔记.md'), '# 另一个仓库\n');
fs.writeFileSync(path.join(HOME, 'tracery.config.json'), JSON.stringify({ currentVault: VAULT, settings: { startup: 'empty' } }));
const packedExe = process.env.TRACERY_TEST_EXE;
const serverScript = packedExe ? path.join(path.dirname(packedExe), 'resources/app.asar/server/server.js') : path.join(ROOT, 'server/server.js');
const server = spawn(packedExe || process.execPath, [serverScript], { cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), TRACERY_HOME: HOME, ...(packedExe ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }, stdio: 'pipe', windowsHide: true });
let browser;
try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/api/state')).ok) break; } catch {} await sleep(250); }
  const lan = phoneAccess(9521, { wifi: [{ family: 'IPv4', internal: false, address: '192.168.1.20' }, { family: 'IPv6', internal: false, address: '::1' }], lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }] });
  assert.equal(lan.addresses.length, 1); assert.equal(lan.addresses[0].url, 'http://192.168.1.20:9521'); assert.equal(lan.access, 'read-write');
  browser = await launchBrowser(); const page = await browser.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  assert.equal(await page.$('#btn-new-note'), null);
  assert.equal(await page.$$eval('#panel-files .library-view:not([hidden])', es => es.length), 1);
  assert.equal(await page.$eval('#section-library', e => e.hidden), false);
  assert.equal(await page.$eval('#panel-outline', e => e.hidden), false);
  assert.equal(await page.$eval('#panel-note-tags', e => e.hidden), true);
  assert.equal(await page.$$eval('#panel-files .panel-header > span:first-child, #panel-search .panel-header, #panel-tags .panel-header', es => es.length), 0);
  const phonePosition = await page.evaluate(() => {
    const theme = document.getElementById('btn-theme').getBoundingClientRect(), phone = document.getElementById('btn-phone-access').getBoundingClientRect(), settings = document.getElementById('btn-settings').getBoundingClientRect();
    return theme.bottom <= phone.top && phone.bottom <= settings.top && !!document.querySelector('.ribbon #btn-phone-access');
  });
  assert.ok(phonePosition);
  // 根目录空白是真实鼠标右键，不用合成事件绕过点击区域。
  async function backgroundMenu() {
    const rect = await page.$eval('#file-tree', e => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.bottom - 24 }; });
    await page.mouse.click(rect.x, rect.y, { button: 'right' });
    await page.waitForSelector('.context-menu');
  }
  const menuAction = text => page.evaluate(text => [...document.querySelectorAll('.context-menu button')].find(b => b.textContent.includes(text)).click(), text);
  async function nameDialog(name) {
    await page.waitForSelector('.dialog-input');
    await page.$eval('.dialog-input', (e, name) => { e.value = name; e.dispatchEvent(new Event('input', { bubbles: true })); }, name);
    await page.click('.dialog-ok');
  }
  await backgroundMenu();
  assert.ok(await page.$eval('.context-menu', e => ['新建笔记', '新建文件夹', '回收站'].every(text => e.textContent.includes(text))));
  await menuAction('新建文件夹'); await nameDialog('根目录文件夹');
  await page.waitForSelector('#file-tree [data-dir="根目录文件夹"]');
  assert.ok(fs.existsSync(path.join(VAULT, '根目录文件夹')));
  await backgroundMenu(); await menuAction('新建笔记'); await nameDialog('空白菜单创建');
  await page.waitForFunction(() => window.__tracery.state.currentPath === '空白菜单创建.md');
  assert.ok(fs.existsSync(path.join(VAULT, '空白菜单创建.md')));
  await page.evaluate(async () => { await window.__tracery.Api.remove('空白菜单创建.md'); await window.__tracery.Api.remove('根目录文件夹'); });
  await page.waitForFunction(() => window.__tracery.state.files.size === 3);
  console.log('PASS 首屏仅文件树与大纲、移除冗余标题和底部加号、手机按钮顺序、空白右键创建根目录文件及文件夹');
  await page.click('#file-tree [data-path="主笔记.md"]');
  await page.waitForFunction(() => document.querySelectorAll('#outline-list .outline-item').length === 4);
  await page.waitForFunction(() => document.getElementById('backlinks-list').textContent.includes('尚未创建'));
  assert.ok(await page.$eval('#backlinks-list', e => e.textContent.includes('来源') && e.textContent.includes('目标')));
  await page.click('#tab-info');
  assert.ok(await page.$eval('#note-tags-list', e => e.textContent.includes('#计划')));
  assert.notEqual(await page.$eval('#note-info-modified', e => e.textContent), '—');
  await page.click('#tab-links');
  assert.equal(await page.$eval('#panel-outline', e => e.hidden), true);
  assert.equal(await page.$$eval('.sidebar-sections > section:not([hidden])', es => es.length), 1);
  await page.reload({ waitUntil: 'networkidle0' });
  assert.equal(await page.$eval('#panel-backlinks', e => e.hidden), false);
  assert.equal(await page.$eval('#panel-note-tags', e => e.hidden), true);
  // startup=empty：刷新后仍是空工作区，不能残留上篇笔记的大纲或标签。
  assert.equal(await page.$$eval('#outline-list .outline-item', es => es.length), 0);
  await page.click('#file-tree [data-path="主笔记.md"]');
  await page.click('#tab-outline');
  await page.waitForSelector('#outline-list [data-line="9"]');
  await page.click('#outline-list [data-line="9"]');
  assert.equal(await page.evaluate(() => window.__editor.view.state.doc.lineAt(window.__editor.view.state.selection.main.head).number), 9);
  const active = await page.$eval('#outline-list .outline-item[aria-current="location"]', e => e.dataset.line); assert.equal(active, '9');
  await page.click('#outline-list .outline-row[data-line="3"] .outline-toggle');
  assert.equal(await page.$eval('#outline-children-3', e => e.hidden), true);
  await page.evaluate(() => window.__tracery.togglePin('主笔记.md'));
  await page.click('#tab-pinned');
  assert.equal(await page.$$eval('#pinned-list .pinned-item', es => es.length), 1);
  await page.click('#tab-recent');
  assert.ok(await page.$$eval('#recent-notes .recent-item', es => es.length >= 1));
  assert.equal(await page.$eval('#section-library', e => e.hidden), true);
  await page.keyboard.press('Home');
  assert.equal(await page.$eval('#tab-library', e => e.getAttribute('aria-selected')), 'true');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.$eval('#tab-pinned', e => e.getAttribute('aria-selected')), 'true');
  await page.reload({ waitUntil: 'networkidle0' });
  assert.equal(await page.$eval('#section-pinned', e => e.hidden), false);
  await page.click('#pinned-list .pinned-item');
  await page.waitForFunction(() => window.__tracery.state.currentPath === '主笔记.md');
  await page.click('#tab-library');
  console.log('PASS 单内容切换、选择记忆、键盘导航、重复标题精确定位、标题折叠、收藏和最近打开');
  await page.click('#tab-links');
  await page.waitForFunction(() => document.getElementById('backlinks-list').textContent.includes('尚未创建'));
  await page.evaluate(() => {
    const api = window.__tracery.Api, original = api.links;
    api.links = async p => { const result = await original(p); if (p === '主笔记.md') await new Promise(r => setTimeout(r, 900)); return result; };
    window.__tracery.switchRightPanel('backlinks');
  });
  await sleep(250);
  await page.click('#file-tree [data-path="目标.md"]');
  await sleep(1200);
  assert.equal(await page.$eval('#note-info-path', e => e.textContent), '目标.md');
  const groups = await page.$$eval('#backlinks-list .relation-heading', es => es.map(e => e.textContent));
  assert.ok(groups.includes('链接到此笔记 · 1') && !groups.some(text => text.includes('本笔记链接到')));
  assert.equal(await page.$('#backlinks-list .relation-unresolved'), null);
  assert.ok(!(await page.$eval('#note-tags-list', e => e.textContent)).includes('#计划'));
  console.log('PASS 切换笔记后忽略迟到的关联响应，信息和标签同步更新');
  // 恢复一个有内容的桌面画面用于视觉检查。
  await page.click('#file-tree [data-path="主笔记.md"]');
  await page.waitForFunction(() => window.__tracery.state.currentPath === '主笔记.md' && document.querySelector('#backlinks-list .relation-heading')?.textContent.includes('链接到此笔记'));
  await page.click('#tab-outline');
  await page.screenshot({ path: screenshot('desktop-dark') });
  await page.click('#btn-theme');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await sleep(250);
  await page.screenshot({ path: screenshot('desktop') });
  await page.click('#btn-phone-access');
  await page.waitForFunction(() => !document.getElementById('phone-addresses').textContent.includes('正在读取'));
  assert.ok(await page.$eval('.phone-permissions', e => e.textContent.includes('编辑')));
  assert.equal(await page.$eval('#app', e => e.inert), true);
  const addresses = await (await fetch(BASE + '/api/access')).json();
  if (addresses.addresses.length) assert.ok(addresses.addresses.every(a => new URL(a.url).port === String(PORT)));
  await page.keyboard.press('Escape'); assert.equal(await page.$eval('#app', e => e.inert), false);
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await sleep(250);
  await page.waitForFunction(() => !!window.__tracery?.state.tree);
  await page.evaluate(() => window.__tracery.openNote('主笔记.md'));
  await page.tap('#btn-toggle-right');
  await page.tap('#tab-info');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  await page.screenshot({ path: screenshot('mobile-right') });
  await page.keyboard.press('Escape');
  await page.tap('#btn-toggle-left');
  await page.tap('#btn-phone-access');
  assert.equal(await page.$eval('#phone-access-panel', e => e.hidden), false);
  await page.screenshot({ path: screenshot('mobile-phone') });
  await page.tap('#btn-phone-close');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'btn-toggle-left');
  await page.setViewport({ width: 1440, height: 900 });
  await page.reload({ waitUntil: 'networkidle0' });
  console.log('PASS 手机访问实际端口、权限说明、焦点返回和移动端抽屉');
  async function switchVault(root, count) {
    await page.waitForFunction(() => window.__tracery?.state.tree && typeof document.getElementById('vault-name').onclick === 'function');
    await page.click('#vault-name');
    await page.waitForSelector('.context-menu button:last-child');
    await page.click('.context-menu button:last-child');
    await page.waitForSelector('#welcome:not([hidden])');
    await page.$eval('#vault-path', el => { el.value = ''; });
    await page.type('#vault-path', root);
    await page.click('#btn-open-vault');
    await page.waitForFunction(root => window.__tracery.state.vault.root === root, {}, root);
    await page.waitForFunction(count => window.__tracery.state.files.size === count, {}, count);
  }
  await switchVault(OTHER, 1);
  assert.equal(await page.$$eval('#pinned-list .pinned-item', es => es.length), 0);
  assert.equal(await page.$$eval('#recent-notes .recent-item', es => es.length), 0);
  await switchVault(VAULT, 3);
  await page.waitForFunction(() => document.querySelectorAll('#pinned-list .pinned-item').length === 1);
  assert.ok(await page.$$eval('#recent-notes .recent-item', es => es.length >= 2));
  console.log('PASS 不同仓库同名文件的收藏与最近打开互不串库');
  // 外部删除最后一个打开的标签后，右栏必须清掉已不存在笔记的信息。
  await page.click('#btn-tab-more');
  await page.evaluate(() => [...document.querySelectorAll('.context-menu button')].find(b => b.textContent.includes('关闭所有标签页')).click());
  await page.waitForFunction(() => window.__tracery.state.currentPath === null);
  await page.evaluate(() => window.__tracery.openNote('主笔记.md'));
  await page.evaluate(() => window.__tracery.Api.remove('主笔记.md'));
  await page.waitForFunction(() => window.__tracery.state.currentPath === null && document.querySelectorAll('#outline-list .outline-item').length === 0);
  assert.equal(await page.$eval('#note-info-path', e => e.textContent), '未打开笔记');
  console.log('PASS 外部删除最后一篇打开的笔记后清空右栏');
  // 拖至桌面最窄宽度，以及小手机抽屉，三个导航与工具按钮仍须在栏内。
  await page.$eval('#sidebar', e => { e.style.width = '190px'; });
  const toolsFit = () => page.evaluate(() => {
    const sidebar = document.getElementById('sidebar').getBoundingClientRect();
    return [...document.querySelectorAll('.library-header button')].filter(b => b.getClientRects().length).every(b => {
      const r = b.getBoundingClientRect(); return r.left >= sidebar.left && r.right <= sidebar.right + 1;
    });
  });
  await sleep(250); assert.ok(await toolsFit());
  await page.setViewport({ width: 320, height: 720, isMobile: true, hasTouch: true });
  await page.tap('#btn-toggle-left'); await sleep(250); assert.ok(await toolsFit());
  await page.screenshot({ path: screenshot('mobile-left-small') });
  await page.keyboard.press('Escape');
  await page.setViewport({ width: 1440, height: 900 });
  await page.$eval('#sidebar', e => { e.style.width = '272px'; });
  await switchVault(OTHER, 1);
  await page.evaluate(() => window.__tracery.Api.remove('主笔记.md'));
  await page.waitForFunction(() => window.__tracery.state.files.size === 0);
  await backgroundMenu(); await menuAction('新建笔记'); await nameDialog('空仓首篇');
  await page.waitForFunction(() => window.__tracery.state.currentPath === '空仓首篇.md');
  assert.ok(fs.existsSync(path.join(OTHER, '空仓首篇.md')));
  console.log('PASS 190px桌面栏与320px手机按钮不溢出，空仓背景右键可创建第一篇笔记');
  assert.deepEqual(errors, []);
  console.log('PASS 无浏览器脚本错误');
} finally {
  await browser?.close();
  const stopped = new Promise(resolve => server.once('exit', resolve)); server.kill(); await stopped;
  fs.rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
