import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { launchBrowser } from './browser.mjs';
import { waitForApp, waitForNote } from './waits.mjs';

const ROOT = path.resolve(import.meta.dirname, '..'), HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tracery-sidebar-draw-'));
const VAULT = path.join(HOME, 'vault'), OUT = path.join(ROOT, 'dist/sidebar-drawing-refresh');
for (const dir of [VAULT, OUT]) fs.mkdirSync(dir, { recursive: true });
const content = '# 学习目标\n\n## 连接 PostgreSQL：psql 与 PyCharm\n\n### 方式一：psql 命令行\n\n说明文字。\n\n### 方式二：PyCharm 数据库工具\n\n说明文字。\n\n## 基础 CRUD：和 MySQL 几乎一样\n\n操作说明。\n\n## PG 专属特性实操\n\n### UUID 主键\n\n说明。\n\n### RETURNING：插入后直接拿回主键\n\n说明。\n';
for (const name of ['01_项目从零理解.md', '03_技术选型与关键难点.md']) fs.writeFileSync(path.join(VAULT, name), content);
fs.writeFileSync(path.join(HOME, 'tracery.config.json'), JSON.stringify({ currentVault: VAULT, settings: { themeMode: 'light', accent: 'purple', startup: 'empty' } }));
const BASE = 'http://127.0.0.1:9708', server = spawn(process.execPath, [path.join(ROOT, 'server/server.js')], { env: { ...process.env, PORT: '9708', TRACERY_HOME: HOME }, windowsHide: true, stdio: 'pipe' });
let browser, page;
const variants = {
  A: '',
  B: `.draw-props-body { background:var(--bg-fill); padding:12px; } .draw-props-body .draw-board-background,.draw-props-body .dp-group { background:var(--bg-sheet); padding:13px!important; border:1px solid var(--hairline)!important; border-radius:12px; margin-bottom:10px!important; } .draw-props-body .draw-element-style .dp-group+.dp-group { padding:13px; } .draw-color-value { display:none; } .draw-props-body .draw-color-presets { gap:5px; }`,
  C: `.draw-props-body { padding:14px 18px; } .draw-props-body .dp-group { margin-bottom:14px; } .draw-props-body .draw-custom-color { display:none; } .draw-custom-details { margin-top:10px; font-size:11px; color:var(--text-secondary); } .draw-custom-details[open] .draw-custom-color { display:flex; } .draw-props-body .draw-color-presets :is(.draw-swatch,.draw-bg) { border-radius:6px; } .draw-props-body .draw-color-recent { display:none; } .draw-props-body .draw-element-style > .dp-group:not(.draw-color-group) { display:grid; grid-template-columns:42px 1fr; align-items:center; gap:8px; } .draw-props-body .draw-element-style > .dp-group:not(.draw-color-group) .dp-label { margin:0; }`
};
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/api/state')).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await launchBrowser({ width: 1440, height: 1000 }); page = await browser.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(BASE, { waitUntil: 'networkidle0' }); await waitForApp(page);
  await page.evaluate(() => { const app = window.__tracery; localStorage.setItem(`tracery.savedGroups:${app.state.vault.root}`, JSON.stringify([{ id: 'law', name: 'law', color: 'purple', tabs: ['01_项目从零理解.md', '03_技术选型与关键难点.md'] }])); });
  await page.reload({ waitUntil: 'networkidle0' }); await waitForApp(page);
  await page.evaluate(() => window.__tracery.openNote('01_项目从零理解.md'));
  await waitForNote(page, '01_项目从零理解.md'); await page.click('#tab-groups'); await page.click('.saved-group summary');
  await page.waitForFunction(() => document.querySelectorAll('.saved-group-note[data-status="open"]').length === 1);
  assert.equal(await page.$eval('.saved-group-count', el => el.textContent), '2');
  assert.equal(await page.$$('.saved-group-note[data-status="closed"]').then(items => items.length), 1);
  await (await page.$('.saved-group')).screenshot({ path: path.join(OUT, 'groups-light.png') });
  await page.click('.saved-group-more'); await page.keyboard.press('Escape');
  assert.equal(await page.$('.saved-group-actions'), null);
  await page.click('.saved-group-note[data-status="closed"]'); await waitForNote(page, '03_技术选型与关键难点.md');
  await page.click('.saved-group-more'); await page.click('.saved-group-open');
  await waitForNote(page, '01_项目从零理解.md');
  await page.waitForFunction(() => document.querySelectorAll('.saved-group-note[data-status="open"]').length === 2);
  await page.click('#tab-outline'); await page.locator('.outline-item[data-line="9"]').click();
  await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))));
  const active = await page.$eval('.outline-row.active', row => ({ line: row.dataset.line, weight: getComputedStyle(row.querySelector('button.outline-item')).fontWeight, bar: getComputedStyle(row, '::before').backgroundColor, text: getComputedStyle(row.querySelector('.outline-item')).color }));
  assert.equal(active.line, '9'); assert.equal(active.weight, '700'); assert.equal(active.bar, active.text);
  await page.hover('.outline-item[data-line="13"]');
  assert.equal(await page.$eval('.outline-item[data-line="13"]', el => getComputedStyle(el).fontWeight), '700');
  await (await page.$('#outline-list')).screenshot({ path: path.join(OUT, 'outline-light.png') });
  await page.click('#btn-draw'); await page.waitForSelector('.draw-overlay:not([hidden])');
  assert.equal(await page.$('#draw-cancel'), null);
  const coverage = await page.$eval('.draw-overlay', el => { const r = el.getBoundingClientRect(); return [r.right, r.bottom, innerWidth, innerHeight]; });
  assert.deepEqual(coverage.slice(0, 2), coverage.slice(2));
  await page.click('#draw-toggle-library');
  const start = await page.$eval('.draw-panel-indicator', el => getComputedStyle(el).transform);
  await page.click('#draw-toggle-props');
  await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))));
  assert.notEqual(await page.$eval('.draw-panel-indicator', el => getComputedStyle(el).transform), start);
  await page.click('.draw-tool[data-tool="rect"]');
  assert.equal(await page.$eval('.draw-props', el => el.scrollWidth > el.clientWidth), false);
  await (await page.$('.draw-overlay')).screenshot({ path: path.join(OUT, 'drawing-light.png') });
  for (const [design, css] of Object.entries(variants)) {
    const style = css ? await page.addStyleTag({ content: css }) : null;
    if (design === 'C') await page.evaluate(() => { for (const custom of document.querySelectorAll('.draw-custom-color')) { const details = document.createElement('details'), summary = document.createElement('summary'); details.className = 'draw-custom-details'; summary.textContent = '自定义颜色'; custom.before(details); details.append(summary, custom); } });
    await (await page.$('.draw-props')).screenshot({ path: path.join(OUT, `style-${design}.png`) });
    if (style) { await style.evaluate(el => el.remove()); await style.dispose(); }
    if (design === 'C') await page.evaluate(() => { for (const details of document.querySelectorAll('.draw-custom-details')) { details.before(details.querySelector('.draw-custom-color')); details.remove(); } });
  }
  await page.setViewport({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector('.draw-overlay').getBoundingClientRect().right === innerWidth);
  await page.click('#draw-toggle-props'); await page.click('#draw-toggle-props');
  assert.equal(await page.$eval('.draw-props', el => el.scrollWidth > el.clientWidth), false);
  await (await page.$('.draw-overlay')).screenshot({ path: path.join(OUT, 'drawing-mobile.png') });
  await page.evaluate(async () => { const { updateSettings } = await import('/js/settings.js'); await updateSettings({ themeMode: 'dark' }); });
  await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))));
  await (await page.$('.draw-props')).screenshot({ path: path.join(OUT, 'style-dark.png') });
  assert.deepEqual(errors, []);
  fs.rmSync(path.join(OUT, 'failure.png'), { force: true });
  fs.writeFileSync(path.join(OUT, 'styles.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>颜色与样式 · 三种方案</title><style>body{font:15px/1.7 system-ui;margin:32px;background:#f6f5fa;color:#24232b}main{display:flex;gap:24px;flex-wrap:wrap}article{background:white;border:1px solid #e6e4ee;border-radius:18px;padding:20px;width:300px}h1{font-size:28px}h2{font-size:18px;margin:0}p{color:#6f6c7c}img{width:292px;border-radius:14px;border:1px solid #eee}</style><h1>颜色与样式 · 方案对比</h1><p>A 已实现；B、C 为界面方案预览。</p><main><article><h2>A · 精简分区（当前实现）</h2><p>统一色板与色号输入，常用选项直接可见。</p><img src="style-A.png"></article><article><h2>B · 分区卡片</h2><p>分区边界更明确，适合偏好独立设置块的使用方式。</p><img src="style-B.png"></article><article><h2>C · 紧凑检查器</h2><p>压缩纵向空间，自定义色号收进展开区。</p><img src="style-C.png"></article></main></html>`);
  console.log('PASS 分组打开状态/菜单、大纲主题色与粗体、画板边界/取消移除/滑动切换、样式面板明暗与窄屏；生成三种方案预览');
} catch (error) { if (page) await page.screenshot({ path: path.join(OUT, 'failure.png') }); throw error; }
finally { await browser?.close(); server.kill(); }
