/* 在隔离仓库中用真实按键验证改键、旧键停用、持久化，以及宽屏行号与菜单开合。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { launchBrowser } from './browser.mjs';
import { waitForApp } from './waits.mjs';
import { HOTKEY_COMMANDS, normalizeShortcut, shortcutFromEvent, validateShortcut } from '../public/js/hotkeys.js';

const ROOT = path.resolve(import.meta.dirname, '..'), HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tracery-hotkeys-'));
const VAULT = path.join(HOME, 'vault'), PORT = 9630, BASE = `http://localhost:${PORT}`;
const OUT = path.join(ROOT, 'dist/hotkeys-preview'); fs.mkdirSync(OUT, { recursive: true }); fs.mkdirSync(VAULT);
const content = '# 宽屏与快捷键\n\n普通内容用于检查行号间距。\n\n' + Array.from({ length: 180 }, (_, i) => `第${i + 1}行，这是用于滚动和定位的文本。`).join('\n');
fs.writeFileSync(path.join(VAULT, '主笔记.md'), content);
fs.writeFileSync(path.join(VAULT, '另一篇.md'), '# 另一篇\n');
fs.writeFileSync(path.join(HOME, 'tracery.config.json'), JSON.stringify({ currentVault: VAULT, settings: { startup: 'empty', themeMode: 'light', editorWidth: 720 } }));
const packed = process.env.TRACERY_TEST_EXE;
const script = packed ? path.join(path.dirname(packed), 'resources/app.asar/server/server.js') : path.join(ROOT, 'server/server.js');
const start = () => spawn(packed || process.execPath, [script], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), TRACERY_HOME: HOME, ...(packed ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }, stdio: 'pipe', windowsHide: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let server = start(), browser, checks = 0;
const check = name => { checks++; console.log('PASS ' + name); };
async function ready() { for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/api/state')).ok) return; } catch {} await sleep(200); } throw Error('启动超时'); }
async function stop() { if (server.exitCode === null) { const ended = new Promise(r => server.once('exit', r)); server.kill(); await ended; } }
try {
  assert.equal(normalizeShortcut('Ctrl+Shift+\\'), 'Mod+Shift+\\');
  assert.equal(shortcutFromEvent({ code: 'Backslash', key: '|', ctrlKey: true, shiftKey: true }), 'Mod+Shift+\\');
  assert.equal(shortcutFromEvent({ key: 'x', code: 'KeyX', ctrlKey: true, isComposing: true }), null);
  assert.ok(validateShortcut('newNote', 'Alt+F4'));
  check('组合键规范化、Shift标点、中文组合输入和系统保留键校验');
  await ready(); browser = await launchBrowser({ width: 2100, height: 1000 });
  const page = await browser.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.click('#file-tree [data-path="主笔记.md"]');
  await page.click('#btn-tab-more'); assert.ok(await page.$('.context-menu'));
  await page.click('#btn-tab-more'); assert.equal(await page.$('.context-menu'), null);
  assert.equal(await page.$eval('#btn-tab-more', e => e.getAttribute('aria-expanded')), 'false');
  await page.click('#btn-tab-more'); await page.keyboard.press('Escape'); assert.equal(await page.$('.context-menu'), null);
  await page.click('#btn-tab-more'); await page.click('#tab-library'); assert.equal(await page.$('.context-menu'), null);
  check('标签页下三角再次点击、Esc和外部点击均收起菜单并同步展开状态');
  await page.click('#btn-new-note-2');
  await page.waitForSelector('.dialog-backdrop:not([hidden])');
  await page.keyboard.down('Control'); await page.keyboard.press('Comma'); await page.keyboard.up('Control');
  assert.ok(await page.evaluate(() => !document.getElementById('settings') || document.getElementById('settings').hidden));
  assert.equal(await page.$eval('.dialog-backdrop', e => e.hidden), false);
  await page.keyboard.press('Escape');
  check('前台确认对话框阻止后台设置快捷键，取消后可继续使用工作区');
  await page.click('#btn-toggle-left'); await page.click('#btn-toggle-right'); await sleep(300);
  async function geometry() {
    return page.evaluate(() => {
      const editor = document.getElementById('editor-live').getBoundingClientRect(), scroller = document.querySelector('.cm-scroller').getBoundingClientRect(), gutter = document.querySelector('.cm-gutters')?.getBoundingClientRect();
      const view = window.__editor.view, text = view.coordsAtPos(view.state.doc.line(3).from), body = view.contentDOM.getBoundingClientRect();
      return { gap: gutter ? text.left - gutter.right : null, inset: text.left - editor.left, bar: editor.right - scroller.right, body: body.width, width: editor.width };
    });
  }
  for (const width of [560, 720, 1000]) {
    await page.evaluate(async width => { await window.__tracery.Api.saveSettings({ editorWidth: width }); }, width);
    await page.waitForFunction(width => document.documentElement.style.getPropertyValue('--editor-width') === width + 'px', {}, width); await sleep(200);
    const g = await geometry(); assert.ok(g.gap >= 8 && g.gap <= 40, JSON.stringify(g)); assert.ok(g.inset > 150, JSON.stringify(g)); assert.ok(Math.abs(g.bar) <= 2, JSON.stringify(g));
  }
  await page.screenshot({ path: path.join(OUT, 'wide-gutter.png') });
  check('2100px宽屏三种正文宽度下行号贴近正文，整列居中且滚动条留在最右侧');
  await page.evaluate(() => window.__tracery.Api.saveSettings({ lineNumbers: false }));
  await page.waitForFunction(() => !document.querySelector('.cm-gutters')); assert.equal((await geometry()).gap, null);
  await page.evaluate(() => window.__tracery.Api.saveSettings({ lineNumbers: true }));
  await page.waitForSelector('.cm-gutters');
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true }); await sleep(250);
  await page.waitForFunction(() => !!window.__tracery?.state.tree);
  await page.evaluate(() => window.__tracery.openNote('主笔记.md'));
  assert.ok((await geometry()).gap <= 40); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  await page.setViewport({ width: 1440, height: 900 }); await sleep(250);
  await page.waitForFunction(() => !!window.__tracery?.state.tree);
  await page.evaluate(() => window.__tracery.openNote('主笔记.md'));
  check('开关行号和手机窄屏时不留下宽屏空白或横向溢出');
  // 本轮展开状态会持久化；宽屏检查收起的侧栏需主动恢复，后续才能从文件树点选。
  await page.click('#btn-toggle-left'); await page.click('#btn-toggle-right');
  await page.waitForFunction(() => !document.getElementById('sidebar').classList.contains('collapsed') && !document.getElementById('sidebar-right').classList.contains('collapsed'));

  async function pane() {
    await page.bringToFront(); await page.click('#btn-settings');
    await page.waitForSelector('#settings:not([hidden])');
    await page.click('.settings-nav [data-pane="hotkeys"]');
    await page.waitForSelector('.settings-pane.active[data-pane="hotkeys"]');
  }
  async function chord(keys) {
    const parts = keys.split('+'), key = parts.pop();
    for (const modifier of parts) await page.keyboard.down(modifier);
    await page.keyboard.press(key);
    for (const modifier of parts.reverse()) await page.keyboard.up(modifier);
  }
  const row = id => `.hotkey-row[data-hotkey="${id}"]`;
  async function record(id, keys) { await page.click(row(id) + ' .hotkey-binding'); await chord(keys); }
  async function persisted(id, expected) {
    try { await page.waitForFunction(async ({ id, expected }) => (await (await fetch('/api/state')).json()).settings.hotkeys[id] === expected, {}, { id, expected }); }
    catch (error) {
      console.error('快捷键保存诊断', await page.evaluate(async id => ({ id, server: (await (await fetch('/api/state')).json()).settings.hotkeys, message: document.getElementById('hotkey-message')?.textContent, label: document.querySelector(`.hotkey-row[data-hotkey="${id}"] .hotkey-binding`)?.textContent, focus: document.activeElement?.outerHTML }), id));
      await page.screenshot({ path: path.join(OUT, 'save-failure.png') }); throw error;
    }
  }
  async function focusEditor() {
    await page.waitForFunction(() => window.__tracery.state.currentPath === '主笔记.md' && window.__editor.view.state.doc.lines > 3);
    await page.evaluate(() => { const v = window.__editor.view; v.dispatch({ selection: { anchor: v.state.doc.line(3).from } }); v.focus(); });
  }
  await pane(); assert.equal(await page.$$eval('.hotkey-row', es => es.length), HOTKEY_COMMANDS.length);
  await page.type('#hotkey-search', '加粗'); assert.equal(await page.$$eval('.hotkey-row:not([hidden])', es => es.length), 1);
  await page.$eval('#hotkey-search', e => { e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); });
  await record('palette', 'Control+Alt+P'); await persisted('palette', 'Mod+Alt+P');
  await record('newNote', 'Control+Alt+P');
  assert.ok(await page.$eval('#hotkey-message', e => e.textContent.includes('已用于')));
  assert.equal(await page.$eval(row('newNote') + ' .hotkey-binding', e => e.getAttribute('aria-pressed')), 'true');
  await page.keyboard.press('Escape'); assert.equal(await page.$eval('#settings', e => e.hidden), false);
  await record('newNote', 'A'); assert.ok(await page.$eval('#hotkey-message', e => e.textContent.includes('组合键'))); await page.keyboard.press('Escape');
  check('快捷键清单搜索、实际按键录制、冲突阻止、无效键拒绝及Esc取消录制');
  await page.screenshot({ path: path.join(OUT, 'settings-hotkeys.png') });
  await page.click('#set-done'); await focusEditor();
  await chord('Control+P'); assert.equal(await page.$eval('#palette', e => e.hidden), true);
  await chord('Control+Alt+P'); assert.equal(await page.$eval('#palette', e => e.hidden), false); await page.keyboard.press('Escape');
  await page.reload({ waitUntil: 'networkidle0' }); await pane();
  assert.equal(await page.$eval(row('palette') + ' .hotkey-binding', e => e.textContent), 'Ctrl+Alt+P');
  await page.click(row('palette') + ' .hotkey-clear'); await persisted('palette', null);
  await page.click('#set-done'); await page.click('#file-tree [data-path="主笔记.md"]'); await focusEditor();
  await chord('Control+Alt+P'); assert.equal(await page.$eval('#palette', e => e.hidden), true);
  await pane(); await page.click(row('palette') + ' .hotkey-reset'); await persisted('palette', 'Mod+P');
  check('新键立即生效、旧键停用、刷新后保留、清除绑定和单项还原');
  await record('bold', 'Control+Alt+B'); await persisted('bold', 'Mod+Alt+B');
  await record('undo', 'Control+Alt+Z'); await persisted('undo', 'Mod+Alt+Z');
  await page.click('#set-done');
  const selected = await page.evaluate(() => { const v = window.__editor.view, line = v.state.doc.line(3); v.dispatch({ selection: { anchor: line.from, head: line.from + 4 } }); v.focus(); return v.state.doc.toString(); });
  await chord('Control+B'); assert.equal(await page.evaluate(() => window.__editor.getContent()), selected);
  await chord('Control+Alt+B'); const bold = await page.evaluate(() => window.__editor.getContent()); assert.ok(bold.includes('**普通内容**'));
  await chord('Control+Z'); assert.equal(await page.evaluate(() => window.__editor.getContent()), bold);
  await chord('Control+Alt+Z'); assert.equal(await page.evaluate(() => window.__editor.getContent()), selected);
  await chord('Control+Y'); assert.ok((await page.evaluate(() => window.__editor.getContent())).includes('**普通内容**'));
  check('编辑区加粗和撤销改键真正生效，CodeMirror旧键不会继续触发，备用重做可用');
  await page.click('.ribbon-btn[data-panel="search"]'); await page.type('#search-input', '输入框撤销');
  const inputBefore = await page.$eval('#search-input', e => e.value);
  await chord('Control+Z');
  assert.notEqual(await page.$eval('#search-input', e => e.value), inputBefore);
  assert.equal(await page.evaluate(() => window.__editor.getContent()), bold);
  await chord('Control+Alt+Z'); assert.equal(await page.evaluate(() => window.__editor.getContent()), bold);
  await page.click('.ribbon-btn[data-panel="files"]'); await focusEditor();
  check('普通搜索输入框保留自身撤销，不会被笔记编辑快捷键抢走');
  const target = await page.evaluate(() => { const v = window.__editor.view, p = v.coordsAtPos(v.state.doc.line(3).from); return { x: p.left + 10, y: p.top + 8 }; });
  await page.mouse.click(target.x, target.y, { button: 'right' });
  await page.waitForSelector('.context-menu');
  assert.equal(await page.$eval('.context-menu button:first-child .mi-kbd', e => e.textContent), 'Ctrl+Alt+Z');
  await page.keyboard.press('Escape');
  check('编辑菜单同步显示修改后的快捷键提示');
  await chord('Control+Shift+Backslash'); assert.ok(await page.$eval('#sidebar-right', e => e.classList.contains('collapsed')));
  await chord('Control+Shift+Backslash'); assert.equal(await page.$eval('#sidebar-right', e => e.classList.contains('collapsed')), false);
  check('Ctrl+Shift+反斜线按物理键识别，可来回切换右侧栏');
  const rejected = await fetch(BASE + '/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hotkeys: { newNote: 'Mod+P' } }) });
  assert.equal(rejected.status, 400); check('服务端拒绝冲突绑定，不能绕过界面写入重复快捷键');
  await pane(); await record('settings', 'Control+Alt+Comma'); await persisted('settings', 'Mod+Alt+,'); await page.click('#set-done');
  await page.evaluate(() => window.__editor.flush());
  // 本段验证配置重启持久化；离线导航由 PWA 套件覆盖，避免重启间隙的离线页影响断言。
  await page.setBypassServiceWorker(true);
  await stop(); server = start(); await ready(); await page.goto(BASE, { waitUntil: 'networkidle0' });
  try { await waitForApp(page); } catch (error) {
    console.error('重启后的页面诊断', JSON.stringify({ errors, page: await page.evaluate(() => ({ title: document.title, body: document.body.innerText.slice(0, 500), scripts: [...document.scripts].map(s => s.src), controlled: Boolean(navigator.serviceWorker.controller) })) }));
    await page.screenshot({ path: path.join(OUT, 'restart-failure.png') }); throw error;
  }
  await page.evaluate(() => window.__tracery.switchPanel('files'));
  await page.waitForSelector('#file-tree [data-path="主笔记.md"]', { visible: true });
  await page.click('#file-tree [data-path="主笔记.md"]'); await focusEditor();
  await chord('Control+Comma'); assert.ok(await page.evaluate(() => !document.getElementById('settings') || document.getElementById('settings').hidden));
  await chord('Control+Alt+Comma'); assert.equal(await page.$eval('#settings', e => e.hidden), false);
  await page.click('.settings-nav [data-pane="hotkeys"]'); await page.click('#hotkey-reset-all'); await persisted('settings', 'Mod+,');
  const saved = JSON.parse(fs.readFileSync(path.join(HOME, 'tracery.config.json'), 'utf8')).settings.hotkeys;
  assert.ok(HOTKEY_COMMANDS.every(command => saved[command.id] === command.defaultKey));
  check('服务重启后仍使用自定义设置快捷键，恢复全部默认可持久化');
  assert.deepEqual(errors, []); check('无页面脚本错误');
  console.log(`${checks}/${checks} 通过`);
} finally { await browser?.close(); await stop(); fs.rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
