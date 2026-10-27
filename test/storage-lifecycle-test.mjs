import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readJson, writeJson } from '../server/durable-json.js';
import { createTrashStore } from '../server/trash-store.js';
import { SyncEngine } from '../server/sync.js';
import { Vault } from '../server/vault.js';
const require = createRequire(import.meta.url), { startServerProcess, stopServerProcess } = require('../electron/server-process.cjs');
const ROOT = path.resolve(import.meta.dirname, '..'), HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tracery-storage-'));
const VAULT = path.join(HOME, 'vault'); fs.mkdirSync(VAULT);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const warnings = [], options = { warn: message => warnings.push(message) };
const cfg = path.join(HOME, 'config.json'), first = { recentVaults: ['fixture-vault'], settings: { hotkeys: { save: 'Ctrl+S' } } };
writeJson(cfg, first); writeJson(cfg, { ...first, version: 2 }); fs.writeFileSync(cfg, '{"broken":');
assert.deepEqual(readJson(cfg, {}, options), first);
assert.ok(warnings.some(message => message.includes('备份')));
assert.ok(fs.readdirSync(HOME).some(name => name.startsWith('config.json.corrupt-')));
const old = path.join(HOME, 'legacy.json'); writeJson(old, first);
assert.deepEqual(readJson(path.join(HOME, 'migrated.json'), {}, { ...options, legacy: old }), first);
for (const code of ['ENOSPC', 'EACCES']) {
  writeJson(cfg, first); const before = fs.readFileSync(cfg, 'utf8'), rename = fs.renameSync;
  try {
    fs.renameSync = (src, dest) => { if (dest === cfg) throw Object.assign(Error('injected'), { code }); return rename(src, dest); };
    assert.throws(() => writeJson(cfg, { changed: true }), { code });
  } finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(cfg, 'utf8'), before);
}
const writeFile = fs.writeFileSync;
try {
  fs.writeFileSync = (file, ...args) => { if (typeof file === 'number') throw Object.assign(Error('full disk'), { code: 'ENOSPC' }); return writeFile(file, ...args); };
  assert.throws(() => writeJson(cfg, { changed: true }), { code: 'ENOSPC' });
} finally { fs.writeFileSync = writeFile; }
assert.deepEqual(JSON.parse(fs.readFileSync(cfg)), first);
const evidenceCount = fs.readdirSync(HOME).filter(name => name.startsWith('config.json.corrupt-')).length;
fs.writeFileSync(cfg, '{"broken":'); readJson(cfg, {}, options); readJson(cfg, {}, options);
assert.equal(fs.readdirSync(HOME).filter(name => name.startsWith('config.json.corrupt-')).length, evidenceCount);
writeJson(cfg, first);
const schema = value => Array.isArray(value.recentVaults);
writeJson(cfg, first, { validate: schema }); fs.writeFileSync(cfg, JSON.stringify({ recentVaults: 'invalid shape' }));
const restoredConfig = readJson(cfg, {}, { ...options, validate: schema });
writeJson(cfg, restoredConfig, { validate: schema });
assert.deepEqual(JSON.parse(fs.readFileSync(`${cfg}.bak`)), first);
console.log('PASS 半截配置保留证据/备份恢复/旧版迁移，ENOSPC/EACCES 不覆盖原件或冒报成功');

const sync = new SyncEngine({ getVaultRoot: () => VAULT, notify: () => {}, onFilesChanged: () => {} });
const credentials = { token: 'FAKE-TOKEN', encryption: { encKey: 'FAKE-KEY' } };
sync._saveCfg(credentials);
const syncFile = path.join(VAULT, '.tracery/sync.json'), rename = fs.renameSync;
try {
  fs.renameSync = (src, dest) => { if (dest === syncFile) throw Object.assign(Error('injected'), { code: 'ENOSPC' }); return rename(src, dest); };
  assert.throws(() => sync._saveCfg({ token: 'CHANGED' }));
} finally { fs.renameSync = rename; }
assert.equal(sync.cfg.token, credentials.token); assert.equal(JSON.parse(fs.readFileSync(syncFile)).encryption.encKey, credentials.encryption.encKey);
fs.writeFileSync(syncFile, '{broken'); fs.writeFileSync(`${syncFile}.bak`, '{also-broken');
const damagedSync = new SyncEngine({ getVaultRoot: () => VAULT, notify: () => {} });
assert.equal(damagedSync.configured, false); assert.match(damagedSync.cfg.lastError, /同步配置损坏/);
assert.throws(() => damagedSync._saveCfg({ token: 'REPLACEMENT' }), /同步配置损坏/);
assert.equal(fs.readFileSync(syncFile, 'utf8'), '{broken');
// 恢复夹具，后续服务启动不依赖这份损坏配置。
fs.writeFileSync(syncFile, '{}');
console.log('PASS 同步配置提交失败保留原凭据，测试只使用虚构字段');

const trash = createTrashStore(HOME), note = path.join(VAULT, 'safe.md'); fs.writeFileSync(note, 'unique original');
const dir = trash.dirFor(VAULT), index = path.join(dir, 'index.json');
try {
  fs.renameSync = (src, dest) => { if (dest === index) throw Object.assign(Error('injected index commit'), { code: 'ENOSPC' }); return rename(src, dest); };
  await assert.rejects(trash.move(VAULT, 'safe.md', note));
} finally { fs.renameSync = rename; }
assert.equal(fs.existsSync(note), false);
const recovered = trash.list(VAULT); assert.equal(recovered.length, 1); assert.equal(recovered[0].path, 'safe.md');
await trash.restore(VAULT, recovered[0].id); assert.equal(fs.readFileSync(note, 'utf8'), 'unique original');
const source = path.join(VAULT, 'folder'); fs.mkdirSync(source); fs.writeFileSync(path.join(source, 'child.md'), 'directory original');
const asyncRename = fsp.rename, copy = fsp.cp;
try {
  fsp.rename = async (src, dest) => { if (src === source) throw Object.assign(Error('cross device'), { code: 'EXDEV' }); return asyncRename(src, dest); };
  fsp.cp = async () => { throw Object.assign(Error('full disk'), { code: 'ENOSPC' }); };
  await assert.rejects(trash.move(VAULT, 'folder', source));
  assert.equal(fs.readFileSync(path.join(source, 'child.md'), 'utf8'), 'directory original');
  fsp.cp = async (src, dest, options) => { await copy(src, dest, options); fs.writeFileSync(path.join(dest, 'child.md'), 'corrupted original'); };
  await assert.rejects(trash.move(VAULT, 'folder', source), /校验失败/);
  assert.equal(fs.readFileSync(path.join(source, 'child.md'), 'utf8'), 'directory original');
  fsp.cp = async (src, dest, options) => { await copy(src, dest, options); fs.writeFileSync(path.join(src, 'external.md'), 'external edit'); };
  await assert.rejects(trash.move(VAULT, 'folder', source), /原件发生变化/);
  assert.equal(fs.readFileSync(path.join(source, 'external.md'), 'utf8'), 'external edit');
  fs.unlinkSync(path.join(source, 'external.md'));
  fsp.cp = copy;
  await trash.move(VAULT, 'folder', source);
} finally { fsp.rename = asyncRename; fsp.cp = copy; }
fs.writeFileSync(index, '{');
const folder = trash.list(VAULT).find(item => item.path === 'folder'); assert.ok(folder);
await trash.restore(VAULT, folder.id); assert.equal(fs.readFileSync(path.join(source, 'child.md'), 'utf8'), 'directory original');
fs.writeFileSync(path.join(dir, '123456-abcdef__orphan.md'), 'orphan');
const orphan = trash.list(VAULT).find(item => item.name === 'orphan.md'); assert.equal(orphan.originalPathUnknown, true);
await trash.restore(VAULT, orphan.id); assert.equal(fs.readFileSync(path.join(VAULT, 'orphan.md'), 'utf8'), 'orphan');
console.log('PASS 回收站索引失败/损坏仍能列出恢复，跨盘副本损坏/源目录变化不删原件，目录跨盘与旧孤立项目可恢复');

// 在真正的进程中卡在替换之前，再强制结束；唯一配置必须仍为完整 JSON。
const fixture = path.join(HOME, 'crash.mjs');
fs.writeFileSync(fixture, `import fs from 'node:fs';import {writeJson} from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'server/durable-json.js')).href)};const rename=fs.renameSync;fs.renameSync=(src,dest)=>{if(dest===process.env.FIXTURE_CONFIG){process.send({paused:true});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}return rename(src,dest);};writeJson(process.env.FIXTURE_CONFIG,{newValue:true});`);
const crashing = spawn(process.execPath, [fixture], { env: { ...process.env, FIXTURE_CONFIG: cfg }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
await new Promise((resolve, reject) => { crashing.once('message', resolve); crashing.once('exit', code => reject(Error('fixture exited ' + code))); });
const dead = new Promise(resolve => crashing.once('exit', resolve)); crashing.kill('SIGKILL'); await dead;
assert.deepEqual(JSON.parse(fs.readFileSync(cfg)), first);
console.log('PASS 配置替换前真实进程中止仍保留完整原配置');

const progress = [], vault = new Vault(VAULT, { onProgress: data => progress.push(data) });
await vault.open(); assert.ok(progress.some(data => data.reason === 'missing')); assert.ok(progress.some(data => data.phase === 'complete' && data.notes >= 2));
progress.length = 0; await new Vault(VAULT, { onProgress: data => progress.push(data) }).open();
assert.ok(progress.some(data => data.reason === 'valid')); assert.equal(progress.find(data => data.phase === 'complete').parsed, 0);
fs.writeFileSync(path.join(VAULT, '.tracery/index.json'), '{}'); progress.length = 0;
await new Vault(VAULT, { onProgress: data => progress.push(data) }).open(); assert.ok(progress.some(data => data.reason === 'invalid-manifest'));
console.log('PASS 首次/暖开/损坏索引都有原因、数量与耗时，暖开继续复用缓存');

// 经认证的进度可以延长空闲超时，但最长启动预算始终有界。
const slow = path.join(HOME, 'slow.cjs');
fs.writeFileSync(slow, `setInterval(()=>process.send({type:'tracery-progress',nonce:process.env.TRACERY_START_TOKEN,pid:process.pid}),50);setTimeout(()=>process.send({type:'tracery-ready',nonce:process.env.TRACERY_START_TOKEN,pid:process.pid,port:9682}),700);`);
const slowState = startServerProcess({ executable: process.execPath, entry: slow, env: process.env, port: 9682, timeout: 400, maxStartupMs: 3000 });
await slowState.ready; slowState.child.kill();
const bounded = startServerProcess({ executable: process.execPath, entry: slow, env: process.env, port: 9682, timeout: 400, maxStartupMs: 500 });
await assert.rejects(bounded.ready, /最长等待/);
const stubbornFile = path.join(HOME, 'stubborn.cjs');
fs.writeFileSync(stubbornFile, `process.send({type:'tracery-ready',nonce:process.env.TRACERY_START_TOKEN,pid:process.pid,port:9682});setInterval(()=>{},1000);`);
const stubborn = startServerProcess({ executable: process.execPath, entry: stubbornFile, env: process.env, port: 9682 });
await stubborn.ready; assert.equal((await stopServerProcess(stubborn.child, 150)).graceful, false); assert.equal(stubborn.child.killed, true);
console.log('PASS 正常慢启动按进度等待，持续进度不能突破最长启动预算');

// 已接受、正文尚未发完的真实保存，在退出请求后仍需完成。
writeJson(path.join(HOME, 'tracery.config.json'), { currentVault: VAULT });
const state = startServerProcess({ executable: process.execPath, entry: path.join(ROOT, 'server/server.js'), env: { ...process.env, PORT: '9682', TRACERY_HOME: HOME }, port: 9682 });
let trace = ''; state.child.stdout.on('data', data => trace += data); state.child.stderr.on('data', data => trace += data);
try {
  await state.ready;
  state.child.send({ type: 'tracery-shutdown', nonce: 'wrong' }); await sleep(100); assert.equal(state.child.exitCode, null);
  const body = JSON.stringify({ path: 'safe.md', content: 'confirmed final write' });
  let request;
  const response = new Promise((resolve, reject) => {
    request = http.request('http://127.0.0.1:9682/api/note', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    request.on('error', reject); request.write(body.slice(0, 8));
  });
  await sleep(100);
  const cancelledBody = JSON.stringify({ path: 'safe.md', content: 'cancelled queued request must not write' });
  const cancelledRequest = http.request('http://127.0.0.1:9682/api/note', { method: 'PUT', headers: { 'Content-Type': 'application/json' } });
  cancelledRequest.on('error', () => {}); cancelledRequest.end(cancelledBody);
  await sleep(50); cancelledRequest.destroy(); await sleep(50);
  const stopped = stopServerProcess(state.child);
  const stoppedAgain = stopServerProcess(state.child);
  await sleep(100); request.end(body.slice(8));
  assert.equal(await response, 200); assert.equal((await stopped).graceful, true);
  assert.equal((await stoppedAgain).graceful, true);
  assert.equal(fs.readFileSync(note, 'utf8'), 'confirmed final write');
  assert.match(trace, /收尾完成/);
  await assert.rejects(fetch('http://127.0.0.1:9682/api/state'));
  assert.equal((await stopServerProcess(state.child)).graceful, true);
  console.log('PASS 错误退出身份无效，IPC 退出等待已接受保存、重复关闭幂等、端口释放');
} catch (error) { console.error(trace); throw error; }
finally { if (state.child.exitCode === null) state.child.kill(); }
