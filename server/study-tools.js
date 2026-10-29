import fsp from 'node:fs/promises';
import path from 'node:path';
import { parseTasks, taskPatch } from '../public/js/note-tasks.js';
import { parseSearch, matchesSearch } from '../public/js/search-query.js';
import { citationMarkdown } from '../public/js/pdf-reference.js';
import { localDate } from '../public/js/note-templates.js';
import { revisionOf, readDiskNote, saveDiskNote } from './note-store.js';
const error = (message, status = 400) => Object.assign(Error(message), { status });
const normalized = source => source.startsWith('\uFEFF') ? source.slice(1) : source;
const caches = new WeakMap();
export function taskCatalog(vault, params) {
  let cache = caches.get(vault); if (!cache) { cache = new Map(); caches.set(vault, cache); }
  for (const key of cache.keys()) if (!vault.notes.has(key)) cache.delete(key);
  const parsed = parseSearch(params.get('q') || ''), scope = params.get('scope') || 'open', today = localDate();
  if (!['open', 'due', 'done', 'all'].includes(scope)) throw error('任务筛选不正确');
  const rows = [], counts = { open: 0, due: 0, done: 0, all: 0 };
  for (const [rel, note] of vault.notes) {
    if (!/\.(md|markdown)$/i.test(rel)) continue;
    const content = vault.contentCache.get(rel) || ''; let entry = cache.get(rel);
    if (!entry || entry.content !== content) { entry = { content, rows: parseTasks(content), revision: revisionOf(content) }; cache.set(rel, entry); }
    for (const task of entry.rows) {
      if (!matchesSearch(parsed, { path: rel, name: note.name, content: task.text, tags: note.tags })) continue;
      counts.all++; counts[task.completed ? 'done' : 'open']++;
      const due = !task.completed && task.due && task.due <= today; if (due) counts.due++;
      if ((scope === 'open' && task.completed) || (scope === 'done' && !task.completed) || (scope === 'due' && !due)) continue;
      const { marker, ...data } = task; rows.push({ ...data, path: rel, name: note.name, revision: entry.revision });
    }
  }
  rows.sort((a, b) => Number(a.completed) - Number(b.completed) || Number(!a.due) - Number(!b.due) || a.due.localeCompare(b.due) || a.path.localeCompare(b.path, 'zh-CN', { numeric: true }) || a.line - b.line);
  const offset = Math.max(0, Math.floor(Number(params.get('offset')) || 0)), limit = Math.max(1, Math.min(200, Math.floor(Number(params.get('limit')) || 100)));
  return { rows: rows.slice(offset, offset + limit), total: rows.length, counts, offset, limit };
}
export function createStudyTools({ resolve, history }) {
  function context(vault, data) { if (data.vaultRoot !== vault.root) throw error('仓库已切换，请回到原仓库重试', 409); }
  async function commit(vault, rel, content, previous) {
    try {
      const revision = await saveDiskNote(vault.root, rel, content, { expectedRevision: revisionOf(previous), beforeCommit: original => original === null ? undefined : history(vault.root, rel, original) });
      await vault.applyChange(rel); return { ok: true, path: rel, revision };
    } catch (failure) {
      if (failure.status) throw failure;
      console.error('[study-tools] 写入或索引刷新失败', failure);
      throw error('笔记写入未确认，请核对原笔记后重试', 500);
    }
  }
  const citationContent = (previous, rel, block) => {
    const eol = previous?.includes('\r\n') ? '\r\n' : '\n';
    const prefix = previous ?? '# ' + path.basename(rel).replace(/\.(md|markdown)$/i, '') + eol;
    return prefix + (prefix.endsWith(eol + eol) ? '' : prefix.endsWith(eol) ? eol : eol + eol) + block.replace(/\n/g, eol);
  };
  return {
    async toggle(vault, data) {
      context(vault, data);
      if (!/\.(md|markdown)$/i.test(data.path || '') || !vault.notes.has(data.path) || !/^[a-f0-9]{64}$/.test(data.expectedRevision || '') || typeof data.checked !== 'boolean' || typeof data.expectedLine !== 'string') throw error('任务参数不正确');
      resolve(vault.root, data.path); let source;
      try { source = await readDiskNote(vault.root, data.path); } catch { throw error('无法读取任务笔记，请检查文件权限', 409); }
      if (source === null) throw error('笔记已删除', 409);
      if (revisionOf(normalized(source)) !== data.expectedRevision) {
        // A lost response can be retried only if this exact one-character edit explains the new revision.
        const task = parseTasks(source).find(task => task.line === data.line);
        const oldChar = /^[ \t]*(?:>[ \t]*)*(?:[-+*]|\d+[.)])[ \t]+\[([ xX])\]/.exec(data.expectedLine)?.[1];
        const reversed = task && oldChar && source.slice(0, task.marker) + oldChar + source.slice(task.marker + 1);
        if (task?.completed === data.checked && reversed && revisionOf(normalized(reversed)) === data.expectedRevision) return { ok: true, path: data.path, revision: revisionOf(source), unchanged: true };
        await vault.applyChange(data.path);
        throw error('笔记已变化，未修改任务；请刷新列表后重试', 409);
      }
      let content; try { content = taskPatch(source, data.line, data.expectedLine, data.checked); } catch (failure) { throw error(failure.message, 409); }
      return commit(vault, data.path, content, source);
    },
    async cite(vault, data) {
      context(vault, data);
      if (typeof data.source !== 'string' || !/\.pdf$/i.test(data.source) || typeof data.path !== 'string' || !/\.(md|markdown)$/i.test(data.path) || (data.expectedRevision !== null && !/^[a-f0-9]{64}$/.test(data.expectedRevision || ''))) throw error('摘录参数不正确');
      const sourcePath = resolve(vault.root, data.source); resolve(vault.root, data.path);
      try { if (!(await fsp.stat(sourcePath)).isFile()) throw error('来源 PDF 不存在', 404); }
      catch (failure) { if (failure.status) throw failure; throw error('无法读取来源 PDF，请检查文件是否存在', 404); }
      const block = citationMarkdown(data.source, data.page, data.excerpt);
      let previous; try { previous = await readDiskNote(vault.root, data.path); } catch { throw error('无法读取目标笔记，请检查路径和文件权限', 409); }
      if (revisionOf(previous) !== data.expectedRevision) {
        let retried = data.expectedRevision === null && previous === citationContent(null, data.path, block);
        if (previous !== null && data.expectedRevision !== null) {
          const eol = previous.includes('\r\n') ? '\r\n' : '\n', suffix = block.replace(/\n/g, eol);
          if (previous.endsWith(suffix)) {
            let prefix = previous.slice(0, -suffix.length);
            for (let i = 0; i <= 2; i++) { if (revisionOf(prefix) === data.expectedRevision && citationContent(prefix, data.path, block) === previous) retried = true; if (!prefix.endsWith(eol)) break; prefix = prefix.slice(0, -eol.length); }
          }
        }
        if (retried) { await vault.applyChange(data.path); return { ok: true, path: data.path, revision: revisionOf(previous), unchanged: true }; }
        throw error('目标笔记已变化，摘录尚未写入；请重新核对目标笔记', 409);
      }
      const content = citationContent(previous, data.path, block);
      return { ...await commit(vault, data.path, content, previous), created: previous === null };
    },
  };
}
