import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..'),files=[];
function walk(directory) {
  for(const item of fs.readdirSync(directory,{withFileTypes:true})) {
    if(item.isSymbolicLink()||['node_modules','screenshots'].includes(item.name))continue;
    const file=path.join(directory,item.name);
    if(item.isDirectory())walk(file);else if(/\.(?:js|mjs|cjs)$/.test(item.name))files.push(file);
  }
}
for(const directory of ['server','sync-server','electron','public/js','scripts','test'])walk(path.join(root,directory));
for(const file of files) {
  const check=spawnSync(process.execPath,['--check',file],{encoding:'utf8',windowsHide:true});
  if(check.status!==0){console.error(check.stderr||check.error);process.exit(1);}
}
console.log('PASS '+files.length+' 个自有 JavaScript 文件语法检查');
