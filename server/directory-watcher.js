import fs from 'node:fs';
import {resolveInDirectory} from './path-guard.js';

/** Linux 递归 fs.watch 逐文件跟踪 inode；原子替换后改为监视父目录。
 * @param {string} root @param {Iterable<string>} directories
 * @param {(event:string,filename:string)=>void} listener
 * @param {(error:Error)=>void} onError */
export function watchDirectories(root,directories,listener,onError) {
  /** @type {Map<string, fs.FSWatcher>} */
  const watchers=new Map();let closed=false;
  /** @param {Iterable<string>} nextDirectories */
  function sync(nextDirectories) {
    if(closed)return;
    const next=new Set(['',...nextDirectories]);
    for(const [rel,watcher] of watchers)if(!next.has(rel)){watcher.close();watchers.delete(rel);}
    for(const rel of next) {
      if(watchers.has(rel))continue;
      const absolute=rel?resolveInDirectory(root,rel):root;
      try {
        const watcher=fs.watch(absolute,{recursive:false},(event,filename)=>{
          if(!closed)listener(event,filename?(rel?rel+'/':'')+String(filename):rel||'*');
        });
        watcher.on('error',error=>{if(!closed)onError(error);});watchers.set(rel,watcher);
      } catch(error) { if(!rel||!['ENOENT','ENOTDIR'].includes(error.code))throw error; }
    }
  }
  function close(){closed=true;for(const watcher of watchers.values())watcher.close();watchers.clear();}
  try { sync(directories); } catch(error) { close();throw error; }
  return {sync,close};
}
