/**
 * 内置绘图（Excalidraw 风格白板）：端到端验证
 * ------------------------------------------------------------------
 * 打开绘图 → 画矩形 + 手绘 → 换背景/填充 → 选择并拖动 → 撤销/重做 →
 * Delete 删除 → 文字 → 保存插入笔记（PNG + 场景 JSON）
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
  const ENGINE = process.env.TRACERY_TEST_ENGINE || 'block';   // 内核：默认 block，cm 用 TRACERY_TEST_ENGINE=cm
  await page.goto(`http://localhost:${PORT}/?engine=${ENGINE}`, { waitUntil: 'networkidle0' });
  await sleep(1200);
  await page.evaluate(() => [...document.querySelectorAll('#file-tree .tree-item')].find((i) => i.textContent.includes('画布'))?.click());
  await sleep(900);

  /* ---------- 1. 打开面板 ---------- */
  await page.evaluate(() => document.getElementById('btn-draw').click());
  await sleep(600);
  const opened = await page.evaluate(() => {
    const ov = document.querySelector('.draw-overlay');
    const cv = document.getElementById('draw-canvas');
    return {
      visible: !!ov && !ov.hidden,
      w: cv ? Math.round(cv.getBoundingClientRect().width) : 0,
      h: cv ? Math.round(cv.getBoundingClientRect().height) : 0,
      tools: document.querySelectorAll('.draw-tool[data-tool]').length,
      colors: document.querySelectorAll('.draw-swatch').length,
      bgs: document.querySelectorAll('.draw-bg').length,
      sizes: document.querySelectorAll('.draw-size').length,
      fills: document.querySelectorAll('.draw-fill').length,
      dashes: document.querySelectorAll('.draw-dash').length,
      hasText: !!document.getElementById('draw-textedit'),
    };
  });
  check('绘图面板可打开且画布铺满', opened.visible && opened.w > 600 && opened.h > 300, JSON.stringify(opened));
  check('工具栏完整（10 工具 / 8 描边色 / 9 背景 / 3 线宽）',
    opened.tools === 10 && opened.colors === 8 && opened.bgs === 9 && opened.sizes === 3,
    `${opened.tools}/${opened.colors}/${opened.bgs}/${opened.sizes}`);
  check('属性面板有填充与线型 + 文字输入浮层',
    opened.fills === 3 && opened.dashes === 3 && opened.hasText);

  /* ---------- 2. 空画布保存应被拒绝 ---------- */
  await page.evaluate(() => document.getElementById('draw-save').click());
  await sleep(400);
  const stillOpen = await page.evaluate(() => !document.querySelector('.draw-overlay').hidden);
  check('空画布点保存不生成文件', stillOpen);

  const box = await page.evaluate(() => {
    const r = document.getElementById('draw-canvas').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const P = (dx, dy) => ({ x: box.x + dx, y: box.y + dy });
  const pickTool = async (t) => {
    await page.evaluate((tt) => document.querySelector(`.draw-tool[data-tool="${tt}"]`).click(), t);
    await sleep(80);
  };
  const drag = async (from, to, steps = 10) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
    }
    await page.mouse.up();
    await sleep(140);
  };
  const counts = () => page.evaluate(() => ({
    n: Number(document.getElementById('draw-canvas').dataset.strokes),
    sel: Number(document.getElementById('draw-canvas').dataset.selected),
  }));

  /* ---------- 3. 形状 + 手绘 ---------- */
  await pickTool('rect');
  await drag(P(220, 150), P(420, 280));
  check('拖拽画出矩形（1 个元素）', (await counts()).n === 1, JSON.stringify(await counts()));

  await pickTool('freedraw');
  await page.mouse.move(P(240, 360).x, P(240, 360).y);
  await page.mouse.down();
  for (let i = 0; i <= 20; i++) {
    await page.mouse.move(P(240 + i * 11, 360 + Math.sin(i / 2.5) * 34).x, P(240 + i * 11, 360 + Math.sin(i / 2.5) * 34).y);
  }
  await page.mouse.up();
  await sleep(200);
  check('画笔手绘记录为独立元素', (await counts()).n === 2, JSON.stringify(await counts()));

  /* ---------- 4. 形状样式：背景 + 排线填充 ---------- */
  await pickTool('select');
  await page.mouse.click(P(300, 210).x, P(300, 210).y);
  await sleep(120);
  const afterPick = await counts();
  check('点选矩形 → 选中 1 个', afterPick.sel === 1, JSON.stringify(afterPick));
  await page.evaluate(() => document.querySelector('.draw-bg[data-color="#a5d8ff"]').click());
  await sleep(150);
  const bgApplied = await page.evaluate(() => document.querySelector('.draw-bg[data-color="#a5d8ff"]').classList.contains('active'));
  check('给选中形状加背景色（应用到选区）', bgApplied);
  await page.screenshot({ path: path.join(SHOTS, 'draw-canvas.png') });

  /* ---------- 5. 拖动移动 ---------- */
  await drag(P(300, 210), P(360, 250), 8);
  check('拖动后仍保持选中', (await counts()).sel === 1, JSON.stringify(await counts()));

  /* ---------- 6. 撤销 / 重做 ---------- */
  const undoEnabled = await page.evaluate(() => !document.getElementById('draw-undo').disabled);
  await page.evaluate(() => document.getElementById('draw-undo').click());
  await sleep(150);
  await page.evaluate(() => document.getElementById('draw-redo').click());
  await sleep(150);
  check('撤销 / 重做可用且不丢元素', undoEnabled && (await counts()).n === 2, JSON.stringify(await counts()));

  /* ---------- 7. Delete 删除选中 ---------- */
  await pickTool('select');
  await page.mouse.click(P(360, 250).x, P(360, 250).y);
  await sleep(100);
  await page.keyboard.press('Delete');
  await sleep(200);
  const afterDel = (await counts()).n;
  await page.evaluate(() => document.getElementById('draw-undo').click());
  await sleep(200);
  check('Delete 删除选中元素且可撤销', afterDel === 1 && (await counts()).n === 2, `${afterDel} → ${(await counts()).n}`);

  /* ---------- 8. 文字 ---------- */
  await pickTool('text');
  await page.mouse.click(P(470, 200).x, P(470, 200).y);
  await sleep(200);
  const editorVisible = await page.evaluate(() => !document.getElementById('draw-textedit').hidden);
  await page.keyboard.type('示意图');
  await sleep(120);
  await page.keyboard.press('Escape');
  await sleep(250);
  check('文字工具出现就地输入框并能落字', editorVisible && (await counts()).n === 3,
    `editor=${editorVisible} n=${(await counts()).n}`);

  /* ---------- 9. 保存并插入笔记 ---------- */
  await page.evaluate(() => document.getElementById('draw-save').click());
  await sleep(2200);
  check('保存后关闭绘图面板', await page.evaluate(() => document.querySelector('.draw-overlay').hidden));

  const note = await (await fetch(`http://localhost:${PORT}/api/note?path=` + encodeURIComponent('画布.md'))).json();
  const embed = /!\[\[(附件\/绘图[^\]]+\.png)\|640\]\]/.exec(note.content || '');
  check('笔记里插入了带尺寸的图片嵌入', !!embed, embed ? embed[0] : note.content.slice(0, 80));
  const imgPath = embed ? path.join(VAULT, embed[1]) : '';
  check('PNG 文件真的写到磁盘', !!imgPath && fs.existsSync(imgPath));
  if (imgPath && fs.existsSync(imgPath)) {
    const buf = fs.readFileSync(imgPath);
    check('文件是合法 PNG 且不是空白图', buf.subarray(1, 4).toString() === 'PNG' && buf.length > 4000, `${buf.length} 字节`);
    const sidecar = imgPath.replace(/\.png$/, '.draw.json');
    check('场景数据另存为 .draw.json', fs.existsSync(sidecar));
    if (fs.existsSync(sidecar)) {
      const scene = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
      const types = (scene.elements || []).map((e) => e.type);
      check('场景 JSON 是 v2 且有形状/手绘/文字',
        scene.v === 2 && types.includes('rect') && types.includes('freedraw') && types.includes('text'),
        `v=${scene.v} types=${types.join(',')}`);
    }
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
