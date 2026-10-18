/**
 * UI/UX 回归测试：布局调整、新建对话框、图片查看、图谱全屏
 * 使用临时仓库，不碰用户数据。
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
const TMP = path.join(os.tmpdir(), 'tracery-uiux');
const VAULT = path.join(TMP, 'vault');
const HOME = path.join(TMP, 'home');
const PORT = 9575;
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
  fs.mkdirSync(path.join(VAULT, 'z_图片'), { recursive: true });
  fs.mkdirSync(HOME, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'demo-vault', '附件', '图谱示例.png'), path.join(VAULT, 'z_图片', '测试图.png'));
  fs.writeFileSync(path.join(VAULT, '图.md'), [
    '# 图片测试', '',
    '裸文件名 ![[测试图.png]]', '',
    '带目录 ![[z_图片/测试图.png]]', '',
    '带尺寸 ![[测试图.png|200]]', '',
    'md 图片 ![](z_图片/测试图.png)', '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(VAULT, '甲.md'), '# 甲\n\n[[乙]] [[图]]\n', 'utf8');
  fs.writeFileSync(path.join(VAULT, '乙.md'), '# 乙\n\n[[甲]]\n', 'utf8');

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
    defaultViewport: { width: 1360, height: 880, deviceScaleFactor: 2 },
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${PORT}/?engine=block`, { waitUntil: 'networkidle0' });   // pin 块级内核（依赖块级 DOM）
  await sleep(1200);

  /* ---------- 1. 布局 ---------- */
  const layout = await page.evaluate(() => {
    const ribbon = document.querySelector('.ribbon').getBoundingClientRect();
    const plus = document.getElementById('btn-new-note').getBoundingClientRect();
    const theme = document.getElementById('btn-theme').getBoundingClientRect();
    return {
      appName: document.querySelector('.app-name')?.textContent || null,
      leftText: document.querySelector('.titlebar-left')?.textContent.trim() || '',
      plusIsBottom: plus.bottom > ribbon.bottom - 80,
      plusAccent: document.getElementById('btn-new-note').classList.contains('accent'),
      themeInRibbon: theme.left < ribbon.right && theme.top > ribbon.top + 100,
      titlebarHasSettings: !!document.querySelector('.titlebar-right #btn-settings'),
    };
  });
  check('左上角不再显示 Tracery 文字', layout.appName === null && !layout.leftText.includes('Tracery'), JSON.stringify(layout));
  check('主题/仓库/设置移到左下角功能区', layout.themeInRibbon && !layout.titlebarHasSettings);
  check('新建按钮在左下角且为主色按钮', layout.plusIsBottom && layout.plusAccent);
  await page.screenshot({ path: path.join(SHOTS, 'ux-layout.png') });

  /* ---------- 2. 新建笔记（对话框） ---------- */
  await page.evaluate(() => document.getElementById('btn-new-note').click());
  await sleep(400);
  const dlg = await page.evaluate(() => ({
    open: !!document.querySelector('.dialog-backdrop') && !document.querySelector('.dialog-backdrop').hidden,
    title: document.querySelector('.dialog-title')?.textContent || '',
    hasInput: !!document.querySelector('.dialog-input'),
  }));
  check('点「+」弹出应用内新建对话框', dlg.open && dlg.hasInput && /新建/.test(dlg.title), JSON.stringify(dlg));
  await page.evaluate(() => {
    const inp = document.querySelector('.dialog-input');
    inp.value = '测试新建';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.dialog-ok').click();
  });
  await sleep(1200);
  const created = await page.evaluate(() => ({
    path: document.getElementById('note-path')?.textContent || '',
    treeHas: [...document.querySelectorAll('#file-tree .tree-item')].some((i) => i.textContent.includes('测试新建')),
  }));
  check('对话框确认后真的创建并打开了笔记', created.path.includes('测试新建') && created.treeHas, JSON.stringify(created));

  /* ---------- 3. 图片 ---------- */
  await page.evaluate(() => {
    [...document.querySelectorAll('#file-tree .tree-item')].find((i) => i.textContent.trim() === '图')?.click();
  });
  await sleep(1500);
  const imgs = await page.evaluate(() => {
    const fig = [...document.querySelectorAll('#editor-live .embed-image')];
    const mdImgs = [...document.querySelectorAll('#editor-live img.md-image')];
    return {
      embeds: fig.map((f) => {
        const img = f.querySelector('img');
        return {
          target: f.dataset.target,
          hasImg: !!img,
          loaded: img ? img.naturalWidth > 0 : false,
          width: img ? Math.round(img.getBoundingClientRect().width) : 0,
        };
      }),
      md: mdImgs.map((i) => ({ src: i.getAttribute('src'), loaded: i.naturalWidth > 0 })),
    };
  });
  check('图片嵌入（裸文件名）能显示', imgs.embeds.some((e) => e.target === '测试图.png' && e.loaded), JSON.stringify(imgs.embeds));
  check('图片嵌入（带目录）能显示', imgs.embeds.some((e) => e.target === 'z_图片/测试图.png' && e.loaded));
  const sized = imgs.embeds.find((e) => e.target === '测试图.png|200');
  check('图片嵌入支持 |200 尺寸', !!sized && sized.loaded && sized.width <= 220 && sized.width >= 150, JSON.stringify(sized));
  check('Markdown 相对路径图片能显示', imgs.md.some((m) => m.loaded), JSON.stringify(imgs.md));

  // 点图 → 灯箱
  await page.evaluate(() => document.querySelector('#editor-live .embed-image img').click());
  await sleep(500);
  const lb = await page.evaluate(() => ({
    open: !!document.querySelector('.lightbox') && !document.querySelector('.lightbox').hidden,
    src: document.querySelector('.lb-img')?.getAttribute('src') || '',
    scale: document.querySelector('.lb-scale')?.textContent || '',
  }));
  check('点击图片打开灯箱', lb.open && lb.src.includes('/api/file'), JSON.stringify(lb));
  await page.evaluate(() => document.querySelector('.lb-tools button[data-act="in"]').click());
  await sleep(200);
  const zoomed = await page.evaluate(() => document.querySelector('.lb-scale')?.textContent || '');
  check('灯箱可放大', parseInt(zoomed, 10) > parseInt(lb.scale, 10), `${lb.scale} → ${zoomed}`);
  await page.screenshot({ path: path.join(SHOTS, 'ux-lightbox.png') });
  await page.keyboard.press('Escape');
  await sleep(300);
  check('Esc 关闭灯箱', await page.evaluate(() => document.querySelector('.lightbox').hidden));

  /* ---------- 4. 图谱全屏 ---------- */
  await page.evaluate(() => document.querySelector('.ribbon-btn[data-panel="graph"]').click());
  await sleep(1200);
  const beforeW = await page.evaluate(() => Math.round(document.getElementById('graph-canvas').getBoundingClientRect().width));
  await page.evaluate(() => document.getElementById('btn-graph-full').click());
  await sleep(900);
  const focused = await page.evaluate(() => ({
    focus: document.body.classList.contains('graph-focus'),
    canvasW: Math.round(document.getElementById('graph-canvas').getBoundingClientRect().width),
    editorHidden: getComputedStyle(document.querySelector('.editor-area')).display === 'none',
  }));
  check('图谱全屏后画布明显变宽', focused.focus && focused.canvasW > beforeW * 2.5, `${beforeW} → ${focused.canvasW}`);
  check('全屏时隐藏编辑区', focused.editorHidden);
  await page.screenshot({ path: path.join(SHOTS, 'ux-graph-full.png') });
  await page.keyboard.press('Escape');
  await sleep(700);
  const exited = await page.evaluate(() => ({
    focus: document.body.classList.contains('graph-focus'),
    canvasW: Math.round(document.getElementById('graph-canvas').getBoundingClientRect().width),
  }));
  check('Esc 退出图谱全屏', !exited.focus && exited.canvasW < beforeW * 1.6, JSON.stringify(exited));

  check('无渲染错误', errors.length === 0, errors.join(' | '));

  await browser.close();
  server.kill();
  fs.rmSync(TMP, { recursive: true, force: true });

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} 通过\n`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => { console.error('💥', e); process.exit(1); });
