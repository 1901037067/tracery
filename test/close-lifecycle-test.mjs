import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
const ROOT = path.resolve(import.meta.dirname, '..'), require = createRequire(import.meta.url);
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tracery-native-close-')), VAULT = path.join(HOME, 'vault'); fs.mkdirSync(VAULT);
fs.writeFileSync(path.join(VAULT, '退出测试.md'), '# 退出测试\n原文');
fs.writeFileSync(path.join(HOME, 'tracery.config.json'), JSON.stringify({ currentVault: VAULT }));
const PORT = 9645, CDP = 9249, BASE = `http://localhost:${PORT}`;
const env = { ...process.env, TRACERY_HOME: HOME, PORT: String(PORT) }; delete env.ELECTRON_RUN_AS_NODE;
const packed = process.env.TRACERY_TEST_EXE;
const app = spawn(packed || require('electron'), [...(packed ? [] : [ROOT]), '--disable-gpu', '--no-sandbox', `--user-data-dir=${path.join(HOME, 'browser')}`, `--remote-debugging-port=${CDP}`], { cwd: ROOT, env, windowsHide: true, stdio: 'pipe' });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms)); let browser;
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${CDP}/json/version`)).ok && (await fetch(BASE + '/api/state')).ok) break; } catch {} await sleep(200); }
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP}` });
  const target = await browser.waitForTarget(t => t.url().includes(':' + PORT));
  const page = await target.page(); assert.ok(page);
  await page.waitForFunction(() => window.__tracery && typeof document.getElementById('win-close').onclick === 'function');
  await page.evaluate(async () => { await window.__tracery.openNote('退出测试.md'); window.__editor.setAutosave(60000); window.__editor.insertText('失败时保留'); });
  let fail = true, release, held = false;
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (request.method() === 'PUT' && new URL(request.url()).pathname === '/api/note') {
      if (fail) request.respond({ status: 503, contentType: 'application/json', body: '{"error":"模拟保存失败"}' });
      else { held = true; release = () => request.continue(); }
    } else request.continue();
  });
  await page.click('#win-close'); await page.waitForFunction(() => document.getElementById('save-notice').hidden === false);
  assert.equal(app.exitCode, null); assert.ok((await fetch(BASE + '/api/state')).ok);
  assert.ok(await page.evaluate(() => window.__editor.dirty));
  assert.ok(!fs.readFileSync(path.join(VAULT, '退出测试.md'), 'utf8').includes('失败时保留'));
  console.log('PASS 原生关闭遇到保存失败，窗口和服务保持运行、草稿未丢');
  fail = false; await page.click('#win-close');
  for (let i = 0; i < 60 && !held; i++) await sleep(50); assert.ok(held);
  assert.equal(app.exitCode, null); assert.ok((await fetch(BASE + '/api/state')).ok);
  release();
  for (let i = 0; i < 100 && app.exitCode === null; i++) await sleep(100);
  assert.equal(app.exitCode, 0);
  assert.ok(fs.readFileSync(path.join(VAULT, '退出测试.md'), 'utf8').includes('失败时保留'));
  let serverAlive = true;
  for (let i = 0; i < 30 && serverAlive; i++) { try { await fetch(BASE + '/api/state'); await sleep(100); } catch { serverAlive = false; } }
  assert.equal(serverAlive, false);
  console.log('PASS 延迟保存确认前不退出，落盘后原生窗口退出且服务子进程结束');
} finally { browser?.disconnect(); if (app.exitCode === null) app.kill(); }
