/**
 * 同步 v3（端到端加密）端到端测试
 * ------------------------------------------------------------------
 * 真进程：同步服务端 + 三个 Tracery 实例（A/B 正常，C 用来验证错误密码）。
 * 验证的重点是「服务端看不到明文」：
 *   ① manifest 里没有明文路径，文件 key 是 64 位 hex
 *   ② blob 是 TRC1 密文，字节里不含笔记内容
 *   ③ 密码错 → 配对被拒；换设备用同一密码能解出原文件名与内容
 *   ④ 加密下的增量同步 / 解密落地 / 解锁流程
 * 运行：node test/sync-enc-test.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { deriveKeys, decryptBuffer } from '../server/crypto.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const TMP = path.join(os.tmpdir(), 'tracery-sync-enc-test');
const SYNC_PORT = 9701;
const SYNC_DATA = path.join(TMP, 'sync-data');
const VAULT_A = path.join(TMP, 'vault-a');
const VAULT_B = path.join(TMP, 'vault-b');
const VAULT_C = path.join(TMP, 'vault-c');
const HOME_A = path.join(TMP, 'home-a');
const HOME_B = path.join(TMP, 'home-b');
const HOME_C = path.join(TMP, 'home-c');
const PAIR_CODE = 'ENC-CODE';
const API = {
  A: 'http://localhost:9563',
  B: 'http://localhost:9564',
  C: 'http://localhost:9565',
};
const PASSWORD = 'correct horse battery staple';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  — ' + extra : ''}`);
};

async function waitFor(url, label) {
  for (let i = 0; i < 80; i++) {
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

function readSyncCfg(vaultRoot) {
  try { return JSON.parse(fs.readFileSync(path.join(vaultRoot, '.tracery', 'sync.json'), 'utf8')); } catch { return {}; }
}

async function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  for (const d of [VAULT_A, VAULT_B, VAULT_C, HOME_A, HOME_B, HOME_C, SYNC_DATA]) fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(path.join(VAULT_A, '项目'), { recursive: true });
  fs.writeFileSync(path.join(VAULT_A, '笔记甲.md'), '# 笔记甲\n\n来自 A 的初始内容。\n', 'utf8');
  fs.writeFileSync(path.join(VAULT_A, '项目', '笔记乙.md'), '# 笔记乙\n\n[[笔记甲]]\n', 'utf8');
  fs.writeFileSync(path.join(VAULT_A, '附件.bin'), crypto.randomBytes(2048));

  const procs = [];
  const start = (label, args, env) => {
    const p = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    p.stderr.on('data', (d) => { if (process.env.VERBOSE) process.stderr.write(`[${label}] ${d}`); });
    procs.push(p);
    return p;
  };

  console.log('\n▶ 启动同步服务端 + 三个实例\n');
  start('sync', ['sync-server/index.js', '--port', String(SYNC_PORT), '--data', SYNC_DATA, '--name', 'EncSync', '--pair-code', PAIR_CODE], {});
  start('A', ['server/server.js'], { PORT: '9563', TRACERY_HOME: HOME_A });
  start('B', ['server/server.js'], { PORT: '9564', TRACERY_HOME: HOME_B });
  start('C', ['server/server.js'], { PORT: '9565', TRACERY_HOME: HOME_C });

  await waitFor(`http://localhost:${SYNC_PORT}/api/health`, '同步服务端');
  for (const k of ['A', 'B', 'C']) await waitFor(`${API[k]}/api/state`, `实例 ${k}`);
  await api(API.A, '/api/vault/open', { method: 'POST', body: { path: VAULT_A } });
  await api(API.B, '/api/vault/open', { method: 'POST', body: { path: VAULT_B } });
  await api(API.C, '/api/vault/open', { method: 'POST', body: { path: VAULT_C } });
  await sleep(600);

  const server = `http://localhost:${SYNC_PORT}`;
  const tokenA = () => readSyncCfg(VAULT_A).token || '';
  const manifestA = async () => (await fetch(`${server}/api/manifest`, { headers: { Authorization: `Bearer ${tokenA()}` } })).json();

  /* ---------- 1. A 用密码开启加密并首次同步 ---------- */
  const pairA = await api(API.A, '/api/sync/pair', {
    method: 'POST',
    body: { serverUrl: server, code: PAIR_CODE, deviceName: '设备A', password: PASSWORD, encrypt: true },
  });
  check('A 开启端到端加密并完成首次同步', pairA.ok && pairA.status?.encrypted === true, JSON.stringify(pairA.status?.lastResult || {}));
  check('本地文件仍是明文', fs.readFileSync(path.join(VAULT_A, '笔记甲.md'), 'utf8').includes('来自 A 的初始内容'));
  check('配置文件里没有明文密码', !JSON.stringify(readSyncCfg(VAULT_A)).includes(PASSWORD));

  /* ---------- 2. 服务端只有密文与哈希名 ---------- */
  const m1 = await manifestA();
  const keys = Object.keys(m1.files || {});
  const fileKeys = keys.filter((k) => !k.startsWith('tracery-v3-'));
  check('清单里有 meta / index 两个保留项', keys.includes('tracery-v3-meta') && keys.includes('tracery-v3-index'), keys.join(','));
  check('文件 key 全部是 64 位十六进制（HMAC）', fileKeys.length === 3 && fileKeys.every((k) => /^[a-f0-9]{64}$/.test(k)), fileKeys.length + ' 个');
  check('清单里没有明文文件名', !keys.some((k) => k.includes('笔记') || k.includes('项目') || k.includes('附件')), keys.slice(0, 3).join(','));

  const metaBlob = await (await fetch(`${server}/api/blob/${m1.files['tracery-v3-meta'].sha}`, { headers: { Authorization: `Bearer ${tokenA()}` } })).arrayBuffer();
  const meta = JSON.parse(Buffer.from(metaBlob).toString('utf8'));
  check('meta 里只有 salt 与校验串（无密码）', !!meta.salt && !!meta.check && !JSON.stringify(meta).includes(PASSWORD), `salt=${String(meta.salt).slice(0, 8)}…`);

  const mdKey = fileKeys[0];
  const blobBuf = Buffer.from(await (await fetch(`${server}/api/blob/${m1.files[mdKey].sha}`, { headers: { Authorization: `Bearer ${tokenA()}` } })).arrayBuffer());
  check('blob 是 TRC1 密文', blobBuf.subarray(0, 4).toString('ascii') === 'TRC1', blobBuf.subarray(0, 4).toString('ascii'));
  check('密文里不含笔记正文', !blobBuf.toString('utf8').includes('来自 A 的初始内容') && !blobBuf.toString('utf8').includes('笔记甲'));

  // 索引能用密码解开，且能还原文件名
  const { encKey } = deriveKeys(PASSWORD, meta.salt);
  const indexBuf = Buffer.from(await (await fetch(`${server}/api/blob/${m1.files['tracery-v3-index'].sha}`, { headers: { Authorization: `Bearer ${tokenA()}` } })).arrayBuffer());
  let indexNames = {};
  try { indexNames = JSON.parse(decryptBuffer(encKey, indexBuf).toString('utf8')).names || {}; } catch { indexNames = {}; }
  const restored = Object.values(indexNames);
  check('加密索引可还原出原路径', restored.includes('笔记甲.md') && restored.includes('项目/笔记乙.md'),
    JSON.stringify(restored));

  /* ---------- 3. B 用同一密码换设备拉取 ---------- */
  const pairB = await api(API.B, '/api/sync/pair', {
    method: 'POST',
    body: { serverUrl: server, code: PAIR_CODE, deviceName: '设备B', password: PASSWORD },
  });
  check('B 用同一密码配对并解密下载', pairB.status?.lastResult?.downloaded === 3, JSON.stringify(pairB.status?.lastResult || {}));
  check('B 本地路径与内容都正确（索引还原了文件名）',
    fs.existsSync(path.join(VAULT_B, '笔记甲.md')) && fs.existsSync(path.join(VAULT_B, '项目', '笔记乙.md'))
    && fs.readFileSync(path.join(VAULT_B, '笔记甲.md'), 'utf8').includes('来自 A 的初始内容'));
  check('二进制附件逐字节一致', Buffer.compare(
    fs.readFileSync(path.join(VAULT_A, '附件.bin')),
    fs.readFileSync(path.join(VAULT_B, '附件.bin')),
  ) === 0);

  /* ---------- 4. 错误密码被拒绝 ---------- */
  // C 用一个全新的仓库配对（同一服务端），密码故意写错
  let wrongPassErr = '';
  try {
    await api(API.C, '/api/sync/pair', {
      method: 'POST',
      body: { serverUrl: server, code: PAIR_CODE, deviceName: '设备C', password: 'wrong-password-123' },
    });
  } catch (e) { wrongPassErr = e.message; }
  check('错误密码配对被拒绝', /密码不正确/.test(wrongPassErr), wrongPassErr);
  check('错误密码不会留下半连接状态', (await api(API.C, '/api/sync/status')).configured === false);

  /* ---------- 5. 加密下的增量同步 ---------- */
  fs.writeFileSync(path.join(VAULT_A, '笔记甲.md'), '# 笔记甲\n\n来自 A 的初始内容。\n\nA 追加的一行。\n', 'utf8');
  const aSync = await api(API.A, '/api/sync/now', { method: 'POST', body: {} });
  check('A 增量上传 1 个文件', aSync.result?.uploaded >= 1, JSON.stringify(aSync.result || {}));
  const bSync = await api(API.B, '/api/sync/now', { method: 'POST', body: {} });
  check('B 拉到增量并解密落地', fs.readFileSync(path.join(VAULT_B, '笔记甲.md'), 'utf8').includes('A 追加的一行'),
    JSON.stringify(bSync.result || {}));
  check('增量后服务端仍是密文', !(await (async () => {
    const m2 = await manifestA();
    const k = Object.keys(m2.files).find((x) => !x.startsWith('tracery-v3-'));
    const b = Buffer.from(await (await fetch(`${server}/api/blob/${m2.files[k].sha}`, { headers: { Authorization: `Bearer ${tokenA()}` } })).arrayBuffer());
    return b.toString('utf8');
  })()).includes('A 追加的一行'));

  /* ---------- 6. 换机/重装：钥匙丢了 → 解锁 ---------- */
  const cfgB = readSyncCfg(VAULT_B);
  const savedEnc = cfgB.encryption;
  cfgB.encryption = { enabled: true };   // 模拟：配置在，但钥匙没搬过来
  fs.writeFileSync(path.join(VAULT_B, '.tracery', 'sync.json'), JSON.stringify(cfgB, null, 2), 'utf8');
  // 让引擎重新读配置：断开重连代价大，这里直接用 unlock 接口验证
  const stBefore = await api(API.B, '/api/sync/status');
  check('钥匙缺失时状态提示需要密码', stBefore.needsPassword === true, JSON.stringify({ enc: stBefore.encrypted, need: stBefore.needsPassword }));
  const unlock = await api(API.B, '/api/sync/unlock', { method: 'POST', body: { password: PASSWORD } });
  check('输入正确密码可解锁并同步', unlock.ok === true && unlock.status?.encrypted === true, JSON.stringify(unlock.status?.lastResult || {}));

  console.log('\n========== 结果 ==========');
  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}`);
  const pass = results.filter((r) => r.ok).length;
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
