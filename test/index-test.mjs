/* 真实临时文件：缓存不能改变正文、搜索排序、同名解析或增量更新的结果。耗时只记录，不设跨机器阈值。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Vault } from '../server/vault.js';
import { IndexCache, snapshotIndex } from '../server/index-cache.js';
const OUT = path.resolve('dist/index-preview');
fs.mkdirSync(OUT, { recursive: true });
const TEMP = fs.mkdtempSync(path.join(OUT, 'fixture-'));
const metrics = [];
let checks = 0;
const check = (name, ok) => { assert.ok(ok, name); checks++; console.log('PASS ' + name); };
const hash = text => createHash('sha256').update(text).digest('hex');
const measure = async job => { const start = performance.now(), value = await job(); return { value, ms: +(performance.now() - start).toFixed(2) }; };
const difference = (a, b) => Object.fromEntries(Object.keys(a).map(key => [key, +(a[key] - b[key]).toFixed(2)]));

// 保留改动前的线性搜索作为独立结果基准，包含所有排序/截断/上下文语义。
function referenceSearch(vault, q, limit = 50) {
  if (!q || limit <= 0) return [];
  const needle = q.toLowerCase(), results = [];
  for (const [rel, content] of vault.contentCache) {
    const name = vault.notes.get(rel)?.name || rel, nameHit = name.toLowerCase().includes(needle), matches = [];
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(needle)) matches.push({ line: i + 1, text: lines[i].trim().slice(0, 160) });
      if (matches.length >= 6) break;
    }
    if (nameHit || matches.length) results.push({ path: rel, name, nameHit, matches });
  }
  const rank = row => row.name.toLowerCase() === needle ? 2 : row.nameHit ? 1 : 0;
  return results.sort((a, b) => rank(b) - rank(a) || (vault.notes.get(b.path)?.mtimeMs || 0) - (vault.notes.get(a.path)?.mtimeMs || 0)
    || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).slice(0, limit);
}
function verifyQueries(vault, expected) {
  for (const q of ['中文', '中', '？', 'pha', 'ALPHA', '🚀', 'é', '不存在', '稀有标记9876', '案例-9999', '\n', '未解析0']) {
    assert.deepEqual(vault.search(q), referenceSearch(expected, q), q);
  }
}
function referenceUnresolved(vault, rel) {
  return [...new Set(vault.notes.get(rel).links)].filter(t => !vault.resolve(t, rel))
    .map(raw => ({ raw, sources: [...vault.notes.values()].filter(note => note.links.includes(raw)).map(note => note.name) }));
}
async function write(vault, rel, content) {
  fs.mkdirSync(path.dirname(path.join(vault.root, rel)), { recursive: true });
  fs.writeFileSync(path.join(vault.root, rel), content);
  await vault.applyChange(rel);
}
async function remove(vault, rel) { fs.unlinkSync(path.join(vault.root, rel)); await vault.applyChange(rel); }

for (const count of [1000, 10000]) {
  const root = path.join(TEMP, String(count)); fs.mkdirSync(root);
  const names = [], before = new Map();
  for (let i = 0; i < count; i++) {
    const rel = `分类${i % 20}/案例-${i}.md`;
    const content = `# 案例 ${i}\n[[未解析${i % 20}]] [[未解析${i % 20}]]\n${'验证中文片段与 English alphaBeta，标点？火箭🚀 é。\n'.repeat(35)}\n稀有标记${i}\n`;
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), content);
    names.push(rel); before.set(rel, hash(content));
  }
  const cold = new Vault(root), coldTime = await measure(() => cold.open());
  check(`${count} 篇冷开完整`, cold.notes.size === count && cold.stats.parsed === count);
  const warm = new Vault(root), warmTime = await measure(() => warm.open());
  check(`${count} 篇暖开不重读/解析正文`, warm.stats.reads === 0 && warm.stats.parsed === 0 && warm.stats.reused === count);
  verifyQueries(warm, cold); check(`${count} 篇暖开搜索与线性基准逐项一致`, true);
  for (const rel of names.slice(0, 30)) assert.deepEqual(warm.linksFor(rel).unresolved, referenceUnresolved(warm, rel));
  let visits = 0;
  const values = warm.notes.values.bind(warm.notes);
  warm.notes.values = function* () { for (const note of values()) { visits++; yield note; } };
  warm.linksFor(names[0]);
  check(`${count} 篇未解析查询不遍历全部笔记`, visits === 0);
  delete warm.notes.values;
  let bodies = 0;
  const iterator = warm.contentCache[Symbol.iterator].bind(warm.contentCache);
  warm.contentCache[Symbol.iterator] = function* () { for (const row of iterator()) { bodies++; yield row; } };
  const empty = warm.drawings(); assert.deepEqual(empty, { drawings: [] }); assert.equal(warm.drawings(), empty);
  check(`${count} 篇无绘图不扫描正文`, bodies === 0);
  delete warm.contentCache[Symbol.iterator];
  const beforeStats = { ...warm.cache.stats };
  const resolutionIndex = warm._linkIndex;
  const content = fs.readFileSync(path.join(root, names[0]), 'utf8').replace('未解析0', '改变目标');
  await write(warm, names[0], content); before.set(names[0], hash(content));
  check(`${count} 篇正文编辑不重建全库名称解析表`, warm._linkIndex === resolutionIndex);
  const incremental = await measure(() => warm.persist()), delta = difference(warm.cache.stats, beforeStats);
  check(`${count} 篇单篇修改只写一个分片和清单`, delta.fileWrites === 2);
  check(`${count} 篇原始目标反向表随编辑更新`, warm._rawSources.get('改变目标').has(names[0]) && warm._rawSources.get('未解析0').has(names[0]));
  assert.deepEqual(warm.linksFor(names[0]).unresolved, referenceUnresolved(warm, names[0]));
  const v1 = JSON.stringify({ version: 1, root, notes: snapshotIndex(warm) });
  const fullTime = await measure(async () => {
    const text = JSON.stringify({ version: 1, root, notes: snapshotIndex(warm) });
    await fsp.writeFile(path.join(root, '.tracery/baseline.tmp'), text);
    await fsp.rename(path.join(root, '.tracery/baseline.tmp'), path.join(root, '.tracery/baseline.json'));
  });
  check(`${count} 篇增量写入字节显著低于全量`, delta.bytesWritten < Buffer.byteLength(v1) / 10);
  const noChange = { ...warm.cache.stats }; await warm.persist();
  check(`${count} 篇未变快照不重写缓存文件`, warm.cache.stats.fileWrites === noChange.fileWrites);
  const reopened = new Vault(root); await reopened.open();
  check(`${count} 篇增量写入后仍全部暖开`, reopened.stats.reused === count);
  verifyQueries(reopened, warm);
  const indexPath = path.join(root, '.tracery/index.json'), manifest = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const victim = manifest.shards[0], shardFile = path.join(root, `.tracery/index-${String(victim.id).padStart(2, '0')}.json`);
  fs.writeFileSync(shardFile, '{broken');
  const damaged = new Vault(root); await damaged.open();
  check(`${count} 篇损坏一片只重建该片`, damaged.stats.parsed === victim.count && damaged.stats.reused === count - victim.count);
  verifyQueries(damaged, warm);
  for (const [rel, digest] of before) assert.equal(hash(fs.readFileSync(path.join(root, rel))), digest, rel);
  check(`${count} 篇缓存/搜索不修改原始文件`, true);
  metrics.push({ count, coldMs: coldTime.ms, warmMs: warmTime.ms, fullWriteMs: fullTime.ms, fullBytes: Buffer.byteLength(v1), incrementalMs: incremental.ms, incremental: delta });
  // 后续只需一个小库验证结构变更，不再保留大库派生对象。
}

const root = path.join(TEMP, 'changes'); fs.mkdirSync(root);
const v = new Vault(root); await v.open();
await write(v, 'a/同名.md', '[[缺失]] [[唯一]]'); await write(v, 'b/同名.md', '[[缺失]]');
check('来源按路径区分同名笔记', v._rawSources.get('缺失').size === 2 && v.linksFor('a/同名.md').unresolved[0].sources.length === 2);
await write(v, '目标/唯一.md', '# 唯一');
check('新增目标重新消歧', !v.linksFor('a/同名.md').unresolved.some(row => row.raw === '唯一'));
await write(v, '重复/唯一.md', '# 重复');
check('新增同名目标重新变为未解析', v.linksFor('a/同名.md').unresolved.some(row => row.raw === '唯一'));
await remove(v, '重复/唯一.md');
check('删除同名目标恢复解析', v.resolve('唯一', 'a/同名.md') === '目标/唯一.md');
await write(v, 'a/同名.md', '[[改变]] [[唯一]]');
check('编辑只清理该来源旧链接', v._rawSources.get('缺失').size === 1 && v._rawSources.get('缺失').has('b/同名.md'));
fs.renameSync(path.join(root, 'b/同名.md'), path.join(root, 'b/改名.md'));
await v.applyChanges(['b/同名.md', 'b/改名.md']);
check('同步式删除/新增批次清除旧来源路径', !v._rawSources.get('缺失').has('b/同名.md') && v._rawSources.get('缺失').has('b/改名.md'));
fs.renameSync(path.join(root, 'b'), path.join(root, '新目录')); await v.applyChange('b');
check('目录改名原子重建来源路径', v._rawSources.get('缺失').has('新目录/改名.md') && !v._rawSources.get('缺失').has('b/改名.md'));
await write(v, '画图.draw.json', '{}'); await write(v, '画图.png', 'fake image');
await write(v, '图片引用.md', '![[画图.png|300]]\n![](画图.png)');
let drawings = v.drawings(); assert.equal(drawings.drawings.length, 1); assert.deepEqual(drawings.drawings[0].notes, ['图片引用.md']);
check('绘图库首次计算后复用相同变更代', v.drawings() === drawings);
await write(v, '图片引用.md', '```md\n![[画图.png]]\n```\n`![[画图.png]]`');
check('修改引用使缓存失效，代码示例不算引用', !v.drawings().drawings[0].inserted);
await write(v, '图片引用.md', '![](画图.png)'); check('增加 Markdown 引用更新绘图库', v.drawings().drawings[0].inserted);
await remove(v, '画图.png'); check('删除配图使缓存失效', v.drawings().drawings.length === 0);
await write(v, '画图.png', 'new image'); await remove(v, '画图.draw.json'); check('删除旁车使缓存失效', v.drawings().drawings.length === 0);

await v.persist();
let release, entered;
const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
const originalWrite = v.cache.write.bind(v.cache), snapshots = [];
v.cache.write = async rows => { snapshots.push(new Map(rows)); if (snapshots.length === 1) { entered(); await gate; } return originalWrite(rows); };
const first = v.persist(); await started;
const pending = [];
for (let i = 0; i < 12; i++) { await write(v, '队列.md', '# 最新正文 ' + i); pending.push(v.persist()); }
release(); assert.ok((await Promise.all([first, ...pending])).every(Boolean));
check('慢写期间多个请求只保留初始和最新快照', snapshots.length === 2 && snapshots[1].get('队列.md').content === '# 最新正文 11');
const queued = new Vault(root); await queued.open();
check('等待保存返回后重启得到最新正文', queued.stats.parsed === 0 && queued.contentCache.get('队列.md') === '# 最新正文 11');
const burstBefore = v.cache.stats.flushes; await Promise.all(Array.from({ length: 20 }, () => v.persist()));
check('同轮请求合并为一次持久化', v.cache.stats.flushes === burstBefore + 1);
v.cache.write = originalWrite;
const indexPath = path.join(root, '.tracery/index.json');
fs.writeFileSync(indexPath, JSON.stringify({ version: 1, root, notes: snapshotIndex(v) }));
const old = new Vault(root); await old.open(); check('旧格式自动重建', old.stats.parsed === v.notes.size);
fs.writeFileSync(indexPath, '{bad manifest'); const broken = new Vault(root); await broken.open();
check('清单损坏完整重建且查询保留', broken.stats.parsed === v.notes.size && broken.search('最新正文').length === 1);
const unwritable = path.join(TEMP, 'readonly'); fs.mkdirSync(path.join(unwritable, '.tracery/index.json'), { recursive: true }); fs.writeFileSync(path.join(unwritable, '笔记.md'), '正文');
const fallback = new Vault(unwritable); await fallback.open();
check('缓存写失败不阻断打开和搜索', fallback.notes.size === 1 && fallback.search('正文').length === 1 && await fallback.persist() === false);
await write(broken, '队列.md', '# 清单提交前退出');
const atomic = broken.cache._atomic.bind(broken.cache);
broken.cache._atomic = async (name, text) => { if (name === 'index.json') throw new Error('模拟提交中断'); return atomic(name, text); };
check('分片写完但清单失败返回失败', await broken.persist() === false);
const interrupted = new Vault(root); await interrupted.open();
check('未提交分片经哈希校验回退真实正文', interrupted.contentCache.get('队列.md') === '# 清单提交前退出' && interrupted.stats.parsed > 0);
broken.cache._atomic = atomic;
check('失败后下一次持久化可恢复', await broken.persist());
const cache = new IndexCache(root), rows = snapshotIndex(v);
const concurrent = new IndexCache(root); await Promise.all([cache.write(rows), concurrent.write(rows)]);
const final = new Vault(root); await final.open(); check('过期并行缓存不能覆盖真实笔记正文', final.contentCache.get('队列.md') === '# 清单提交前退出');
const thresholdRoot = path.join(TEMP, 'thresholds'); fs.mkdirSync(thresholdRoot);
const adaptive = new IndexCache(thresholdRoot);
for (const size of [10, 500, 4500, 100, 0]) {
  const rows = Array.from({ length: size }, (_, i) => [`模拟${i}.md`, { name: '模拟' + i, content: '原始缓存 ' + i, links: [], tags: [], headings: [] }]);
  assert.ok(await adaptive.write(rows));
  const recovered = await new IndexCache(thresholdRoot).read();
  assert.deepEqual([...recovered].sort(), [...rows].sort());
  const files = fs.readdirSync(path.join(thresholdRoot, '.tracery'));
  assert.equal(files.length, adaptive.shards.size + 1);
}
check('大小库跨阈值重分片及清空不留旧正文分片', true);
fs.writeFileSync(path.join(OUT, 'metrics.json'), JSON.stringify(metrics, null, 2));
console.log(JSON.stringify(metrics));
console.log(`${checks}/${checks} 通过`);
