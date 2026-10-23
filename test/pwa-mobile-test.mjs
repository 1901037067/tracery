/* 临时仓库 + 真实浏览器触屏与离线模式，验证安装资源、移动抽屉和断线后的内容保留。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { buildWorker } from '../server/pwa.js';
const ROOT = path.resolve(import.meta.dirname, '..');
const TMP = path.join(os.tmpdir(), 'tracery-pwa-mobile-test');
if (!path.resolve(TMP).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('临时路径越界');
fs.rmSync(TMP, { recursive: true, force: true });
const VAULT = path.join(TMP, 'vault'); fs.mkdirSync(VAULT, { recursive: true });
fs.writeFileSync(path.join(VAULT, '手机测试.md'), '# 手机测试\n\n正文测试，支持手机输入。\n\n## 小节\n\n> [!info] 提示\n> 手机也能阅读。\n');
fs.writeFileSync(path.join(VAULT, '另一篇.md'), '# 另一篇\n\n[[手机测试]]\n');
const OUT = path.join(ROOT, 'dist/pwa-preview'); fs.mkdirSync(OUT, { recursive: true });
const PORT = 9602, BASE = `http://127.0.0.1:${PORT}`;
const startServer = () => spawn(process.execPath, ['server/server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), TRACERY_HOME: path.join(TMP, 'home') }, stdio: 'pipe' });
let server = startServer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
function check(name, ok, detail = '') { checks.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); }
let browser;
try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/api/state')).ok) break; } catch {} await sleep(200); }
  await fetch(BASE + '/api/vault/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: VAULT }) });
  const manifestRes = await fetch(BASE + '/manifest.webmanifest'); const manifest = await manifestRes.json();
  check('manifest 可用且支持独立窗口安装', manifestRes.headers.get('content-type').includes('manifest+json') && manifest.display === 'standalone' && manifest.start_url === '/' && manifest.icons.length >= 3);
  for (const icon of manifest.icons) {
    const response = await fetch(BASE + icon.src); const png = Buffer.from(await response.arrayBuffer());
    check(`安装图标尺寸 ${icon.sizes} (${icon.purpose})`, response.ok && `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}` === icon.sizes);
  }
  const workerRes = await fetch(BASE + '/sw.js'); const source = await workerRes.text();
  check('worker 版本与资源清单由发布内容生成', workerRes.headers.get('cache-control') === 'no-cache' && !source.includes('__SHELL_') && source.includes('/js/mobile.js'));
  const shellDir = path.join(TMP, 'shell-version-test'); fs.mkdirSync(shellDir);
  fs.copyFileSync(path.join(ROOT, 'public/sw.js'), path.join(shellDir, 'sw.js'));
  fs.writeFileSync(path.join(shellDir, 'index.html'), 'version one');
  const before = buildWorker(shellDir); fs.writeFileSync(path.join(shellDir, 'index.html'), 'version two');
  check('资源内容变化会生成新的 worker 版本', before !== buildWorker(shellDir));
  browser = await puppeteer.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true, args: ['--no-sandbox'], defaultViewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true } });
  const page = await browser.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__tracery?.state.currentPath);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, { timeout: 30000 });
  check('service worker 已接管页面', await page.evaluate(() => navigator.serviceWorker.controller.scriptURL.endsWith('/sw.js')));
  const layout = await page.evaluate(() => {
    const r = document.getElementById('editor-area').getBoundingClientRect();
    return { width: r.width, left: getComputedStyle(document.getElementById('sidebar')).display, right: getComputedStyle(document.getElementById('sidebar-right')).display, overflow: document.documentElement.scrollWidth > innerWidth };
  });
  check('手机默认编辑区铺开、两侧栏收起、无整页横向溢出', layout.width >= 370 && layout.left === 'none' && layout.right === 'none' && !layout.overflow, JSON.stringify(layout));
  await page.screenshot({ path: path.join(OUT, 'mobile-editor.png') });
  await page.tap('#btn-toggle-left');
  check('触摸打开左抽屉且背景编辑器不接收操作', await page.evaluate(() => document.body.classList.contains('mobile-left-open') && document.getElementById('editor-area').inert));
  await page.screenshot({ path: path.join(OUT, 'mobile-files.png') });
  await page.tap('.ribbon-btn[data-panel="search"]');
  await page.type('#search-input', '手机测试'); await sleep(400);
  await page.tap('#search-results .search-result');
  await page.waitForFunction(() => !document.body.classList.contains('mobile-left-open') && document.getElementById('note-path').textContent === '手机测试.md');
  check('手机搜索可打开笔记并收回抽屉', await page.$eval('#note-path', (el) => el.textContent === '手机测试.md'));
  await page.tap('#btn-mode');
  await page.tap('#editor-live .cm-line:nth-child(3)');
  await page.keyboard.press('End'); await page.keyboard.type('手机输入验证'); await sleep(1200);
  const mobileNote = await (await fetch(BASE + '/api/note?path=' + encodeURIComponent('手机测试.md'))).json();
  check('触摸定位后输入中文可自动保存到仓库', mobileNote.content.includes('手机输入验证'));
  await page.tap('#btn-mode');
  await page.screenshot({ path: path.join(OUT, 'mobile-editor.png') });
  await page.tap('#btn-mode');
  await sleep(450);
  await page.tap('#btn-toggle-right');
  check('右侧大纲以抽屉展示', await page.evaluate(() => document.body.classList.contains('mobile-right-open') && document.querySelectorAll('#outline-list .outline-item').length >= 2));
  await page.screenshot({ path: path.join(OUT, 'mobile-outline.png') });
  await page.tap('#outline-list .outline-item');
  check('点击大纲后回到编辑区', await page.evaluate(() => !document.body.classList.contains('mobile-right-open')));
  await page.tap('#btn-toggle-left'); await page.tap('#btn-settings'); await sleep(200);
  const settings = await page.$eval('.settings-box', (el) => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; });
  check('手机设置弹窗适配视口', settings);
  await page.screenshot({ path: path.join(OUT, 'mobile-settings.png') });
  await page.keyboard.press('Escape');
  await page.tap('#btn-toggle-left');
  await page.tap('#btn-draw'); await page.waitForFunction(() => !document.querySelector('.draw-overlay').hidden);
  const canvas = await page.$eval('#draw-canvas', (el) => el.getBoundingClientRect().toJSON());
  check('手机绘图默认保留完整画布', canvas.width > 360 && canvas.right <= 390 && canvas.bottom <= 844);
  await page.tap('#draw-toggle-props');
  check('颜色面板通过触屏按钮展开', await page.evaluate(() => document.querySelector('.draw-overlay').classList.contains('draw-show-props')));
  await page.screenshot({ path: path.join(OUT, 'mobile-draw.png') });
  await page.tap('#draw-toggle-props');
  await page.tap('.draw-tool[data-tool="rect"]');
  const x = canvas.left + 60, y = canvas.top + 210;
  const touch = await page.touchscreen.touchStart(x, y);
  await touch.move(x + 90, y + 80);
  await touch.end();
  await sleep(250);
  check('真实触屏拖动可画出图形', await page.$eval('#draw-canvas', (el) => el.dataset.strokes === '1'));
  await page.tap('#draw-cancel');
  await page.waitForFunction(() => document.querySelector('.draw-overlay').hidden);
  check('画布触屏手势后按钮仍可正常关闭绘图', await page.$eval('.draw-overlay', (el) => el.hidden));
  await page.tap('#btn-toggle-left'); await page.tap('.ribbon-btn[data-panel="graph"]'); await sleep(1000);
  check('手机图谱铺开且可接受触屏指针', await page.$eval('#graph-canvas', (el) => el.getBoundingClientRect().width > 360 && getComputedStyle(el).touchAction === 'none'));
  await page.screenshot({ path: path.join(OUT, 'mobile-graph.png') });
  await page.tap('#btn-graph-full');
  await page.waitForFunction(() => !document.body.classList.contains('graph-focus'));
  for (const [width, height] of [[360, 740], [768, 1024], [844, 390]]) {
    await page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: true, hasTouch: true }); await sleep(200);
    const rect = await page.evaluate(() => {
      const r = document.getElementById('editor-area').getBoundingClientRect();
      return { scrollWidth: document.documentElement.scrollWidth, width: innerWidth, editorWidth: r.width, editorHeight: r.height };
    });
    check(`${width}×${height} 窄屏 / 平板 / 横屏布局无溢出`, rect.scrollWidth <= rect.width && rect.editorWidth >= rect.width - 16 && rect.editorHeight >= 220, JSON.stringify(rect));
    if (width === 844) await page.screenshot({ path: path.join(OUT, 'mobile-landscape.png') });
  }
  await page.setViewport({ width: 1360, height: 860, deviceScaleFactor: 1, isMobile: false, hasTouch: false }); await sleep(400);
  check('回到桌面恢复原有三栏', await page.$eval('#sidebar', (el) => el.getBoundingClientRect().width === 272));
  await page.evaluate(() => { window.__tracery.editor.setMode('source'); });
  await page.setOfflineMode(true);
  await page.evaluate(() => { const ed = window.__tracery.editor; ed.view.dispatch({ changes: { from: ed.view.state.doc.length, insert: '\n离线保留内容' } }); });
  await sleep(1300);
  check('断线保存失败不会清除 dirty，文字已保存在设备', await page.evaluate(() => window.__tracery.editor.dirty && Object.keys(localStorage).some((key) => key.startsWith('tracery.unsaved:') && localStorage.getItem(key).includes('离线保留内容'))));
  const apiUncached = await page.evaluate(async () => { try { await fetch('/api/state'); return false; } catch { return true; } });
  check('仓库 API 不从缓存冒充在线数据', apiUncached);
  // 浏览器的离线模拟只覆盖页面目标；停掉隔离的服务才能验证 worker 自身的网络失败分支。
  await new Promise((resolve) => { server.once('exit', resolve); server.kill(); });
  await page.reload({ waitUntil: 'domcontentloaded' });
  check('离线冷启动显示可重连的页面', await page.$eval('h1', (el) => el.textContent.includes('无法连接笔记仓库')));
  await page.screenshot({ path: path.join(OUT, 'offline.png') });
  server = startServer();
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/api/state')).ok) break; } catch {} await sleep(200); }
  await page.setOfflineMode(false); await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('.dialog-ok');
  check('重新连接后提示恢复该仓库笔记的未保存内容', await page.$eval('.dialog-title', (el) => el.textContent.includes('恢复未保存')));
  const beforeRestore = await (await fetch(BASE + '/api/note?path=' + encodeURIComponent('手机测试.md'))).json();
  check('用户确认前不会用设备草稿覆盖仓库内容', !beforeRestore.content.includes('离线保留内容'));
  await page.click('.dialog-ok'); await sleep(1500);
  const note = await (await fetch(BASE + '/api/note?path=' + encodeURIComponent('手机测试.md'))).json();
  check('确认恢复后内容成功落盘并清除设备草稿', note.content.includes('离线保留内容') && await page.evaluate(() => !window.__tracery.editor.dirty && !Object.keys(localStorage).some((key) => key.startsWith('tracery.unsaved:'))));
  let releaseSave; let delayed = false;
  const intercept = (request) => {
    if (!delayed && request.method() === 'PUT' && new URL(request.url()).pathname === '/api/note') {
      delayed = true; releaseSave = () => request.continue();
    } else request.continue();
  };
  await page.setRequestInterception(true); page.on('request', intercept);
  await page.evaluate(() => { const ed = window.__tracery.editor; ed.setAutosave(100); ed.insertText('保存中甲'); });
  for (let i = 0; i < 30 && !delayed; i++) await sleep(50);
  await page.evaluate(() => window.__tracery.editor.insertText('保存中乙'));
  check('保存请求未完成时新输入仍标记为未保存', delayed && await page.evaluate(() => window.__tracery.editor.dirty));
  await releaseSave();
  await page.evaluate(() => window.__tracery.editor.flush());
  page.off('request', intercept); await page.setRequestInterception(false);
  const concurrent = await (await fetch(BASE + '/api/note?path=' + encodeURIComponent('手机测试.md'))).json();
  check('保存期间继续输入的两段文字都落盘', concurrent.content.includes('保存中甲') && concurrent.content.includes('保存中乙') && await page.evaluate(() => !window.__tracery.editor.dirty));
  check('无页面脚本错误', errors.length === 0, errors.join(' | '));
} finally {
  await browser?.close(); server.kill();
}
console.log(`${checks.filter(Boolean).length}/${checks.length} 通过`);
process.exit(checks.every(Boolean) ? 0 : 1);
