import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { launchBrowser } from './browser.mjs';
import { tidyTabGroups, moveTabToGroup, renameTabKeys } from '../public/js/tab-workspace.js';

const ROOT = path.resolve(import.meta.dirname, '..'), HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tracery-tab-groups-'));
const VAULT = path.join(HOME, 'vault'), OUT = path.join(ROOT, 'dist/tab-groups'); fs.mkdirSync(VAULT); fs.mkdirSync(OUT, { recursive: true });
for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(VAULT, `笔记${i}.md`), `# 笔记${i}\n\n正文${i}`);
fs.writeFileSync(path.join(HOME, 'tracery.config.json'), JSON.stringify({ currentVault: VAULT, settings: { themeMode: 'light' } }));
const model = { tabs: ['a', 'b', 'c'], activeTab: 1, tabGroups: [{ id: 'g', name: '组', color: 'teal', tabs: ['a', 'c'] }] };
tidyTabGroups(model); assert.deepEqual(model.tabs, ['a', 'c', 'b']); assert.equal(model.tabs[model.activeTab], 'b');
moveTabToGroup(model, 'b', 'g'); assert.deepEqual(model.tabGroups[0].tabs, ['a', 'c', 'b']);
renameTabKeys(model, key => key === 'b' ? 'renamed' : key); assert.ok(model.tabGroups[0].tabs.includes('renamed'));
const PORT = 9638, BASE = `http://127.0.0.1:${PORT}`, sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const packed = process.env.TRACERY_TEST_EXE, entry = packed ? path.join(path.dirname(packed), 'resources/app.asar/server/server.js') : path.join(ROOT, 'server/server.js');
const server = spawn(packed || process.execPath, [entry], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), TRACERY_HOME: HOME, ...(packed ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }, windowsHide: true, stdio: 'pipe' });
let browser, page;
const errors = [];
try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/api/state')).ok) break; } catch {} await sleep(200); }
  browser = await launchBrowser({ width: 1440, height: 900 }); page = await browser.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  const menu = async label => { await page.waitForSelector('.context-menu', { visible: true }); await page.evaluate(label => { const button = [...document.querySelectorAll('.context-menu button')].find(node => node.textContent.trim() === label); if (!button) throw new Error(`菜单缺少 ${label}`); button.click(); }, label); };
  const tab = key => page.evaluate(key => [...document.querySelectorAll('#tablist .tab')].find(node => node.querySelector('.tab-name').textContent === key)?.dataset.index, key);
  const context = async key => { const index = await tab(key); await page.click(`#tablist .tab[data-index="${index}"]`, { button: 'right' }); };
  const open = async i => page.evaluate(i => window.__tracery.openNote(`笔记${i}.md`, null, { newTab: true }), i);
  const snapshot = () => page.evaluate(() => JSON.parse(JSON.stringify({ tabs: window.__tracery.state.tabs, groups: window.__tracery.state.tabGroups, active: window.__tracery.state.activeTab, path: window.__tracery.state.currentPath })));
  await open(1); await open(2); await open(3);
  // + 打开空白标签，不创建文件；快速打开替换该标签。
  const filesBefore = fs.readdirSync(VAULT).filter(name => name.endsWith('.md')).length;
  await page.click('#btn-tab-new'); await page.waitForSelector('#empty-note', { visible: true });
  assert.equal((await snapshot()).path, null); assert.ok((await snapshot()).tabs.at(-1).startsWith('tracery:blank:'));
  assert.equal(fs.readdirSync(VAULT).filter(name => name.endsWith('.md')).length, filesBefore);
  const blankCount = (await snapshot()).tabs.length;
  await page.click('#empty-open-note'); await page.type('#palette-input', '笔记4'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__tracery.state.currentPath === '笔记4.md');
  assert.equal((await snapshot()).tabs.length, blankCount);
  // 右键新建组，修改名称、颜色。
  await context('笔记1'); await menu('添加到新分组'); await page.waitForSelector('.tab-group-editor input');
  await page.$eval('.tab-group-editor input', node => node.select()); await page.type('.tab-group-editor input', '工具');
  await page.click('.tab-group-color[data-color="orange"]'); await page.click('.tab-group-editor input'); await page.keyboard.press('Enter');
  let state = await snapshot(); const toolId = state.groups[0].id; assert.equal(state.groups[0].name, '工具');
  await context('笔记2'); await menu('移入「工具」');
  await context('笔记3'); await menu('添加到新分组'); await page.waitForSelector('.tab-group-editor input');
  await page.$eval('.tab-group-editor input', node => node.select()); await page.type('.tab-group-editor input', '上课');
  await page.click('.tab-group-color[data-color="teal"]'); await page.click('.tab-group-editor input'); await page.keyboard.press('Enter');
  state = await snapshot(); assert.equal(state.groups.length, 2); assert.ok(state.groups.some(group => group.color === 'teal'));
  const classId = state.groups.find(group => group.name === '上课').id;
  await page.click('#btn-tab-more'); await menu('笔记1'); await page.waitForFunction(() => window.__tracery.state.currentPath === '笔记1.md');
  const expandedLook = await page.evaluate(id => {
    const header = [...document.querySelectorAll('.tab-group-header')].find(node => node.dataset.group === id);
    const rail = [...document.querySelectorAll('.tab-group-rail')].find(node => node.dataset.group === id);
    const members = [...document.querySelectorAll('.tab')].filter(node => node.dataset.group === id);
    const active = members.find(node => node.classList.contains('active'));
    return { right: rail.getBoundingClientRect().right, end: members.at(-1).getBoundingClientRect().right, gap: header.querySelector('.tab-group-label').getBoundingClientRect().top - rail.getBoundingClientRect().bottom,
      underline: getComputedStyle(active, '::after').backgroundColor, accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(), group: getComputedStyle(rail).backgroundColor, radius: parseFloat(getComputedStyle(active).borderTopLeftRadius),
      topBorder: getComputedStyle(active).borderTopColor,
      centers: [header.querySelector('.tab-group-label'), ...document.querySelectorAll('#tablist .tab:not([hidden]) .tab-name')].map(el => { const r = document.createRange(); r.selectNodeContents(el); const box = r.getBoundingClientRect(); return box.top + box.height / 2; }),
      tops: members.map(tab => tab.getBoundingClientRect().top), railBottom: rail.getBoundingClientRect().bottom };
  }, toolId);
  assert.ok(Math.abs(expandedLook.right - expandedLook.end) < 1); assert.ok(expandedLook.gap >= 6);
  assert.ok(expandedLook.radius >= 10);
  assert.notEqual(expandedLook.topBorder, expandedLook.group);
  assert.ok(Math.max(...expandedLook.centers) - Math.min(...expandedLook.centers) <= 1.5, JSON.stringify(expandedLook.centers));
  assert.ok(expandedLook.tops.every(top => top >= expandedLook.railBottom));
  await page.screenshot({ path: path.join(OUT, 'group-active-connected.png'), clip: { x: 140, y: 0, width: 1000, height: 52 } });
  await open(4);
  await page.click(`.tab-group-header[data-group="${toolId}"]`);
  assert.equal(await page.$$eval(`.tab[data-group="${toolId}"]`, nodes => nodes.every(node => node.hidden)), true);
  assert.equal((await snapshot()).path, '笔记4.md');
  await page.click('#btn-tab-more'); await menu('笔记1');
  await page.waitForFunction(() => window.__tracery.state.currentPath === '笔记1.md');
  assert.equal(await page.$eval(`.tab-group-header[data-group="${toolId}"]`, node => node.getAttribute('aria-expanded')), 'true');
  // 鼠标拖入组，整组拖动换序，再从菜单移出。
  const drag = async (source, target, ratio = .5) => {
    const a = await page.$eval(source, node => { const r = node.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    const b = await page.$eval(target, (node, ratio) => { const r = node.getBoundingClientRect(); return { x: r.x + r.width * ratio, y: r.y + r.height / 2 }; }, ratio);
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 12 }); await page.mouse.up(); await sleep(120);
  };
  let fourth = await tab('笔记4'); await drag(`.tab[data-index="${fourth}"]`, `.tab-group-header[data-group="${classId}"]`);
  assert.ok((await snapshot()).groups.find(group => group.id === classId).tabs.includes('笔记4.md'));
  fourth = await tab('笔记4'); const rootTab = await tab('笔记0');
  await drag(`.tab[data-index="${fourth}"]`, `.tab[data-index="${rootTab}"]`, .9);
  assert.ok(!(await snapshot()).groups.some(group => group.tabs.includes('笔记4.md')));
  fourth = await tab('笔记4'); await drag(`.tab[data-index="${fourth}"]`, `.tab-group-header[data-group="${classId}"]`);
  await drag(`.tab-group-header[data-group="${classId}"]`, `.tab-group-header[data-group="${toolId}"]`, .1);
  state = await snapshot(); assert.equal(state.groups[0].id, classId); assert.equal(state.path, '笔记1.md');
  await context('笔记4'); await menu('移出分组'); assert.ok(!(await snapshot()).groups.some(group => group.tabs.includes('笔记4.md')));
  await page.click(`.tab-group-header[data-group="${toolId}"]`); // 折叠当前组
  await page.screenshot({ path: path.join(OUT, 'groups-collapsed.png') });
  const saved = await snapshot(); await page.reload({ waitUntil: 'networkidle0' });
  state = await snapshot(); assert.deepEqual(state.groups, saved.groups); assert.deepEqual(state.tabs, saved.tabs); assert.equal(state.path, saved.path);
  // 右键组名可在组内新开空白页；新建笔记会填入空白标签并继承组。
  await page.click(`.tab-group-header[data-group="${toolId}"]`, { button: 'right' }); await menu('在分组中新建标签页');
  await page.waitForSelector('#empty-note', { visible: true });
  await page.reload({ waitUntil: 'networkidle0' }); await page.waitForSelector('#empty-note', { visible: true });
  assert.ok((await snapshot()).groups.find(group => group.id === toolId).tabs.some(key => key.startsWith('tracery:blank:')));
  const beforeNew = (await snapshot()).tabs.length;
  await page.click('#empty-new-note'); await page.waitForSelector('.dialog-input', { visible: true });
  await page.$eval('.dialog-input', node => node.select()); await page.type('.dialog-input', '分组新笔记'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__tracery.state.currentPath === '分组新笔记.md');
  state = await snapshot(); assert.equal(state.tabs.length, beforeNew); assert.ok(state.groups.find(group => group.id === toolId).tabs.includes('分组新笔记.md'));
  // 多标签压缩：所有标签均在同一行，不存在横向滚动；加号后保留至少 96px 窗口拖动区。
  for (let i = 5; i < 27; i++) await open(i);
  for (const width of [1440, 1024]) {
    await page.setViewport({ width, height: 900 }); await sleep(150);
    const geometry = await page.evaluate(() => {
      const r = query => document.querySelector(query).getBoundingClientRect().toJSON(), list = document.getElementById('tablist');
      return { list: r('#tablist'), plus: r('#btn-tab-new'), drag: r('.window-drag-space'), more: r('#btn-tab-more'), overflow: list.scrollWidth - list.clientWidth, scroll: getComputedStyle(list).overflowX, region: getComputedStyle(document.querySelector('.window-drag-space')).getPropertyValue('-webkit-app-region'), tabs: [...list.querySelectorAll('.tab:not([hidden])')].map(node => node.getBoundingClientRect().toJSON()) };
    });
    assert.ok(geometry.drag.width >= 96); assert.equal(geometry.region, 'drag'); assert.ok(geometry.plus.right <= geometry.drag.left + 1); assert.ok(geometry.drag.right <= geometry.more.left + 1);
    assert.ok(geometry.overflow <= 1, JSON.stringify(geometry)); assert.equal(geometry.scroll, 'clip');
    for (const box of geometry.tabs) { assert.ok(box.width < 168); assert.ok(box.left >= geometry.list.left - 1 && box.right <= geometry.list.right + 1); }
  }
  await page.screenshot({ path: path.join(OUT, 'many-compressed-tabs.png') });
  await page.evaluate(() => document.body.classList.add('electron'));
  await sleep(150);
  const desktop = await page.evaluate(() => {
    const list = document.getElementById('tablist');
    return { overflow: list.scrollWidth - list.clientWidth, drag: document.querySelector('.window-drag-space').getBoundingClientRect().width, groupWidths: [...document.querySelectorAll('.tab-group-header')].map(node => node.getBoundingClientRect().width) };
  });
  assert.ok(desktop.overflow <= 1); assert.ok(desktop.drag >= 96); assert.ok(desktop.groupWidths.every(width => width >= 20));
  await page.screenshot({ path: path.join(OUT, 'desktop-compressed-tabs.png') });
  await page.evaluate(() => document.body.classList.remove('electron'));
  await page.setViewport({ width: 390, height: 844 }); await sleep(150); assert.ok(await page.$eval('#btn-tab-new', node => node.getBoundingClientRect().right <= innerWidth));
  await page.setViewport({ width: 1440, height: 900 });
  const beforeSwitch = await snapshot(), second = path.join(HOME, 'second'); fs.mkdirSync(second);
  await page.evaluate(second => window.__tracery.Api.openVault(second), second);
  await page.waitForFunction(() => window.__tracery.state.vault.name === 'second' && window.__tracery.state.tabs.length === 0);
  assert.equal((await snapshot()).groups.length, 0);
  await page.evaluate(vault => window.__tracery.Api.openVault(vault), VAULT);
  await page.waitForFunction(path => window.__tracery.state.vault.name === 'vault' && window.__tracery.state.tabGroups.length === 2 && window.__tracery.state.currentPath === path, {}, beforeSwitch.path);
  assert.deepEqual((await snapshot()).groups, beforeSwitch.groups);
  // 关闭/取消分组不删除磁盘笔记；切换仓库后不带入分组。
  await page.click(`.tab-group-header[data-group="${classId}"]`, { button: 'right' }); await menu('关闭分组');
  await page.waitForFunction(id => !window.__tracery.state.tabGroups.some(group => group.id === id), {}, classId);
  assert.ok(fs.existsSync(path.join(VAULT, '笔记3.md'))); assert.ok(!(await snapshot()).groups.some(group => group.id === classId));
  await page.click(`.tab-group-header[data-group="${toolId}"]`, { button: 'right' }); await menu('取消分组'); assert.equal((await snapshot()).groups.length, 0);
  await page.click('#btn-tab-more'); await menu('关闭所有标签页'); await page.waitForSelector('#empty-note', { visible: true });
  await open(1); await context('笔记1'); await menu('添加到新分组'); await page.waitForSelector('.tab-group-editor input'); await page.keyboard.press('Escape');
  await page.click('.tab-group-header', { button: 'right' }); await menu('关闭分组');
  await page.waitForFunction(() => window.__tracery.state.tabs.length === 0);
  assert.equal(await page.evaluate(() => localStorage.getItem('tracery.lastNote')), null);
  assert.ok(fs.existsSync(path.join(VAULT, '笔记1.md')));
  await page.click('#btn-tab-new'); await page.waitForFunction(() => window.__tracery.state.tabs.length === 1);
  await context('新标签页'); await menu('添加到新分组'); await page.waitForSelector('.tab-group-editor input'); await page.keyboard.press('Escape');
  await page.click('.tab-group-header', { button: 'right' }); await menu('关闭分组');
  await page.waitForFunction(() => window.__tracery.state.tabs.length === 0);
  assert.equal((await snapshot()).groups.length, 0); assert.equal((await snapshot()).path, null);
  // 只有一个折叠分组时，应显示完整组名，不能退化成只剩数量。
  await open(1); await open(2); await open(3);
  await context('笔记1'); await menu('添加到新分组'); await page.waitForSelector('.tab-group-editor input');
  await page.click('.tab-group-color[data-color="teal"]'); await page.click('.tab-group-editor input'); await page.keyboard.press('Enter');
  await context('笔记2'); await menu('移入「新分组」'); await context('笔记3'); await menu('移入「新分组」');
  await page.click('.tab-group-header');
  const collapsedLook = await page.$eval('.tab-group-header', node => {
    const label = node.querySelector('.tab-group-label');
    return { name: label.textContent, visible: label.clientWidth >= label.scrollWidth, width: node.getBoundingClientRect().width, rails: document.querySelectorAll('.tab-group-rail').length, current: node.classList.contains('is-current'), background: getComputedStyle(node).backgroundColor };
  });
  assert.equal(collapsedLook.name, '新分组'); assert.ok(collapsedLook.visible); assert.ok(collapsedLook.width >= 64); assert.equal(collapsedLook.rails, 0); assert.ok(collapsedLook.current);
  await page.screenshot({ path: path.join(OUT, 'single-collapsed-group.png'), clip: { x: 140, y: 0, width: 700, height: 52 } });
  await page.click('.tab-group-header'); await page.screenshot({ path: path.join(OUT, 'single-expanded-group.png'), clip: { x: 140, y: 0, width: 1000, height: 52 } });
  await page.evaluate(() => window.__tracery.Api.saveSettings({ themeMode: 'dark' })); await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await sleep(250); // 等主题颜色过渡完成再保存视觉对照。
  await page.screenshot({ path: path.join(OUT, 'groups-dark.png'), clip: { x: 140, y: 0, width: 1000, height: 52 } });
  assert.deepEqual(errors, []);
  console.log('PASS 连续分组色线、同色活动下划线、组名留白和单组折叠名称；+空白页/替换、分组拖拽/恢复、压缩/拖窗、关闭取消与仓库隔离');
} finally { await browser?.close(); server.kill(); }
