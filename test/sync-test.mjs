/**
 * 同步端到端测试
 * ------------------------------------------------------------------
 * 真实跑三个进程：
 *   同步服务端（sync-server） + EVNote 实例 A + EVNote 实例 B
 * 验证：首次上传 / 首次下载 / 增量上传 / 增量下载 / 冲突副本 / 删除传播 / 鉴权
 *
 * 用临时目录，不碰仓库里的 demo-vault 和用户真实笔记。
 * 运行：node test/sync-test.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const TMP = path.join(os.tmpdir(), 'evnote-sync-test');
const SYNC_PORT = 9700;
const VAULT_A = path.join(TMP, 'vault-a');
const VAULT_B = path.join(TMP, 'vault-b');
const HOME_A = path.join(TMP, 'home-a');
const HOME_B = path.join(TMP, 'home-b');
const SYNC_DATA = path.join(TMP, 'sync-data');
const PAIR_CODE = 'TEST-CODE';
const API_A = 'http://localhost:9561';
const API_B = 'http://localhost:9562';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  — ' + extra : ''}`);
};

async function waitFor(url, label) {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* retry */ }
    await sleep(250);
  }
  throw new Error(`${label} 启动超时`);
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

/** 从仓库内的同步配置取 token（status 接口故意不回传 token） */
function readToken(vaultRoot) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(vaultRoot, '.evnote', 'sync.json'), 'utf8'));
    return cfg.token || '';
  } catch { return ''; }
}

function makeVaultA() {  fs.mkdirSync(path.join(VAULT_A, '项目'), { recursive: true });
  fs.writeFileSync(path.join(VAULT_A, '笔记甲.md'), '# 笔记甲\n\n来自 A 的初始内容。\n', 'utf8');
  fs.writeFileSync(path.join(VAULT_A, '项目', '笔记乙.md'), '# 笔记乙\n\n[[笔记甲]]\n', 'utf8');
  fs.writeFileSync(path.join(VAULT_A, '附件.bin'), Buffer.from([0, 1, 2, 3, 255, 254, 32, 10]));
}

async function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(VAULT_A, { recursive: true });
  fs.mkdirSync(VAULT_B, { recursive: true });
  fs.mkdirSync(HOME_A, { recursive: true });
  fs.mkdirSync(HOME_B, { recursive: true });
  fs.mkdirSync(SYNC_DATA, { recursive: true });
  makeVaultA();

  const procs = [];
  const start = (label, cmd, args, env) => {
    const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', (d) => { if (process.env.VERBOSE) process.stdout.write(`[${label}] ${d}`); });
    p.stderr.on('data', (d) => process.stderr.write(`[${label}:err] ${d}`));
    procs.push(p);
    return p;
  };

  console.log('\n▶ 启动同步服务端与两个 EVNote 实例\n');
  start('sync', process.execPath, ['sync-server/index.js', '--port', String(SYNC_PORT), '--data', SYNC_DATA, '--name', 'TestSync', '--pair-code', PAIR_CODE]);
  start('A', process.execPath, ['server/server.js'], { PORT: '9561', EVNOTE_HOME: HOME_A, EVNOTE_CHUNK_THRESHOLD: '1048576' });
  start('B', process.execPath, ['server/server.js'], { PORT: '9562', EVNOTE_HOME: HOME_B, EVNOTE_CHUNK_THRESHOLD: '1048576' });

  await waitFor(`http://localhost:${SYNC_PORT}/api/health`, '同步服务端');
  await waitFor(`${API_A}/api/state`, '实例 A');
  await waitFor(`${API_B}/api/state`, '实例 B');

  // 两个实例都先指向各自仓库（服务端默认会打开 HOME 下的演示仓库）
  await api(API_A, '/api/vault/open', { method: 'POST', body: { path: VAULT_A } });
  await api(API_B, '/api/vault/open', { method: 'POST', body: { path: VAULT_B } });
  await sleep(600);

  const server = `http://localhost:${SYNC_PORT}`;

  // 1. 错误配对码
  let codeRejected = false;
  try {
    await api(API_A, '/api/sync/pair', { method: 'POST', body: { serverUrl: server, code: 'WRONG-CODE', deviceName: 'devA' } });
  } catch (e) { codeRejected = /配对码/.test(e.message); }
  check('错误配对码被拒绝', codeRejected);

  // 2. A 配对并上传
  const pairA = await api(API_A, '/api/sync/pair', { method: 'POST', body: { serverUrl: server, code: PAIR_CODE, deviceName: '设备A' } });
  check('A 配对成功并完成首次同步', pairA.ok && pairA.status?.configured, JSON.stringify(pairA.status?.lastResult || {}));
  const uploaded = pairA.status?.lastResult?.uploaded || 0;
  check('A 首次同步上传了 3 个文件', uploaded === 3, `uploaded=${uploaded}`);

  const manifest1 = await (await fetch(`${server}/api/manifest`, {
    headers: { Authorization: `Bearer ${readToken(VAULT_A)}` },
  })).json();
  check('服务端清单记录了 3 个文件', Object.keys(manifest1.files || {}).length === 3,
    `files=${Object.keys(manifest1.files || {}).length}`);

  // 3. B 配对并下载
  const pairB = await api(API_B, '/api/sync/pair', { method: 'POST', body: { serverUrl: server, code: PAIR_CODE, deviceName: '设备B' } });
  const downloaded = pairB.status?.lastResult?.downloaded || 0;
  check('B 配对后拉取到 3 个文件', downloaded === 3, `downloaded=${downloaded}`);
  check('B 本地出现 A 的笔记', fs.existsSync(path.join(VAULT_B, '笔记甲.md')) && fs.existsSync(path.join(VAULT_B, '项目', '笔记乙.md')));
  const binA = fs.readFileSync(path.join(VAULT_A, '附件.bin'));
  const binB = fs.readFileSync(path.join(VAULT_B, '附件.bin'));
  check('二进制附件逐字节一致', Buffer.compare(binA, binB) === 0);

  // 4. A 改 → B 拉到
  fs.writeFileSync(path.join(VAULT_A, '笔记甲.md'), '# 笔记甲\n\nA 在第一次同步后追加了一行。\n', 'utf8');
  const aSync1 = await api(API_A, '/api/sync/now', { method: 'POST', body: {} });
  check('A 增量上传 1 个文件', aSync1.result?.uploaded === 1, JSON.stringify(aSync1.result || {}));
  const bSync1 = await api(API_B, '/api/sync/now', { method: 'POST', body: {} });
  check('B 增量下载 1 个文件', bSync1.result?.downloaded === 1, JSON.stringify(bSync1.result || {}));
  check('B 读到 A 的新内容', fs.readFileSync(path.join(VAULT_B, '笔记甲.md'), 'utf8').includes('追加了一行'));

  // 5. 冲突：两边改同一文件
  fs.writeFileSync(path.join(VAULT_A, '笔记甲.md'), '# 笔记甲\n\nA 的版本。\n', 'utf8');
  await api(API_A, '/api/sync/now', { method: 'POST', body: {} });
  fs.writeFileSync(path.join(VAULT_B, '笔记甲.md'), '# 笔记甲\n\nB 的版本。\n', 'utf8');
  const bConflict = await api(API_B, '/api/sync/now', { method: 'POST', body: {} });
  const conflictCount = bConflict.result?.conflicts?.length || 0;
  check('冲突被识别并生成副本', conflictCount === 1, JSON.stringify(bConflict.result?.conflicts || []));
  const bFiles = fs.readdirSync(VAULT_B);
  const copy = bFiles.find((f) => f.includes('冲突') && f.endsWith('.md'));
  check('冲突副本文件真实存在', !!copy, copy || '');
  check('原路径保留本地版本', fs.readFileSync(path.join(VAULT_B, '笔记甲.md'), 'utf8').includes('B 的版本'));
  check('冲突副本保存远端版本', !!copy && fs.readFileSync(path.join(VAULT_B, copy), 'utf8').includes('A 的版本'));

  // 5b. v2：两边改不同段落 → 自动合并，不产生副本
  const mergeBase = ['# 合并测试', '', '第一段：原文。', '', '第二段：原文。', '', '第三段：原文。'].join('\n');
  fs.writeFileSync(path.join(VAULT_A, '合并测试.md'), mergeBase, 'utf8');
  await api(API_A, '/api/sync/now', { method: 'POST', body: {} });
  await api(API_B, '/api/sync/now', { method: 'POST', body: {} });
  check('B 拿到合并测试基准文件', fs.existsSync(path.join(VAULT_B, '合并测试.md')));

  fs.writeFileSync(path.join(VAULT_A, '合并测试.md'), mergeBase.replace('第一段：原文。', '第一段：A 改的。'), 'utf8');
  await api(API_A, '/api/sync/now', { method: 'POST', body: {} });
  fs.writeFileSync(path.join(VAULT_B, '合并测试.md'), mergeBase.replace('第三段：原文。', '第三段：B 改的。'), 'utf8');
  const mergeRes = await api(API_B, '/api/sync/now', { method: 'POST', body: {} });
  const bMerged = fs.readFileSync(path.join(VAULT_B, '合并测试.md'), 'utf8');
  const copyOfMerge = fs.readdirSync(VAULT_B).filter((f) => f.includes('合并测试') && f.includes('冲突'));
  check('不同段落改动自动合并', mergeRes.result?.merged?.includes('合并测试.md'), JSON.stringify(mergeRes.result?.merged || []));
  check('合并结果包含两边的修改', bMerged.includes('A 改的') && bMerged.includes('B 改的'));
  check('自动合并不产生冲突副本', copyOfMerge.length === 0, copyOfMerge.join(','));

  await api(API_A, '/api/sync/now', { method: 'POST', body: {} });
  check('合并结果同步回 A', fs.readFileSync(path.join(VAULT_A, '合并测试.md'), 'utf8').includes('B 改的'));

  // 5c. v2：大附件走分块上传 + 服务端 Range
  const big = Buffer.alloc(5 * 1024 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = (i * 37) % 251;
  fs.writeFileSync(path.join(VAULT_A, '大附件.bin'), big);
  const bigUp = await api(API_A, '/api/sync/now', { method: 'POST', body: {} });
  check('大附件上传成功', (bigUp.result?.uploaded || 0) >= 1, `uploaded=${bigUp.result?.uploaded}`);
  await api(API_B, '/api/sync/now', { method: 'POST', body: {} });
  const bigB = fs.readFileSync(path.join(VAULT_B, '大附件.bin'));
  check('大附件逐字节一致', Buffer.compare(big, bigB) === 0, `${big.length} → ${bigB.length}`);

  const bigSha = crypto.createHash('sha256').update(big).digest('hex');
  const rangeRes = await fetch(`${server}/api/blob/${bigSha}`, {
    headers: { Authorization: `Bearer ${readToken(VAULT_A)}`, Range: 'bytes=0-1023' },
  });
  const rangeBuf = await rangeRes.arrayBuffer();
  check('服务端支持 Range 断点下载', rangeRes.status === 206 && rangeBuf.byteLength === 1024,
    `status=${rangeRes.status} bytes=${rangeBuf.byteLength}`);

  // 5d. 分块协议独立验证（init → 3 个块 → complete）
  const protoBuf = crypto.randomBytes(2.5 * 1024 * 1024);
  const protoSha = crypto.createHash('sha256').update(protoBuf).digest('hex');
  const token = readToken(VAULT_A);
  const auth = { Authorization: `Bearer ${token}` };
  const initRes = await (await fetch(`${server}/api/upload/init`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sha: protoSha, size: protoBuf.length, chunkSize: 1024 * 1024 }),
  })).json();
  let protoOk = false;
  if (initRes.uploadId) {
    const step = 1024 * 1024;
    for (let i = 0; i * step < protoBuf.length; i++) {
      await fetch(`${server}/api/upload/${initRes.uploadId}/${i}`, {
        method: 'PUT', headers: auth,
        body: protoBuf.subarray(i * step, Math.min((i + 1) * step, protoBuf.length)),
      });
    }
    const done = await (await fetch(`${server}/api/upload/${initRes.uploadId}/complete`, {
      method: 'POST', headers: auth,
    })).json();
    const back = await fetch(`${server}/api/blob/${protoSha}`, { headers: auth });
    const backBuf = Buffer.from(await back.arrayBuffer());
    protoOk = done.ok && Buffer.compare(backBuf, protoBuf) === 0;
  }
  check('分块协议 init/分块/complete 全链路', protoOk);

  // 6. 删除传播
  await api(API_A, '/api/delete', { method: 'POST', body: { path: '项目/笔记乙.md' } });
  await sleep(300);
  const aDel = await api(API_A, '/api/sync/now', { method: 'POST', body: {} });
  const bDel = await api(API_B, '/api/sync/now', { method: 'POST', body: {} });
  check('删除从 A 传播到 B', !fs.existsSync(path.join(VAULT_B, '项目', '笔记乙.md')),
    `A删除=${aDel.result?.deleted} B下载=${bDel.result?.downloaded}`);
  const trashDir = path.join(VAULT_B, '.evnote', 'trash');
  let inTrash = false;
  if (fs.existsSync(trashDir)) {
    for (const d of fs.readdirSync(trashDir)) {
      if (fs.existsSync(path.join(trashDir, d, '项目', '笔记乙.md'))) inTrash = true;
    }
  }
  check('被删除的文件进了回收站（不直接销毁）', inTrash);

  // 7. 状态与断开
  const st = await api(API_A, '/api/sync/status');
  check('状态接口返回连接信息', st.configured === true && !!st.lastSyncAt, `server=${st.serverUrl}`);
  const offline = await api(API_A, '/api/sync/disconnect', { method: 'POST', body: {} });
  check('可断开同步', offline.status?.configured === false);

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
  console.error('\n💥 测试异常:', e);
  process.exit(1);
});
