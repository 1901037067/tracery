/* 缓存是可丢弃的派生数据；损坏、版本变化或只读仓库均退回正常扫描，不影响原笔记。 */
import fsp from 'node:fs/promises';
import path from 'node:path';
const VERSION = 1;
export const sameStat = (a, b) => !!a && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.size === b.size;
export const fileStat = (st) => ({ mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, birthtimeMs: st.birthtimeMs, size: st.size });
export async function readIndex(root) {
  try {
    const data = JSON.parse(await fsp.readFile(path.join(root, '.tracery/index.json'), 'utf8'));
    if (data.version !== VERSION || data.root !== root || !Array.isArray(data.notes)) return new Map();
    return new Map(data.notes.filter((row) => {
      if (!Array.isArray(row) || row.length !== 2) return false;
      const [rel, e] = row;
      return typeof rel === 'string' && e && typeof e.content === 'string' && typeof e.name === 'string'
        && Array.isArray(e.links) && e.links.every((s) => typeof s === 'string')
        && Array.isArray(e.tags) && e.tags.every((s) => typeof s === 'string') && Array.isArray(e.headings);
    }));
  } catch { return new Map(); }
}
export function snapshotIndex(vault) {
  return [...vault.notes].map(([rel, note]) => [rel, { ...vault.files.get(rel), name: note.name,
    links: note.links, tags: [...note.tags], headings: note.headings, content: vault.contentCache.get(rel) }]);
}
export async function writeIndex(root, notes) {
  const dir = path.join(root, '.tracery');
  const temp = path.join(dir, `index.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(temp, JSON.stringify({ version: VERSION, root, notes }), 'utf8');
    await fsp.rename(temp, path.join(dir, 'index.json'));
    return true;
  } catch { await fsp.unlink(temp).catch(() => {}); return false; }
}
