/**
 * Tracery 端到端测试
 * ------------------------------------------------------------------
 * 无头 Edge 真实驱动 Tracery：
 *   1. 启动即自动打开 demo-vault 演示仓库
 *   2. 文件树渲染（10 篇笔记）
 *   3. 打开笔记 → 实时预览渲染（标题/双链/任务列表/Callout）
 *   4. 编辑器输入 → 自动保存 → API 校验落盘
 *   5. 点击 [[双链]] → 跳转到目标笔记
 *   6. 反链面板数据
 *   7. 全局搜索
 *   8. 命令面板 Ctrl+P 快速跳转
 *   9. 图谱视图渲染
 *   10. 主题切换
 *   11. 截图存档
 *
 * 运行: node test/e2e.mjs
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE, IS_CM, engineUrl } from './_engine-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 9598;
const BASE = `http://localhost:${PORT}`;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const SHOTS = path.join(__dirname, 'screenshots');
// 每次都用全新的临时配置目录，保证「首次启动自动打开 demo-vault」的行为可复现
const E2E_HOME = path.join(process.env.TEMP || '/tmp', 'tracery-e2e-home');

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok, extra });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${extra ? '  — ' + extra : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(page, name) {
  const st = await page.evaluate(() => {
    const w = document.getElementById('welcome');
    const a = document.getElementById('app');
    const p = document.getElementById('palette');
    return {
      welcomeHidden: w.hidden, welcomeDisplay: getComputedStyle(w).display,
      appHidden: a.hidden, appDisplay: getComputedStyle(a).display,
      paletteHidden: p.hidden, paletteDisplay: getComputedStyle(p).display,
      note: document.getElementById('note-path')?.textContent || '',
    };
  });
  console.log(`  [截图 ${name}] ${JSON.stringify(st)}`);
  await page.screenshot({ path: path.join(SHOTS, name + '.png') });
}

/* 模拟真实键盘逐键输入（无头浏览器下比 keyboard.type 更可靠） */
async function typeText(page, text) {
  for (const ch of text) {
    if (ch === '\n') { await page.keyboard.press('Enter'); continue; }
    if (ch === ' ') { await page.keyboard.press('Space'); continue; }
    const upper = ch === ch.toUpperCase() && ch !== ch.toLowerCase();
    if (upper) await page.keyboard.down('Shift');
    await page.keyboard.press(/[A-Z]/.test(ch) ? `Key${ch.toUpperCase()}` : /[0-9]/.test(ch) ? `Digit${ch}` : ch);
    if (upper) await page.keyboard.up('Shift');
  }
}

async function waitForServer(url, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(`${url}/api/state`);
      if (res.ok) return;
    } catch { /* retry */ }
    await sleep(300);
  }
  throw new Error('服务器启动超时');
}

async function main() {
  fs.rmSync(E2E_HOME, { recursive: true, force: true });
  fs.mkdirSync(E2E_HOME, { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });

  // ---- 启动被测服务器（独立端口，避开开发实例） ----
  const server = spawn(process.execPath, ['server/server.js'], {
    cwd: ROOT,
    // 隔离配置：不用仓库根目录的 tracery.config.json，避免读到用户真实仓库
    env: { ...process.env, PORT: String(PORT), TRACERY_HOME: E2E_HOME },
    stdio: 'pipe',
  });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  await waitForServer(BASE);
  console.log(`\n▶ 服务器已启动 ${BASE}\n`);

  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    defaultViewport: { width: 1440, height: 900 },
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-color-profile=srgb'],
  });

  let failed = 0;
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.error('  [pageerror]', e.message));
    // 内核由 TRACERY_TEST_ENGINE 决定（默认 block）；渲染/输入类断言按内核分支走
    await page.goto(engineUrl(BASE), { waitUntil: 'networkidle0' });
    console.log(`[e2e] 内核：${ENGINE}`);
    await sleep(800);

    // 1. 自动打开演示仓库
    const appVisible = await page.evaluate(() => !document.getElementById('app').hidden);
    const vaultName = await page.evaluate(() => document.getElementById('vault-name').textContent);
    check('启动后自动打开演示仓库', appVisible && vaultName.includes('demo-vault'), vaultName);

    // 2. 文件树渲染
    const treeCount = await page.evaluate(() => document.querySelectorAll('#file-tree .tree-item').length);
    check('文件树渲染全部条目', treeCount >= 10, `${treeCount} 个条目`);
    await shot(page, '01-main');

    // 3. 打开「Markdown 语法」笔记，检查实时预览渲染
    await page.evaluate(() => {
      const items = [...document.querySelectorAll('#file-tree .tree-item')];
      items.find((i) => i.textContent.includes('Markdown 语法'))?.click();
    });
    await sleep(600);
    let render;
    if (IS_CM) {
      // cm 的实时预览装饰是「视口作用域」的（视口外不建 DOM），所以分段滚动把各段的
      // 计数累加，才能覆盖到文档中后段的 Callout / 表格 / 双链。
      // 注意：cm 没有 `pre code` / `table` 元素（代码就是普通行、表格是行装饰），
      // 代码块断言按 7.9-C 去掉，表格改数 `.cm-lp-tr` 行装饰。
      const agg = { h1: 0, wikilinks: 0, tasks: 0, callouts: 0, rows: 0 };
      for (const f of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
        await page.evaluate((frac) => {
          const s = document.querySelector('#editor-live .cm-scroller');
          if (s) s.scrollTop = Math.max(0, (s.scrollHeight - s.clientHeight) * frac);
        }, f);
        await sleep(300);
        const c = await page.evaluate(() => {
          const live = document.getElementById('editor-live');
          return {
            h1: live.querySelectorAll('.cm-lp-h1, .cm-lp-h2, .cm-lp-h3').length,
            wikilinks: live.querySelectorAll('.cm-lp-wikilink').length,
            tasks: live.querySelectorAll('input.cm-lp-cb').length,
            callouts: live.querySelectorAll('.cm-lp-callout').length,
            rows: live.querySelectorAll('.cm-lp-tr').length,
          };
        });
        for (const k of Object.keys(agg)) agg[k] += c[k] || 0;
      }
      render = agg;
      await page.evaluate(() => {
        const s = document.querySelector('#editor-live .cm-scroller');
        if (s) s.scrollTop = 0;
      });
      await sleep(300);
      check('实时预览渲染（标题/双链/任务/Callout/表格行装饰）——cm：分段滚动累加',
        render.h1 >= 1 && render.wikilinks >= 5 && render.tasks >= 5 && render.callouts >= 1 && render.rows >= 1,
        JSON.stringify(render));
    } else {
      render = await page.evaluate(() => {
        const live = document.getElementById('editor-live');
        return {
          h1: live.querySelectorAll('h1').length,
          wikilinks: live.querySelectorAll('a.wikilink').length,
          tasks: live.querySelectorAll('li.task-list-item input[type=checkbox]').length,
          callouts: live.querySelectorAll('.callout').length,
          pre: live.querySelectorAll('pre code').length,
          table: live.querySelectorAll('table').length,
        };
      });
      check('实时预览渲染（标题/双链/任务/Callout/代码块/表格）',
        render.h1 >= 1 && render.wikilinks >= 5 && render.tasks >= 5 && render.callouts >= 1 && render.pre >= 2 && render.table >= 1,
        JSON.stringify(render));
    }
    await shot(page, '02-editor');

    // 4. 编辑器输入 → 自动保存
    if (IS_CM) {
      // cm：不能再用块级那套 `live.lastElementChild + DOM Range`（cm 的 DOM 是行，不是渲染产物）
      await page.click('#editor-live .cm-content');
      await page.keyboard.down('Control'); await page.keyboard.press('End'); await page.keyboard.up('Control');
      await sleep(200);
    } else {
      await page.evaluate(() => {
        const live = document.getElementById('editor-live');
        live.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        const last = live.lastElementChild || live;
        range.selectNodeContents(last);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      });
    }
    await typeText(page, '\n\nTRACERY_E2E_TEST_LINE');
    await sleep(1800); // 等自动保存（900ms 防抖 + 余量）
    const saved = await page.evaluate(async () => {
      const res = await fetch('/api/note?path=' + encodeURIComponent('Markdown 语法.md'));
      const data = await res.json();
      return data.content.includes('TRACERY_E2E_TEST_LINE');
    });
    check('编辑器输入后自动保存到磁盘', saved);
    // 清理测试行
    await page.evaluate(async () => {
      const res = await fetch('/api/note?path=' + encodeURIComponent('Markdown 语法.md'));
      const { content } = await res.json();
      await fetch('/api/note', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'Markdown 语法.md', content: content.replace(/\n*TRACERY_E2E_TEST_LINE/g, '') }),
      });
    });

    // 5. 点击双链跳转（cm：`.cm-lp-wikilink` 是 span，没有 dataset.target；按文本找）
    await page.evaluate((isCm) => {
      if (isCm) {
        const span = [...document.querySelectorAll('#editor-live .cm-lp-wikilink')]
          .find((s) => s.textContent.includes('双链与反链'));
        span?.click();
        return;
      }
      const link = [...document.querySelectorAll('#editor-live a.wikilink')].find((a) => a.dataset.target === '双链与反链');
      link?.click();
    }, IS_CM);
    await sleep(600);
    const navPath = await page.evaluate(() => document.getElementById('note-path').textContent);
    check('点击 [[双链]] 跳转到目标笔记', navPath.includes('双链与反链'), navPath);

    // 6. 反链面板
    const backlinks = await page.evaluate(() => document.querySelectorAll('#backlinks-list .backlink-item').length);
    check('反链面板展示反向链接', backlinks >= 3, `${backlinks} 条反链`);

    // 7. 全局搜索
    await page.evaluate(() => {
      document.querySelector('.ribbon-btn[data-panel="search"]').click();
      const input = document.getElementById('search-input');
      input.value = '双链';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sleep(700);
    const searchHits = await page.evaluate(() => document.querySelectorAll('#search-results .search-result').length);
    check('全局搜索返回结果', searchHits >= 2, `${searchHits} 条结果`);
    await shot(page, '03-search');

    // 8. 命令面板
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyP');
    await page.keyboard.up('Control');
    await sleep(400);
    const paletteVisible = await page.evaluate(() => !document.getElementById('palette').hidden);
    await page.evaluate(() => {
      const input = document.getElementById('palette-input');
      input.value = '图谱视图';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sleep(300);
    await page.keyboard.press('Enter');
    await sleep(600);
    const paletteNav = await page.evaluate(() => document.getElementById('note-path').textContent);
    check('命令面板 Ctrl+P 快速跳转', paletteVisible && paletteNav.includes('图谱视图'), paletteNav);

    // 9. 图谱视图
    await page.evaluate(() => document.querySelector('.ribbon-btn[data-panel="graph"]').click());
    await sleep(1200);
    const graphOk = await page.evaluate(() => {
      const c = document.getElementById('graph-canvas');
      const ctx = c.getContext('2d');
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      let painted = 0;
      for (let i = 3; i < data.length; i += 400) if (data[i] > 0) painted++;
      return painted > 50;
    });
    check('图谱视图力导向渲染', graphOk);
    await shot(page, '04-graph');

    // 10. 主题切换
    const themeBefore = await page.evaluate(() => document.documentElement.dataset.theme);
    await page.evaluate(() => document.getElementById('btn-theme').click());
    await sleep(300);
    const themeAfter = await page.evaluate(() => document.documentElement.dataset.theme);
    check('亮/暗主题切换', themeBefore !== themeAfter, `${themeBefore} → ${themeAfter}`);
    await shot(page, '05-light');

    // 11. 未解析双链 → 点击创建
    await page.evaluate(async () => {
      document.querySelector('.ribbon-btn[data-panel="files"]').click();
      const items = [...document.querySelectorAll('#file-tree .tree-item')];
      items.find((i) => i.textContent.includes('双链与反链'))?.click();
    });
    await sleep(500);
    // cm 侧由 createLivePreview 注入 resolveLink，未解析的双链补 `.cm-lp-unresolved` 变体类
    // （与块级 `.wikilink.unresolved` 同视觉），两个内核都能断言
    const unresolved = await page.evaluate((isCm) => (isCm
      ? document.querySelectorAll('#editor-live .cm-lp-wikilink.cm-lp-unresolved').length
      : document.querySelectorAll('#editor-live a.wikilink.unresolved').length), IS_CM);
    check('未解析双链显示为灰色虚线样式', unresolved >= 1, `${unresolved} 个未解析链接`);

    // 12. 设置面板：打开 → 改强调色/圆角（即时生效）→ 持久化
    await page.keyboard.down('Control');
    await page.keyboard.press('Comma');
    await page.keyboard.up('Control');
    await sleep(500);
    const setOpen = await page.evaluate(() => {
      const el = document.getElementById('settings');
      return !!el && !el.hidden;
    });
    check('设置面板可打开（Ctrl+,）', setOpen);

    await page.evaluate(() => {
      document.querySelector('#settings .swatches button[data-value="purple"]')?.click();
      const seg = [...document.querySelectorAll('#settings .seg')].find((s) => s.dataset.key === 'radius');
      seg?.querySelector('button[data-value="compact"]')?.click();
    });
    await sleep(400);
    const applied = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      return { accent: cs.getPropertyValue('--accent').trim(), rlg: cs.getPropertyValue('--r-lg').trim() };
    });
    check('设置：改强调色 / 圆角即时生效',
      /#(7c5cff|9b7cff)/i.test(applied.accent) && applied.rlg === '14px',
      JSON.stringify(applied));

    await sleep(700); // 等防抖落盘
    const persisted = await page.evaluate(async () => (await (await fetch('/api/state')).json()).settings);
    check('设置：持久化到 tracery.config.json',
      persisted.accent === 'purple' && persisted.radius === 'compact',
      JSON.stringify({ accent: persisted.accent, radius: persisted.radius }));

    // 还原，避免污染后续运行
    await page.evaluate(async () => {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accent: 'blue', radius: 'default' }),
      });
    });
    await page.keyboard.press('Escape');
    await sleep(300);
    const setClosed = await page.evaluate(() => document.getElementById('settings').hidden);
    check('设置：Esc 可关闭', setClosed);

  } catch (e) {
    failed = 1;
    console.error('\n💥 e2e 异常:', e);
    try { await page?.screenshot({ path: path.join(SHOTS, 'error.png') }); } catch { /* ignore */ }
  } finally {
    await browser.close();
    server.kill();
    fs.rmSync(E2E_HOME, { recursive: true, force: true });
  }

  console.log('\n========== 结果 ==========');
  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.extra ? '  — ' + r.extra : ''}`);
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} 通过`);
  process.exit(failed || pass !== results.length ? 1 : 0);
}

main();
