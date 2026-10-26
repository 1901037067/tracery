import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import puppeteer from 'puppeteer-core';
import {waitForApp} from './waits.mjs';
import {pdfFixture} from './pdf-fixture.mjs';
const require=createRequire(import.meta.url),{startServerProcess}=require('../electron/server-process.cjs');
const ROOT=path.resolve(import.meta.dirname,'..'),HOME=fs.mkdtempSync(path.join(os.tmpdir(),'tracery-startup-')),VAULT=path.join(HOME,'vault'),PORT=9670;
fs.mkdirSync(VAULT);fs.writeFileSync(path.join(VAULT,'safe.md'),'# safe fixture');fs.writeFileSync(path.join(HOME,'tracery.config.json'),JSON.stringify({currentVault:VAULT}));
fs.writeFileSync(path.join(VAULT,'native.pdf'),pdfFixture());
const OUT=path.join(ROOT,'dist/startup-preview');fs.mkdirSync(OUT,{recursive:true});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(condition,label,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){if(await condition())return;await sleep(50);}throw Error('等待失败：'+label);}
const fixture=path.join(HOME,'ipc.cjs');fs.writeFileSync(fixture,`const nonce=process.env.TRACERY_START_TOKEN;for(const data of [{nonce:'wrong',pid:process.pid,port:${PORT}},{nonce,pid:process.pid+1,port:${PORT}},{nonce,pid:process.pid,port:${PORT+1}},{nonce,pid:process.pid,port:${PORT},valid:true}])process.send({type:'tracery-ready',...data});setInterval(()=>{},1000);`);
const ipc=startServerProcess({executable:process.execPath,entry:fixture,env:process.env,port:PORT});let validSeen=false;ipc.child.on('message',data=>{if(data.valid)validSeen=true;});await ipc.ready;assert.ok(validSeen);ipc.child.kill();
fs.writeFileSync(fixture,'setInterval(()=>{},1000);');const late=startServerProcess({executable:process.execPath,entry:fixture,env:process.env,port:PORT,timeout:300});await assert.rejects(late.ready,/超时/);assert.ok(late.child.killed);
console.log('PASS IPC 仅接受匹配的子进程 PID/随机身份/端口，超时终止本次子进程');
const env={...process.env,TRACERY_HOME:HOME,PORT:String(PORT)};delete env.ELECTRON_RUN_AS_NODE;
const APP=path.join(HOME,'app'),restoredFile=path.join(HOME,'restored.json'),childrenFile=path.join(HOME,'children.txt');fs.mkdirSync(APP);
fs.writeFileSync(path.join(APP,'package.json'),JSON.stringify({name:'tracery-startup-fixture',version:'1.0.0',main:'main.cjs'}));
const wrapperError=path.join(HOME,'wrapper-error.txt');
fs.writeFileSync(path.join(APP,'main.cjs'),`const fs=require('node:fs');try{const cp=require('node:child_process'),{app}=require('electron');const spawn=cp.spawn;cp.spawn=(...args)=>{const child=spawn(...args);fs.appendFileSync(${JSON.stringify(childrenFile)},String(child.pid)+'\\n');return child;};app.on('browser-window-created',(_,win)=>win.on('restore',()=>fs.writeFileSync(${JSON.stringify(restoredFile)},JSON.stringify({restored:true}))));require(${JSON.stringify(path.join(ROOT,'electron/main.cjs'))});}catch(error){fs.writeFileSync(${JSON.stringify(wrapperError)},error.stack);process.exit(1);}`);
const apps=[],browsers=[];
function launch(profile,cdp){const app=spawn(require('electron'),[APP,'--disable-gpu','--no-sandbox','--user-data-dir='+path.join(HOME,profile),'--remote-debugging-port='+cdp],{cwd:ROOT,env,windowsHide:true,stdio:['ignore','pipe','pipe']});apps.push(app);let log='';app.stdout.on('data',c=>log+=c);app.stderr.on('data',c=>log+=c);app.trace=()=>log;return app;}
async function connect(port){let browser;await until(async()=>{try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});return true;}catch{return false;}},'原生调试连接');browsers.push(browser);return browser;}
let occupied;
try{
 const primary=launch('primary-browser',9254),browser=await connect(9254);const target=await browser.waitForTarget(target=>target.url().startsWith(`http://localhost:${PORT}`));const page=await target.page();await waitForApp(page);
 await page.evaluate(()=>{globalThis.__nativeCspViolations=[];document.addEventListener('securitypolicyviolation',event=>globalThis.__nativeCspViolations.push(event.effectiveDirective));window.__tracery.openNote('native.pdf');});
 await page.waitForSelector('.pdf-viewer:not([hidden]) .pdf-frame');await page.waitForNetworkIdle({idleTime:500,timeout:15000});
 assert.deepEqual(await page.evaluate(()=>globalThis.__nativeCspViolations),[]);
 await page.bringToFront();await page.screenshot({path:path.join(OUT,'native-pdf-csp.png')});
 await page.evaluate(()=>window.__tracery.openNote('safe.md'));await page.waitForFunction(()=>window.__tracery.editor.path==='safe.md'&&!document.querySelector('.pdf-frame').getAttribute('src'));
 console.log('PASS 原生编辑区 PDF 在 CSP 下打开无违规，保留实际渲染截图供核验');
 await page.evaluate(()=>window.electronAPI.minimize());const second=launch('primary-browser',9255);await until(()=>second.exitCode!==null,'重复实例退出');assert.equal(second.exitCode,0,second.trace());assert.equal(primary.exitCode,null);
 await until(()=>fs.existsSync(restoredFile),'已有窗口从最小化恢复');assert.equal(JSON.parse(fs.readFileSync(restoredFile)).restored,true);
 assert.equal((await browser.pages()).filter(page=>page.url().includes(':'+PORT)).length,1);
 await page.evaluate(()=>window.electronAPI.close());await until(()=>primary.exitCode!==null,'主实例正常关闭');assert.equal(primary.exitCode,0);browser.disconnect();
 await until(async()=>{try{await fetch(`http://127.0.0.1:${PORT}/api/state`);return false;}catch{return true;}},'服务随窗口退出');
 console.log('PASS 重复实例退出并恢复已有窗口，不产生第二窗口；正常关闭仍结束服务');
 let foreignRequests=0;occupied=http.createServer((req,res)=>{foreignRequests++;res.setHeader('Content-Type','application/json');res.end('{"vault":{"name":"foreign"}}');});await new Promise((r,j)=>{occupied.once('error',j);occupied.listen(PORT,'127.0.0.1',r);});
 const failed=launch('failed-browser',9256),errorBrowser=await connect(9256);const errorTarget=await errorBrowser.waitForTarget(target=>target.url().startsWith('data:text/html'));const errorPage=await errorTarget.page();await errorPage.waitForSelector('#startup-error');
 assert.match(await errorPage.$eval('#startup-error',el=>el.textContent),/被占用/);assert.equal(foreignRequests,0);assert.ok((await errorBrowser.pages()).every(page=>!page.url().startsWith('http://localhost:'+PORT)));
 await errorPage.bringToFront();await errorPage.screenshot({path:path.join(OUT,'occupied-port.png')});await errorPage.close();await until(()=>failed.exitCode!==null,'错误窗口关闭');errorBrowser.disconnect();
 assert.equal(fs.readFileSync(path.join(VAULT,'safe.md'),'utf8'),'# safe fixture');
 console.log('PASS 端口占用时只显示启动错误，不请求或加载外部已有服务，笔记原件未变');
}catch(error){for(const app of apps)console.error('原生启动诊断',app.pid,app.exitCode,app.trace().slice(-5000));if(fs.existsSync(wrapperError))console.error(fs.readFileSync(wrapperError,'utf8'));throw error;}finally{
 for(const browser of browsers){try{for(const page of await browser.pages())if(page.url().includes(':'+PORT))await page.evaluate(()=>window.electronAPI?.close());}catch{}browser.disconnect();}
 try{await until(()=>apps.every(app=>app.exitCode!==null),'测试窗口清理',2000);}catch{}
 for(const app of apps)if(app.exitCode===null)app.kill();
 try{const state=await(await fetch(`http://127.0.0.1:${PORT}/api/state`,{signal:AbortSignal.timeout(500)})).json();if(state.vault?.root===VAULT&&fs.existsSync(childrenFile))for(const id of fs.readFileSync(childrenFile,'utf8').trim().split('\n')){try{process.kill(Number(id));}catch{}}}catch{}
 if(occupied)await new Promise(r=>occupied.close(r));
}
