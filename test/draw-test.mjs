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
  await page.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle0' });
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
  const regions = await page.evaluate(() => {
    const rect = (selector) => { const r = document.querySelector(selector).getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }; };
    return { library: rect('.draw-drafts'), canvas: rect('#draw-canvas'), props: rect('.draw-props'), tools: rect('.draw-tools'), width: innerWidth };
  });
  check('图片库固定在左，样式固定在右，工具条位于画布上方且互不遮挡',
    regions.library.width >= 170 && regions.props.width >= 170
    && regions.library.right <= regions.canvas.left && regions.props.left >= regions.canvas.right
    && regions.tools.bottom <= regions.canvas.top && regions.props.right <= regions.width, JSON.stringify(regions));

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
    angle: Number(document.getElementById('draw-canvas').dataset.selectedAngle || 0),
  }));

  /* ---------- 3. 形状 + 手绘 ---------- */
  await pickTool('rect');
  await drag(P(220, 150), P(420, 280));
  check('拖拽画出矩形（1 个元素）', (await counts()).n === 1, JSON.stringify(await counts()));

  /* ---------- 3b. 旋转（2026-10-19 新增能力：画完的图形能转） ---------- */
  check('新画的形状初始角度为 0', (await counts()).angle === 0, JSON.stringify(await counts()));
  // 旋转柄在顶边中点上方 ROTATE_OFFSET=26px：矩形 (220,150)-(420,280) 的顶边中点是 (320,150)，
  // 所以柄在 (320,124)。拖到中心右侧 → 角度约 +90°。
  await drag(P(320, 124), P(430, 215));
  const rotated = await counts();
  check('拖旋转柄把图形转起来（角度 ≈ 90°）', Math.abs(rotated.angle) > 60, JSON.stringify(rotated));
  await page.screenshot({ path: path.join(SHOTS, 'draw-rotate.png') });
  // 旋转后的命中检测仍要准：点它应该还是选中它
  await page.mouse.click(P(320, 215).x, P(320, 215).y);
  await sleep(150);
  check('旋转后仍能点选到该图形', (await counts()).sel === 1, JSON.stringify(await counts()));

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
      // 旋转角是新增字段：老场景没有它（缺省 0），新场景必须带着它落盘
      const rectEl = (scene.elements || []).find((e) => e.type === 'rect') || {};
      check('场景 JSON 带着旋转角（≈ π/2）',
        Math.abs((rectEl.angle || 0) - Math.PI / 2) < 0.06, `angle=${rectEl.angle}`);
    }
  }

  await sleep(600);
  const rendered = await page.evaluate(() => {
    const fig = document.querySelector('#editor-live .embed-image img');
    return fig ? { loaded: fig.naturalWidth > 0, w: Math.round(fig.getBoundingClientRect().width) } : null;
  });
  check('插入后笔记里能直接看到图', !!rendered && rendered.loaded, JSON.stringify(rendered));
  await page.screenshot({ path: path.join(SHOTS, 'draw-inserted.png') });

  /* ---------- 10. 二次编辑：右键图片 → 编辑绘图 → 原地覆盖保存 ---------- */
  if (imgPath && fs.existsSync(imgPath)) {
    const beforeMtime = fs.statSync(imgPath).mtimeMs;
    const imgBox = await page.evaluate(() => {
      const img = document.querySelector('#editor-live .embed-image img');
      const r = img.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
    await page.mouse.click(imgBox.x, imgBox.y, { button: 'right' });
    await sleep(400);
    const hasEdit = await page.evaluate(() => [...document.querySelectorAll('.context-menu button')]
      .some((b) => b.textContent.includes('编辑绘图')));
    check('图片右键菜单有「编辑绘图」', hasEdit);
    await page.evaluate(() => [...document.querySelectorAll('.context-menu button')]
      .find((b) => b.textContent.includes('编辑绘图'))?.click());
    await sleep(900);
    const reopened = await page.evaluate(() => ({
      open: !document.querySelector('.draw-overlay').hidden,
      strokes: Number(document.getElementById('draw-canvas').dataset.strokes),
      label: document.getElementById('draw-save').textContent,
    }));
    check('重新编辑时载入原场景（3 个元素）', reopened.open && reopened.strokes === 3, JSON.stringify(reopened));
    check('编辑模式的按钮是「更新绘图」', reopened.label === '更新绘图', reopened.label);

    const cv2 = await page.evaluate(() => {
      const r = document.getElementById('draw-canvas').getBoundingClientRect();
      return { x: r.x, y: r.y };
    });
    await page.evaluate(() => document.querySelector('.draw-tool[data-tool="rect"]').click());
    await page.mouse.move(cv2.x + 420, cv2.y + 120);
    await page.mouse.down();
    await page.mouse.move(cv2.x + 560, cv2.y + 230, { steps: 10 });
    await page.mouse.up();
    await sleep(200);
    await page.evaluate(() => document.getElementById('draw-save').click());
    await sleep(1800);

    const after = await (await fetch(`http://localhost:${PORT}/api/note?path=` + encodeURIComponent('画布.md'))).json();
    const embeds = (after.content.match(/!\[\[/g) || []).length;
    check('更新绘图不新增嵌入（原地覆盖原文件）', embeds === 1, `embeds=${embeds}`);
    check('原 PNG 被覆盖（mtime 前进）', fs.statSync(imgPath).mtimeMs > beforeMtime);
    const scene2 = JSON.parse(fs.readFileSync(imgPath.replace(/\.png$/, '.draw.json'), 'utf8'));
    check('场景 JSON 同步更新（元素 3 → 4）', (scene2.elements || []).length === 4, `n=${(scene2.elements || []).length}`);
  }

  /* ---------- 11. 草稿箱：暂存 / 草稿箱重开 / 多开画板（2026-10-19 新功能） ---------- */
  await page.evaluate(() => localStorage.removeItem('tracery.drawDrafts'));
  await page.evaluate(() => document.getElementById('btn-draw').click());
  await sleep(700);
  await page.evaluate(() => document.querySelector('.draw-tool[data-tool="ellipse"]').click());
  await sleep(80);
  await drag(P(260, 150), P(420, 260));
  await page.evaluate(() => document.getElementById('draw-stash').click());
  await sleep(500);
  const stashDialog = await page.evaluate(() => {
    const d = document.querySelector('.dialog-backdrop');
    if (!d || d.hidden) return null;
    const card = d.querySelector('.dialog-card').getBoundingClientRect();
    const top = document.elementFromPoint(card.left + card.width / 2, card.top + 16);
    return { value: d.querySelector('.dialog-input').value, onTop: !!top?.closest?.('.dialog-backdrop') };
  });
  check('「暂存」弹出命名框，且对话框盖在绘图浮层之上', !!stashDialog && stashDialog.onTop, JSON.stringify(stashDialog));
  await page.evaluate(() => { document.querySelector('.dialog-input').value = '端到端草稿甲'; });
  await page.evaluate(() => document.querySelector('.dialog-ok').click());
  await sleep(400);
  const drafts1 = await page.evaluate(() => JSON.parse(localStorage.getItem('tracery.drawDrafts') || '[]').map((d) => ({ name: d.name, n: (d.elements || []).length })));
  check('暂存后草稿箱里出现这份草稿（元素也在）',
    drafts1.length === 1 && drafts1[0].name === '端到端草稿甲' && drafts1[0].n === 1, JSON.stringify(drafts1));

  await page.evaluate(() => document.getElementById('draw-clear').click());
  await sleep(200);
  await page.evaluate(() => document.getElementById('draw-drafts-btn').click());
  await sleep(300);
  const panelRows = await page.evaluate(() => ({
    visible: !document.getElementById('draw-drafts').hidden,
    names: [...document.querySelectorAll('#draw-drafts .dd-row .dd-name')].map((e) => e.textContent),
  }));
  check('草稿箱面板列得出这份草稿', panelRows.visible && panelRows.names.includes('端到端草稿甲'), JSON.stringify(panelRows));
  await page.evaluate(() => document.querySelector('.dd-open').click());
  await sleep(700);
  check('从草稿箱重开后画板内容回来了', (await counts()).n === 1, JSON.stringify(await counts()));

  // 多开：草稿箱 → 新建画板 → 再暂存一份 → 两份共存
  await page.evaluate(() => document.getElementById('draw-drafts-btn').click());
  await sleep(250);
  await page.evaluate(() => document.getElementById('draw-draft-new').click());
  await sleep(350);
  await page.evaluate(() => document.querySelector('.dialog-ok')?.click());
  await sleep(500);
  check('「新建画板」把画布清空（离开当前草稿）', (await counts()).n === 0, JSON.stringify(await counts()));
  await page.evaluate(() => document.querySelector('.draw-tool[data-tool="ellipse"]').click());
  await sleep(80);
  await drag(P(300, 340), P(460, 450));
  await page.evaluate(() => document.getElementById('draw-stash').click());
  await sleep(500);
  await page.evaluate(() => { const i = document.querySelector('.dialog-input'); if (i) i.value = '端到端草稿乙'; });
  await page.evaluate(() => document.querySelector('.dialog-ok').click());
  await sleep(400);
  const drafts2 = await page.evaluate(() => JSON.parse(localStorage.getItem('tracery.drawDrafts') || '[]').map((d) => d.name));
  check('多开画板：草稿箱能同时存两份',
    drafts2.length === 2 && drafts2.includes('端到端草稿甲') && drafts2.includes('端到端草稿乙'), JSON.stringify(drafts2));

  await page.evaluate(() => document.getElementById('draw-cancel').click());
  await sleep(400);
  check('关闭绘图后草稿仍在（本地暂存不随浮层清空）',
    (await page.evaluate(() => JSON.parse(localStorage.getItem('tracery.drawDrafts') || '[]').length)) === 2);

  /* ---------- 12. 固定图片库：旧图、草稿插入迁移与新画板隔离 ---------- */
  await page.click('#btn-draw');
  await sleep(800);
  check('未插入区显示草稿缩略图', await page.evaluate(() =>
    document.querySelectorAll('#draw-drafts .dd-preview canvas').length === 2));
  await page.click('#draw-inserted-btn');
  await page.waitForFunction(() => document.querySelector('#draw-drafts img')?.naturalWidth > 0);
  const insertedRow = await page.evaluate(() => ({
    count: document.querySelectorAll('#draw-drafts .dd-row').length,
    imageLoaded: document.querySelector('#draw-drafts img')?.naturalWidth > 0,
    path: document.querySelector('#draw-drafts .dd-row')?.dataset.path,
  }));
  check('已插入区可发现既有绘图并显示缩略图', insertedRow.count === 1 && insertedRow.path === embed?.[1] && insertedRow.imageLoaded, JSON.stringify(insertedRow));
  await page.click('#draw-drafts .dd-open');
  await sleep(400);
  check('图片库可重开既有场景并更新原图', (await counts()).n === 4 && await page.$eval('#draw-save', (el) => el.textContent === '更新绘图'));
  const originalImage = fs.readFileSync(imgPath);
  await page.click('#draw-draft-new');
  await sleep(150);
  await page.click('.dialog-ok');
  await sleep(300);
  await pickTool('ellipse');
  await drag(P(280, 180), P(440, 290));
  check('从已插入图切到新画板后恢复插入按钮', await page.$eval('#draw-save', (el) => el.textContent === '插入笔记'));
  await page.click('#draw-save');
  await sleep(1000);
  const newNote = await (await fetch(`http://localhost:${PORT}/api/note?path=${encodeURIComponent('画布.md')}`)).json();
  check('新画板另存插图，既有图片字节不变', (newNote.content.match(/!\[\[/g) || []).length === 2 && originalImage.equals(fs.readFileSync(imgPath)));

  await page.click('#btn-draw');
  await sleep(800);
  await page.click('#draw-drafts .dd-open');
  await sleep(300);
  await page.click('#draw-save');
  await sleep(1000);
  check('草稿插入成功后移出未插入区', await page.evaluate(() => JSON.parse(localStorage.getItem('tracery.drawDrafts')).length === 1));
  const library = await (await fetch(`http://localhost:${PORT}/api/drawings`)).json();
  check('已插入区按真实笔记引用收录三份绘图', library.drawings.length === 3 && library.drawings.every((d) => d.inserted && d.notes.includes('画布.md')));

  // 删除引用后不能继续标成「已插入」，文件仍可从未插入区重新使用。
  await page.evaluate(async (imagePath) => {
    const ed = window.__tracery.editor;
    const content = ed.getContent().split('\n').filter((line) => !line.includes(imagePath)).join('\n');
    ed.view.dispatch({ changes: { from: 0, to: ed.view.state.doc.length, insert: content } }); await ed.flush();
  }, embed[1]);
  const afterUnlink = await (await fetch(`http://localhost:${PORT}/api/drawings`)).json();
  check('移除笔记引用后绘图自动归入未插入', afterUnlink.drawings.find((d) => d.path === embed[1])?.inserted === false);
  await fetch(`http://localhost:${PORT}/api/note/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '分类检查.md', content: '# 分类\n\n```md\n![[组图]]\n```\n\n`![[组图]]`\n'.replaceAll('组图', embed[1]) }),
  });
  const codeExample = await (await fetch(`http://localhost:${PORT}/api/drawings`)).json();
  check('代码示例里的图片语法不算已插入', codeExample.drawings.find((d) => d.path === embed[1])?.inserted === false);
  await fetch(`http://localhost:${PORT}/api/note`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '分类检查.md', content: `# 分类\n\n![绘图](${encodeURI(embed[1])})\n` }),
  });
  const markdownImage = await (await fetch(`http://localhost:${PORT}/api/drawings`)).json();
  check('Markdown 图片引用同样归入已插入', markdownImage.drawings.find((d) => d.path === embed[1])?.notes.includes('分类检查.md'));
  await page.click('#btn-draw');
  await sleep(800);
  await page.screenshot({ path: path.join(SHOTS, 'draw-library.png') });
  await page.setViewport({ width: 800, height: 640, deviceScaleFactor: 1 });
  await sleep(400);
  // ≤900px 改成触屏抽屉，旧的「两边属性栏始终可见」口径随移动设计改写。
  check('窄窗口下画布铺开、侧栏默认收起、工具条可横向滚动', await page.evaluate(() => {
    const tools = document.querySelector('.draw-tools').getBoundingClientRect();
    const cv = document.getElementById('draw-canvas').getBoundingClientRect();
    return getComputedStyle(document.querySelector('.draw-props')).display === 'none' && tools.right <= innerWidth && cv.width >= 760 && cv.height > 300;
  }));
  await page.click('#draw-cancel');

  check('无渲染错误', errors.length === 0, errors.join(' | '));

  await browser.close();
  server.kill();
  fs.rmSync(TMP, { recursive: true, force: true });

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} 通过\n`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => { console.error('💥', e); process.exit(1); });
