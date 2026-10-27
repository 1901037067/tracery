import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import WebSocket from 'ws';
import {watchDirectories} from '../server/directory-watcher.js';

const ROOT=path.resolve(import.meta.dirname,'..'),HOME=fs.mkdtempSync(path.join(os.tmpdir(),'tracery-watch-')),VAULT=path.join(HOME,'vault');
fs.mkdirSync(VAULT);const target=path.join(VAULT,'atomic.md');fs.writeFileSync(target,'initial');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(condition,label,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){if(await condition())return;await sleep(25);}throw Error('等待失败：'+label);}
const events=[],nativeEvents=[],errors=[];
const observed=(list,event,file)=>{let content;try{content=fs.readFileSync(path.join(VAULT,file),'utf8');}catch{}list.push({event,file,content});};
let native;
if(process.platform==='linux')try{native=fs.watch(VAULT,{recursive:true},(event,file)=>observed(nativeEvents,event,String(file)));}catch{}
const watcher=watchDirectories(VAULT,[],(event,file)=>observed(events,event,file),error=>errors.push(error.message));
try {
  const temporary=path.join(VAULT,'pending');fs.writeFileSync(temporary,'atomic replacement');fs.renameSync(temporary,target);
  await until(()=>events.some(event=>event.file==='atomic.md'&&event.content==='atomic replacement'),'原子替换事件');
  // 留出操作系统交付前一次 rename 事件的时间，再独立测试后续原地编辑。
  await sleep(250);events.length=0;nativeEvents.length=0;fs.writeFileSync(target,'external in-place edit');
  await until(()=>events.some(event=>event.file==='atomic.md'&&event.event==='change'&&event.content==='external in-place edit'),'原子替换后的原地编辑');
  await sleep(100);console.log('观察：Node 原生递归监听后续事件 '+(native?nativeEvents.filter(event=>event.file==='atomic.md').length:'未启用（仅 Linux 对照）')+'，目录监听后续事件 '+events.filter(event=>event.file==='atomic.md').length);
  fs.mkdirSync(path.join(VAULT,'new/sub'),{recursive:true});watcher.sync(['new','new/sub']);
  fs.writeFileSync(path.join(VAULT,'new/sub/nested.md'),'nested sentinel');
  await until(()=>events.some(event=>event.file==='new/sub/nested.md'&&event.content==='nested sentinel'),'新增子目录相对路径');
  watcher.sync([]);assert.deepEqual(errors,[]);
  console.log('PASS 目录监听跨原子替换仍收到原地写入，新增子目录可加入及移除监听');
} finally {watcher.close();native?.close();}
fs.writeFileSync(path.join(HOME,'tracery.config.json'),JSON.stringify({currentVault:VAULT}));
const PORT=9676,BASE='http://127.0.0.1:'+PORT,server=spawn(process.execPath,[path.join(ROOT,'server/server.js')],{env:{...process.env,PORT:String(PORT),TRACERY_HOME:HOME},windowsHide:true,stdio:'pipe'});
let serverLog='',socket;for(const stream of [server.stdout,server.stderr])stream.on('data',chunk=>{serverLog=(serverLog+chunk).slice(-5000);});
try {
  await until(async()=>{try{return (await fetch(BASE+'/api/state')).ok;}catch{return false;}},'服务器就绪');
  socket=new WebSocket(BASE.replace('http:','ws:')+'/ws',{origin:BASE});
  await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
  const messages=[];socket.on('message',data=>messages.push(JSON.parse(String(data))));
  for(const marker of ['first','second']) {
    const response=await fetch(BASE+'/api/note',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:'atomic.md',content:'safe-save-'+marker})});assert.equal(response.status,200);
    // 服务端 120ms 防抖必须先消费安全保存的 rename，防止旧事件替后续写入兜底。
    await sleep(300);const offset=messages.length,content='outside-'+marker;fs.writeFileSync(target,content);
    await until(()=>messages.slice(offset).some(message=>message.type==='fs-change'&&message.paths.some(file=>file==='atomic.md'||file==='*')),'安全保存后的真实磁盘通知');
    await until(async()=>{const data=await(await fetch(BASE+'/api/search?q='+content)).json();return data.results.some(row=>row.path==='atomic.md');},'外部编辑更新搜索索引');
  }
  fs.mkdirSync(path.join(VAULT,'added'));fs.writeFileSync(path.join(VAULT,'added/n.md'),'created subtree');
  await until(async()=>{const data=await(await fetch(BASE+'/api/search?q=created')).json();return data.results.some(row=>row.path==='added/n.md');},'外部新增目录建索引');
  await sleep(200);const offset=messages.length;fs.writeFileSync(path.join(VAULT,'added/n.md'),'updated subtree');
  await until(()=>messages.slice(offset).some(message=>message.type==='fs-change'&&message.paths.some(file=>file==='added/n.md'||file==='*')),'新增目录的持续监听');
  console.log('PASS 真实服务两次安全保存后外部编辑均推送 WebSocket 并更新索引，新目录后续修改可见');
}catch(error){console.error(serverLog);throw error;}finally{socket?.terminate();server.kill();}
