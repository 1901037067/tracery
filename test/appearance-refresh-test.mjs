import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { launchBrowser } from './browser.mjs';
import { waitForApp, waitForNote, waitForLayout } from './waits.mjs';
const ROOT = path.resolve(import.meta.dirname, '..'), HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tracery-appearance-'));
const VAULT = path.join(HOME, 'vault'), OUT = path.join(ROOT, 'dist/appearance-refresh'), BASE = 'http://127.0.0.1:9716';
const NOTE = '课程资料/很长的文件夹名称_用于验证路径自动换行/复杂笔记.md';
const SOURCE = '---\ntags: [课程, 复习]\ncourse: "#不是标签"\ncustom: keep-this\n---\n# 笔记\n\n正文 #课程 #数学\n\n```text\n#忽略代码标签\n```\n\n- [ ] 复习\n';
fs.mkdirSync(path.dirname(path.join(VAULT, NOTE)), { recursive: true }); fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(VAULT, NOTE), SOURCE);
fs.writeFileSync(path.join(HOME, 'tracery.config.json'), JSON.stringify({ currentVault: VAULT, settings: { startup: 'empty', themeMode: 'light' } }));
const server = spawn(process.execPath, [path.join(ROOT, 'server/server.js')], { env: { ...process.env, TRACERY_HOME: HOME, PORT: '9716' }, windowsHide: true, stdio: 'ignore' });
let browser, page;
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/api/state')).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await launchBrowser({ width: 1440, height: 1000 }); page = await browser.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(BASE, { waitUntil: 'networkidle0' }); await waitForApp(page);
  await page.evaluate(note => window.__tracery.openNote(note), NOTE); await waitForNote(page, NOTE, SOURCE);
  const set = settings => page.evaluate(async settings => { const { updateSettings } = await import('/js/settings.js'); await updateSettings(settings); }, settings);
  const aligned = async label => {
    await page.waitForFunction(() => { const tools = document.querySelector('#workspace-tools').getBoundingClientRect(); const footer = [...document.querySelectorAll('#editor-area .statusbar, #editor-area .note-list-footer')].find(el => el.getBoundingClientRect().height > 0); return footer && Math.abs(tools.top - footer.getBoundingClientRect().top) < 1; });
    return page.evaluate(label => { const tools = document.querySelector('#workspace-tools').getBoundingClientRect(), footer = [...document.querySelectorAll('#editor-area .statusbar, #editor-area .note-list-footer')].find(el => el.getBoundingClientRect().height > 0).getBoundingClientRect(); return { label, tools: tools.top, footer: footer.top, height: tools.height }; }, label);
  };
  const geometry = [await aligned('note')];
  await page.click('#tab-info'); await page.waitForSelector('#panel-note-tags', { visible: true });
  assert.equal(await page.$eval('#note-info-path', el => el.textContent), NOTE);
  assert.equal(await page.$eval('#note-tag-count', el => el.textContent), '3 个');
  assert.equal(await page.$$eval('#note-tags-list .tag-chip', els => els.some(el => el.textContent.includes('忽略代码标签'))), false);
  await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.copiedPath = value; } } }); });
  await page.click('#btn-copy-note-path'); assert.equal(await page.evaluate(() => window.copiedPath), NOTE);
  assert.ok(await page.$eval('.note-path-row', el => el.scrollWidth <= el.clientWidth + 1));
  await page.screenshot({ path: path.join(OUT, 'note-info-light.png') });
  await page.click('#btn-note-tag-add'); await page.waitForFunction(() => document.activeElement.id === 'property-tags');
  await page.$eval('#property-tags', el => { el.value = '课程, 复习, 新标签'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.click('#properties-save'); await page.waitForFunction(() => document.querySelector('#note-tag-count').textContent === '4 个');
  const saved = fs.readFileSync(path.join(VAULT, NOTE), 'utf8'); assert.ok(saved.includes('custom: keep-this')); assert.ok(saved.endsWith(SOURCE.slice(SOURCE.indexOf('# 笔记'))));
  await page.evaluate(() => window.__editor.setMode('read')); await page.waitForFunction(() => document.querySelector('#btn-note-tag-add').disabled);
  await page.evaluate(() => window.__editor.setMode('live'));
  // Modal state, keyboard and failure recovery. Opening must never enable LAN access.
  await page.$eval('#btn-phone-access', el => el.click()); await page.waitForFunction(() => document.querySelector('#phone-state-title').textContent.includes('已关闭'));
  assert.equal((await (await fetch(BASE + '/api/access')).json()).enabled, false);
  assert.equal(await page.$$eval('.phone-section > h3, .phone-section-heading h3', els => els.length), 3);
  await page.screenshot({ path: path.join(OUT, 'phone-off-light.png') });
  await page.focus('#btn-phone-close'); await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'phone-mode');
  await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement.id), 'btn-phone-close');
  await page.keyboard.press('Escape'); assert.equal(await page.$eval('#phone-access-panel', el => el.hidden), true);
  await page.setRequestInterception(true); let failure = true, starts = 0;
  const intercept = request => {
    if (request.url().endsWith('/api/access') && request.method() === 'GET' && failure) return request.respond({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '验收网络错误' }) });
    if (request.url().includes('/api/access/start')) starts++;
    return request.continue();
  };
  page.on('request', intercept); await page.$eval('#btn-phone-access', el => el.click()); await page.waitForFunction(() => document.querySelector('#phone-state-title').textContent === '状态读取失败');
  assert.equal(await page.$eval('#btn-phone-start', el => el.disabled), true); failure = false;
  await page.click('#btn-phone-refresh'); await page.waitForFunction(() => !document.querySelector('#btn-phone-start').disabled);
  await page.$eval('#btn-phone-start', el => { el.click(); el.click(); });
  await page.waitForFunction(() => document.querySelector('#phone-state-title').textContent.includes('已开启') && !document.querySelector('#btn-phone-start').disabled);
  assert.equal(starts, 1); assert.match(await page.$eval('#phone-code', el => el.textContent), /^\d{6}$/);
  await page.click('#btn-phone-copy-code'); assert.equal(await page.evaluate(() => window.copiedPath), await page.$eval('#phone-code', el => el.textContent));
  await page.screenshot({ path: path.join(OUT, 'phone-on-light.png') }); await page.click('#btn-phone-stop'); await page.waitForFunction(() => document.querySelector('#phone-state-title').textContent.includes('已关闭'));
  await page.keyboard.press('Escape'); page.off('request', intercept); await page.setRequestInterception(false);
  // Each built-in palette really loads and remains readable in both modes.
  const metrics = [];
  for (const themeName of ['apple', 'obsidian', 'paper', 'sage', 'dusk']) for (const themeMode of ['light', 'dark']) {
    await set({ themeName, themeMode });
    await page.waitForFunction(name => document.querySelector('#theme-css').sheet?.href.endsWith('/' + name + '.css'), {}, themeName);
    for (const width of [1440, 900, 390]) {
      await page.setViewport({ width, height: 950 }); await waitForLayout(page);
      await page.$eval('#btn-phone-access', el => el.click()); await page.waitForFunction(() => document.querySelector('#phone-state-title').textContent.includes('已关闭'));
      const data = await page.evaluate(() => {
        const rgb = value => value.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
        const luminance = value => { const c = rgb(value); return c[0] * .2126 + c[1] * .7152 + c[2] * .0722; };
        const ratio = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
        const card = document.querySelector('.phone-access-card'), c = getComputedStyle(card), desc = getComputedStyle(document.querySelector('.phone-access-heading p')), button = getComputedStyle(document.querySelector('#btn-phone-start'));
        return { overflow: document.documentElement.scrollWidth - innerWidth, cardOverflow: card.scrollWidth - card.clientWidth, textContrast: ratio(c.color, c.backgroundColor), secondaryContrast: ratio(desc.color, c.backgroundColor), buttonContrast: ratio(button.color, button.backgroundColor), background: c.backgroundColor };
      });
      assert.ok(data.overflow <= 1 && data.cardOverflow <= 1, JSON.stringify(data)); assert.ok(data.textContrast >= 4.5 && data.secondaryContrast >= 4.5 && data.buttonContrast >= 4.5, JSON.stringify({ themeName, themeMode, data }));
      metrics.push({ themeName, themeMode, width, ...data });
      if (width !== 900) await page.screenshot({ path: path.join(OUT, `phone-${themeName}-${themeMode}-${width}.png`) });
      await page.keyboard.press('Escape');
    }
  }
  await page.setViewport({ width: 1440, height: 1000 }); await set({ themeName: 'sage', themeMode: 'light', layout: { navigationSide: 'right' } }); await waitForLayout(page); geometry.push(await aligned('mirrored-note'));
  await page.click('#btn-note-list'); await page.waitForSelector('#note-list-view', { visible: true }); geometry.push(await aligned('note-list'));
  await page.click('#note-list-close'); await page.click('#btn-task-list'); await page.waitForSelector('#task-list-view', { visible: true }); geometry.push(await aligned('tasks'));
  await page.click('#task-close'); await set({ layout: { navigationSide: 'left' } });
  await page.click('#btn-settings'); await page.waitForSelector('.theme-picker');
  assert.equal(await page.$$eval('.theme-picker button', els => els.length), 5); assert.equal(await page.$eval('.theme-picker', el => el.textContent.includes('Apple 风')), false);
  await page.click('.theme-picker [data-value="paper"]'); await page.waitForFunction(() => document.querySelector('.theme-picker [data-value="paper"]').getAttribute('aria-pressed') === 'true');
  await page.waitForFunction(() => document.querySelector('#theme-css').sheet?.href.endsWith('/paper.css'));
  await page.waitForFunction(() => !document.getAnimations().some(animation => animation instanceof CSSTransition && animation.playState === 'running'));
  assert.equal(await page.$$eval('.theme-picker .active', els => els.length), 1);
  await page.screenshot({ path: path.join(OUT, 'skin-picker.png') });
  await page.setViewport({ width: 390, height: 844 }); await waitForLayout(page);
  assert.ok(await page.$eval('.theme-picker', el => el.scrollWidth <= el.clientWidth + 1));
  assert.equal(await page.$eval('.theme-picker', el => getComputedStyle(el).gridTemplateColumns.split(' ').length), 2);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(OUT, 'skin-picker-narrow.png') });
  await page.setViewport({ width: 1440, height: 1000 }); await waitForLayout(page);
  await page.evaluate(async () => { await (await import('/js/settings.js')).flushPendingSettings(); });
  assert.equal((await (await fetch(BASE + '/api/state')).json()).settings.themeName, 'paper');
  await page.reload({ waitUntil: 'networkidle0' }); await waitForApp(page); assert.equal(await page.evaluate(() => document.documentElement.dataset.themeName), 'paper');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(OUT, 'metrics.json'), JSON.stringify({ geometry, metrics, errors }, null, 2));
  console.log('PASS five persisted skins/light-dark/three widths/contrast, note path copy and combined tags, property focus/body preservation, phone status/error/retry/duplicate prevention/focus, note/list/task/mirrored footer alignment');
} catch (error) { if (page) await page.screenshot({ path: path.join(OUT, 'failure.png') }); throw error; }
finally { await browser?.close(); server.kill(); }

