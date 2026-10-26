import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {launchBrowser} from './browser.mjs';
import {waitForApp,waitForNote,waitForSaved} from './waits.mjs';
const ROOT=path.resolve(import.meta.dirname,'..'),HOME=fs.mkdtempSync(path.join(os.tmpdir(),'tracery-fence-selection-')),VAULT=path.join(HOME,'vault');fs.mkdirSync(VAULT);
const doc='before\n\n```js\nlet value = 1\n```\n\n| head |\n| --- |\n| cell |\n\nafter';fs.writeFileSync(path.join(VAULT,'fence.md'),doc);fs.writeFileSync(path.join(HOME,'tracery.config.json'),JSON.stringify({currentVault:VAULT}));
const viewportDoc='# viewport-head\n\n**head-bold**\n\n'+'padding paragraph\n\n'.repeat(1000)+'# viewport-tail\n\n> viewport quote\n\n- **tail-bold**\n';fs.writeFileSync(path.join(VAULT,'viewport.md'),viewportDoc);
const PORT=9671,BASE=`http://127.0.0.1:${PORT}`,server=spawn(process.execPath,[path.join(ROOT,'server/server.js')],{env:{...process.env,PORT:String(PORT),TRACERY_HOME:HOME},windowsHide:true,stdio:'ignore'});let browser;
try{
 for(let i=0;i<100;i++){try{if((await fetch(BASE+'/api/state')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 browser=await launchBrowser({width:1440,height:1000});const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(BASE,{waitUntil:'domcontentloaded'});await waitForApp(page);await page.evaluate(()=>window.__tracery.openNote('fence.md'));await waitForNote(page,'fence.md',doc);
 await page.evaluate(()=>{window.__tracery.editor.setMode('live');window.__tracery.editor.view.dispatch({selection:{anchor:0}});});
 const fences=()=>page.$$eval('.cm-line',lines=>lines.filter(line=>line.textContent.includes('```')).length);assert.equal(await fences(),0);
 const box=await page.$$eval('.cm-line',lines=>{const line=lines.find(line=>line.textContent.includes('let value'));const r=line.getBoundingClientRect();return {x:r.left+20,y:r.top+r.height/2};});await page.mouse.click(box.x,box.y);
 await page.waitForFunction(()=>[...document.querySelectorAll('.cm-line')].filter(line=>line.textContent.includes('```')).length===2);
 await page.keyboard.down('Control');await page.keyboard.press('Home');await page.keyboard.up('Control');await page.waitForFunction(()=>![...document.querySelectorAll('.cm-line')].some(line=>line.textContent.includes('```')));
 await page.evaluate(()=>window.__tracery.editor.setMode('read'));assert.equal(await fences(),0);assert.equal(await page.evaluate(()=>window.__tracery.editor.getContent()),doc);assert.equal(fs.readFileSync(path.join(VAULT,'fence.md'),'utf8'),doc);assert.deepEqual(errors,[]);
 console.log('PASS 真实鼠标进入代码块显示围栏、键盘离开收起、阅读模式与磁盘正文保持不变');
 let held;await page.setRequestInterception(true);page.on('request',request=>{if(request.method()==='PUT'&&new URL(request.url()).pathname==='/api/note')held=request;else request.continue();});
 await page.evaluate(()=>{const editor=window.__tracery.editor;editor.setMode('source');editor.setAutosave(0);editor.insertText('semantic-save\n');});
 const deadline=Date.now()+10000;while(!held&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));assert.ok(held);
 let completed=false;const expected=await page.evaluate(()=>window.__tracery.editor.getContent()),saved=waitForSaved(page,'fence.md',expected).then(()=>{completed=true;});
 await page.waitForFunction(()=>window.__tracery.editor.dirty);assert.equal(completed,false);assert.equal(fs.readFileSync(path.join(VAULT,'fence.md'),'utf8'),doc);
 await held.continue();await saved;assert.equal(fs.readFileSync(path.join(VAULT,'fence.md'),'utf8'),expected);
 console.log('PASS 自动保存响应被挂起时语义等待不会提前通过，放行后以磁盘正文验收');
 await page.evaluate(()=>window.__tracery.openNote('viewport.md'));await waitForNote(page,'viewport.md',viewportDoc);
 await page.evaluate(()=>window.__tracery.editor.scrollToHeading('viewport-tail'));
 await page.waitForFunction(()=>[...document.querySelectorAll('.cm-lp-h1')].some(el=>el.textContent.includes('viewport-tail'))&&[...document.querySelectorAll('.cm-lp-quote')].some(el=>el.textContent.includes('viewport quote'))&&[...document.querySelectorAll('.cm-lp-bold')].some(el=>el.textContent==='tail-bold'));
 await page.evaluate(()=>window.__tracery.editor.scrollToHeading('viewport-head'));
 await page.waitForFunction(()=>[...document.querySelectorAll('.cm-lp-h1')].some(el=>el.textContent.includes('viewport-head'))&&[...document.querySelectorAll('.cm-lp-bold')].some(el=>el.textContent==='head-bold'));
 assert.deepEqual(errors,[]);assert.equal(fs.readFileSync(path.join(VAULT,'viewport.md'),'utf8'),viewportDoc);
 console.log('PASS 长文跨视口往返后标题、引用和列表内粗体恢复，磁盘正文不变');
}finally{await browser?.close();server.kill();}
