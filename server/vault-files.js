import fsp from 'node:fs/promises';
import { isPrivateUserPath } from './user-path.js';
import { resolveInDirectory } from './path-guard.js';
export async function vaultFiles(root, home, { strictLinks = false } = {}) {
  const files = [], directories = [];
  async function walk(rel = '') {
    const dir = rel ? resolveInDirectory(root, rel) : root;
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const name = rel ? rel + '/' + entry.name : entry.name;
      if (isPrivateUserPath(root, name, home)) continue;
      if (entry.isSymbolicLink()) { if (strictLinks) throw Error(`文件夹包含链接，未生成完整备份：${name}`); continue; }
      if (entry.isDirectory()) { directories.push(name); await walk(name); }
      else if (entry.isFile()) {
        const stat = await fsp.stat(resolveInDirectory(root, name));
        files.push({ path: name, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
      }
    }
  }
  await walk(); files.sort((a, b) => a.path.localeCompare(b.path)); directories.sort();
  return { files, directories };
}
