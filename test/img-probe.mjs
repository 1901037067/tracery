import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
const TMP = path.join(os.tmpdir(), 'tracery-img-probe');
const VAULT = path.join(TMP, 'vault');
const HOME = path.join(TMP, 'home');
const PORT = 9571;
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(path.join(VAULT, 'z_图片'), { recursive: true });
fs.mkdirSync(path.join(VAULT, '附件'), { recursive: true });
fs.mkdirSync(HOME, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'demo-vault/附件/图谱示例.png'), path.join(VAULT, 'z_图片/测试图.png'));
fs.writeFileSync(path.join(VAULT, '图.md'), [
  '# 图片测试', '',
  '裸文件名: ![[测试图.png]]', '',
  '带目录: ![[z_图片/测试图.png]]', '',
  '带尺寸: ![[测试图.png|200]]', '',
  'md 语法: ![](z_图片/测试图.png)', '',
  'md 带空格: ![](z_图片/测试 图.png)', '',
].join('\n'), 'utf8');

const server = spawn(process.execPath, ['server/server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), TRACERY_HOME: HOME }, stdio: 'pipe' });
server.stderr.on('data', d => process.stderr.write('srv: ' + d));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://localhost:${PORT}/api/state`)).ok) break; } catch {} await sleep(250); }
await fetch(`http://localhost:${PORT}/api/vault/open`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: VAULT }) });

const browser = await puppeteer.launch({ executablePath: 'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: 'new', args: ['--no-sandbox'], defaultViewport: { width: 1200, height: 900, deviceScaleFactor: 2 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console:' + m.text()); });
await page.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle0' });
await sleep(1000);
await page.evaluate(() => [...document.querySelectorAll('#file-tree .tree-item')].find(i => i.textContent.includes('图'))?.click());
await sleep(1200);
const info = await page.evaluate(() => ({
  embeds: [...document.querySelectorAll('#editor-live .embed')].map(el => ({
    target: el.dataset.target,
    title: el.querySelector('.embed-title')?.textContent,
    bodyHtml: el.querySelector('.embed-body')?.innerHTML?.slice(0, 160),
    img: el.querySelector('img') ? { src: el.querySelector('img').src, w: el.querySelector('img').naturalWidth, h: el.querySelector('img').naturalHeight } : null,
  })),
  imgs: [...document.querySelectorAll('#editor-live img')].map(i => ({ src: i.getAttribute('src'), nat: `${i.naturalWidth}x${i.naturalHeight}` })),
  imgCount: document.querySelectorAll('#editor-live img').length,
  md: window.__tracery.editor.md.slice(0, 200),
}));
console.log(JSON.stringify(info, null, 1));
console.log('errors:', JSON.stringify(errors));
await page.screenshot({ path: path.join(ROOT, 'test/screenshots/img-probe.png'), fullPage: false });
await browser.close(); server.kill(); fs.rmSync(TMP, { recursive: true, force: true });
