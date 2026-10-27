import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { referenceIndex, rewriteReferences, scanReferences, resolveReference } from '../public/js/reference-path.js';
import { isAttachmentTarget } from '../public/js/wiki-path.js';
import { resolveUserPath } from './user-path.js';
import { vaultFiles } from './vault-files.js';
import { saveDiskNote, readDiskNote, revisionOf } from './note-store.js';
import { writeJson } from './durable-json.js';
const note = /\.(md|markdown|txt)$/i;
const fail = message => Object.assign(Error(message), { status: 409 });
const exists = async file => { try { await fsp.lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };

export function createReferenceStore({ home, history, fault = async () => {} }) {
  async function rollback(root, folder, journal) {
    for (const change of [...journal.changes].reverse()) {
      const move = journal.moves.find(move => move.phase !== 'pending' && move.phase !== 'reverted' && (change.before === move.from || change.before.startsWith(move.from + '/')));
      const moved = move && !(move.phase === 'moving' && !move.caseOnly && await exists(resolveUserPath(root, move.from, home)));
      const current = moved && await exists(resolveUserPath(root, change.after, home)) ? change.after : change.before;
      const text = await readDiskNote(root, current), hash = revisionOf(text);
      const original = await fsp.readFile(path.join(folder, change.backup), 'utf8');
      if (revisionOf(original) !== change.oldHash) throw fail('恢复副本校验失败');
      if (hash === change.newHash) await saveDiskNote(root, current, original, { expectedRevision: hash });
      else if (hash !== change.oldHash) throw fail(`文件在操作期间被外部修改，未覆盖：${current}`);
    }
    for (const move of [...journal.moves].reverse()) {
      if (move.phase === 'pending' || move.phase === 'reverted') continue;
      const from = resolveUserPath(root, move.from, home), to = resolveUserPath(root, move.to, home);
      if (await exists(to)) {
        if (!move.caseOnly && await exists(from)) {
          // 已记录意图但尚未执行的移动可能遇到新出现的目标；不碰它，继续回退已完成项。
          if (move.phase !== 'moving') throw fail(`原路径出现文件，未覆盖：${move.from}`);
        } else {
          await fsp.mkdir(path.dirname(from), { recursive: true }); await fsp.rename(to, from);
        }
      } else if (!await exists(from)) {
        throw fail(`移动前后路径均不存在，需要检查恢复副本：${move.from}`);
      }
      move.phase = 'reverted'; writeJson(path.join(folder, 'journal.json'), journal);
    }
    writeJson(path.join(folder, 'journal.json'), { ...journal, state: 'rolled-back' }); journal.state = 'rolled-back';
  }
  async function commit(root, inventory, moves, changes) {
    const folder = path.join(root, '.tracery', 'operations', randomUUID()); await fsp.mkdir(folder, { recursive: true });
    moves = moves.map(move => ({ ...move, phase: 'pending' }));
    const journal = { version: 2, root, state: 'prepared', moves, changes: changes.map((change, i) => ({ before: change.before, after: change.after,
      oldHash: revisionOf(change.original), newHash: revisionOf(change.text), backup: `${i}.md` })) };
    for (const [i, change] of changes.entries()) {
      const handle = await fsp.open(path.join(folder, `${i}.md`), 'wx', 0o600);
      try { await handle.writeFile(change.original, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    }
    writeJson(path.join(folder, 'journal.json'), journal);
    try {
      await fault('prepared');
      const current = await vaultFiles(root, home);
      if (JSON.stringify(current) !== JSON.stringify(inventory)) throw fail('仓库在规划期间发生变化，请重试');
      for (const change of changes) if (revisionOf(await readDiskNote(root, change.before)) !== revisionOf(change.original)) throw fail('正文已被外部修改，请重试');
      writeJson(path.join(folder, 'journal.json'), { ...journal, state: 'committing' }); journal.state = 'committing';
      for (const move of moves) {
        const from = resolveUserPath(root, move.from, home), to = resolveUserPath(root, move.to, home);
        move.phase = 'moving'; writeJson(path.join(folder, 'journal.json'), journal);
        await fault('moving', moves.indexOf(move));
        if (!move.caseOnly && await exists(to)) throw fail('目标路径已存在，未覆盖');
        await fsp.mkdir(path.dirname(to), { recursive: true }); await fsp.rename(from, to);
        await fault('moved-entry', moves.indexOf(move));
        move.phase = 'moved'; writeJson(path.join(folder, 'journal.json'), journal);
      }
      await fault('moved');
      for (const [i, change] of changes.entries()) {
        await saveDiskNote(root, change.after, change.text, { expectedRevision: revisionOf(change.original),
          beforeCommit: previous => history?.snapshot(root, change.before, previous) });
        await fault('written', i);
      }
      writeJson(path.join(folder, 'journal.json'), { ...journal, state: 'committed' }); journal.state = 'committed';
      await fsp.rm(folder, { recursive: true, force: true }).catch(error => console.warn('[references] 已提交，临时副本清理失败:', error.message));
    } catch (error) {
      if (journal.state === 'committing') {
        try { await rollback(root, folder, journal); }
        catch (recovery) { throw fail(`${error.message}；自动回退未完成：${recovery.message}。恢复副本：${folder}`); }
      }
      throw error;
    }
    return { updated: changes.length, references: changes.reduce((sum, row) => sum + row.count, 0), paths: changes.map(row => row.after) };
  }
  return {
    async rename(root, from, to) {
      const source = resolveUserPath(root, from, home), target = resolveUserPath(root, to, home);
      from = from.replace(/\\/g, '/'); to = to.replace(/\\/g, '/');
      if (from === to) return { path: to, updated: 0, references: 0, paths: [] };
      const stat = await fsp.lstat(source); if (stat.isSymbolicLink()) throw fail('不移动符号链接');
      if (to.startsWith(from + '/')) throw fail('不能将目录移动到自身内部');
      const caseOnly = process.platform === 'win32' && from.toLowerCase() === to.toLowerCase();
      if (!caseOnly && await exists(target)) throw fail('目标路径已存在，未覆盖');
      const inventory = await vaultFiles(root, home), moves = [{ from, to, caseOnly }];
      if (!stat.isDirectory() && /\.(png|jpe?g|webp|gif)$/i.test(from)) {
        const paired = from.replace(/\.[^.]+$/, '.draw.json'), next = to.replace(/\.[^.]+$/, '.draw.json');
        if (paired !== next && inventory.files.some(file => file.path === paired)) {
          const pairedCase = process.platform === 'win32' && paired.toLowerCase() === next.toLowerCase();
          if (!pairedCase && await exists(resolveUserPath(root, next, home))) throw fail('目标绘图数据已存在，未覆盖');
          moves.push({ from: paired, to: next, caseOnly: pairedCase });
        }
      }
      const map = value => { const move = moves.find(move => value === move.from || (stat.isDirectory() && value.startsWith(move.from + '/'))); return move ? move.to + value.slice(move.from.length) : value; };
      const before = referenceIndex(inventory.files.map(file => file.path)), after = referenceIndex(inventory.files.map(file => map(file.path))), changes = [];
      for (const file of inventory.files.filter(file => note.test(file.path))) {
        const original = await readDiskNote(root, file.path), next = rewriteReferences(original, file.path, map(file.path), before, after, map);
        if (next.text !== original) changes.push({ before: file.path, after: map(file.path), original, ...next });
      }
      return { path: to, ...await commit(root, inventory, moves, changes) };
    },
    async relink(root, source, raw, target, expectedRevision) {
      resolveUserPath(root, source, home); const dest = resolveUserPath(root, target, home);
      source = source.replace(/\\/g, '/'); target = target.replace(/\\/g, '/');
      if (!(await fsp.stat(dest)).isFile() || !isAttachmentTarget(target)) throw fail('请选择仓库内的图片或附件');
      const inventory = await vaultFiles(root, home), index = referenceIndex(inventory.files.map(file => file.path));
      const original = await readDiskNote(root, source);
      if (expectedRevision === undefined || revisionOf(original) !== expectedRevision) throw fail('笔记已变化，请刷新后重新关联');
      const normalized = String(raw).split('|')[0].trim();
      if (resolveReference(normalized, source, index)) throw fail('原引用已经可以解析，未替换');
      if (!isAttachmentTarget(normalized) || !scanReferences(original).some(ref => ref.raw === normalized)) throw fail('未找到这条缺失附件引用');
      const result = rewriteReferences(original, source, source, index, index, value => value, { raw: normalized, target });
      if (!result.count) throw fail('未找到需要更新的引用');
      return commit(root, inventory, [], [{ before: source, after: source, original, ...result }]);
    },
    async recover(root) {
      const base = path.join(root, '.tracery/operations'); let names;
      try { names = await fsp.readdir(base, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      const warnings = [];
      for (const entry of names) {
        if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
        const folder = path.join(base, entry.name), file = path.join(folder, 'journal.json');
        try {
          const data = JSON.parse(await fsp.readFile(file, 'utf8'));
          if (![1, 2].includes(data.version) || data.root !== root || !Array.isArray(data.moves) || !Array.isArray(data.changes)) throw fail('恢复日志身份不匹配');
          for (const move of data.moves) { resolveUserPath(root, move.from, home); resolveUserPath(root, move.to, home); if (data.version === 2 && !['pending', 'moving', 'moved', 'reverted'].includes(move.phase)) throw fail('恢复移动阶段无效'); }
          for (const change of data.changes) { resolveUserPath(root, change.before, home); resolveUserPath(root, change.after, home); if (!/^\d+\.md$/.test(change.backup)) throw fail('恢复文件名无效'); }
          if (data.state === 'committing') { await rollback(root, folder, data); warnings.push('已回退上次未完成的移动或引用修改'); }
        } catch (error) { warnings.push(`有未完成操作需要检查：${entry.name}（${error.message}）`); }
      }
      return warnings;
    },
  };
}
