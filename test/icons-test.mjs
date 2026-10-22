/* 验证原图对应的 PNG/ICO/网页安装入口，打包模式额外校验 exe 的真实图标资源。 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { launchBrowser } from './browser.mjs';
import { patchWindowsIcon } from '../scripts/lib/windows-icon.mjs';
import asar from '@electron/asar';

const ROOT = path.resolve(import.meta.dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tracery-icons-'));
const PORT = 9628, BASE = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const asset = file => fs.readFileSync(path.join(ROOT, file));
const sizes = { 'build/icon.png': 512, 'public/icon.png': 512, 'public/icons/icon-192.png': 192,
  'public/icons/icon-512.png': 512, 'public/icons/maskable-512.png': 512, 'public/icons/apple-touch-icon.png': 180,
  'public/icons/favicon-16.png': 16, 'public/icons/favicon-32.png': 32 };
for (const [file, size] of Object.entries(sizes)) {
  const png = asset(file);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), size, file); assert.equal(png.readUInt32BE(20), size, file);
}
assert.deepEqual(asset('build/icon.png'), asset('public/icon.png'));
const ico = asset('build/icon.ico'), expected = [16, 24, 32, 48, 64, 128, 256];
assert.equal(ico.readUInt16LE(2), 1); assert.equal(ico.readUInt16LE(4), expected.length);
for (let i = 0; i < expected.length; i++) {
  const p = 6 + i * 16, size = ico[p] || 256;
  assert.equal(size, expected[i]);
  const bytes = ico.subarray(ico.readUInt32LE(p + 12), ico.readUInt32LE(p + 12) + ico.readUInt32LE(p + 8));
  assert.equal(bytes.readUInt32BE(16), size);
  if ([16, 32].includes(size)) assert.deepEqual(bytes, asset(`public/icons/favicon-${size}.png`));
}
console.log('PASS 桌面 / favicon / 主屏幕图标尺寸与 ICO 七个分辨率一致');
let browser, server;
try {
  const packed = process.env.TRACERY_TEST_EXE;
  if (packed) {
    patchWindowsIcon(packed, ROOT, true);
    assert.deepEqual(asar.extractFile(path.join(path.dirname(packed), 'resources/app.asar'), 'build/icon.png'), asset('build/icon.png'));
    console.log('PASS exe 图标资源与 asar 内窗口图标均为新标志');
  }
  const script = packed ? path.join(path.dirname(packed), 'resources/app.asar/server/server.js') : path.join(ROOT, 'server/server.js');
  server = spawn(packed || process.execPath, [script], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), TRACERY_HOME: HOME,
    ...(packed ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }, stdio: 'pipe', windowsHide: true });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/api/state')).ok) break; } catch {} await sleep(250); }
  const png = Buffer.from(await (await fetch(BASE + '/icon.png')).arrayBuffer()); assert.deepEqual(png, asset('public/icon.png'));
  const manifest = await (await fetch(BASE + '/manifest.webmanifest')).json();
  for (const icon of manifest.icons) {
    const res = await fetch(BASE + icon.src); assert.equal(res.status, 200); assert.ok(res.headers.get('content-type').startsWith('image/png'));
  }
  const worker = await (await fetch(BASE + '/sw.js')).text();
  assert.ok(worker.includes('/icons/favicon-32.png') && worker.includes('/icons/maskable-512.png'));
  browser = await launchBrowser(); const page = await browser.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  const images = await page.$$eval('.app-logo img, .welcome-logo img', es => es.every(e => e.complete && e.naturalWidth === 512)); assert.ok(images);
  const favicons = await page.$$eval('link[rel="icon"]', es => es.map(e => e.getAttribute('href')));
  assert.deepEqual(favicons.sort(), ['/icons/favicon-16.png', '/icons/favicon-32.png']);
  const source = 'data:image/png;base64,' + asset('build/icon-source.png').toString('base64');
  const comparison = await page.evaluate(async source => {
    const original = new Image(), rendered = new Image(); original.src = source; rendered.src = '/icon.png';
    await Promise.all([original.decode(), rendered.decode()]);
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 512;
    const ctx = canvas.getContext('2d'); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(original, 0, 0, 512, 512);
    const reference = ctx.getImageData(0, 0, 512, 512).data;
    ctx.clearRect(0, 0, 512, 512); ctx.drawImage(rendered, 0, 0); const actual = ctx.getImageData(0, 0, 512, 512).data;
    let delta = 0; for (let i = 0; i < actual.length; i++) delta = Math.max(delta, Math.abs(actual[i] - reference[i]));
    return { width: original.naturalWidth, height: original.naturalHeight, delta };
  }, source);
  assert.equal(comparison.width, comparison.height); assert.ok(comparison.delta <= 1, JSON.stringify(comparison));
  const out = path.join(ROOT, 'dist/icon-check'); fs.mkdirSync(out, { recursive: true });
  await page.screenshot({ path: path.join(out, 'app-brand.png') });
  assert.deepEqual(errors, []);
  console.log('PASS 网页标志与原图缩放像素一致，favicon / 安装图标 / 缓存资源可用');
} finally {
  await browser?.close();
  if (server && server.exitCode === null) { const stopped = new Promise(resolve => server.once('exit', resolve)); server.kill(); await stopped; }
  fs.rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
