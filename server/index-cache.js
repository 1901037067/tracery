/* 可丢弃的派生缓存：固定分片限制文件数，只重写变化分片；正文仍在内存中供同步查询。 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveInDirectory } from './path-guard.js';
const VERSION = 2, SHARDS = 64;
export const sameStat = (a, b) => !!a && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.size === b.size;
export const fileStat = (st) => ({ mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, birthtimeMs: st.birthtimeMs, size: st.size });
const digest = text => createHash('sha256').update(text).digest('hex');
function shardFor(rel, count) {
  let hash = 2166136261;
  for (let i = 0; i < rel.length; i++) hash = Math.imul(hash ^ rel.charCodeAt(i), 16777619);
  return (hash >>> 0) % count;
}
const shardName = id => `index-${String(id).padStart(2, '0')}.json`;
function validRow(row, id, count) {
  if (!Array.isArray(row) || row.length !== 2) return false;
  const [rel, e] = row;
  return typeof rel === 'string' && shardFor(rel, count) === id && e && typeof e.content === 'string' && typeof e.name === 'string'
    && Array.isArray(e.links) && e.links.every(s => typeof s === 'string')
    && Array.isArray(e.tags) && e.tags.every(s => typeof s === 'string') && Array.isArray(e.headings);
}
function unchanged(previous, rows) {
  if (!previous || previous.size !== rows.size) return false;
  for (const [rel, e] of rows) {
    const old = previous.get(rel);
    if (!sameStat(old, e) || old.birthtimeMs !== e.birthtimeMs || old.content !== e.content || old.name !== e.name
      || old.links.length !== e.links.length || old.links.some((link, index) => link !== e.links[index])) return false;
  }
  return true;
}
export function snapshotIndex(vault) {
  return [...vault.notes].map(([rel, note]) => [rel, { ...vault.files.get(rel), name: note.name,
    links: note.links, tags: [...note.tags], headings: note.headings, content: vault.contentCache.get(rel) }]);
}
export class IndexCache {
  constructor(root) {
    this.root = root;
    this.shards = new Map();
    this.shardCount = 1;
    this.manifestValid = false;
    this.stats = { flushes: 0, fileWrites: 0, bytesWritten: 0, serializedBytes: 0, serializeMs: 0, writeMs: 0, failures: 0 };
  }
  _file(name) { return resolveInDirectory(this.root, `.tracery/${name}`); }
  async read() {
    this.shards.clear();
    this.manifestValid = false;
    this.readReason = 'invalid-manifest';
    try {
      const data = JSON.parse(await fsp.readFile(this._file('index.json'), 'utf8'));
      if (data.version !== VERSION || data.root !== this.root || ![1, 16, SHARDS].includes(data.shardCount)
        || !Array.isArray(data.shards) || data.shards.length > data.shardCount) return new Map();
      const ids = new Set();
      for (const entry of data.shards) {
        if (!entry || !Number.isInteger(entry.id) || entry.id < 0 || entry.id >= data.shardCount || ids.has(entry.id)
          || !/^[a-f0-9]{64}$/.test(entry.hash) || !Number.isInteger(entry.count) || entry.count < 1) return new Map();
        ids.add(entry.id);
      }
      const loaded = await Promise.all(data.shards.map(async ({ id, hash, count }) => {
        try {
          const text = await fsp.readFile(this._file(shardName(id)), 'utf8');
          if (digest(text) !== hash) return null;
          const rows = JSON.parse(text);
          if (!Array.isArray(rows) || rows.length !== count || !rows.every(row => validRow(row, id, data.shardCount))) return null;
          const notes = new Map(rows);
          if (notes.size !== count) return null;
          return { id, hash, notes };
        } catch { return null; }
      }));
      const notes = new Map();
      for (const shard of loaded) if (shard) {
        this.shards.set(shard.id, shard);
        for (const [rel, entry] of shard.notes) notes.set(rel, entry);
      }
      this.manifestValid = loaded.every(Boolean);
      this.readReason = this.manifestValid ? 'valid' : 'damaged-shards';
      this.shardCount = data.shardCount;
      return notes;
    } catch (error) { this.readReason = error.code === 'ENOENT' ? 'missing' : 'unreadable-or-invalid'; return new Map(); }
  }
  _serialize(value) {
    const start = performance.now(), text = JSON.stringify(value);
    this.stats.serializeMs += performance.now() - start;
    this.stats.serializedBytes += Buffer.byteLength(text);
    return text;
  }
  async _atomic(name, text) {
    const tempName = `${name}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    const temp = this._file(tempName);
    try {
      await fsp.writeFile(temp, text, 'utf8');
      await fsp.rename(temp, this._file(name));
      this.stats.fileWrites++;
      this.stats.bytesWritten += Buffer.byteLength(text);
    } finally { await fsp.unlink(temp).catch(() => {}); }
  }
  async write(notes) {
    const start = performance.now();
    this.stats.flushes++;
    try {
      const groups = new Map();
      // 小库不承担 64 个文件的读取开销；跨阈值时重分片，之后继续增量写入。
      const shardCount = notes.length < 256 ? 1 : notes.length < 4096 ? 16 : SHARDS;
      for (const [rel, e] of notes) {
        const id = shardFor(rel, shardCount);
        if (!groups.has(id)) groups.set(id, new Map());
        groups.get(id).set(rel, e);
      }
      await fsp.mkdir(path.dirname(this._file('index.json')), { recursive: true });
      const next = new Map();
      let changed = !this.manifestValid || shardCount !== this.shardCount || groups.size !== this.shards.size;
      // 固定文件名不会积累旧正文；先写分片再提交 manifest。中途退出/并发写造成的哈希不符只重建该片。
      const dirty = [];
      for (const [id, rows] of groups) {
        const old = this.shards.get(id);
        if (unchanged(old?.notes, rows)) next.set(id, old);
        else { changed = true; dirty.push([id, rows]); }
      }
      // 重建时有界并行写入；单篇保存仍只有一个分片。失败也等所有写入收尾，才允许下次刷新。
      let cursor = 0;
      const writes = await Promise.allSettled(Array.from({ length: Math.min(8, dirty.length) }, async () => {
        while (cursor < dirty.length) {
          const [id, rows] = dirty[cursor++];
          const text = this._serialize([...rows]);
          await this._atomic(shardName(id), text);
          next.set(id, { id, notes: rows, hash: digest(text) });
        }
      }));
      const failed = writes.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      const manifest = { version: VERSION, root: this.root, shardCount, shards: [...next.values()]
        .map(({ id, hash, notes: rows }) => ({ id, hash, count: rows.size })).sort((a, b) => a.id - b.id) };
      if (changed) await this._atomic('index.json', this._serialize(manifest));
      const obsolete = new Set(this.shards.keys());
      if (!this.manifestValid) {
        // 损坏清单可能丢失旧分片目录；仅识别本格式固定文件，不触碰其他内部配置。
        for (const name of await fsp.readdir(path.dirname(this._file('index.json')))) {
          const match = /^index-(\d{2})\.json$/.exec(name);
          if (match && Number(match[1]) < SHARDS) obsolete.add(Number(match[1]));
        }
      }
      for (const id of obsolete) if (!next.has(id)) await fsp.unlink(this._file(shardName(id))).catch(() => {});
      this.shards = next;
      this.shardCount = shardCount;
      this.manifestValid = true;
      return true;
    } catch { this.stats.failures++; this.shards.clear(); this.manifestValid = false; return false; }
    finally { this.stats.writeMs += performance.now() - start; }
  }
}
