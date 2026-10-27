/* 仅处理历史副本；导入必须验证当前正文，绝不恢复或覆盖原始笔记。 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveInDirectory } from './path-guard.js';
import { resolveUserPath } from './user-path.js';
export const HISTORY_BACKUP_LIMIT = 32 * 1024 * 1024;
const sha = text => createHash('sha256').update(text).digest('hex');
const rootHash = root => createHash('sha1').update(root).digest('hex').slice(0, 12);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
function walk(directory, visit, rel = '') {
  if (!fs.existsSync(directory)) return;
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    if (item.isSymbolicLink()) throw fail('历史目录包含链接，未导出');
    const relative = rel ? rel + '/' + item.name : item.name, file = resolveInDirectory(directory, item.name);
    if (item.isDirectory()) walk(file, visit, relative); else if (item.isFile()) visit(file, relative);
  }
}
export function createHistoryBackup(home, history) {
  function currentHash(root, rel) {
    try { return sha(fs.readFileSync(resolveUserPath(root, rel, home))); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
  }
  return {
    export(root) {
      root = path.resolve(root);
      const archive = { format: 'tracery-history', version: 1, sourceRoot: root, createdAt: new Date().toISOString(), notes: [], legacy: [] };
      let bytes = 1024, count = 0;
      const version = (time, content) => {
        const row = { time, content, hash: sha(content) };
        bytes += Buffer.byteLength(JSON.stringify(row)) + 256;
        if (bytes > HISTORY_BACKUP_LIMIT - 4096 || ++count > 50000) throw fail('历史备份超过 32 MiB 或 5 万版本，请关闭应用后复制用户数据目录中的 history-v2 和 history 文件夹备份', 413);
        return row;
      };
      const base = resolveInDirectory(home, `history-v2/${sha(root)}`);
      if (fs.existsSync(base)) for (const item of fs.readdirSync(base, { withFileTypes: true })) {
        if (item.isSymbolicLink()) throw fail('历史目录包含链接');
        if (!item.isDirectory() || !/^[a-f0-9]{64}$/.test(item.name)) continue;
        const dir = resolveInDirectory(base, item.name), identity = JSON.parse(fs.readFileSync(resolveInDirectory(dir, 'identity.json'), 'utf8'));
        if (identity.root !== root || typeof identity.path !== 'string' || sha(identity.path) !== item.name) throw fail('历史身份不匹配，未导出');
        const rel = identity.path, digest = currentHash(root, rel);
        const versions = history.list(root, rel).filter(row => !row.legacy).map(row => {
          if (row.size > HISTORY_BACKUP_LIMIT - 4096) throw fail('单个历史版本超过 32 MiB，请复制用户数据目录备份', 413);
          return version(row.time, history.read(root, rel, row.id));
        });
        if (versions.length) archive.notes.push({ path: rel, currentHash: digest, versions });
      }
      const old = resolveInDirectory(home, `history/${rootHash(root)}`), legacy = new Map();
      walk(old, (file, rel) => {
        if (!/^\d+\.md$/.test(path.posix.basename(rel))) return;
        const name = path.posix.dirname(rel); resolveUserPath(root, name, home);
        if (fs.statSync(file).size > HISTORY_BACKUP_LIMIT - 4096) throw fail('单个旧版历史超过 32 MiB，请复制用户数据目录备份', 413);
        if (!legacy.has(name)) legacy.set(name, []);
        legacy.get(name).push(version(Number(path.posix.basename(rel, '.md')), fs.readFileSync(file, 'utf8')));
      });
      archive.legacy = [...legacy].map(([rel, versions]) => ({ path: rel, sourceUncertain: true, versions }));
      if (Buffer.byteLength(JSON.stringify(archive)) > HISTORY_BACKUP_LIMIT) throw fail('历史备份超过 32 MiB，请使用用户数据目录备份', 413);
      return archive;
    },
    import(root, archive, { allowRebind = false } = {}) {
      root = path.resolve(root);
      if (!archive || archive.format !== 'tracery-history' || archive.version !== 1 || typeof archive.sourceRoot !== 'string' || !Array.isArray(archive.notes) || !Array.isArray(archive.legacy)) throw fail('不是受支持的 Tracery 历史备份');
      if (Buffer.byteLength(JSON.stringify(archive)) > HISTORY_BACKUP_LIMIT) throw fail('历史备份超过 32 MiB', 413);
      if (archive.sourceRoot !== root && !allowRebind) throw fail('备份来自另一个仓库位置，需明确确认导入当前仓库', 409);
      const tasks = [], skipped = [], seen = new Set(); let count = 0;
      for (const legacy of [false, true]) for (const note of legacy ? archive.legacy : archive.notes) {
        if (!note || typeof note.path !== 'string' || note.path.includes('\\') || !Array.isArray(note.versions) || seen.has(`${legacy}:${note.path}`)) throw fail('历史条目或重复路径无效');
        seen.add(`${legacy}:${note.path}`); resolveUserPath(root, note.path, home);
        const times = new Set();
        for (const row of note.versions) {
          if (!row || typeof row.content !== 'string' || !Number.isSafeInteger(row.time) || row.time < 1 || times.has(row.time) || sha(row.content) !== row.hash || ++count > 50000) throw fail('历史正文校验失败或版本无效');
          times.add(row.time);
        }
        if (!legacy && (typeof note.currentHash !== 'string' || !/^[a-f0-9]{64}$/.test(note.currentHash) || currentHash(root, note.path) !== note.currentHash)) skipped.push({ path: note.path, reason: '当前正文缺失或与备份时不同，未关联历史' });
        else tasks.push({ note, legacy });
      }
      const completed = []; let added = 0;
      try {
        for (const { note, legacy } of tasks) {
          const result = history.importVersions(root, note.path, note.versions, { legacy });
          completed.push(result); added += result.added;
        }
      } catch (error) {
        for (const item of completed.reverse()) item.rollback();
        throw error;
      }
      return { added, skipped, legacyUnverified: archive.legacy.length, sourceRoot: archive.sourceRoot };
    },
  };
}
