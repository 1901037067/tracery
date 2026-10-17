/**
 * 局域网直连端到端测试：A 生成 6 位通行码 → B 输码发现并配对 → 双向同步 → 停止共享
 * 全程只跑两个 EVNote 实例，不需要外部同步服务端。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
const TMP = path.join(os.tmpdir(), 'evnote-lan-test');
const VAULT_A = path.join(TMP, 'vault-a');
const VAULT_B = path.join(TMP, 'vault-b');
const SYNC_PORT_A = '9564';
const SYNC_PORT_B = '9565';
const API_A = 'http://localhost:9564';
const API_B = 'http://localhost:9565';

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  — ' + extra : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url) {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* retry */ }
    await sleep(250);
  }
  throw new Error(`${url} 启动超时`);
}

async function api(base, p, opts) {
  const res = await fetch(base + p, {
    method: opts?.method || 'GET',
    headers: opts?.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || `HTTP ${res.status}`); e.status = res.status; throw e; }
  return data;
}

async function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(VAULT_A, { recursive: true });
  fs.mkdirSync(VAULT_B, { recursive: true });
  fs.writeFileSync(path.join(VAULT_A, '主机笔记.md'), '# 主机笔记\n\n来自 A 的初始内容。\n', 'utf8');
  fs.mkdirSync(path.join(VAULT_A, '项目'), { recursive: true });
  fs.writeFileSync(path.join(VAULT_A, '项目', '子目录笔记.md'), '# 子目录笔记\n', 'utf8');

  const procs = [];
  const start = (label, args, env) => {
    const p = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    p.stderr.on('data', (d) => process.stderr.write(`[${label}:err] ${d}`));
    procs.push(p);
    return p;
  };
  start('A', ['server/server.js'], { PORT: SYNC_PORT_A, EVNOTE_HOME: path.join(TMP, 'home-a') });
  start('B', ['server/server.js'], { PORT: SYNC_PORT_B, EVNOTE_HOME: path.join(TMP, 'home-b') });

  await waitFor(`${API_A}/api/state`);
  await waitFor(`${API_B}/api/state`);
  await api(API_A, '/api/vault/open', { method: 'POST', body: { path: VAULT_A } });
  await api(API_B, '/api/vault/open', { method: 'POST', body: { path: VAULT_B } });
  await sleep(500);

  // 1. A 开启共享
  const startRes = await api(API_A, '/api/sync/lan/start', { method: 'POST', body: {} });
  const code = startRes.lan?.code;
  check('A 开启局域网共享并生成 6 位通行码', startRes.ok && /^\d{6}$/.test(String(code)), `code=${code}`);
  check('A 的同步引擎已指向内嵌服务端', startRes.sync?.configured === true);

  // 2. 错误的码找不到
  const wrong = String(code) === '000000' ? '111111' : '000000';
  let rejected = false;
  try { await api(API_B, '/api/sync/lan/find', { method: 'POST', body: { code: wrong } }); }
  catch (e) { rejected = e.status === 404; }
  check('错误通行码发现不到任何主机', rejected);

  // 3. B 按码发现主机并配对
  const hit = await api(API_B, '/api/sync/lan/find', { method: 'POST', body: { code } });
  check('B 通过通行码发现主机', !!hit.url && !!hit.name, JSON.stringify(hit));
  const pairRes = await api(API_B, '/api/sync/pair', { method: 'POST', body: { serverUrl: hit.url, code, deviceName: '设备B' } });
  check('B 配对成功并完成首次同步', pairRes.ok && pairRes.status?.configured === true,
    `downloaded=${pairRes.status?.lastResult?.downloaded}`);

  // 4. B 拿到 A 的笔记
  const bHas = fs.existsSync(path.join(VAULT_B, '主机笔记.md')) && fs.existsSync(path.join(VAULT_B, '项目', '子目录笔记.md'));
  check('B 下载到 A 的笔记（含子目录）', bHas);

  // 5. A 改 → B 拉到
  fs.writeFileSync(path.join(VAULT_A, '主机笔记.md'), '# 主机笔记\n\nA 在共享后追加了内容。\n', 'utf8');
  await api(API_A, '/api/sync/now', { method: 'POST', body: {} });
  const bSync = await api(API_B, '/api/sync/now', { method: 'POST', body: {} });
  check('A 的修改同步到 B', bSync.result?.downloaded === 1 && fs.readFileSync(path.join(VAULT_B, '主机笔记.md'), 'utf8').includes('追加了内容'),
    JSON.stringify(bSync.result || {}));

  // 6. B 改不同段落 → A 自动合并拿到
  fs.writeFileSync(path.join(VAULT_B, '主机笔记.md'), '# 主机笔记\n\nA 在共享后追加了内容。\n\nB 新加的一段。\n', 'utf8');
  const bUp = await api(API_B, '/api/sync/now', { method: 'POST', body: {} });
  await sleep(200);
  const aSync = await api(API_A, '/api/sync/now', { method: 'POST', body: {} });
  const aContent = fs.readFileSync(path.join(VAULT_A, '主机笔记.md'), 'utf8');
  check('B 的新段落合并回 A', aContent.includes('B 新加的一段'), `merged=${(aSync.result?.merged || []).length}`);

  // 7. A 停止共享
  const stopRes = await api(API_A, '/api/sync/lan/stop', { method: 'POST', body: {} });
  check('A 停止共享后引擎断开', stopRes.ok && stopRes.sync?.configured === false, JSON.stringify(stopRes.sync || {}));

  // 8. A 本地笔记不丢
  check('停止共享后 A 的笔记还在本地', fs.existsSync(path.join(VAULT_A, '主机笔记.md')));

  console.log('\n========== 结果 ==========');
  const pass = results.filter((r) => r.ok).length;
  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}`);
  console.log(`\n${pass}/${results.length} 通过\n`);

  for (const p of procs) p.kill();
  await sleep(300);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error('💥', e);
  process.exit(1);
});
