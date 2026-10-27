/* 流式目录备份：清单最后提交，恢复只写新目录；每个文件均验证大小与 SHA-256。 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { vaultFiles } from './vault-files.js';
import { resolveInDirectory, isWithin } from './path-guard.js';
import { resolveUserPath } from './user-path.js';
import { publicSettings } from './public-settings.js';
import { safeClientState } from '../public/js/workspace-backup.js';
const digest = (value, algorithm = 'sha256') => createHash(algorithm).update(value).digest('hex');
const fail = message => Object.assign(Error(message), { status: 400 });
const checked = (root, rel) => resolveInDirectory(root, rel);
async function writeSynced(file, text, flags = 'wx') {
  const handle = await fsp.open(file, flags, 0o600);
  try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
}
async function regular(root, rel) {
  const file = checked(root, rel), parts = rel.split('/'); let cursor = root;
  for (const part of parts) { cursor = path.join(cursor, part); if ((await fsp.lstat(cursor)).isSymbolicLink()) throw fail('备份中不允许符号链接'); }
  if (!(await fsp.stat(file)).isFile()) throw fail('备份文件类型无效');
  return file;
}
async function hashFile(file, signal) {
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of fs.createReadStream(file, { signal })) { hash.update(chunk); bytes += chunk.length; }
  return { hash: hash.digest('hex'), size: bytes };
}
async function copyFile(from, to, signal) {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  const before = await fsp.stat(from), hash = createHash('sha256'); let size = 0;
  const meter = new Transform({ transform(chunk, encoding, callback) { hash.update(chunk); size += chunk.length; callback(null, chunk); } });
  await pipeline(fs.createReadStream(from), meter, fs.createWriteStream(to, { flags: 'wx', mode: 0o600 }), { signal });
  const handle = await fsp.open(to, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
  const after = await fsp.stat(from);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || size !== before.size) throw fail('源文件在备份时发生变化，请重试');
  const result = { size, hash: hash.digest('hex'), mtimeMs: before.mtimeMs };
  const readback = await hashFile(to, signal);
  if (readback.size !== size || readback.hash !== result.hash) throw fail('备份落盘后的内容校验失败');
  await fsp.utimes(to, before.atime, before.mtime);
  return result;
}
async function rawTree(root, prefix, output, directories) {
  let entries; try { if ((await fsp.lstat(root)).isSymbolicLink()) throw fail('备份内容不允许链接'); entries = await fsp.readdir(root, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  directories.push(prefix);
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw fail('历史或回收站包含符号链接，未生成备份');
    const rel = prefix + '/' + entry.name, file = path.join(root, entry.name);
    if (entry.isDirectory()) await rawTree(file, rel, output, directories);
    else if (entry.isFile()) output.push({ source: file, path: rel, stat: await fsp.stat(file) });
  }
}
async function newLocation(parent, name) {
  if (typeof parent !== 'string' || !path.isAbsolute(parent)) throw fail('请选择绝对路径的文件夹');
  const base = await fsp.realpath(parent); if (!(await fsp.stat(base)).isDirectory()) throw fail('请选择文件夹');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const final = path.join(base, `${name}-${stamp}-${randomUUID().slice(0, 8)}`), staging = final + '.incomplete';
  return { final, staging };
}
async function readManifest(root, home) {
  if ((await fsp.lstat(root)).isSymbolicLink()) throw fail('请选择真实的备份文件夹');
  const file = await regular(root, 'manifest.json');
  if ((await fsp.stat(file)).size > 32 * 1024 * 1024) throw fail('备份清单超过 32 MiB');
  const checksum = await regular(root, 'manifest.sha256'); if ((await fsp.stat(checksum)).size > 128) throw fail('备份校验文件无效');
  const text = await fsp.readFile(file, 'utf8'), expected = (await fsp.readFile(checksum, 'utf8')).trim();
  if (digest(text) !== expected) throw fail('备份清单校验失败');
  const manifest = JSON.parse(text);
  if (manifest.format !== 'tracery-vault-backup' || manifest.version !== 1 || !Array.isArray(manifest.files) || !Array.isArray(manifest.directories)
    || typeof manifest.sourceRoot !== 'string' || manifest.files.length > 200000 || manifest.directories.length > 200000) throw fail('不支持的完整备份格式');
  const seen = new Set();
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== 'string' || !/^(vault|history-v2|history|trash)\//.test(entry.path) || seen.has(entry.path.toLowerCase())
      || !Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/.test(entry.hash)) throw fail('备份条目无效或路径重复');
    checked(root, entry.path); seen.add(entry.path.toLowerCase());
    if (entry.path.startsWith('vault/')) resolveUserPath(path.join(root, 'vault'), entry.path.slice(6), home);
  }
  for (const rel of manifest.directories) { if (typeof rel !== 'string' || !/^(vault|history-v2|history|trash)(\/|$)/.test(rel)) throw fail('备份目录条目无效'); checked(root, rel); }
  safeClientState(manifest.clientState); manifest.settings = publicSettings(manifest.settings || {});
  return manifest;
}
export function createFullBackup({ home, getVault, getSettings, runExclusive = job => job(), fault = async () => {} }) {
  home = path.resolve(home);
  const jobs = new Map();
  const update = (job, phase, detail = {}) => Object.assign(job, { phase, ...detail });
  async function validate(source, job, allowIncomplete = false) {
    if (!allowIncomplete && source.endsWith('.incomplete')) throw fail('该备份尚未完成，不能用于恢复');
    const manifest = await readManifest(source, home), rows = [], dirs = [];
    for (const prefix of ['vault', 'history-v2', 'history', 'trash']) await rawTree(path.join(source, prefix), prefix, rows, dirs);
    const expected = new Set(manifest.files.map(row => row.path));
    if (rows.length !== expected.size || rows.some(row => !expected.has(row.path))) throw fail('备份中出现未登记文件或缺失文件');
    const expectedDirs = new Set(manifest.directories);
    if (expectedDirs.size !== manifest.directories.length || dirs.length !== expectedDirs.size || dirs.some(rel => !expectedDirs.has(rel))) throw fail('备份中出现未登记目录或缺失目录');
    update(job, '正在校验备份', { total: manifest.files.length, completed: 0, bytes: 0 });
    for (const entry of manifest.files) {
      job.controller.signal.throwIfAborted();
      const result = await hashFile(await regular(source, entry.path), job.controller.signal);
      if (result.hash !== entry.hash || result.size !== entry.size) throw fail(`文件校验失败：${entry.path}`);
      job.completed++; job.bytes += result.size;
    }
    // 历史身份必须与原仓库一致；恢复时只改这份副本的 root。
    for (const entry of manifest.files.filter(row => /^history-v2\/[^/]+\/identity\.json$/.test(row.path))) {
      if (entry.size > 16384) throw fail('历史身份文件过大');
      const identity = JSON.parse(await fsp.readFile(checked(source, entry.path), 'utf8'));
      if (identity.version !== 2 || identity.root !== manifest.sourceRoot || typeof identity.path !== 'string' || digest(identity.path) !== entry.path.split('/')[1]) throw fail('备份历史身份无效');
      resolveUserPath(path.join(source, 'vault'), identity.path, home);
    }
    return manifest;
  }
  async function create(options, job) {
    const snapshot = await runExclusive(async () => {
      job.controller.signal.throwIfAborted();
      const vault = getVault(); if (options.vaultRoot !== vault.root) throw fail('仓库已切换，请重新备份');
      update(job, '正在扫描仓库');
      const inventory = await vaultFiles(vault.root, home, { strictLinks: true }), rows = inventory.files.map(file => ({ path: 'vault/' + file.path, source: checked(vault.root, file.path), stat: file }));
      const directories = ['vault', ...inventory.directories.map(rel => 'vault/' + rel)];
      await rawTree(checked(home, 'history-v2/' + digest(vault.root)), 'history-v2', rows, directories);
      await rawTree(checked(home, 'history/' + digest(vault.root, 'sha1').slice(0, 12)), 'history', rows, directories);
      await rawTree(checked(home, 'trash/' + digest(vault.root, 'sha1').slice(0, 12)), 'trash', rows, directories);
      return { vault, inventory, rows, directories, settings: publicSettings(getSettings()) };
    });
    const { vault, inventory, rows, directories, settings } = snapshot;
    job.controller.signal.throwIfAborted();
    const location = await newLocation(options.parent, 'Tracery-backup');
    if (isWithin(vault.root, location.final) || ['history', 'history-v2', 'trash'].some(name => isWithin(path.join(home, name), location.final))) throw fail('备份不能放在当前仓库、历史或回收站内部');
    if (rows.length > 200000 || directories.length > 200000) throw fail('完整备份最多支持 20 万文件及 20 万目录');
    const manifest = { format: 'tracery-vault-backup', version: 1, createdAt: new Date().toISOString(), sourceRoot: vault.root,
      settings, clientState: safeClientState(options.clientState), directories, files: [],
      excluded: ['同步凭据', '索引缓存', '.git', 'node_modules', '.local', '未保存草稿'] };
    await fsp.mkdir(location.staging); job.incomplete = location.staging;
    for (const rel of directories) await fsp.mkdir(checked(location.staging, rel), { recursive: true });
    update(job, '正在复制并回读校验', { total: rows.length, completed: 0, bytes: 0 });
    for (const row of rows) {
      job.controller.signal.throwIfAborted();
      const result = await copyFile(row.source, checked(location.staging, row.path), job.controller.signal);
      manifest.files.push({ path: row.path, ...result }); job.completed++; job.bytes += result.size;
      await fault('copied', job.completed);
    }
    if (JSON.stringify(await vaultFiles(vault.root, home, { strictLinks: true })) !== JSON.stringify(inventory)) throw fail('仓库在备份过程中发生变化，未完成提交');
    for (const row of rows) { const current = await fsp.stat(row.source); if (current.size !== row.stat.size || current.mtimeMs !== row.stat.mtimeMs || current.ctimeMs !== row.stat.ctimeMs) throw fail('源历史或文件在备份中发生变化，未完成提交'); }
    const metadataRows = [], metadataDirs = [];
    for (const [prefix, hash] of [['history-v2', digest(vault.root)], ['history', digest(vault.root, 'sha1').slice(0, 12)], ['trash', digest(vault.root, 'sha1').slice(0, 12)]]) await rawTree(checked(home, prefix + '/' + hash), prefix, metadataRows, metadataDirs);
    if (JSON.stringify(metadataRows.map(row => row.path).sort()) !== JSON.stringify(rows.filter(row => !row.path.startsWith('vault/')).map(row => row.path).sort())
      || JSON.stringify(metadataDirs.sort()) !== JSON.stringify(directories.filter(rel => !/^vault(?:\/|$)/.test(rel)).sort())) throw fail('历史或回收站在备份过程中发生变化，未完成提交');
    const text = JSON.stringify(manifest, null, 2);
    if (Buffer.byteLength(text) > 32 * 1024 * 1024) throw fail('备份清单超过 32 MiB');
    await writeSynced(path.join(location.staging, 'manifest.json'), text);
    await writeSynced(path.join(location.staging, 'manifest.sha256'), digest(text) + '\n');
    await validate(location.staging, job, true);
    job.controller.signal.throwIfAborted(); await fsp.rename(location.staging, location.final); delete job.incomplete;
    return { path: location.final, sourceName: path.basename(vault.root), files: rows.length, verified: true };
  }
  async function restore(options, job) {
    const source = await fsp.realpath(options.source), manifest = await validate(source, job);
    const location = await newLocation(options.parent, 'Tracery-restored');
    if (isWithin(source, location.final) || isWithin(getVault().root, location.final)
      || ['history', 'history-v2', 'trash'].some(name => isWithin(path.join(home, name), location.final))) throw fail('恢复位置不能位于备份、当前仓库、历史或回收站内部');
    job.controller.signal.throwIfAborted();
    await fsp.mkdir(location.staging); job.incomplete = location.staging;
    const metadata = [], counts = { completed: 0, total: manifest.files.length, bytes: 0 };
    update(job, '正在恢复到新文件夹', counts);
    for (const rel of manifest.directories.filter(rel => rel.startsWith('vault/'))) await fsp.mkdir(checked(location.staging, rel.slice(6)), { recursive: true });
    for (const entry of manifest.files) {
      job.controller.signal.throwIfAborted();
      if (!entry.path.startsWith('vault/')) { metadata.push(entry); continue; }
      const result = await copyFile(await regular(source, entry.path), checked(location.staging, entry.path.slice(6)), job.controller.signal);
      if (result.hash !== entry.hash || result.size !== entry.size) throw fail('恢复复制期间备份被修改');
      job.completed++; job.bytes += result.size;
    }
    const stagedHistory = [];
    try {
      for (const prefix of ['history-v2', 'history', 'trash']) {
        const entries = metadata.filter(row => row.path.startsWith(prefix + '/')); if (!entries.length) continue;
        const hash = prefix === 'history-v2' ? digest(location.final) : digest(location.final, 'sha1').slice(0, 12);
        const base = checked(home, prefix); await fsp.mkdir(base, { recursive: true });
        const staging = checked(home, prefix + '/.restore-' + randomUUID()), destination = checked(home, prefix + '/' + hash);
        if (fs.existsSync(destination)) throw fail('恢复历史目标已存在，未覆盖');
        await fsp.mkdir(staging); stagedHistory.push({ staging, destination, committed: false });
        for (const entry of entries) {
          const rel = entry.path.slice(prefix.length + 1), target = checked(staging, rel);
          const result = await copyFile(await regular(source, entry.path), target, job.controller.signal);
          if (result.hash !== entry.hash) throw fail('恢复元数据复制校验失败');
          if (prefix === 'history-v2' && /\/identity\.json$/.test(entry.path)) {
            const identity = JSON.parse(await fsp.readFile(target, 'utf8')); identity.root = location.final;
            await writeSynced(target, JSON.stringify(identity), 'w');
          }
          job.completed++; job.bytes += result.size;
        }
      }
      await fault('restored'); job.controller.signal.throwIfAborted();
      for (const [i, row] of stagedHistory.entries()) {
        job.controller.signal.throwIfAborted();
        await fsp.rename(row.staging, row.destination); row.committed = true;
        await fault('metadata-committed', i);
      }
      job.controller.signal.throwIfAborted();
      await fsp.rename(location.staging, location.final); delete job.incomplete;
      return { path: location.final, verified: true, files: manifest.files.length, settings: manifest.settings, clientState: safeClientState(manifest.clientState) };
    } catch (error) {
      // 只回收本轮创建的历史副本，原库和备份始终保留。
      for (const row of stagedHistory) await fsp.rm(row.committed ? row.destination : row.staging, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }
  function start(kind, options) {
    if (!['create', 'verify', 'restore'].includes(kind)) throw fail('未知备份操作');
    if ([...jobs.values()].some(job => job.status === 'running')) throw fail('已有完整备份任务正在运行，请等待完成或取消');
    const id = randomUUID(), job = { id, kind, status: 'running', phase: '等待当前写入完成', completed: 0, total: 0, bytes: 0, controller: new AbortController() };
    jobs.set(id, job);
    job.promise = Promise.resolve().then(async () => {
      job.controller.signal.throwIfAborted();
      return kind === 'create' ? create(options, job) : kind === 'restore' ? restore(options, job) : validate(await fsp.realpath(options.source), job).then(manifest => ({ verified: true, files: manifest.files.length }));
    }).then(result => { job.status = 'complete'; job.result = result; job.phase = '完成'; }, error => { job.status = job.controller.signal.aborted ? 'cancelled' : 'failed'; job.error = error.message; job.phase = job.status === 'cancelled' ? '已取消' : '未完成'; });
    for (const [key, old] of jobs) if (jobs.size > 10 && old.status !== 'running') jobs.delete(key);
    return id;
  }
  return { start,
    status(id) { const job = jobs.get(id); if (!job) throw fail('任务不存在'); const { controller, promise, ...status } = job; return status; },
    cancel(id) { const job = jobs.get(id); if (!job) throw fail('任务不存在'); job.controller.abort(); },
    async close() { for (const job of jobs.values()) if (job.status === 'running') job.controller.abort(); await Promise.all([...jobs.values()].map(job => job.promise)); },
    wait(id) { return jobs.get(id)?.promise; },
  };
}
