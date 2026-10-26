import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveInVault } from './path-guard.js';

export const revisionOf = content => content === null ? null : crypto.createHash('sha256').update(content).digest('hex');
/** @type {Map<string, Promise<unknown>>} */
const queues = new Map();
export async function readDiskNote(root, rel) {
  try { return await fs.readFile(resolveInVault(root, rel), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
/** @param {string} root @param {string} rel @param {string} content
 * @param {{expectedRevision?:string|null,beforeCommit?:(previous:string|null)=>unknown}} [options] */
export function saveDiskNote(root, rel, content, { expectedRevision, beforeCommit } = {}) {
  const key = resolveInVault(root, rel);
  const job = (queues.get(key) || Promise.resolve()).then(async () => {
    if (typeof content !== 'string') throw Object.assign(new Error('笔记内容必须是文字'), { status: 400 });
    const previous = await readDiskNote(root, rel);
    // BOM 是文件编码标记；编辑器不显示它，保存时保留已有标记。
    if (previous?.startsWith('\uFEFF') && !content.startsWith('\uFEFF')) content = '\uFEFF' + content;
    const conflict = () => Object.assign(new Error('磁盘上的笔记已变化，请查看磁盘版本或将当前内容另存副本'), { status: 409 });
    if (expectedRevision !== undefined && expectedRevision !== revisionOf(previous) && content !== previous) throw conflict();
    if (content === previous) return revisionOf(content); // 丢失响应后的重试是幂等的。
    const tempRel = `.tracery/pending/${crypto.randomUUID()}.tmp`;
    await fs.mkdir(path.dirname(resolveInVault(root, tempRel)), { recursive: true });
    const temp = resolveInVault(root, tempRel);
    try {
      const mode = await fs.stat(key).then(st => st.mode).catch(() => 0o666);
      const handle = await fs.open(temp, 'wx', mode);
      try { await handle.writeFile(content, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      if (beforeCommit) await beforeCommit(previous);
      // 写临时文件期间发生的外部编辑也不能被覆盖；失败时原件保持完整。
      if (await readDiskNote(root, rel) !== previous) throw conflict();
      await fs.mkdir(path.dirname(resolveInVault(root, rel)), { recursive: true });
      await fs.rename(temp, resolveInVault(root, rel));
      return revisionOf(content);
    } finally { await fs.unlink(temp).catch(() => {}); }
  });
  const tail = job.catch(() => {}); queues.set(key, tail);
  tail.finally(() => { if (queues.get(key) === tail) queues.delete(key); })
    .catch(error => console.error('[note-store] 保存队列清理失败', error));
  return job;
}
