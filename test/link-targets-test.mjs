/* 附件不是待创建笔记：包括旧缓存、显式附件链接及正文点击入口。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Vault } from '../server/vault.js';
import { snapshotIndex } from '../server/index-cache.js';
import { noteIndex, resolveNote, missingNotePath } from '../public/js/wiki-path.js';
import { launchBrowser } from './browser.mjs';
import { waitForApp, waitForNote } from './waits.mjs';
const ROOT = path.resolve(import.meta.dirname, '..'), HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tracery-targets-'));
const VAULT = path.join(HOME, 'vault'), OUT = path.join(ROOT, 'dist/link-targets'); fs.mkdirSync(VAULT); fs.mkdirSync(OUT, { recursive: true });
const original = '# 附件引用\n\n![[Pasted image.PNG|448]]\n\n![[丢失图片.png]]\n\n![[说明.pdf#page=2]]\n\n[[Pasted image.PNG|查看图片]]\n\n[[缺失附件.pdf]]\n\n[[目标#小节|已有笔记]]\n\n![[目标]]\n\n[[计划笔记]]\n\n[[研究v1.2]]\n\n`[[代码示例]]`\n\n```md\n[[围栏示例]]\n```\n';
fs.writeFileSync(path.join(VAULT, '主笔记.md'), original); fs.writeFileSync(path.join(VAULT, '目标.md'), '# 目标\n\n## 小节');
fs.copyFileSync(path.join(ROOT, 'public/icons/favicon-16.png'), path.join(VAULT, 'Pasted image.PNG'));
const cold = new Vault(VAULT); await cold.open();
const expected = ['计划笔记', '研究v1.2'];
assert.deepEqual(cold.linksFor('主笔记.md').unresolved.map(link => link.raw), expected);
assert.equal(cold.linksFor('目标.md').backlinks.length, 1);
const index = noteIndex(['Pasted image.PNG.md', '目标.md']);
assert.equal(resolveNote('Pasted image.PNG', '', index), null, '附件名不能命中曾被误建的 .png.md');
for (const raw of ['Pasted image.PNG|448', '丢失图片.png', './说明.PDF#page=2', '视频.mp4', '附件.zip']) assert.equal(missingNotePath(raw), null);
assert.equal(missingNotePath('研究v1.2'), '研究v1.2.md', '带版本号的普通笔记名保持可创建');
// 模拟旧版本已写盘的错误元数据；正文及 stat 不改，修复必须通过暖缓存生效。
const rows = structuredClone(snapshotIndex(cold));
rows.find(([rel]) => rel === '主笔记.md')[1].links.push('Pasted image.PNG', '丢失图片.png', '说明.pdf');
assert.equal(await cold.cache.write(rows), true);
const warm = new Vault(VAULT); await warm.open();
assert.equal(warm.stats.parsed, 0); assert.equal(warm.stats.reads, 0);
assert.deepEqual(warm.linksFor('主笔记.md').unresolved.map(link => link.raw), expected);
assert.ok(warm.cache.stats.fileWrites > 0, '修复后的缓存元数据应提交');
const reopened = new Vault(VAULT); await reopened.open();
assert.equal(reopened.cache.shards.values().next().value.notes.get('主笔记.md').links.some(raw => /\.(png|pdf)$/i.test(raw)), false);
console.log('PASS 图片/PDF/附件不入待创建，笔记嵌入和普通笔记保留，旧缓存零正文读取修复并持久化');
fs.writeFileSync(path.join(HOME, 'tracery.config.json'), JSON.stringify({ currentVault: VAULT, settings: { themeMode: 'light', startup: 'empty' } }));
const BASE = 'http://127.0.0.1:9683';
const server = spawn(process.execPath, [path.join(ROOT, 'server/server.js')], { env: { ...process.env, TRACERY_HOME: HOME, PORT: '9683' }, windowsHide: true, stdio: 'pipe' });
let browser, page;
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/api/state')).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await launchBrowser({ width: 1440, height: 900 }); page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(BASE, { waitUntil: 'networkidle0' }); await waitForApp(page);
  await page.evaluate(() => window.__tracery.openNote('主笔记.md')); await waitForNote(page, '主笔记.md');
  await page.click('#tab-links');
  await page.waitForFunction(() => document.querySelector('.relation-unresolved summary')?.textContent === '待创建 · 2');
  const pending = await page.$$eval('.relation-unresolved .bl-name', nodes => nodes.map(el => el.textContent));
  assert.deepEqual(pending, ['[[计划笔记]]', '[[研究v1.2]]']);
  await page.evaluate(() => { window.__editor.setMode('read'); });
  const clickWiki = async label => {
    await page.waitForFunction(label => [...document.querySelectorAll('.cm-lp-wikilink')].some(el => el.textContent.includes(label)), {}, label);
    const handle = await page.evaluateHandle(label => [...document.querySelectorAll('.cm-lp-wikilink')].find(el => el.textContent.includes(label)), label);
    await handle.asElement().click(); await handle.dispose();
  };
  await clickWiki('查看图片');
  await page.waitForSelector('.lightbox.open');
  assert.equal(await page.$('.dialog-backdrop:not([hidden])'), null);
  await page.keyboard.press('Escape');
  await clickWiki('缺失附件.pdf');
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('找不到引用'));
  assert.equal(await page.$('.dialog-backdrop:not([hidden])'), null);
  await page.$eval('.relation-unresolved', el => { el.open = true; });
  await page.click('.relation-unresolved .backlink-item');
  await page.waitForSelector('.dialog-backdrop:not([hidden]) .dialog-cancel');
  await page.click('.dialog-cancel');
  await page.screenshot({ path: path.join(OUT, 'attachments-not-notes.png') });
  assert.equal(fs.readFileSync(path.join(VAULT, '主笔记.md'), 'utf8'), original);
  assert.equal(fs.readdirSync(VAULT).some(name => /\.(png|pdf)\.md$/i.test(name)), false);
  assert.deepEqual(errors, []);
  console.log('PASS 实际右栏只列缺失笔记，图片点开预览，缺失附件不触发创建，普通缺失笔记仍可创建');
} catch (error) { if (page) await page.screenshot({ path: path.join(OUT, 'failure.png') }); throw error; }
finally { await browser?.close(); server.kill(); }
