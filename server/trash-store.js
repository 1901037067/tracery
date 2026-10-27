/* 每项先落恢复元数据，再移动文件，最后提交索引；索引损坏或写失败仍可由元数据列出。
 * 跨盘先完整复制到暂存，再公布目标，最后删除原件；中断可能留下副本，不会隐藏唯一原件。 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { readJson, writeJson } from './durable-json.js';
import { resolveUserPath } from './user-path.js';

export function createTrashStore(home) {
  let queue = Promise.resolve();
  const serial = job => { const result = queue.then(job); queue = result.catch(() => {}); return result; };
  const dirFor = root => path.join(home, 'trash', crypto.createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 12));
  const valid = item => item && /^\d+-[a-f0-9]+$/.test(item.id) && typeof item.name === 'string' && item.name === path.basename(item.name)
    && !/[\\/]/.test(item.name) && typeof item.path === 'string';
  const payload = (dir, item) => path.join(dir, `${item.id}__${item.name}`);
  const meta = (dir, item) => path.join(dir, `${item.id}.entry.json`);
  function list(root) {
    const dir = dirFor(root), index = path.join(dir, 'index.json');
    const rows = readJson(index, [], { validate: value => Array.isArray(value) && value.every(valid) });
    const found = new Map(rows.map(item => [item.id, item]));
    let names;
    try { names = fs.readdirSync(dir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    for (const name of names.filter(name => /^\d+-[a-f0-9]+\.entry\.json$/.test(name))) {
      const item = readJson(path.join(dir, name), null, { validate: valid });
      if (item) found.set(item.id, item);
    }
    // 兼容旧流程中已搬走、但从未登记索引的文件；无法推断旧目录时明确恢复到根目录。
    for (const name of names) {
      const match = /^(\d+-[a-f0-9]+)__(.+)$/.exec(name);
      if (!match || found.has(match[1])) continue;
      const item = { id: match[1], name: match[2], path: match[2], deletedAt: Number(match[1].split('-')[0]), originalPathUnknown: true };
      if (valid(item)) found.set(item.id, item);
    }
    return [...found.values()].filter(item => { resolveUserPath(root, item.path); return fs.existsSync(payload(dir, item)); })
      .sort((a, b) => b.deletedAt - a.deletedAt);
  }
  const commit = (dir, items) => writeJson(path.join(dir, 'index.json'), items);
  async function inventory(root) {
    const rows = [];
    async function walk(file, rel) {
      const stat = await fsp.lstat(file);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw Error('跨盘回收不支持链接或特殊文件，原件保留');
      rows.push({ path: rel, directory: stat.isDirectory(), size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs });
      if (stat.isDirectory()) for (const name of (await fsp.readdir(file)).sort()) await walk(path.join(file, name), rel ? rel + '/' + name : name);
    }
    await walk(root, ''); return rows;
  }
  async function hash(file) {
    const digest = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
    return digest.digest('hex');
  }
  async function transfer(src, dest) {
    try { await fsp.rename(src, dest); }
    catch (error) {
      if (error.code !== 'EXDEV') throw error;
      const partial = path.join(path.dirname(dest), `.copy-${crypto.randomUUID()}.partial`);
      try {
        const before = await inventory(src);
        await fsp.cp(src, partial, { recursive: true, errorOnExist: true, force: false });
        const copied = await inventory(partial);
        const shape = rows => rows.map(row => ({ path: row.path, directory: row.directory, size: row.directory ? 0 : row.size }));
        if (JSON.stringify(shape(before)) !== JSON.stringify(shape(copied))) throw Error('跨盘副本目录或文件大小不完整，原件保留');
        for (const row of before.filter(row => !row.directory)) {
          const target = path.join(partial, row.path), handle = await fsp.open(target, 'r+');
          try { await handle.sync(); } finally { await handle.close(); }
          if (await hash(path.join(src, row.path)) !== await hash(target)) throw Error('跨盘副本内容校验失败，原件保留');
        }
        if (JSON.stringify(before) !== JSON.stringify(await inventory(src))) throw Error('跨盘复制期间原件发生变化，原件保留');
        await fsp.rename(partial, dest);
        if (JSON.stringify(before) !== JSON.stringify(await inventory(src))) throw Error('跨盘提交期间原件发生变化，原件和副本均保留');
      } finally { await fsp.rm(partial, { recursive: true, force: true }).catch(() => {}); }
      await fsp.rm(src, { recursive: true });
    }
  }
  async function remove(dir, item) {
    await fsp.rm(payload(dir, item), { recursive: true, force: true });
    await fsp.rm(meta(dir, item), { force: true });
    await fsp.rm(`${meta(dir, item)}.bak`, { force: true });
  }
  return {
    dirFor, list,
    move: (root, rel, abs) => serial(async () => {
      const dir = dirFor(root); fs.mkdirSync(dir, { recursive: true });
      const items = list(root);
      const item = { id: `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`, name: path.basename(abs),
        path: rel.replace(/\\/g, '/'), deletedAt: Date.now(), size: (await fsp.stat(abs)).size };
      writeJson(meta(dir, item), item);
      await transfer(abs, payload(dir, item));
      // 先提交完整索引；提交失败时元数据仍能找回刚移动的项目，不执行清理。
      items.unshift(item); commit(dir, items);
      for (const drop of items.slice(200)) await remove(dir, drop);
      if (items.length > 200) commit(dir, items.slice(0, 200));
    }),
    restore: (root, id) => serial(async () => {
      const dir = dirFor(root), items = list(root), item = items.find(row => row.id === id);
      if (!item) return null;
      const dest = resolveUserPath(root, item.path); let target = dest, n = 1;
      while (fs.existsSync(target)) { const ext = path.extname(dest); target = `${dest.slice(0, dest.length - ext.length)} (${n++})${ext}`; }
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await transfer(payload(dir, item), target);
      await fsp.rm(meta(dir, item), { force: true });
      commit(dir, items.filter(row => row.id !== id));
      return path.relative(root, target).replace(/\\/g, '/');
    }),
    purge: (root, id) => serial(async () => {
      const dir = dirFor(root), items = list(root), item = items.find(row => row.id === id);
      if (item) await remove(dir, item);
      commit(dir, items.filter(row => row.id !== id));
    }),
    empty: root => serial(async () => { const dir = dirFor(root); for (const item of list(root)) await remove(dir, item); commit(dir, []); }),
    drain: () => queue,
  };
}
