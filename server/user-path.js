/* 面向用户的文件入口与可信内部存储分开；同步和原子保存仍可访问内部目录。 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveInVault, pathError, isWithin } from './path-guard.js';
const reserved = new Set(['.tracery', '.evnote', '.obsidian', '.git', '.trash', '.local', 'node_modules']);
const dataHome = path.resolve(process.env.TRACERY_HOME || process.env.EVNOTE_HOME || path.join(import.meta.dirname,'..'));
export function isPrivateUserPath(root,rel,home=dataHome) {
  const parts=String(rel).replaceAll('\\','/').split('/');
  if(parts.some(part=>{
    const name=part.toLowerCase();
    return reserved.has(name)||['tracery.config.json','evnote.config.json'].some(config=>name===config||name.startsWith(config+'.'));
  }))return true;
  const absolute=path.resolve(root,...parts);
  return ['history','history-v2','trash'].some(name=>isWithin(path.join(home,name),absolute));
}
function check(root, rel, home) {
  if (isPrivateUserPath(root,rel,home)) throw pathError('不能通过文件接口访问程序内部目录或配置');
}
export function resolveUserPath(root, rel, home=dataHome) {
  check(root,rel,home);
  const target = resolveInVault(root, rel);
  // 库内链接也不能把保留目录伪装成普通附件目录。
  let existing = target;
  while (!fs.existsSync(existing) && existing !== path.resolve(root)) existing = path.dirname(existing);
  check(fs.realpathSync(root),path.relative(fs.realpathSync(root), fs.realpathSync(existing)),fs.existsSync(home)?fs.realpathSync(home):home);
  return target;
}
