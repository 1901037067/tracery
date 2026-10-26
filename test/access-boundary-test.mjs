import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {WebSocket} from 'ws';
import {createHistoryStore} from '../server/history-store.js';
const ROOT=path.resolve(import.meta.dirname,'..'), HOME=fs.mkdtempSync(path.join(os.tmpdir(),'tracery-boundary-')),VAULT=path.join(HOME,'vault');
fs.mkdirSync(VAULT);fs.mkdirSync(path.join(VAULT,'.tracery'));
const secret='SYNTHETIC_BOUNDARY_TOKEN',key='ab'.repeat(32);
fs.writeFileSync(path.join(VAULT,'.tracery/sync.json'),JSON.stringify({token:secret,encryption:{enabled:true,encKey:key,nameKey:key}}));
fs.symlinkSync(path.join(VAULT,'.tracery'),path.join(VAULT,'internal-alias'),process.platform==='win32'?'junction':'dir');
fs.mkdirSync(path.join(VAULT,'.ObSiDiAn'));fs.writeFileSync(path.join(VAULT,'.ObSiDiAn/secret.md'),secret);
for(const name of ['a b.md','a_b.md','空 格.md','空_格.md','İ.md','i\u0307.md','子/同名.md','另/同名.md']) {fs.mkdirSync(path.dirname(path.join(VAULT,name)),{recursive:true});fs.writeFileSync(path.join(VAULT,name),'original:'+name);}
fs.writeFileSync(path.join(HOME,'tracery.config.json'),JSON.stringify({currentVault:VAULT,settings:{sync:{token:secret,encryption:{encKey:key}},unexpected:secret,attachment:{mode:'folder',folder:'附件',token:secret}}}));
const PORT=9661,BASE=`http://127.0.0.1:${PORT}`;
const server=spawn(process.execPath,[path.join(ROOT,'server/server.js')],{env:{...process.env,PORT:String(PORT),TRACERY_HOME:HOME},windowsHide:true,stdio:['ignore','pipe','pipe']});
let log='';server.stdout.on('data',c=>log+=c);server.stderr.on('data',c=>log+=c);
async function request(route,method='GET',body){const response=await fetch(BASE+route,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});return {status:response.status,data:await response.json()};}
try{
 let ready=false;for(let i=0;i<100;i++){try{if((await request('/api/state')).status===200){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready,log);
 for(const state of [await request('/api/state'),await request('/api/settings','POST',{fontSize:17}),await request('/api/theme','POST',{theme:'light'})]){assert.equal(state.status,200);assert.ok(!JSON.stringify(state.data).includes(secret));assert.ok(!JSON.stringify(state.data).includes(key));assert.equal(state.data.settings.attachment.folder,'附件');}
 const socket=new WebSocket(`ws://127.0.0.1:${PORT}/ws`);await new Promise((r,j)=>{socket.once('open',r);socket.once('error',j);});
 const broadcast=new Promise(r=>socket.once('message',data=>r(JSON.parse(data))));await request('/api/settings','POST',{fontSize:18});const message=await broadcast;assert.equal(message.type,'settings');assert.ok(!JSON.stringify(message).includes(secret));socket.close();
 for(const rel of ['.tracery/sync.json','.TRACERY/new.md','.evnote/old.md','.obsidian/config.json','.git/config','node_modules/private.md','internal-alias/sync.json','internal-alias/new.md']){
  for(const route of ['/api/file?path=','/api/note?path=','/api/history?path='])assert.equal((await request(route+encodeURIComponent(rel))).status,403,route+rel);
  for(const [route,method,body]of [ ['/api/note','PUT',{path:rel,content:'bad'}],['/api/note/create','POST',{path:rel}],['/api/delete','POST',{path:rel}],['/api/rename','POST',{path:rel,newPath:'moved.md'}],['/api/rename','POST',{path:'a b.md',newPath:rel}],['/api/asset','POST',{dir:rel+'/sub',name:'x',data:'data:image/png;base64,aGk='}] ])assert.equal((await request(route,method,body)).status,403,route+rel);
 }
 assert.equal(JSON.parse(fs.readFileSync(path.join(VAULT,'.tracery/sync.json'))).token,secret);
 assert.equal((await request('/api/search?q='+secret)).data.results.length,0);
 assert.ok(!JSON.stringify((await request('/api/tree')).data).includes('.ObSiDiAn'));
 console.log('PASS 内部目录及库内别名读写/创建/改名/删除/附件被拒绝，配置响应与 WS 广播无敏感字段');
 const names=['a b.md','a_b.md','空 格.md','空_格.md','İ.md','i\u0307.md','子/同名.md','另/同名.md'];
 for(const name of names)assert.equal((await request('/api/note','PUT',{path:name,content:'changed:'+name})).status,200);
 for(const name of names){const items=(await request('/api/history?path='+encodeURIComponent(name))).data.items;assert.equal(items.length,1);assert.equal(items[0].restorable,true);assert.equal((await request('/api/history/content?path='+encodeURIComponent(name)+'&id='+items[0].id)).data.content,'original:'+name);assert.equal((await request('/api/history/restore','POST',{path:name,id:items[0].id})).status,200);assert.equal(fs.readFileSync(path.join(VAULT,name),'utf8'),'original:'+name);}
 const oldRoot=crypto.createHash('sha1').update(path.resolve(VAULT)).digest('hex').slice(0,12),oldDir=path.join(HOME,'history',oldRoot,'a_b.md');fs.mkdirSync(oldDir,{recursive:true});fs.writeFileSync(path.join(oldDir,'123.md'),'legacy ambiguous');
 for(const name of ['a b.md','a_b.md']){const legacy=(await request('/api/history?path='+encodeURIComponent(name))).data.items.find(i=>i.legacy);assert.ok(legacy.sourceUncertain);assert.equal(legacy.restorable,false);assert.equal((await request('/api/history/content?path='+encodeURIComponent(name)+'&id='+legacy.id)).data.content,'legacy ambiguous');assert.equal((await request('/api/history/restore','POST',{path:name,id:legacy.id})).status,409);assert.equal((await request('/api/history/restore','POST',{path:name,id:123})).status,409);}
 assert.equal(fs.readFileSync(path.join(oldDir,'123.md'),'utf8'),'legacy ambiguous');
 const store=createHistoryStore(HOME);for(let i=0;i<25;i++)store.snapshot(VAULT,'a b.md','retention '+i);assert.equal(store.list(VAULT,'a b.md').filter(i=>!i.legacy).length,20);
 const v2=path.join(HOME,'history-v2');let identityFile;for(const vaultDir of fs.readdirSync(v2))for(const noteDir of fs.readdirSync(path.join(v2,vaultDir))){const file=path.join(v2,vaultDir,noteDir,'identity.json');if(JSON.parse(fs.readFileSync(file)).path==='空 格.md')identityFile=file;}
 const identity=fs.readFileSync(identityFile);fs.writeFileSync(identityFile,JSON.stringify({version:2,root:VAULT,path:'a_b.md'}));assert.equal((await request('/api/history?path='+encodeURIComponent('空 格.md'))).status,409);fs.writeFileSync(identityFile,identity);
 console.log('PASS 空格/下划线/Unicode/同名历史隔离、恢复、20 份保留；旧历史可读但禁止不确定恢复，元数据串改拒绝');
 assert.equal((await request('/api/vault/open','POST',{path:HOME})).status,200);
 for(const rel of ['tracery.config.json',path.relative(HOME,identityFile).replaceAll('\\','/'),path.relative(HOME,path.join(oldDir,'123.md')).replaceAll('\\','/')])assert.equal((await request('/api/file?path='+encodeURIComponent(rel))).status,403,rel);
 assert.equal((await request('/api/search?q='+encodeURIComponent('retention 24'))).data.results.length,0);
 assert.equal((await request('/api/search?q='+secret)).data.results.length,0);
 console.log('PASS 仓库与应用数据目录重叠时，配置及本机历史仍不可下载或搜索');
}finally{server.kill();}
