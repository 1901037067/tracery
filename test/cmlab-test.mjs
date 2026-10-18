/**
 * cmlab-test.mjs — CM6 探针页运行器（编辑区内核迁移 P0–P4）
 * ------------------------------------------------------------------
 * 复用项目既有的 puppeteer-core + Edge 无头模式：
 *   1. 起服务（独立端口，不占用 npm run dev 的 9520）；
 *   2. 打开 public/cmlab.html，等页内 8 个自动探针跑完；
 *   3. 用 CDP Input.imeSetComposition / Input.insertText 驱动中文输入法组词
 *      （ni → 你好 → 提交；再在行中位置组词 中文输入法 → 提交）；
 *   4. 汇总 window.__probe.results，打印报告；全绿退出 0，否则退出 1。
 *
 * IME 说明：无头 Edge 没有真实输入法，CDP 的 imeSetComposition 是渲染层
 * 模拟 composition 的标准途径，compositionstart/update/end 会真实触发。
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 9598;
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tracery-cmlab-'));
const VAULT = path.join(HOME, 'vault');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(VAULT, { recursive: true });

const server = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), TRACERY_HOME: HOME },
  stdio: 'pipe',
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

const browserErrors = [];
let exitCode = 0;

try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://localhost:${PORT}/api/state`)).ok) break; } catch { /* wait */ }
    await sleep(250);
  }
  const browser = await puppeteer.launch({
    executablePath: EDGE, headless: 'new', args: ['--no-sandbox'],
    defaultViewport: { width: 1280, height: 860 },
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => browserErrors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') browserErrors.push('console: ' + m.text()); });

  await page.goto(`http://localhost:${PORT}/cmlab.html`, { waitUntil: 'networkidle0' });
  await page.waitForFunction('window.__probe && window.__probe.view', { timeout: 20000 });
  await page.waitForFunction('window.__probe.done === true', { timeout: 90000 });

  /* ---------- IME 组词探针（CDP 驱动） ---------- */
  const client = await page.createCDPSession();
  const imeStages = [];
  const commitStrategy = { round1: null, round2: null };

  const commitComposition = async (text, round) => {
    commitStrategy[round] = 'insertText';
    await client.send('Input.insertText', { text });
    let post = await page.evaluate(() => window.__probe.ime.observe('post-commit', ''));
    if (post.composing) {
      // 兜底：Chromium 中组词期间按 Enter 会先提交组词（不产生换行）
      commitStrategy[round] = 'enter-key';
      for (const type of ['keyDown', 'keyUp']) {
        await client.send('Input.dispatchKeyEvent', {
          type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
        });
      }
      post = await page.evaluate(() => window.__probe.ime.observe('post-commit-enter', ''));
    }
    return post;
  };

  await page.evaluate(() => document.querySelector('.cm-content').focus());
  // 第一轮：行尾附近组词 ni → 你好 → 提交
  await page.evaluate(() => window.__probe.ime.begin(5, 4));
  await client.send('Input.imeSetComposition', { text: 'ni', selectionStart: 0, selectionEnd: 2 });
  imeStages.push(await page.evaluate(() => window.__probe.ime.observe('compose-ni', 'ni')));
  await client.send('Input.imeSetComposition', { text: '你好', selectionStart: 0, selectionEnd: 2 });
  imeStages.push(await page.evaluate(() => window.__probe.ime.observe('update-你好', '你好')));
  imeStages.push(await commitComposition('你好', 'round1'));
  const imeRound1 = await page.evaluate(() => window.__probe.ime.commit('你好'));

  // 第二轮：行中位置组词 中文输入法 → 提交
  await page.evaluate(() => window.__probe.ime.begin(5, 10));
  await client.send('Input.imeSetComposition', { text: 'zhongwenshurufa', selectionStart: 0, selectionEnd: 14 });
  imeStages.push(await page.evaluate(() => window.__probe.ime.observe('compose-pinyin', 'zhongwenshurufa')));
  await client.send('Input.imeSetComposition', { text: '中文输入法', selectionStart: 0, selectionEnd: 5 });
  imeStages.push(await page.evaluate(() => window.__probe.ime.observe('update-中文输入法', '中文输入法')));
  imeStages.push(await commitComposition('中文输入法', 'round2'));
  const imeRound2 = await page.evaluate(() => window.__probe.ime.commit('中文输入法'));

  const results = await page.evaluate(() => JSON.parse(JSON.stringify(window.__probe.results)));
  const pageError = await page.evaluate(() => window.__probe.pageError || null);

  /* ---------- 报告 ---------- */
  console.log('================ CM6 探针报告（P0–P4 · cmlab） ================');
  console.log(`环境: Edge headless · ${await browser.version()} · 视口 1280x860 · 端口 ${PORT}`);
  for (const [name, r] of Object.entries(results)) {
    console.log(`\n[${r.ok ? '通过' : '失败'}] ${name}`);
    for (const [k, v] of Object.entries(r.metrics)) console.log(`    ${k}: ${v}`);
    for (const n of r.notes || []) console.log(`    — ${n}`);
  }
  console.log(`\n---- IME 组词明细（提交策略: 轮次1=${commitStrategy.round1} 轮次2=${commitStrategy.round2}） ----`);
  for (const s of imeStages) {
    console.log(`  ${s.stage}: composing=${s.composing} domShows=${s.domShowsComposing} caret=${s.caret} events=${s.imeEvents}`);
  }
  console.log(`  轮次1(你好): ok=${imeRound1.ok}  轮次2(中文输入法·行中): ok=${imeRound2.ok}`);
  const autoOk = Object.entries(results).filter(([k]) => k !== 'ime').every(([, r]) => r.ok);
  const imeOk = results.ime && results.ime.ok;
  console.log(`\n总体: 自动探针 ${autoOk ? '全过' : '有失败'} · IME ${imeOk ? '通过' : '失败'}` +
    ` · 页面错误 ${browserErrors.length + (pageError ? 1 : 0) === 0 ? '无' : '有!'}`);
  if (browserErrors.length) console.log(browserErrors.join('\n'));
  if (pageError) console.log('pageError: ' + pageError);
  if (!autoOk || !imeOk || browserErrors.length || pageError) exitCode = 1;

  await browser.close();
} catch (err) {
  console.error('运行器异常:', err);
  console.error('---- server log ----\n' + serverLog.slice(-2000));
  exitCode = 1;
} finally {
  server.kill();
  fs.rmSync(HOME, { recursive: true, force: true });
}

process.exit(exitCode);
