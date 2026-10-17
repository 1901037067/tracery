/**
 * 同步面板 UI 测试：设置 → 同步 → 填地址/配对码 → 连接 → 立即同步
 * 真跑一个同步服务端 + 一个 Tracery 实例，用无头 Edge 操作界面。
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
const TMP = path.join(os.tmpdir(), 'tracery-sync-ui');
const VAULT = path.join(TMP, 'vault');
const HOME = path.join(TMP, 'home');
const SYNC_DATA = path.join(TMP, 'sync-data');
const SYNC_PORT = 9701;
const API = 'http://localhost:9563';
const SHOTS = path.join(ROOT, 'test', 'screenshots');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PAIR__CODE = 'UI-TEST-1';
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
  fs.mkdirSync(path.join(VAULT, '项目'), { recursive: true });
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(SYNC_DATA, { recursive: true });
  fs.writeFileSync(path.join(VAULT, '欢迎.md'), '# 欢迎\n\n这是同步 UI 测试仓库。\n\n[[项目/计划]]\n', 'utf8');
  fs.writeFileSync(path.join(VAULT, '项目', '计划.md'), '# 计划\n\n- [ ] 一项任务\n', 'utf8');

  const procs = [];
  const start = (label, args, env) => {
    const p = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    p.stderr.on('data', (d) => process.stderr.write(`[${label}:err] ${d}`));
    procs.push(p);
    return p;
  };
  start('sync', ['sync-server/index.js', '--port', String(SYNC_PORT), '--data', SYNC_DATA, '--name', '我家NAS', '--pair-code', PAIR__CODE], {});
  start('app', ['server/server.js'], { PORT: '9563', TRACERY_HOME: HOME });

  await waitFor(`http://localhost:${SYNC_PORT}/api/health`);
  await waitFor(`${API}/api/state`);
  await fetch(`${API}/api/vault/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: VAULT.replace(/\\/g, '/') }),
  });

  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--no-sandbox'],
    defaultViewport: { width: 1280, height: 860, deviceScaleFactor: 2 },
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(API, { waitUntil: 'networkidle0' });
  await sleep(1200);

  // 打开设置（Ctrl+,）→ 同步
  await page.keyboard.down('Control');
  await page.keyboard.press(',');
  await page.keyboard.up('Control');
  await sleep(500);
  await page.evaluate(() => {
    [...document.querySelectorAll('.settings-nav button')].find((b) => b.dataset.pane === 'sync').click();
  });
  await sleep(500);

  const form = await page.evaluate(() => ({
    paneActive: document.querySelector('.settings-pane[data-pane="sync"]')?.classList.contains('active'),
    hasUrl: !!document.getElementById('sync-url'),
    hasCode: !!document.getElementById('sync-code'),
    hasConnect: !!document.getElementById('sync-connect'),
    navCount: document.querySelectorAll('.settings-nav button').length,
  }));
  check('同步页存在于设置面板', form.paneActive && form.hasUrl && form.hasCode && form.hasConnect, JSON.stringify(form));

  // 部署说明（用户最需要的部分）
  await page.evaluate(() => document.getElementById('sync-help').click());
  await sleep(700);
  const help = await page.evaluate(() => {
    const box = document.getElementById('sync-help-box');
    const pane = document.querySelector('.settings-pane[data-pane="sync"]');
    const b = box.getBoundingClientRect();
    const p = pane.getBoundingClientRect();
    return {
      open: !!box && !box.hidden,
      steps: box.querySelectorAll('li').length,
      cmd: box.querySelector('.sync-cmd code')?.textContent || '',
      inView: b.top >= p.top - 2 && b.top < p.bottom - 20,
    };
  });
  check('「怎么部署」展开三步说明并滚到可视区', help.open && help.steps === 3 && help.inView, JSON.stringify(help));
  check('部署命令可复制', help.cmd.includes('npx tracery-sync'));
  await page.screenshot({ path: path.join(SHOTS, 'sync-pane-form.png') });

  // 填表连接
  await page.type('#sync-url', `http://localhost:${SYNC_PORT}`, { delay: 4 });
  await page.type('#sync-code', PAIR__CODE, { delay: 4 });
  await page.evaluate(() => {
    const d = document.getElementById('sync-device');
    if (d) { d.value = '测试设备'; d.dispatchEvent(new Event('input', { bubbles: true })); }
  });
  await page.evaluate(() => document.getElementById('sync-connect').click());
  await sleep(2600);

  const connected = await page.evaluate(() => ({
    card: !!document.querySelector('.sync-card'),
    title: document.querySelector('.sync-title')?.textContent || '',
    sub: document.querySelector('.sync-sub')?.textContent || '',
    dotOk: !!document.querySelector('.sync-dot.ok'),
    stateText: document.getElementById('sync-state-text')?.textContent || '',
    buttons: [...document.querySelectorAll('#sync-body .set-actions button')].map((b) => b.textContent.trim()),
  }));
  check('连接后切换为「已连接」卡片', connected.card && /已连接/.test(connected.title), JSON.stringify(connected));
  check('卡片显示服务端名称与地址', /我家NAS/.test(connected.title) && /9701/.test(connected.sub));
  check('显示同步结果文案', /上传|最新|上次/.test(connected.stateText), connected.stateText);
  await page.screenshot({ path: path.join(SHOTS, 'sync-pane-connected.png') });

  // 立即同步
  await page.evaluate(() => document.getElementById('sync-now').click());
  await sleep(1800);
  const afterSync = await page.evaluate(() => document.getElementById('sync-state-text')?.textContent || '');
  check('「立即同步」可执行且状态更新', !/出错/.test(afterSync), afterSync);

  // 自动同步开关
  await page.evaluate(() => {
    const seg = document.querySelector('.seg[data-sync-key="autoSync"]');
    seg.querySelector('button[data-value="0"]').click();
  });
  await sleep(900);
  const autoOff = await page.evaluate(() => !!document.querySelector('.seg[data-sync-key="autoSync"] button[data-value="0"].active'));
  check('自动同步开关可关闭', autoOff);

  // 服务端确实收到了清单
  const cfg = JSON.parse(fs.readFileSync(path.join(VAULT, '.tracery', 'sync.json'), 'utf8'));
  const manifest = await (await fetch(`http://localhost:${SYNC_PORT}/api/manifest`, {
    headers: { Authorization: `Bearer ${cfg.token}` },
  })).json();
  check('服务端清单包含 2 个文件', Object.keys(manifest.files || {}).length === 2, `files=${Object.keys(manifest.files || {}).length}`);
  check('token 未暴露给前端状态接口', !JSON.stringify(await (await fetch(`${API}/api/sync/status`)).json()).includes(cfg.token));

  // 断开后回到表单态，此时才显示「局域网直连」区块
  await fetch(`${API}/api/sync/disconnect`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  await sleep(400);
  await page.evaluate(() => [...document.querySelectorAll('.settings-nav button')].find((b) => b.dataset.pane === 'sync').click());
  await sleep(800);
  const lan = await page.evaluate(() => ({
    present: !!document.querySelector('.lan-block'),
    input: !!document.getElementById('lan-code-input'),
    start: !!document.getElementById('lan-start'),
  }));
  check('未连接时显示局域网直连区块', lan.present && lan.input && lan.start, JSON.stringify(lan));
  // 输入非 6 位数字应被校验拦截
  await page.evaluate(() => {
    document.getElementById('lan-code-input').value = '12';
    document.getElementById('lan-find').click();
  });
  await sleep(400);
  const lanErr = await page.evaluate(() => ({
    shown: !document.getElementById('lan-error').hidden,
    msg: document.getElementById('lan-error').textContent,
  }));
  check('通行码格式错误有提示', lanErr.shown && /6 位/.test(lanErr.msg), JSON.stringify(lanErr));

  check('无渲染错误', errors.length === 0, errors.join(' | '));

  await browser.close();
  for (const p of procs) p.kill();
  await sleep(300);
  fs.rmSync(TMP, { recursive: true, force: true });

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} 通过\n`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => { console.error('💥', e); process.exit(1); });
