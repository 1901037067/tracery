import fs from 'node:fs';
import path from 'node:path';

export function pathError(message = '路径必须位于当前仓库内') {
  return Object.assign(new Error(message), { status: 403 });
}
export function isWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}
/** 同时校验词法边界和已有祖先的真实路径。不存在的新文件检查到最近的已有父目录。 */
export function resolveInDirectory(root, rel, { allowRoot = false } = {}) {
  if (typeof rel !== 'string' || !rel || /[\x00-\x1f:*?"<>|]/.test(rel) || path.posix.isAbsolute(rel) || path.win32.isAbsolute(rel)) throw pathError();
  const parts = rel.replace(/\\/g, '/').split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw pathError();
  const base = path.resolve(root), target = path.resolve(base, ...parts);
  if (!isWithin(base, target) || (!allowRoot && target === base)) throw pathError();
  const realRoot = fs.realpathSync(base);
  let cursor = target;
  while (true) {
    try {
      fs.lstatSync(cursor);
      if (!isWithin(realRoot, fs.realpathSync(cursor))) throw pathError('路径中的链接指向仓库外');
      return target;
    } catch (error) {
      if (error.status || !['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      // 一个已存在但目标丢失的符号链接不能作为新文件的父目录。
      try { if (fs.lstatSync(cursor).isSymbolicLink()) throw pathError('路径中的链接已失效'); } catch (e) { if (e.status) throw e; }
      if (cursor === base) throw pathError();
      cursor = path.dirname(cursor);
    }
  }
}
export const resolveInVault = resolveInDirectory;
