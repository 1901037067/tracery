import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { planCleanup, applyCleanup } from '../scripts/clean.mjs';
import { createHistoryStore } from '../server/history-store.js';
import { createHistoryBackup } from '../server/history-backup.js';
const OUT = path.resolve('dist/maintenance-preview'); fs.mkdirSync(OUT, { recursive: true });
const TEMP = fs.mkdtempSync(path.join(OUT, 'fixture-'));
const repo = path.join(TEMP, 'repo'); fs.mkdirSync(repo);
for (let i = 1; i <= 12; i++) {
  const id = `202610${String(i).padStart(2, '0')}T000000-${i}`, dir = path.join(repo, 'dist/test-runs', id), work = path.join(dir, 'test/work');
  fs.mkdirSync(path.join(work, 'dist'), { recursive: true }); fs.writeFileSync(path.join(work, 'code.js'), '// disposable');
  fs.writeFileSync(path.join(work, 'dist/evidence.png'), 'evidence');
  fs.writeFileSync(path.join(dir, 'test/output.log'), 'log');
  fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify({ finishedAt: '2026-10-27', results: [{ id: 'test', status: i === 1 || i === 3 ? 'FAIL' : 'PASS' }] }));
  if (i === 4) fs.writeFileSync(path.join(dir, '.keep'), '人工保留');
  if (i === 3) fs.writeFileSync(path.join(dir, '.resolved'), '已定位并修复；报告日志与截图仍保留');
}
const release = path.join(repo, 'dist/release-1.12.0-final'); fs.mkdirSync(release); fs.writeFileSync(path.join(release, 'Tracery.exe'), 'release');
let plan = planCleanup(repo);
assert.ok(plan.retained.some(row => row.path.includes('20261001') && row.reasons.includes('首个失败记录')));
assert.ok(plan.retained.some(row => row.path.includes('20261004')));
assert.equal(plan.candidates.length, 5);
assert.ok(plan.candidates.every(row => fs.existsSync(row.path)), '预览不删除');
const unresolved = path.join(repo, 'dist/test-runs/20261002T000000-2/results.json');
const report = JSON.parse(fs.readFileSync(unresolved)); report.results.push({ id: 'pending', status: 'FAIL' }); fs.writeFileSync(unresolved, JSON.stringify(report));
assert.throws(() => applyCleanup(plan), /失效/, '保留状态变化时拒绝旧计划');
plan = planCleanup(repo); assert.ok(plan.retained.some(row => row.reasons.includes('尚未通过：pending')));
const candidate = plan.candidates[0].path, link = path.join(candidate, 'outside-link');
try {
  fs.symlinkSync(release, link, 'junction');
  assert.ok(planCleanup(repo).warnings.some(row => row.path === candidate));
  assert.throws(() => applyCleanup(plan), /失效/);
} catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; }
finally { if (fs.existsSync(link)) fs.unlinkSync(link); }
applyCleanup(plan);
for (const row of plan.candidates) {
  assert.ok(!fs.existsSync(row.path));
  assert.equal(fs.readFileSync(path.join(path.dirname(row.path), 'preserved-evidence/dist/evidence.png'), 'utf8'), 'evidence');
  assert.ok(fs.existsSync(path.join(path.dirname(row.path), 'output.log')));
}
assert.equal(fs.readFileSync(path.join(release, 'Tracery.exe'), 'utf8'), 'release');
assert.throws(() => applyCleanup({ ...plan, candidates: [{ path: release }] }), /失效/);
const home = path.join(TEMP, 'home'), root = path.join(TEMP, 'vault'), moved = path.join(TEMP, 'moved'), otherHome = path.join(TEMP, 'other-home');
for (const dir of [home, root, moved, otherHome]) fs.mkdirSync(dir);
for (const dir of [root, moved]) { fs.writeFileSync(path.join(dir, '笔记.md'), '\ufeff# 当前\r\n正文'); fs.writeFileSync(path.join(dir, '第二篇.md'), '第二篇'); }
const store = createHistoryStore(home), backup = createHistoryBackup(home, store);
store.snapshot(root, '笔记.md', '旧正文一'); store.snapshot(root, '笔记.md', '旧正文二'); store.snapshot(root, '第二篇.md', '第二篇旧正文');
const archive = backup.export(root); assert.equal(archive.notes.length, 2);
const target = createHistoryStore(otherHome), importer = createHistoryBackup(otherHome, target);
assert.throws(() => importer.import(moved, archive), /明确确认/);
const imported = importer.import(moved, archive, { allowRebind: true }); assert.equal(imported.added, 3);
assert.equal(importer.import(moved, archive, { allowRebind: true }).added, 0, '重复导入幂等');
assert.equal(target.read(moved, '笔记.md', target.list(moved, '笔记.md')[0].id), '旧正文二');
assert.equal(fs.readFileSync(path.join(moved, '笔记.md'), 'utf8'), '\ufeff# 当前\r\n正文');
fs.writeFileSync(path.join(moved, '第二篇.md'), '不同仓库的内容');
assert.equal(importer.import(moved, archive, { allowRebind: true }).skipped.length, 1);
const invalid = structuredClone(archive); invalid.notes[0].versions[0].content = '篡改';
assert.throws(() => importer.import(moved, invalid, { allowRebind: true }), /校验/);
const traversal = structuredClone(archive); traversal.notes[0].path = '../outside.md';
assert.throws(() => importer.import(moved, traversal, { allowRebind: true }), /路径/);
const privatePath = structuredClone(archive); privatePath.notes[0].path = '.tracery/sync.json';
assert.throws(() => importer.import(moved, privatePath, { allowRebind: true }), /内部/);
// 在第二篇触发冲突，第一篇本轮新加的版本也必须回滚。
const rollbackHome = path.join(TEMP, 'rollback-home'); fs.mkdirSync(rollbackHome);
const rollbackStore = createHistoryStore(rollbackHome), rollback = createHistoryBackup(rollbackHome, rollbackStore);
const sorted = structuredClone(archive); sorted.notes.sort((a, b) => a.path === '第二篇.md' ? 1 : b.path === '第二篇.md' ? -1 : 0);
const collision = sorted.notes[1].versions[0]; rollbackStore.importVersions(root, '第二篇.md', [{ time: collision.time, content: '不覆盖的已有历史' }]);
assert.throws(() => rollback.import(root, sorted), /冲突/);
assert.equal(rollbackStore.list(root, '笔记.md').length, 0);
assert.equal(rollbackStore.read(root, '第二篇.md', 'v2-' + collision.time), '不覆盖的已有历史');
const blockedHome = path.join(TEMP, 'blocked-home'); fs.mkdirSync(blockedHome); fs.writeFileSync(path.join(blockedHome, 'history-v2'), '不可写目录');
assert.throws(() => createHistoryBackup(blockedHome, createHistoryStore(blockedHome)).import(root, archive));
assert.equal(fs.readFileSync(path.join(root, '笔记.md'), 'utf8'), '\ufeff# 当前\r\n正文');
console.log('PASS 清理默认预览/保留/受控删除/证据保留，历史换机迁移/幂等/哈希/路径/冲突回滚/原文保留');
