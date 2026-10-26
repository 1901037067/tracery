import { launchBrowser as launchTestBrowser } from '../scripts/lib/browser.mjs';
/**
 * 多标签页 / 栏宽拖拽 / 绘图历史 回归测试
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
const TMP = path.join(os.tmpdir(), 'tracery-tabs-test');
const VAULT = path.join(TMP, 'vault');
const HOME = path.join(TMP, 'home');
const PORT = 9581;
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
  for (const n of ['甲', '乙', '丙']) fs.writeFileSync(path.join(VAULT, `${n}.md`), `# ${n}\n\n这是 ${n}。\n`, 'utf8');

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
    defaultViewport: { width: 1400, height: 880, deviceScaleFactor: 2 },
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle0' });
  await sleep(1400);

  const clickTree = (name) => page.evaluate((n) => {
    [...document.querySelectorAll('#file-tree .tree-item')]
      .find((i) => i.textContent.trim() === n)?.click();
  }, name);

  // 1. 启动时已自动开了一篇，再开两篇 → 三个标签
  const bootName = await page.evaluate(() => document.getElementById('note-path').textContent.replace(/\.md$/, ''));
  const toOpen = ['甲', '乙', '丙'].filter((n) => n !== bootName);
  for (const n of toOpen.slice(0, 2)) { await clickTree(n); await sleep(550); }
  const tabs1 = await page.evaluate(() => ({
    count: document.querySelectorAll('#tablist .tab').length,
    names: [...document.querySelectorAll('#tablist .tab-name')].map((e) => e.textContent),
    activeName: document.querySelector('#tablist .tab.active .tab-name')?.textContent,
    path: document.getElementById('note-path').textContent,
  }));
  check('每打开一篇笔记新增一个标签', tabs1.count === 3, JSON.stringify(tabs1));
  check('最后打开的标签处于激活状态', tabs1.activeName === toOpen[1] && tabs1.path === `${toOpen[1]}.md`, JSON.stringify(tabs1));

  // 2. 切到一个「不是当前」的标签，内容应随之更换
  const otherIdx = await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('#tablist .tab')];
    const i = tabs.findIndex((t) => !t.classList.contains('active'));
    tabs[i].click();
    return i;
  });
  await sleep(650);
  const switched = await page.evaluate((i) => ({
    path: document.getElementById('note-path').textContent,
    body: document.querySelector('#editor-live').textContent,
    activeIdx: [...document.querySelectorAll('#tablist .tab')].findIndex((t) => t.classList.contains('active')),
    expect: [...document.querySelectorAll('#tablist .tab-name')][i].textContent,
  }), otherIdx);
  check('切换标签会换内容', switched.path === `${switched.expect}.md` && switched.body.includes(switched.expect) && switched.activeIdx === otherIdx, JSON.stringify(switched));
  await page.screenshot({ path: path.join(SHOTS, 'tabs.png') });

  // 3. 用关闭按钮关掉某个标签
  const closedName = await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('#tablist .tab')];
    const target = tabs.find((t) => !t.classList.contains('active'));
    const name = target.querySelector('.tab-name').textContent;
    target.querySelector('.tab-close').click();
    return name;
  });
  await sleep(450);
  const afterClose = await page.evaluate(() => [...document.querySelectorAll('#tablist .tab-name')].map((e) => e.textContent));
  check('关闭按钮移除对应标签', afterClose.length === 2 && !afterClose.includes(closedName), `${closedName} → ${afterClose.join(',')}`);

  // 4. Ctrl+W 关闭当前标签
  await page.keyboard.down('Control'); await page.keyboard.press('KeyW'); await page.keyboard.up('Control');
  await sleep(550);
  const afterW = await page.evaluate(() => ({
    count: document.querySelectorAll('#tablist .tab').length,
    path: document.getElementById('note-path').textContent,
    activeName: document.querySelector('#tablist .tab.active .tab-name')?.textContent,
  }));
  check('Ctrl+W 关闭当前标签并切到邻页', afterW.count === 1 && afterW.path === `${afterW.activeName}.md`, JSON.stringify(afterW));

  // 5. 刷新后标签恢复
  const reopen = ['甲', '乙', '丙'].find((n) => n !== afterW.activeName);
  await clickTree(reopen); await sleep(500);
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(1700);
  const restored = await page.evaluate(() => ({
    names: [...document.querySelectorAll('#tablist .tab-name')].map((e) => e.textContent),
    active: document.querySelector('#tablist .tab.active .tab-name')?.textContent,
  }));
  check('刷新后恢复标签页与激活项', restored.names.length === 2 && restored.active === reopen, JSON.stringify(restored));

  // 5b. 标签栏外观（卡片 + 常显关闭钮）与拖拽换序（2026-10-19 新版）
  const look = await page.evaluate(() => {
    const list = document.getElementById('tablist');
    const tabs = [...list.querySelectorAll('.tab')];
    const cs = getComputedStyle(list);
    return {
      gap: parseFloat(cs.columnGap || cs.gap || '0'),
      count: tabs.length,
      divider: Math.max(...tabs.map((t) => parseFloat(getComputedStyle(t).borderRightWidth) || 0)),
      firstRadius: parseFloat(getComputedStyle(tabs[0]).borderTopLeftRadius),
      height: Math.round(tabs[0].getBoundingClientRect().height),
      top: Math.round(tabs[0].getBoundingClientRect().top),
      barHeight: Math.round(document.querySelector('.titlebar').getBoundingClientRect().height),
      closeOpacity: Number(getComputedStyle(tabs[0].querySelector('.tab-close')).opacity),
    };
  });
  // 契约更新（2026-10-19）：标签从「33px 卡片贴底坐」改成**铺满标题栏高度**——
  // 顶边要贴到窗口最上方（top≈0）、高度≈标题栏高度，见 docs/HANDOFF.md §5 新决策。
  check('标签为有间距的紧凑卡片，留出标题栏边缘',
    look.gap >= 3 && look.firstRadius >= 6 && look.top >= 3 && look.height < look.barHeight
    && look.closeOpacity > 0.2,
    JSON.stringify(look));

  const idleTab = await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('#tablist .tab')];
    const i = tabs.findIndex((t) => !t.classList.contains('active'));
    return { idx: i, color: getComputedStyle(tabs[i]).color };
  });
  await page.hover(`#tablist .tab:nth-child(${idleTab.idx + 1})`);
  await sleep(300);
  const hoverColor = await page.evaluate((i) => getComputedStyle(document.querySelectorAll('#tablist .tab')[i]).color, idleTab.idx);
  check('悬停标签改变文字颜色', hoverColor !== idleTab.color, `${idleTab.color} → ${hoverColor}`);

  const order0 = await page.evaluate(() => [...document.querySelectorAll('#tablist .tab-name')].map((e) => e.textContent));
  const boxes = await page.evaluate(() => [...document.querySelectorAll('#tablist .tab')].map((t) => {
    const r = t.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left };
  }));
  await page.mouse.move(boxes[1].x, boxes[1].y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(boxes[1].x + (boxes[0].left + 5 - boxes[1].x) * (i / 10), boxes[1].y);
    await sleep(20);
  }
  const dragPreview = await page.evaluate(() => {
    const el = document.querySelector('.tab-drag-preview');
    const r = el?.getBoundingClientRect();
    return { name: el?.querySelector('.tab-drop-caption')?.textContent, moving: el?.querySelector('.is-moving')?.textContent, x: r?.left, y: r?.top, pointerEvents: el ? getComputedStyle(el).pointerEvents : '' };
  });
  check('拖动时显示松手后的排列预览且不遮挡落点',
    dragPreview.name?.includes('松开后') && dragPreview.moving === order0[1] && dragPreview.pointerEvents === 'none'
    && Math.abs(dragPreview.x - (boxes[0].left + 5)) < 280 && dragPreview.y > boxes[1].y && dragPreview.y < 120, JSON.stringify(dragPreview));
  await page.mouse.up();
  check('拖动结束移除标签预览', await page.evaluate(() => !document.querySelector('.tab-drag-preview')));
  await sleep(500);
  const order1 = await page.evaluate(() => ({
    names: [...document.querySelectorAll('#tablist .tab-name')].map((e) => e.textContent),
    active: document.querySelector('#tablist .tab.active .tab-name')?.textContent,
    path: document.getElementById('note-path').textContent,
  }));
  check('拖拽标签可换序（第二个拖到第一个前面）',
    order0.length === 2 && order1.names[0] === order0[1] && order1.names[1] === order0[0],
    `${order0.join(',')} → ${order1.names.join(',')}`);
  check('换序后激活的仍是同一篇笔记', order1.path === `${order1.active}.md`, JSON.stringify(order1));

  // 6. 拖拽左栏宽度
  const before = await page.evaluate(() => Math.round(document.getElementById('sidebar').getBoundingClientRect().width));
  const handle = await page.evaluate(() => { const r = document.getElementById('resizer-left').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  await page.mouse.move(handle.x + 110, handle.y, { steps: 10 });
  await page.mouse.up();
  await sleep(300);
  const after = await page.evaluate(() => Math.round(document.getElementById('sidebar').getBoundingClientRect().width));
  check('拖拽可加宽左侧栏', after > before + 60, `${before} → ${after}`);

  // 7. 拖拽右栏宽度
  const rb = await page.evaluate(() => Math.round(document.getElementById('sidebar-right').getBoundingClientRect().width));
  const rh = await page.evaluate(() => { const r = document.getElementById('resizer-right').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await page.mouse.move(rh.x, rh.y);
  await page.mouse.down();
  await page.mouse.move(rh.x - 80, rh.y, { steps: 8 });
  await page.mouse.up();
  await sleep(300);
  const ra = await page.evaluate(() => Math.round(document.getElementById('sidebar-right').getBoundingClientRect().width));
  check('拖拽可加宽右侧栏', ra > rb + 40, `${rb} → ${ra}`);

  // 8. 刷新后宽度保持
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(1500);
  const persisted = await page.evaluate(() => Math.round(document.getElementById('sidebar').getBoundingClientRect().width));
  check('栏宽刷新后保持', Math.abs(persisted - after) <= 2, `${after} → ${persisted}`);
  await page.bringToFront();
  await page.screenshot({ path: path.join(SHOTS, 'resizable-panels.png') });

  // 9. 绘图：清空后可撤销
  await page.evaluate(() => document.getElementById('btn-draw').click());
  const strokes = count => page.waitForFunction(count => document.visibilityState === 'visible' && document.getElementById('draw-canvas')?.dataset.strokes === String(count), {}, count);
  await strokes(0);
  // 白板默认是「选择」工具，先切到手绘笔再拖
  await page.evaluate(() => document.querySelector('.draw-tool[data-tool="freedraw"]').click());
  await sleep(100);
  const box = await page.evaluate(() => { const r = document.getElementById('draw-canvas').getBoundingClientRect(); return { x: r.x, y: r.y }; });
  // 起点避开左上角的属性面板（面板占 12~208 x 12~220）
  for (let k = 0; k < 2; k++) {
    await page.mouse.move(box.x + 320 + k * 60, box.y + 260);
    await page.mouse.down();
    for (let i = 0; i < 10; i++) await page.mouse.move(box.x + 320 + k * 60 + i * 9, box.y + 260 + i * 6);
    await page.mouse.up();
    await strokes(k + 1);
  }
  const drawn = await page.evaluate(() => document.getElementById('draw-canvas').dataset.strokes);
  await page.evaluate(() => document.getElementById('draw-clear').click());
  await strokes(0);
  const cleared = await page.evaluate(() => document.getElementById('draw-canvas').dataset.strokes);
  const clearUndoDisabled = await page.evaluate(() => document.getElementById('draw-undo').disabled);
  await page.evaluate(() => document.getElementById('draw-undo').click());
  await strokes(2);
  const undoneClear = await page.evaluate(() => document.getElementById('draw-canvas').dataset.strokes);
  check('清空后可以撤销回来', drawn === '2' && cleared === '0' && undoneClear === '2', `${drawn} → ${cleared} → ${undoneClear}`);
  check('有历史时撤销按钮可用', !clearUndoDisabled);
  await page.evaluate(() => document.getElementById('draw-cancel').click());

  /* ---------- 标签条最右侧的下拉菜单（2026-10-19 新增） ----------
   * 三项能力：列出已开标签页（当前项带 ✓）/ 关闭所有标签页 / 收藏所有标签页（= 全部加星标） */
  const more = await page.evaluate(() => {
    const btn = document.getElementById('btn-tab-more');
    const bar = document.querySelector('.titlebar').getBoundingClientRect();
    const list = document.getElementById('tablist').getBoundingClientRect();
    const b = btn.getBoundingClientRect();
    return {
      exists: !!btn,
      fullHeight: b.height >= 30 && b.height < bar.height,
      rightOfTabs: b.left >= list.right - 60,
      tabs: document.querySelectorAll('#tablist .tab').length,
    };
  });
  check('标签条最右侧有下拉按钮（铺满标题栏、位于标签右边）',
    more.exists && more.fullHeight && more.rightOfTabs && more.tabs >= 2, JSON.stringify(more));

  await page.evaluate(() => document.getElementById('btn-tab-more').click());
  await sleep(350);
  const tabMenu = await page.evaluate(() => {
    const m = document.querySelector('.context-menu');
    if (!m) return null;
    return [...m.querySelectorAll('button')].map((b) => ({
      label: b.querySelector('.mi-label')?.textContent || '',
      checked: !!b.querySelector('.mi-check'),
      disabled: b.disabled,
    }));
  });
  check('下拉里列出已开标签页（当前项带勾）+ 关闭所有标签页 + 收藏所有标签页',
    !!tabMenu && tabMenu.filter((r) => r.checked).length === 1
    && tabMenu.some((r) => r.label === '关闭所有标签页')
    && tabMenu.some((r) => r.label.startsWith('收藏所有标签页')),
    JSON.stringify(tabMenu));

  // 收藏所有标签页 → 每个标签都进「星标」
  await page.evaluate(() => {
    [...document.querySelectorAll('.context-menu button')].find((b) => b.textContent.includes('收藏所有标签页'))?.click();
  });
  await sleep(600);
  const pinnedAll = await page.evaluate(() => ({
    stored: JSON.parse(localStorage.getItem(`tracery.shortcuts:${window.__tracery.state.vault.root}`)).pinned.length,
    section: document.querySelectorAll('#pinned-list .pinned-item').length,
    tabs: document.querySelectorAll('#tablist .tab').length,
  }));
  check('「收藏所有标签页」把打开的每个标签都加进星标',
    pinnedAll.tabs >= 2 && pinnedAll.stored === pinnedAll.tabs && pinnedAll.section === pinnedAll.tabs,
    JSON.stringify(pinnedAll));

  // 关闭所有标签页 → 标签条清空（放最后做，它会把标签都关掉）
  await page.evaluate(() => document.getElementById('btn-tab-more').click());
  await sleep(300);
  await page.evaluate(() => {
    [...document.querySelectorAll('.context-menu button')].find((b) => b.textContent === '关闭所有标签页')?.click();
  });
  await sleep(900);
  const closedAll = await page.evaluate(() => ({
    hidden: document.getElementById('tablist').hidden,
    tabs: document.querySelectorAll('#tablist .tab').length,
    path: document.getElementById('note-path').textContent,
  }));
  check('「关闭所有标签页」清空标签条且当前笔记置空',
    closedAll.hidden && closedAll.tabs === 0 && closedAll.path === '', JSON.stringify(closedAll));

  check('无渲染错误', errors.length === 0, errors.join(' | '));

  await browser.close();
  server.kill();
  fs.rmSync(TMP, { recursive: true, force: true });

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} 通过\n`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => { console.error('💥', e); process.exit(1); });
