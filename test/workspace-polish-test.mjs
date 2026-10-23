import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { launchBrowser } from './browser.mjs';
import { externalLinks, externalUrl } from '../public/js/external-link.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tracery-workspace-polish-'));
const VAULT = path.join(HOME, 'vault'), OUT = path.join(ROOT, 'dist/workspace-polish');
fs.mkdirSync(VAULT); fs.mkdirSync(OUT, { recursive: true });
const md = '# 网页链接\n\n`[显示文字](https://obsidian.md)` 渲染为 [Obsidian 官网](https://obsidian.md)，另有 [带括号](https://example.com/a_(b))。\n\n## 整理课堂笔记\n\n正文\n\n### 子标题\n\n[危险](javascript:alert(1))\n\n结尾';
fs.writeFileSync(path.join(VAULT, '链接.md'), md);
fs.writeFileSync(path.join(HOME, 'tracery.config.json'), JSON.stringify({ currentVault: VAULT, settings: { startup: 'empty' } }));
assert.equal(externalUrl('javascript:alert(1)'), null);
assert.equal(externalUrl('https://example.com/\nmalformed'), null);
assert.equal(externalLinks('[括号](https://example.com/a_(b))')[0].href, 'https://example.com/a_(b)');
assert.equal(externalLinks('[标题](https://example.com "说明")')[0].title, '说明');
assert.equal(externalLinks('![图](https://example.com/a.png)').length, 0);
const PORT = 9637, BASE = `http://127.0.0.1:${PORT}`, sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const packed = process.env.TRACERY_TEST_EXE, entry = packed ? path.join(path.dirname(packed), 'resources/app.asar/server/server.js') : path.join(ROOT, 'server/server.js');
const server = spawn(packed || process.execPath, [entry], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), TRACERY_HOME: HOME, ...(packed ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }, windowsHide: true, stdio: 'pipe' });
let browser, page;
const errors = [];
try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/api/state')).ok) break; } catch {} await sleep(200); }
  browser = await launchBrowser({ width: 1440, height: 1000 }); page = await browser.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  // 配置服务的启动设置可能会与初次默认值合并，明确按空白启动验收。
  await page.evaluate(() => window.__tracery.Api.saveSettings({ startup: 'empty', themeMode: 'light' }));
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.waitForSelector('#empty-note', { visible: true });
  assert.equal(await page.$('#tablist .tab.active'), null);
  assert.equal(await page.$eval('#editor-live', node => node.hidden && node.inert), true);
  assert.equal(await page.evaluate(() => window.__tracery.editor.getContent()), '');
  await page.click('#empty-open-note'); await page.waitForSelector('#palette-input', { visible: true });
  await page.type('#palette-input', '链接'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__tracery.state.currentPath === '链接.md');
  await page.waitForSelector('#empty-note', { hidden: true });
  await page.waitForSelector('.cm-lp-external-link');
  const links = await page.$$eval('.cm-lp-external-link', nodes => nodes.map(node => ({ label: node.textContent, href: node.href, deco: getComputedStyle(node).textDecorationLine, icon: getComputedStyle(node, '::after').maskImage })));
  assert.equal(links.length, 2); assert.equal(links[0].label, 'Obsidian 官网');
  assert.equal(links[0].href, 'https://obsidian.md/'); assert.ok(links[0].deco.includes('underline')); assert.ok(links[0].icon.includes('svg'));
  assert.ok(await page.$eval('.cm-lp-code', node => node.textContent.includes('[显示文字](https://obsidian.md)')));
  // 只记录交给浏览器的目标，避免把第三方站点网络可用性混入本地交互验收。
  await page.evaluate(() => { window.__openedLinks = []; window.open = (...args) => { window.__openedLinks.push(args); return null; }; });
  await page.click('.cm-lp-external-link');
  await page.waitForFunction(() => window.__openedLinks.length === 1);
  assert.deepEqual(await page.evaluate(() => window.__openedLinks[0]), ['https://obsidian.md/', '_blank', 'noopener,noreferrer']);
  assert.equal(await page.evaluate(() => window.__tracery.editor.getContent()), md);
  // 光标进入链接所在行，完整源码重新出现；移开再恢复预览。
  await page.evaluate(() => { const editor = window.__tracery.editor; editor.view.dispatch({ selection: { anchor: editor.getContent().indexOf('[Obsidian 官网]') } }); });
  assert.equal(await page.$('.cm-lp-external-link'), null);
  await page.evaluate(() => window.__tracery.editor.view.dispatch({ selection: { anchor: 0 } }));
  await page.evaluate(() => window.__tracery.editor.setMode('read')); await page.waitForSelector('.cm-lp-external-link');
  assert.equal(await page.$eval('.cm-content', node => node.isContentEditable), false);
  await page.evaluate(() => window.__tracery.editor.setMode('source')); assert.equal(await page.$('.cm-lp-external-link'), null);
  await page.evaluate(() => window.__tracery.editor.setMode('live'));
  console.log('PASS 网页链接文字/图标/真实点击、源码编辑与三模式、代码字面量及危险协议');

  await page.evaluate(() => { const editor = window.__tracery.editor; editor.scrollToLine(5); }); await sleep(250);
  const active = await page.$('#outline-list .outline-row.active'); assert.ok(active);
  const before = await active.evaluate(node => ({ bg: getComputedStyle(node).backgroundColor, width: node.getBoundingClientRect().width }));
  await active.hover();
  const after = await active.evaluate(node => ({ bg: getComputedStyle(node).backgroundColor, width: node.getBoundingClientRect().width, buttonBg: getComputedStyle(node.querySelector('.outline-item')).backgroundColor }));
  assert.equal(before.width, after.width); assert.notEqual(before.bg, after.bg); assert.equal(after.buttonBg, 'rgba(0, 0, 0, 0)');
  await page.screenshot({ path: path.join(OUT, 'links-outline-light.png') });
  await page.click('#tablist .tab-close'); await page.waitForSelector('#empty-note', { visible: true });
  await page.keyboard.type('不应写入已关闭的笔记');
  assert.equal(await page.evaluate(() => window.__tracery.editor.getContent()), '');
  assert.equal(fs.readFileSync(path.join(VAULT, '链接.md'), 'utf8'), md);
  await page.click('#empty-new-note'); await page.waitForSelector('.dialog-backdrop input', { visible: true });
  await page.$eval('.dialog-backdrop input', node => node.select()); await page.keyboard.type('空白页新建'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__tracery.state.currentPath === '空白页新建.md');
  assert.ok(fs.existsSync(path.join(VAULT, '空白页新建.md')));
  // 关闭所有标签，再从空白页打开已有文件。
  await page.evaluate(() => window.__tracery.openNote('链接.md', null, { newTab: true }));
  await page.click('#btn-tab-more');
  await page.evaluate(() => [...document.querySelectorAll('.context-menu button')].find(node => node.textContent.includes('关闭所有标签页')).click());
  await page.waitForSelector('#empty-note', { visible: true });
  assert.equal(await page.evaluate(() => window.__tracery.state.tabs.length), 0);
  await page.screenshot({ path: path.join(OUT, 'empty-light.png') });
  await page.click('#btn-theme'); await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark'); await page.screenshot({ path: path.join(OUT, 'empty-dark.png') });
  await page.evaluate(() => window.__tracery.openNote('链接.md'));
  await page.evaluate(async () => { await window.__tracery.editor.flush(); await window.__tracery.Api.remove('链接.md'); });
  await page.waitForSelector('#empty-note', { visible: true });
  assert.equal(await page.evaluate(() => window.__tracery.editor.getContent()), '');
  await page.evaluate(() => window.__tracery.openNote('空白页新建.md'));
  console.log('PASS 启动空白、关闭最后一个/全部标签、禁止空页输入、新建和快速打开、大纲整行悬浮');

  // 记录真实画布绘制路径，检查四个圆角手柄中心恰好落在选框拐点。
  await page.evaluate(() => {
    const proto = CanvasRenderingContext2D.prototype;
    window.__selectionPaths = [];
    const begin = proto.beginPath; proto.beginPath = function(...args) { this.__path = []; return begin.apply(this, args); };
    for (const name of ['moveTo', 'lineTo', 'roundRect']) {
      const original = proto[name]; proto[name] = function(...args) { this.__path?.push({ name, args }); return original.apply(this, args); };
    }
    const stroke = proto.stroke; proto.stroke = function(...args) { if (this.strokeStyle === '#6965db') window.__selectionPaths.push(this.__path); return stroke.apply(this, args); };
  });
  await page.click('#btn-draw'); await page.waitForSelector('#draw-canvas', { visible: true });
  const box = await page.$eval('#draw-canvas', node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y }; });
  await page.click('.draw-tool[data-tool="rect"]');
  await page.mouse.move(box.x + 450, box.y + 350); await page.mouse.down(); await page.mouse.move(box.x + 650, box.y + 500, { steps: 8 }); await page.mouse.up(); await sleep(120);
  await page.click('.draw-tool[data-tool="select"]'); await page.mouse.click(box.x + 550, box.y + 420); await sleep(120);
  const geometry = () => page.evaluate(() => {
    const paths = window.__selectionPaths;
    const last = paths.findLastIndex(p => p?.length === 4 && p[0]?.name === 'moveTo');
    const outline = paths[last]?.map(p => p.args), handles = paths.slice(last + 1, last + 5).map(p => p?.[0]).filter(p => p?.name === 'roundRect').map(p => ({ x: p.args[0] + p.args[2] / 2, y: p.args[1] + p.args[3] / 2, radius: p.args[4] }));
    return { outline, handles };
  });
  const frame = await geometry(); assert.equal(frame.handles.length, 4);
  for (let i = 0; i < 4; i++) { assert.ok(Math.abs(frame.handles[i].x - frame.outline[i][0]) < .01); assert.ok(Math.abs(frame.handles[i].y - frame.outline[i][1]) < .01); assert.equal(frame.handles[i].radius, 2); }
  const se = frame.handles[2]; await page.mouse.move(box.x + se.x, box.y + se.y); await page.mouse.down(); await page.mouse.move(box.x + se.x + 1, box.y + se.y + 1); await page.mouse.up(); await sleep(100);
  const resized = await geometry(); assert.ok(Math.abs(resized.handles[2].x - se.x - 1) < .1); assert.ok(Math.abs(resized.handles[2].y - se.y - 1) < .1);
  assert.ok(Math.abs(resized.handles[0].x - frame.handles[0].x) < .1);
  await page.click('#draw-zoom-in'); await sleep(100);
  const zoomed = await geometry(); for (let i = 0; i < 4; i++) assert.ok(Math.hypot(zoomed.handles[i].x - zoomed.outline[i][0], zoomed.handles[i].y - zoomed.outline[i][1]) < .1);
  const center = { x: (zoomed.handles[0].x + zoomed.handles[2].x) / 2, y: (zoomed.handles[0].y + zoomed.handles[2].y) / 2 };
  const rotationY = zoomed.handles[0].y - 20, radius = center.y - rotationY;
  await page.mouse.move(box.x + center.x, box.y + rotationY); await page.mouse.down();
  await page.mouse.move(box.x + center.x + radius / Math.SQRT2, box.y + center.y - radius / Math.SQRT2, { steps: 8 }); await page.mouse.up(); await sleep(100);
  const rotated = await geometry(); assert.ok(Math.abs(rotated.outline[1][1] - rotated.outline[0][1]) > 20);
  for (let i = 0; i < 4; i++) assert.ok(Math.hypot(rotated.handles[i].x - rotated.outline[i][0], rotated.handles[i].y - rotated.outline[i][1]) < .1);
  await page.mouse.move(box.x + rotated.handles[2].x, box.y + rotated.handles[2].y); await page.mouse.down();
  await page.mouse.move(box.x + rotated.handles[2].x + 14, box.y + rotated.handles[2].y + 18, { steps: 6 }); await page.mouse.up(); await sleep(100);
  const rotatedResize = await geometry();
  assert.ok(Math.hypot(rotatedResize.handles[0].x - rotated.handles[0].x, rotatedResize.handles[0].y - rotated.handles[0].y) < .1);
  assert.ok(Math.abs(rotatedResize.handles[2].x - rotated.handles[2].x - 14) < .1);
  assert.ok(Math.abs(rotatedResize.handles[2].y - rotated.handles[2].y - 18) < .1);
  await page.screenshot({ path: path.join(OUT, 'selection-corners.png') });
  assert.deepEqual(errors, []); console.log('PASS 四角圆角手柄与边框同心、真实拖动无跳变、缩放/45度旋转/旋转后缩放');
} finally { await browser?.close(); server.kill(); }
