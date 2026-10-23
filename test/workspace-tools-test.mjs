/** 临时仓库验证排序、右键目标、图谱缩放与悬浮画板，包含真实鼠标命中检查。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { sortTree } from '../public/js/file-sort.js';
import { repel } from '../public/js/graph-layout.js';
import { launchBrowser } from './browser.mjs';
const ROOT = path.resolve(import.meta.dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tracery-workspace-tools-'));
const VAULT = path.join(HOME, 'vault'), OTHER = path.join(HOME, 'other');
fs.mkdirSync(VAULT); fs.mkdirSync(OTHER); fs.mkdirSync(path.join(VAULT, '文件夹'));
for (const [i, name] of ['note10.md', 'note2.md', 'note1.md'].entries()) {
  const file = path.join(VAULT, name); fs.writeFileSync(file, `# ${name}\n\n[[note1]]\n`);
  fs.utimesSync(file, new Date('2020-01-01'), new Date(Date.UTC(2020 + i, 0, 1)));
}
fs.writeFileSync(path.join(OTHER, '别的.md'), '# 别的');
const fixture = { dirs: [], files: [
  { name: 'note10', mtimeMs: 3, birthtimeMs: 1 }, { name: 'note2', mtimeMs: 1, birthtimeMs: 2 }, { name: 'note1', mtimeMs: 2, birthtimeMs: 3 },
] };
for (const [mode, expected] of Object.entries({ 'name-asc': ['note1','note2','note10'], 'name-desc': ['note10','note2','note1'],
  'modified-asc': ['note2','note1','note10'], 'modified-desc': ['note10','note1','note2'],
  'created-asc': ['note10','note2','note1'], 'created-desc': ['note1','note2','note10'] })) {
  assert.deepEqual(sortTree(fixture, mode).files.map(f => f.name), expected);
}
assert.equal(fixture.files[0].name, 'note10');
const nodes = Array.from({ length: 3000 }, (_, i) => ({ x: (i % 60) * 12, y: Math.floor(i / 60) * 12, vx: 0, vy: 0 }));
const start = performance.now(); repel(nodes);
assert.ok(nodes.every(n => Number.isFinite(n.vx) && Number.isFinite(n.vy)));
console.log(`PASS 六种排序、自然数字顺序、不改原数据；3000 节点斥力 ${Math.round(performance.now() - start)}ms`);
const PORT = 9631, BASE = `http://127.0.0.1:${PORT}`, sleep = ms => new Promise(r => setTimeout(r, ms));
fs.writeFileSync(path.join(HOME, 'tracery.config.json'), JSON.stringify({ currentVault: VAULT }));
const packed = process.env.TRACERY_TEST_EXE;
const entry = packed ? path.join(path.dirname(packed), 'resources/app.asar/server/server.js') : path.join(ROOT, 'server/server.js');
const server = spawn(packed || process.execPath, [entry], { cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), TRACERY_HOME: HOME, ...(packed ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }, stdio: 'pipe', windowsHide: true });
let browser;
const OUT = path.join(ROOT, 'dist/workspace-preview'); fs.mkdirSync(OUT, { recursive: true });
try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/api/state')).ok) break; } catch {} await sleep(200); }
  browser = await launchBrowser({ width: 1360, height: 900 }); const page = await browser.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.click('[data-path="note1.md"]');
  await page.click('[data-path="note2.md"]', { button: 'right' });
  assert.ok(await page.$eval('[data-path="note2.md"]', e => e.classList.contains('context-target')));
  await page.screenshot({ path: path.join(OUT, 'sidebar-context.png') });
  assert.equal(await page.evaluate(() => window.__tracery.state.currentPath), 'note1.md');
  await page.keyboard.press('Escape');
  assert.equal(await page.$('.context-target'), null);
  await page.click('[data-dir="文件夹"]', { button: 'right' });
  assert.ok(await page.$eval('[data-dir="文件夹"]', e => e.classList.contains('context-target')));
  await page.click('#btn-file-sort');
  assert.equal(await page.$('.context-target'), null);
  assert.equal(await page.$$eval('.context-menu button', bs => bs.length), 6);
  await page.screenshot({ path: path.join(OUT, 'sidebar-sort-menu.png') });
  await page.evaluate(() => [...document.querySelectorAll('.context-menu button')].find(b => b.textContent.includes('编辑时间（从新到旧）')).click());
  const paths = () => page.$$eval('#file-tree [data-path]', es => es.map(e => e.dataset.path));
  assert.deepEqual(await paths(), ['note1.md', 'note2.md', 'note10.md']);
  await page.reload({ waitUntil: 'networkidle0' });
  assert.deepEqual(await paths(), ['note1.md', 'note2.md', 'note10.md']);
  const tree = await (await fetch(BASE + '/api/tree')).json();
  for (const f of tree.files) assert.equal(f.birthtimeMs, fs.statSync(path.join(VAULT, f.path)).birthtimeMs);
  await page.evaluate(async root => window.__tracery.Api.openVault(root), OTHER);
  await page.waitForSelector('[data-path="别的.md"]');
  assert.ok(await page.$eval('#btn-file-sort', e => e.title.includes('A–Z')));
  await page.evaluate(async root => window.__tracery.Api.openVault(root), VAULT);
  await page.waitForSelector('[data-path="note1.md"]');
  assert.deepEqual(await paths(), ['note1.md', 'note2.md', 'note10.md']);
  // 保存后排序即时更新，不能依赖目录结构改变才刷新时间。
  await page.evaluate(async () => window.__tracery.Api.saveNote('note10.md', '# 修改后的十\n'));
  await page.waitForFunction(() => document.querySelector('#file-tree [data-path]')?.dataset.path === 'note10.md');
  await page.screenshot({ path: path.join(OUT, 'sidebar-sort.png') });
  console.log('PASS 右键描边与清除、不打开目标；排序菜单、重启、跨仓库隔离、真实创建时间及编辑后重排');
  await page.evaluate(async () => {
    const { ForceGraph } = await import('/js/graph.js');
    const draw = ForceGraph.prototype._draw;
    ForceGraph.prototype._draw = function () { window.testGraph = this; return draw.call(this); };
  });
  await page.click('.ribbon-btn[data-panel="graph"]');
  await page.waitForFunction(() => window.testGraph?.nodes.length > 0);
  const rect = await page.$eval('#graph-canvas', c => c.getBoundingClientRect().toJSON());
  await page.mouse.move(rect.left + rect.width / 2, rect.top + rect.height / 2);
  await page.mouse.wheel({ deltaY: 120 }); await sleep(60);
  const zoom = await page.evaluate(() => window.testGraph.scale);
  await sleep(1100); assert.equal(await page.evaluate(() => window.testGraph.scale), zoom);
  const rendering = await page.evaluate(async () => {
    const g = window.testGraph; g.pause(); let labels = 0, draws = 0;
    const fill = g.ctx.fillText.bind(g.ctx); g.ctx.fillText = (...args) => { labels++; return fill(...args); };
    g.nodes.forEach(n => { n.degree = 100; }); g.hoverNode = g.nodes[0]; g.scale = .3; g._draw();
    const small = labels; labels = 0; g.scale = 1; g._draw(); const large = labels;
    const draw = g._draw.bind(g); g._draw = () => { draws++; draw(); };
    for (let i = 0; i < 60; i++) g.canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 1, clientX: 400, clientY: 300, cancelable: true }));
    await new Promise(r => requestAnimationFrame(r)); return { small, large, draws };
  });
  assert.equal(rendering.small, 0); assert.ok(rendering.large >= 3); assert.ok(rendering.draws <= 2);
  await page.screenshot({ path: path.join(OUT, 'graph.png') });
  console.log('PASS 首次手动缩放不被自动适配打断、小比例隐藏高连接/悬停名称、60 次滚轮合并绘制', rendering);
  await page.keyboard.press('Escape'); await page.click('[data-path="note1.md"]'); await page.click('#btn-draw');
  await page.waitForSelector('.draw-overlay:not([hidden])');
  const bounds = () => page.evaluate(() => {
    const r = q => document.querySelector(q).getBoundingClientRect().toJSON();
    return { canvas: r('#draw-canvas'), ribbon: r('.ribbon'), title: r('.titlebar'), tools: r('.draw-tools') };
  });
  const before = await bounds();
  assert.ok(before.canvas.left > before.ribbon.right); assert.ok(before.canvas.top > before.title.bottom);
  assert.ok(before.canvas.bottom < 900); assert.ok(before.tools.top > before.canvas.top);
  assert.deepEqual(await page.$$eval('.ribbon-btn.active', buttons => buttons.map(b => b.id)), ['btn-draw']);
  const topRow = await page.evaluate(() => {
    const rect = q => document.querySelector(q).getBoundingClientRect().toJSON();
    const overlay = getComputedStyle(document.querySelector('.draw-overlay'));
    return { switches: rect('.draw-mobile-switches'), tools: rect('.draw-tools'), actions: rect('.draw-top'), radius: overlay.borderTopLeftRadius, shadow: overlay.boxShadow };
  });
  assert.equal(topRow.tools.top, topRow.switches.top);
  assert.ok(topRow.tools.left > topRow.switches.right && topRow.tools.right < topRow.actions.left);
  assert.ok(parseFloat(topRow.radius) > 0 && topRow.shadow !== 'none');
  const handle = await page.$eval('.draw-tools-handle', e => e.getBoundingClientRect().toJSON());
  await page.mouse.move(handle.left + 10, handle.top + 18); await page.mouse.down();
  await page.mouse.move(handle.left + 70, handle.top + 168, { steps: 10 }); await page.mouse.up();
  const moved = (await bounds()).tools;
  assert.ok(moved.top > before.tools.top + 100);
  assert.equal(await page.$eval('#draw-canvas', e => e.dataset.strokes), '0');
  await page.setViewport({ width: 1024, height: 700 }); await sleep(120);
  const smaller = await bounds();
  assert.ok(smaller.tools.left >= smaller.canvas.left && smaller.tools.right <= smaller.canvas.right);
  assert.ok(smaller.tools.top >= smaller.canvas.top && smaller.tools.bottom <= smaller.canvas.bottom);
  await page.setViewport({ width: 1360, height: 900 }); await sleep(120);
  await page.click('.draw-tools-handle', { clickCount: 2 });
  assert.equal((await bounds()).tools.top, before.tools.top);
  // 手柄支持键盘微调，工具按钮仍保留自己的点击行为。
  await page.focus('.draw-tools-handle'); await page.keyboard.press('ArrowDown');
  assert.equal((await bounds()).tools.top, before.tools.top + 10);
  await page.click('.draw-tools-handle', { clickCount: 2 });
  console.log('PASS 绘图独占导航选中态、圆角与悬浮留白、工具栏同排无重叠、鼠标拖动/缩窄约束/复位/键盘微调');
  await page.click('#draw-toggle-props'); await page.waitForSelector('.draw-show-props');
  assert.deepEqual((await bounds()).canvas, before.canvas);
  const ink = async value => {
    await page.click(`[data-board-background="${value}"]`);
    return page.$eval('#draw-canvas', async canvas => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const d = devicePixelRatio, data = canvas.getContext('2d').getImageData(700*d, 400*d, 96*d, 96*d).data;
      let count = 0; for (let i = 0; i < data.length; i += 4) if (data[i] < 255) count++;
      return count;
    });
  };
  const dots = await ink('dots'), lines = await ink('lines'), blank = await ink('blank');
  assert.ok(dots > 0 && lines > dots && blank === 0, JSON.stringify({ dots, lines, blank }));
  await page.click('.draw-tool[data-tool="hand"]');
  await page.click('[data-board-background="lines"]');
  assert.equal(await page.$eval('#draw-canvas', e => e.dataset.background), 'lines');
  await page.click('.draw-tool[data-tool="select"]');
  await page.click('#draw-close-props'); await page.click('#draw-toggle-library');
  assert.deepEqual((await bounds()).canvas, before.canvas);
  assert.ok(await page.$$eval('.dd-tabs button', buttons => buttons.every(button => {
    const row = button.parentElement.getBoundingClientRect(), rect = button.getBoundingClientRect();
    return Math.abs((rect.top - row.top) - (row.bottom - rect.bottom)) <= 1;
  })));
  await page.click('#draw-toggle-ui');
  assert.equal(await page.$eval('.draw-tools', e => getComputedStyle(e).display), 'none');
  assert.equal(await page.$eval('.draw-drafts', e => getComputedStyle(e).display), 'none');
  assert.deepEqual((await bounds()).canvas, before.canvas);
  await page.screenshot({ path: path.join(OUT, 'drawing-canvas.png') });
  await page.click('#draw-toggle-ui'); await page.click('#draw-close-library'); await page.click('.draw-tool[data-tool="rect"]');
  const x = before.canvas.left + 330, y = before.canvas.top + 220;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 110, y + 70, { steps: 8 }); await page.mouse.up();
  assert.equal(await page.$eval('#draw-canvas', e => e.dataset.strokes), '1');
  await page.click('#draw-toggle-props');
  await page.screenshot({ path: path.join(OUT, 'drawing-floats.png') });
  const after = await bounds();
  assert.deepEqual(after.canvas, before.canvas);
  assert.equal(after.title.top, 0);
  await page.click('#btn-theme');
  await page.screenshot({ path: path.join(OUT, 'drawing-floats-light.png') });
  await page.click('#btn-settings');
  assert.ok(await page.$eval('#settings', e => !e.hidden));
  await page.keyboard.press('Escape');
  assert.ok(await page.$eval('#settings', e => e.hidden));
  assert.equal(await page.$eval('.draw-overlay', e => e.hidden), false);
  await page.click('.ribbon-btn[data-panel="search"]');
  assert.equal(await page.$eval('.draw-overlay', e => e.hidden), true);
  assert.equal(await page.$eval('#btn-draw', e => e.classList.contains('active')), false);
  assert.ok(await page.$eval('.ribbon-btn[data-panel="search"]', e => e.classList.contains('active')));
  assert.ok(await page.evaluate(() => JSON.parse(localStorage.getItem('tracery.drawDrafts')).some(d => d.elements.length === 1)));
  assert.ok(await page.evaluate(() => JSON.parse(localStorage.getItem('tracery.drawDrafts')).some(d => d.boardBackground === 'lines')));
  await page.click('#btn-draw'); await page.click('#draw-cancel');
  assert.ok(await page.$eval('.ribbon-btn[data-panel="search"]', e => e.classList.contains('active')));
  assert.deepEqual(errors, []);
  console.log('PASS 画布避开主导航与顶栏、面板悬浮/收起不改变尺寸、真实鼠标绘图、主导航离开时保留草稿');
} finally { await browser?.close(); server.kill(); }
