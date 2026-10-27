import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createFullBackup } from '../server/full-backup.js';
import { createHistoryStore } from '../server/history-store.js';
import { createTrashStore } from '../server/trash-store.js';
fs.mkdirSync(path.resolve('dist'), { recursive: true });
const HOME = fs.mkdtempSync(path.resolve('dist/full-backup-')), ROOT = path.join(HOME, 'vault'), DEST = path.join(HOME, 'backups'), RESTORE = path.join(HOME, 'restored');
for (const dir of [ROOT, DEST, RESTORE]) fs.mkdirSync(dir);
const put = (rel, content) => { const file = path.join(ROOT, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
const sha = value => createHash('sha256').update(value).digest('hex');
const original = '\uFEFF# 完整备份\n\n![[附件/大图.png|400]]\n';
put('正文.md', original); put('history/正常笔记.md', '# 用户自己的 history 文件夹');
put('附件/大图.png', Buffer.alloc(34 * 1024 * 1024, 137)); put('附件/大图.draw.json', '{"strokes":[]}'); put('附件/原始数据.bin', Buffer.from([0, 255, 1, 9]));
put('.tracery/sync.json', '{"token":"SYNTHETIC_SECRET"}'); put('.tracery/index.json', 'CACHE'); put('.git/config', 'SYNTHETIC_SECRET'); put('node_modules/private', 'SYNTHETIC_SECRET');
fs.mkdirSync(path.join(ROOT, '空文件夹'));
const history = createHistoryStore(HOME); history.snapshot(ROOT, '正文.md', '# 旧正文'); history.importVersions(ROOT, '正文.md', [{ time: 12345, content: '# 不确定旧历史' }], { legacy: true });
put('已删.md', '# 回收站正文'); const trash = createTrashStore(HOME); await trash.move(ROOT, '已删.md', path.join(ROOT, '已删.md'));
const settings = { themeName: 'apple', themeMode: 'light', fontSize: 17, sync: { token: 'SYNTHETIC_SECRET' } };
const service = createFullBackup({ home: HOME, getVault: () => ({ root: ROOT }), getSettings: () => settings });
async function run(kind, options, instance = service) { const id = instance.start(kind, options); await instance.wait(id); return instance.status(id); }
const created = await run('create', { parent: DEST, vaultRoot: ROOT, clientState: { tabs: '{"tabs":["正文.md"],"active":0}', workspaces: '[]', drafts: 'SYNTHETIC_SECRET' } });
assert.equal(created.status, 'complete', JSON.stringify(created)); const backup = created.result.path;
const manifestText = fs.readFileSync(path.join(backup, 'manifest.json'), 'utf8'), manifest = JSON.parse(manifestText);
assert.ok(!manifestText.includes('SYNTHETIC_SECRET')); assert.equal(manifest.clientState.tabs, '{"tabs":["正文.md"],"active":0}');
assert.ok(!manifest.files.some(row => /\.tracery|\.git|node_modules/.test(row.path)));
assert.ok(manifest.files.some(row => row.path === 'vault/附件/大图.draw.json'));
assert.equal(fs.statSync(path.join(backup, 'vault/附件/大图.png')).size, 34 * 1024 * 1024);
assert.ok(fs.existsSync(path.join(backup, 'vault/空文件夹')));
assert.ok(Math.abs(fs.statSync(path.join(backup, 'vault/正文.md')).mtimeMs - fs.statSync(path.join(ROOT, '正文.md')).mtimeMs) < 2);
assert.equal((await run('verify', { source: backup })).status, 'complete');
console.log('PASS 完整正文/34MiB 附件/二进制/绘图/空目录/历史/回收站/会话，排除缓存和凭据，创建后回读与独立校验通过');
put('正文.md', '# 备份后修改原件');
const restored = await run('restore', { source: backup, parent: RESTORE }); assert.equal(restored.status, 'complete', JSON.stringify(restored));
const next = restored.result.path;
assert.equal(fs.readFileSync(path.join(next, '正文.md'), 'utf8'), original); assert.equal(fs.readFileSync(path.join(ROOT, '正文.md'), 'utf8'), '# 备份后修改原件');
assert.equal(fs.readFileSync(path.join(next, 'history/正常笔记.md'), 'utf8'), '# 用户自己的 history 文件夹');
assert.equal(sha(fs.readFileSync(path.join(next, '附件/大图.png'))), sha(fs.readFileSync(path.join(backup, 'vault/附件/大图.png'))));
assert.ok(!fs.existsSync(path.join(next, '.tracery/sync.json')));
const versions = history.list(next, '正文.md'); assert.equal(versions.length, 2); assert.ok(versions.some(row => row.legacy && !row.restorable));
assert.equal(history.read(next, '正文.md', versions.find(row => !row.legacy).id), '# 旧正文');
assert.equal(trash.list(next).length, 1); assert.equal(trash.list(next)[0].path, '已删.md');
assert.ok(Math.abs(fs.statSync(path.join(next, '正文.md')).mtimeMs - manifest.files.find(row => row.path === 'vault/正文.md').mtimeMs) < 2);
assert.equal(settings.fontSize, 17); assert.equal(restored.result.settings.sync, undefined);
console.log('PASS 恢复到全新目录，文件逐字节一致，历史身份重绑定、旧历史仍仅预览，回收站可列出，原库及当前设置不覆盖');
const count = fs.readdirSync(RESTORE).length;
fs.appendFileSync(path.join(backup, 'vault/正文.md'), 'tampered');
const damaged = await run('restore', { source: backup, parent: RESTORE }); assert.equal(damaged.status, 'failed'); assert.match(damaged.error, /校验失败/);
assert.equal(fs.readdirSync(RESTORE).length, count); fs.writeFileSync(path.join(backup, 'vault/正文.md'), original);
const malicious = structuredClone(manifest); malicious.files[0].path = '../outside.txt';
fs.writeFileSync(path.join(backup, 'manifest.json'), JSON.stringify(malicious)); fs.writeFileSync(path.join(backup, 'manifest.sha256'), sha(JSON.stringify(malicious)));
assert.equal((await run('verify', { source: backup })).status, 'failed');
fs.writeFileSync(path.join(backup, 'manifest.json'), manifestText); fs.writeFileSync(path.join(backup, 'manifest.sha256'), sha(manifestText));
const restoreFail = createFullBackup({ home: HOME, getVault: () => ({ root: ROOT }), getSettings: () => settings,
  fault: async stage => { if (stage === 'restored') throw Error('injected restore failure'); } });
assert.equal((await run('restore', { source: backup, parent: RESTORE }, restoreFail)).status, 'failed');
assert.equal(fs.readFileSync(path.join(ROOT, '正文.md'), 'utf8'), '# 备份后修改原件');
assert.equal((await run('create', { parent: ROOT, vaultRoot: ROOT })).status, 'failed');
console.log('PASS 篡改备份在恢复前拒绝，路径穿越与库内递归备份拒绝，原件保持');
const faulting = createFullBackup({ home: HOME, getVault: () => ({ root: ROOT }), getSettings: () => settings,
  fault: async stage => { if (stage === 'copied') throw Error('injected full disk'); } });
const failed = await run('create', { parent: DEST, vaultRoot: ROOT }, faulting); assert.equal(failed.status, 'failed'); assert.ok(failed.incomplete.endsWith('.incomplete'));
assert.equal((await run('verify', { source: failed.incomplete })).status, 'failed');
let release, started; const seen = new Promise(resolve => started = resolve), gate = new Promise(resolve => release = resolve);
const cancelling = createFullBackup({ home: HOME, getVault: () => ({ root: ROOT }), getSettings: () => settings,
  fault: async stage => { if (stage === 'copied') { started(); await gate; } } });
const id = cancelling.start('create', { parent: DEST, vaultRoot: ROOT }); await seen; cancelling.cancel(id); release(); await cancelling.wait(id);
assert.equal(cancelling.status(id).status, 'cancelled');
const changed = createFullBackup({ home: HOME, getVault: () => ({ root: ROOT }), getSettings: () => settings,
  fault: async stage => { if (stage === 'copied') put('外部新增.md', '# 外部变化'); } });
assert.equal((await run('create', { parent: DEST, vaultRoot: ROOT }, changed)).status, 'failed');
console.log('PASS 写入失败/取消/备份中外部修改不冒报完成，未完成目录不可恢复');
let queue = Promise.resolve(), unblock, copying;
const exclusive = job => { const result = queue.then(job); queue = result.catch(() => {}); return result; };
const copied = new Promise(resolve => copying = resolve), copyingGate = new Promise(resolve => unblock = resolve);
const live = createFullBackup({ home: HOME, getVault: () => ({ root: ROOT }), getSettings: () => settings, runExclusive: exclusive,
  fault: async stage => { if (stage === 'copied') { copying(); await copyingGate; } } });
const liveId = live.start('create', { parent: DEST, vaultRoot: ROOT }); await copied;
await Promise.race([exclusive(() => put('备份期间保存.md', '# 保存不阻塞')), new Promise((resolve, reject) => setTimeout(() => reject(Error('大文件复制阻塞了保存队列')), 1500))]);
unblock(); await live.wait(liveId); assert.equal(live.status(liveId).status, 'failed'); assert.equal(fs.readFileSync(path.join(ROOT, '备份期间保存.md'), 'utf8'), '# 保存不阻塞');
console.log('PASS 大文件复制期间写入队列仍可保存，变化被检测后备份拒绝提交');
fs.rmdirSync(path.join(backup, 'vault/空文件夹'));
assert.equal((await run('verify', { source: backup })).status, 'failed');
fs.mkdirSync(path.join(backup, 'vault/空文件夹'));
assert.equal((await run('restore', { source: backup, parent: path.join(HOME, 'history-v2') })).status, 'failed');
const metadataBefore = () => ['history-v2', 'history', 'trash'].map(name => [name, fs.readdirSync(path.join(HOME, name)).sort()]);
for (const cancel of [false, true]) {
  const before = metadataBefore(); let jobId;
  const partial = createFullBackup({ home: HOME, getVault: () => ({ root: ROOT }), getSettings: () => settings,
    fault: async stage => { if (stage === 'metadata-committed') { if (cancel) partial.cancel(jobId); else throw Error('injected metadata commit failure'); } } });
  jobId = partial.start('restore', { source: backup, parent: RESTORE }); await partial.wait(jobId);
  assert.equal(partial.status(jobId).status, cancel ? 'cancelled' : 'failed');
  assert.ok(fs.existsSync(partial.status(jobId).incomplete));
  assert.deepEqual(metadataBefore(), before);
  assert.equal(fs.readFileSync(path.join(ROOT, '正文.md'), 'utf8'), '# 备份后修改原件');
  assert.equal((await run('verify', { source: backup })).status, 'complete');
  await partial.close();
}
const addedMetadata = createFullBackup({ home: HOME, getVault: () => ({ root: ROOT }), getSettings: () => settings,
  fault: async stage => { if (stage === 'copied') history.snapshot(ROOT, '新增历史.md', '# 在备份期间新增'); } });
const changedMetadata = await run('create', { parent: DEST, vaultRoot: ROOT }, addedMetadata);
assert.equal(changedMetadata.status, 'failed'); assert.match(changedMetadata.error, /历史或回收站/);
// 排队期间取消/退出，不得继续扫描或创建未完成目录。
let scanCalls = 0, queued;
const waiting = createFullBackup({ home: HOME, getVault: () => { scanCalls++; return { root: ROOT }; }, getSettings: () => settings,
  runExclusive: job => new Promise((resolve, reject) => { queued = () => { void Promise.resolve().then(job).then(resolve, reject); }; }) });
const waitingId = waiting.start('create', { parent: DEST, vaultRoot: ROOT });
await new Promise(resolve => setImmediate(resolve)); const closing = waiting.close(); queued(); await closing;
assert.equal(waiting.status(waitingId).status, 'cancelled'); assert.equal(scanCalls, 0);
await addedMetadata.close();
console.log('PASS 空目录完整性、内部恢复路径拒绝、元数据部分提交失败/取消回滚、历史新增检测和排队退出取消');
await Promise.all([service.close(), faulting.close(), cancelling.close(), changed.close(), restoreFail.close(), live.close()]);
