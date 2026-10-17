/**
 * 内置绘图：端到端验证
 * 打开绘图 → 画两笔 → 换色/粗细 → 撤销 → 保存 → 笔记里出现图片并真正渲染
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
const TMP = path.join(os.tmpdir(), 'tracery-draw-test');
const VAULT = path.join(TMP, 'vault');
const HOME = path.join(TMP, 'home');
const PORT = 9577;
const SHOTS = path.join(ROOT, 'test', 'screenshots');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  — ' + extra : ''}`);
};

async function waitFor(url) {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* retry */ }
    await sleep(250);
  }
  throw new Error('启动超时');
}

async function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(VAULT, { recursive: true });
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(VAULT, '画布.md'), '# 画布\n\n下面放一张图：\n', 'utf8');

  const server = spawn(process.execPath, ['server/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), TRACERY_HOME: HOME },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));
  await waitFor(`http://localhost:${PORT}/api/state`);
  await fetch(`http://localhost:${PORT}/api/vault/open`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: VAULT.replace(/\\/g, '/') }),
  });

  const browser = await puppeteer.launch({
    executablePath: EDGE, headless: 'new', args: ['--no-sandbox'],
    defaultViewport: { width: 1360, height: 860, deviceScaleFactor: 2 },
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle0' });
  await sleep(1200);
  await page.evaluate(() => [...document.querySelectorAll('#file-tree .tree-item')].find((i) => i.textContent.includes('画布'))?.click());
  await sleep(900);

  // 1. 打开绘图
  await page.evaluate(() => document.getElementById('btn-draw').click());
  await sleep(600);
  const opened = await page.evaluate(() => {
    const ov = document.querySelector('.draw-overlay');
    const cv = document.getElementById('draw-canvas');
    return {
      visible: !!ov && !ov.hidden,
      w: cv ? Math.round(cv.getBoundingClientRect().width) : 0,
      h: cv ? Math.round(cv.getBoundingClientRect().height) : 0,
      tools: document.querySelectorAll('.draw-tool').length,
      colors: document.querySelectorAll('.draw-swatch').length,
      sizes: document.querySelectorAll('.draw-size').length,
    };
  });
  check('绘图面板可打开且画布铺满', opened.visible && opened.w > 600 && opened.h > 300, JSON.stringify(opened));
  check('工具栏完整（3 工具/8 色/3 粗细）', opened.tools === 3 && opened.colors === 8 && opened.sizes === 3);

  // 2. 空画布保存应被拒绝
  await page.evaluate(() => document.getElementById('draw-save').click());
  await sleep(400);
  const stillOpen = await page.evaluate(() => !document.querySelector('.draw-overlay').hidden);
  check('空画布点保存不生成文件', stillOpen);

  // 3. 画两笔（第一笔黑，第二笔换红 + 粗）
  const box = await page.evaluate(() => {
    const r = document.getElementById('draw-canvas').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  await page.mouse.move(box.x + 140, box.y + 130);
  await page.mouse.down();
  for (let i = 0; i <= 24; i++) {
    await page.mouse.move(box.x + 140 + i * 12, box.y + 130 + Math.sin(i / 3) * 40);
  }
  await page.mouse.up();
  await sleep(150);

  await page.evaluate(() => {
    document.querySelector('.draw-swatch[data-color="#e5484d"]').click();
    document.querySelector('.draw-size[data-size="9"]').click();
  });
  await page.mouse.move(box.x + 160, box.y + 300);
  await page.mouse.down();
  for (let i = 0; i <= 20; i++) await page.mouse.move(box.x + 160 + i * 14, box.y + 300 + i * 6);
  await page.mouse.up();
  await sleep(250);
  const afterDraw = await page.evaluate(() => document.getElementById('draw-canvas').dataset.strokes);
  check('两笔都记录到画布', afterDraw === '2', `strokes=${afterDraw}`);
  await page.screenshot({ path: path.join(SHOTS, 'draw-canvas.png') });

  // 4. 撤销 / 重做
  await page.evaluate(() => document.getElementById('draw-undo').click());
  await sleep(150);
  const afterUndo = await page.evaluate(() => document.getElementById('draw-canvas').dataset.strokes);
  await page.evaluate(() => document.getElementById('draw-redo').click());
  await sleep(150);
  const afterRedo = await page.evaluate(() => document.getElementById('draw-canvas').dataset.strokes);
  check('撤销 / 重做生效', afterUndo === '1' && afterRedo === '2', `${afterDraw} → ${afterUndo} → ${afterRedo}`);

  // 5. 保存并插入笔记
  await page.evaluate(() => document.getElementById('draw-save').click());
  await sleep(2000);
  const closed = await page.evaluate(() => document.querySelector('.draw-overlay').hidden);
  check('保存后关闭绘图面板', closed);

  const note = await (await fetch(`http://localhost:${PORT}/api/note?path=` + encodeURIComponent('画布.md'))).json();
  const embed = /!\[\[(附件\/绘图[^\]]+\.png)\|640\]\]/.exec(note.content || '');
  check('笔记里插入了带尺寸的图片嵌入', !!embed, embed ? embed[0] : note.content.slice(0, 80));
  const imgPath = embed ? path.join(VAULT, embed[1]) : '';
  check('PNG 文件真的写到磁盘', !!imgPath && fs.existsSync(imgPath));
  if (imgPath && fs.existsSync(imgPath)) {
    const buf = fs.readFileSync(imgPath);
    check('文件是合法 PNG', buf.subarray(1, 4).toString() === 'PNG', `${buf.length} 字节`);
    const sidecar = imgPath.replace(/\.png$/, '.draw.json');
    check('笔画数据另存为 .draw.json', fs.existsSync(sidecar));
  }

  await sleep(600);
  const rendered = await page.evaluate(() => {
    const fig = document.querySelector('#editor-live .embed-image img');
    return fig ? { loaded: fig.naturalWidth > 0, w: Math.round(fig.getBoundingClientRect().width) } : null;
  });
  check('插入后笔记里能直接看到图', !!rendered && rendered.loaded, JSON.stringify(rendered));
  await page.screenshot({ path: path.join(SHOTS, 'draw-inserted.png') });

  check('无渲染错误', errors.length === 0, errors.join(' | '));

  await browser.close();
  server.kill();
  fs.rmSync(TMP, { recursive: true, force: true });

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} 通过\n`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => { console.error('💥', e); process.exit(1); });
