/* 固定混合内容样本：中文长文、宽表、长行、图片、丢图与 PDF，两套主题/明暗/窄窗。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { launchBrowser } from './browser.mjs';
import { waitForApp, waitForNote, waitForLayout } from './waits.mjs';
import { pdfFixture } from './pdf-fixture.mjs';
const ROOT = path.resolve(import.meta.dirname, '..'), HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tracery-chrome-matrix-')), VAULT = path.join(HOME, 'vault'), OUT = path.join(ROOT, 'dist/chrome-matrix');
fs.mkdirSync(VAULT); fs.mkdirSync(OUT, { recursive: true });
const text = '# 固定混合样本\n\n![[样图.png|1100]]\n\n| 中文字段 | English field | 长内容 |\n| --- | --- | --- |\n| 数据 | sample | ' + '长文本'.repeat(150) + ' |\n\n' + ('## 小节\n\n' + '中文与 English 混合段落。'.repeat(40) + '\n\n').repeat(80);
fs.writeFileSync(path.join(VAULT, '混合.md'), text); fs.writeFileSync(path.join(VAULT, '阅读.pdf'), pdfFixture());
fs.copyFileSync(path.join(ROOT, 'public/icons/favicon-16.png'), path.join(VAULT, '样图.png'));
fs.writeFileSync(path.join(HOME, 'tracery.config.json'), JSON.stringify({ currentVault: VAULT, settings: { startup: 'empty' } }));
const packed = process.env.TRACERY_TEST_EXE, entry = packed ? path.join(path.dirname(packed), 'resources/app.asar/server/server.js') : path.join(ROOT, 'server/server.js');
const BASE = 'http://127.0.0.1:9686', server = spawn(packed || process.execPath, [entry], { env: { ...process.env, ...(packed ? { ELECTRON_RUN_AS_NODE: '1' } : {}), PORT: '9686', TRACERY_HOME: HOME }, windowsHide: true, stdio: 'pipe' });
let browser, page;
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/api/state')).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await launchBrowser({ width: 1440, height: 950 }); page = await browser.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(BASE, { waitUntil: 'networkidle0' }); await waitForApp(page); await page.evaluate(() => window.__tracery.openNote('混合.md')); await waitForNote(page, '混合.md');
  for (const themeName of ['apple', 'obsidian']) for (const themeMode of ['light', 'dark']) {
    await page.evaluate(async value => { const { updateSettings } = await import('/js/settings.js'); await updateSettings(value); }, { themeName, themeMode });
    for (const width of [1440, 1000, 760]) {
      await page.setViewport({ width, height: 950 }); await page.evaluate(() => document.body.classList.add('electron')); await waitForLayout(page);
      const geometry = await page.evaluate(() => {
        const rect = selector => document.querySelector(selector).getBoundingClientRect(); const bar = rect('.titlebar'), tab = rect('.tab.active'), more = rect('#btn-tab-more'), doc = rect('#document-header');
        return { bar: bar.height, centers: [bar, tab, more].map(box => box.top + box.height / 2), overflow: document.documentElement.scrollWidth - innerWidth,
          docHeight: doc.height, expected: parseFloat(getComputedStyle(document.querySelector('.layout')).getPropertyValue('--chrome-document-height')) };
      });
      assert.equal(geometry.bar, 46); assert.ok(Math.max(...geometry.centers) - Math.min(...geometry.centers) < 1, JSON.stringify(geometry)); assert.ok(geometry.overflow <= 1, JSON.stringify(geometry));
      await page.screenshot({ path: path.join(OUT, `${themeName}-${themeMode}-${width}.png`) });
    }
    await page.setViewport({ width: 1440, height: 950 }); await waitForLayout(page);
    await page.evaluate(() => window.__tracery.openNote('阅读.pdf', null, { newTab: true }));
    await page.waitForFunction(() => window.__tracery.state.currentPath === '阅读.pdf');
    assert.equal(await page.$eval('#document-header', el => el.hidden), true);
    await page.screenshot({ path: path.join(OUT, `${themeName}-${themeMode}-pdf.png`) });
    await page.evaluate(() => window.__tracery.openNote('混合.md')); await waitForNote(page, '混合.md');
  }
  // 真正修改面板布局，使侧栏页签换行，再核对文件标题分割线。
  await page.evaluate(async () => { const { updateSettings } = await import('/js/settings.js'); await updateSettings({ layout: { leftWidth: 190, panels: { navigation: ['library','pinned','recent','groups','outline','links','info'], context: [] } } }); });
  await waitForLayout(page);
  await page.waitForFunction(() => { const tabs = document.querySelector('#sidebar .dock-tabs').getBoundingClientRect(), header = document.querySelector('#document-header').getBoundingClientRect(), tools = document.querySelector('#sidebar .panel-actions').getBoundingClientRect(); return tabs.height > 32 && Math.abs(header.bottom - 1 - tools.top) < 1; });
  await page.screenshot({ path: path.join(OUT, 'wrapped-sidebar.png') });
  assert.equal(fs.readFileSync(path.join(VAULT, '混合.md'), 'utf8'), text); assert.deepEqual(errors, []);
  console.log('PASS 两套主题×明暗×三种桌面宽度、混合长文/宽表/图片/PDF、侧栏换行分割线与横向边界');
} catch (error) { if (page) await page.screenshot({ path: path.join(OUT, 'failure.png') }); throw error; }
finally { await browser?.close(); server.kill(); }
