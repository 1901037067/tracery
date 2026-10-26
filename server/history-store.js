import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveInDirectory } from './path-guard.js';
import { resolveUserPath } from './user-path.js';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const failure = (message, status = 409) => Object.assign(new Error(message), { status });
let lastId = 0;
export function createHistoryStore(home) {
  function locations(root, rel) {
    resolveUserPath(root, rel, home);
    const normalized = rel.replaceAll('\\', '/');
    const identity = { version: 2, root: path.resolve(root), path: normalized };
    const key = JSON.stringify([identity.root, identity.path]);
    // 身份使用原始 Unicode 路径，不做有损替换或大小写折叠。
    const directory = resolveInDirectory(home, `history-v2/${hash(identity.root)}/${hash(normalized)}`);
    const oldRoot = crypto.createHash('sha1').update(path.resolve(root)).digest('hex').slice(0,12);
    const safe = rel.split('/').map(s => s.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_')).join('/');
    const legacy = resolveInDirectory(home, `history/${oldRoot}/${safe}`);
    return { identity, key, directory, legacy };
  }
  function verify(location, create = false) {
    const file = path.join(location.directory, 'identity.json');
    if (create) {
      fs.mkdirSync(location.directory, {recursive:true});
      try { fs.writeFileSync(file, JSON.stringify(location.identity), {flag:'wx'}); } catch(error) { if(error.code !== 'EEXIST') throw error; }
    }
    if (!fs.existsSync(file)) {
      if (fs.existsSync(location.directory)) throw failure('历史来源信息缺失，未读取或恢复');
      return false;
    }
    let saved; try { saved = JSON.parse(fs.readFileSync(file,'utf8')); } catch { throw failure('历史来源信息损坏，未读取或恢复'); }
    const key = JSON.stringify([saved.root,saved.path]);
    if(saved.version !== 2 || key !== location.key) throw failure('历史记录不属于这篇笔记');
    return true;
  }
  function entries(directory, legacy) {
    let names; try { names=fs.readdirSync(directory); } catch(error) { if(error.code==='ENOENT') return []; throw error; }
    return names.filter(name=>/^\d+\.md$/.test(name)).map(name=>{
      const id=name.slice(0,-3), size=fs.statSync(resolveInDirectory(directory,name)).size;
      return {id:(legacy?'legacy-':'v2-')+id,time:Number(id),size,legacy,sourceUncertain:legacy,restorable:!legacy};
    });
  }
  return {
    snapshot(root, rel, content) {
      if(content == null) return;
      const location=locations(root,rel); verify(location,true);
      const id=lastId=Math.max(Date.now(),lastId+1);
      fs.writeFileSync(resolveInDirectory(location.directory,`${id}.md`),content,{encoding:'utf8',flag:'wx'});
      for(const item of entries(location.directory,false).sort((a,b)=>b.time-a.time).slice(20)) fs.unlinkSync(resolveInDirectory(location.directory,`${item.time}.md`));
    },
    list(root,rel) {
      const location=locations(root,rel);
      return [...(verify(location)?entries(location.directory,false):[]),...entries(location.legacy,true)].sort((a,b)=>b.time-a.time);
    },
    read(root,rel,id,{restore=false}={}) {
      const location=locations(root,rel), match=/^(v2-|legacy-)?(\d+)$/.exec(String(id||''));
      if(!match) throw failure('版本不存在',404);
      const legacy=match[1]!=='v2-';
      if(legacy&&restore) throw failure('旧版历史来源未验证，请预览后手动复制或另存；已阻止直接恢复');
      if(!legacy&&!verify(location)) throw failure('版本不存在',404);
      const file=resolveInDirectory(legacy?location.legacy:location.directory,`${match[2]}.md`);
      try {return fs.readFileSync(file,'utf8');}catch(error){if(error.code==='ENOENT')throw failure('版本不存在',404);throw error;}
    },
  };
}
