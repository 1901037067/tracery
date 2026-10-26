import { launchBrowser as launchTestBrowser } from '../scripts/lib/browser.mjs';
/**
 * UI/UX 回归测试：布局调整、新建对话框、图片查看、图谱全屏
 * 使用临时仓库，不碰用户数据。
 */
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
    // 整行嵌入：图片 widget 只认「整行就是一个 ![[..]]」
    '![[z_图片/测试图.png]]', '',
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

  const browser = await launchTestBrowser({
    executablePath: EDGE, headless: 'new', args: ['--no-sandbox'],
    defaultViewport: { width: 1360, height: 880, deviceScaleFactor: 2 },
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle0' });
  await sleep(1200);

  /* ---------- 1. 布局 ---------- */
  const layout = await page.evaluate(() => {
    const ribbon = document.querySelector('.ribbon').getBoundingClientRect();
    const phone = document.getElementById('btn-phone-access').getBoundingClientRect();
    const theme = document.getElementById('btn-theme').getBoundingClientRect();
    const settings = document.getElementById('btn-settings').getBoundingClientRect();
    return {
      appName: document.querySelector('.app-name')?.textContent || null,
      leftText: document.querySelector('.titlebar-left')?.textContent.trim() || '',
      noBottomPlus: !document.getElementById('btn-new-note'),
      phoneBetween: theme.bottom <= phone.top && phone.bottom <= settings.top,
      themeInRibbon: theme.left < ribbon.right && theme.top > ribbon.top + 100,
      titlebarHasSettings: !!document.querySelector('.titlebar-right #btn-settings'),
    };
  });
  check('左上角不再显示 Tracery 文字', layout.appName === null && !layout.leftText.includes('Tracery'), JSON.stringify(layout));
  check('主题/仓库/设置移到左下角功能区', layout.themeInRibbon && !layout.titlebarHasSettings);
  check('移除底部加号，手机访问位于主题和设置之间', layout.noBottomPlus && layout.phoneBetween);
  await page.screenshot({ path: path.join(SHOTS, 'ux-layout.png') });

  /* ---------- 2. 新建笔记（对话框） ---------- */
  await page.click('#btn-new-note-2');
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
    // cm 的图片统一走 `.embed-image`：整行是 figure，行内是 span，
    // 都带 dataset.target。
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
  await page.click('.ribbon-btn[data-panel="graph"]');
  await sleep(1600);
  const focused = await page.evaluate(() => ({
    focus: document.body.classList.contains('graph-focus'),
    canvasW: Math.round(document.getElementById('graph-canvas').getBoundingClientRect().width),
    editorHidden: getComputedStyle(document.querySelector('.editor-area')).display === 'none',
    rightHidden: getComputedStyle(document.getElementById('sidebar-right')).display === 'none',
    availableW: document.querySelector('.layout').clientWidth - document.querySelector('.ribbon').offsetWidth,
  }));
  // 新入口直接全屏，旧的「先小图再点放大」断言按新设计改写。
  check('点击图谱直接铺满工作区', focused.focus && focused.canvasW >= focused.availableW - 24, JSON.stringify(focused));
  check('全屏时隐藏编辑区和右栏', focused.editorHidden && focused.rightHidden);
  await page.screenshot({ path: path.join(SHOTS, 'ux-graph-full.png') });

  // 从真实画布绘制坐标取得节点落点，验证鼠标操作而非直接调用回调。
  const nodePoint = () => page.evaluate(() => {
    const canvas = document.getElementById('graph-canvas');
    const ctx = canvas.getContext('2d');
    const original = ctx.arc;
    const points = [];
    ctx.arc = function(x, y, ...rest) {
      const p = this.getTransform().transformPoint(new DOMPoint(x, y));
      points.push({ x: p.x / devicePixelRatio, y: p.y / devicePixelRatio });
      return original.call(this, x, y, ...rest);
    };
    document.getElementById('btn-graph-fit').click();
    ctx.arc = original;
    const rect = canvas.getBoundingClientRect();
    return { x: rect.left + points[0].x, y: rect.top + points[0].y, path: window.__tracery.state.graph.nodes[0].id };
  });
  const point = await nodePoint();
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 80, point.y + 40, { steps: 10 });
  await page.mouse.up();
  check('拖动节点松手保持图谱打开', await page.evaluate(() => document.body.classList.contains('graph-focus')));
  await sleep(1600);
  const clickPoint = await nodePoint();
  await page.mouse.click(clickPoint.x, clickPoint.y);
  await sleep(600);
  check('单击节点返回编辑区并打开对应笔记', await page.evaluate((path) =>
    !document.body.classList.contains('graph-focus') && document.getElementById('note-path').textContent === path, clickPoint.path));

  await page.click('.ribbon-btn[data-panel="search"]');
  await page.click('.ribbon-btn[data-panel="graph"]');
  await page.keyboard.press('Escape');
  await sleep(400);
  const exited = await page.evaluate(() => ({
    focus: document.body.classList.contains('graph-focus'),
    searchActive: document.getElementById('panel-search').classList.contains('active'),
    editorVisible: getComputedStyle(document.getElementById('editor-area')).display !== 'none',
  }));
  check('Esc 关闭图谱并恢复先前的搜索面板', !exited.focus && exited.searchActive && exited.editorVisible, JSON.stringify(exited));

  await page.click('#btn-toggle-left');
  await sleep(300);
  await page.click('.ribbon-btn[data-panel="graph"]');
  await sleep(1000);
  check('左栏折叠时也能打开大图谱', await page.$eval('#graph-canvas', (el) => el.getBoundingClientRect().width > 1200));
  await page.click('#btn-graph-full');
  await sleep(300);
  check('关闭按钮恢复原来的左栏折叠状态', await page.$eval('#sidebar', (el) => el.getBoundingClientRect().width === 0));
  await page.click('#btn-toggle-left');

  await page.click('.ribbon-btn[data-panel="graph"]');
  await page.click('#tablist .tab.active');
  check('点击当前笔记标签也能返回编辑区', await page.evaluate(() => !document.body.classList.contains('graph-focus')));

  await page.keyboard.down('Control');
  await page.keyboard.press('p');
  await page.keyboard.up('Control');
  await page.type('#palette-input', '打开图谱视图');
  await sleep(300);
  await page.keyboard.press('Enter');
  await sleep(1000);
  check('命令面板同样直接打开大图谱', await page.evaluate(() => document.body.classList.contains('graph-focus')));
  await page.click('.ribbon-btn[data-panel="files"]');
  check('切换文件面板退出图谱', await page.evaluate(() => !document.body.classList.contains('graph-focus')));

  check('无渲染错误', errors.length === 0, errors.join(' | '));

  await browser.close();
  server.kill();
  fs.rmSync(TMP, { recursive: true, force: true });

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} 通过\n`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => { console.error('💥', e); process.exit(1); });
