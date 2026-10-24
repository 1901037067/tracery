import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { launchBrowser } from './browser.mjs';
import { openLayoutSettings } from './settings-entry.mjs';
const ROOT=path.resolve(import.meta.dirname,'..'), HOME=fs.mkdtempSync(path.join(os.tmpdir(),'tracery-workspaces-')), VAULT=path.join(HOME,'vault'), OTHER=path.join(HOME,'other'), OUT=path.join(ROOT,'dist/workspaces');
fs.mkdirSync(VAULT);fs.mkdirSync(OTHER);fs.mkdirSync(OUT,{recursive:true});
const source='# 课堂笔记\n\n'+Array.from({length:220},(_,i)=>`第 ${i} 段复习资料。\n`).join('\n');
for(const name of ['课堂.md','复习.md','写作.md'])fs.writeFileSync(path.join(VAULT,name),source);
fs.writeFileSync(path.join(OTHER,'其他.md'),'# 其他库');
fs.writeFileSync(path.join(HOME,'tracery.config.json'),JSON.stringify({currentVault:VAULT,settings:{themeMode:'light'}}));
const BASE='http://localhost:9647',sleep=ms=>new Promise(r=>setTimeout(r,ms)),packed=process.env.TRACERY_TEST_EXE;
const server=spawn(packed||process.execPath,[packed?path.join(path.dirname(packed),'resources/app.asar/server/server.js'):'server/server.js'],{cwd:ROOT,env:{...process.env,TRACERY_HOME:HOME,PORT:'9647',...(packed?{ELECTRON_RUN_AS_NODE:'1'}:{})},windowsHide:true,stdio:'pipe'});let browser;
try{
 for(let i=0;i<90;i++){try{if((await fetch(BASE+'/api/state')).ok)break;}catch{}await sleep(150);}
 browser=await launchBrowser({width:1440,height:940});const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const ready=()=>page.waitForFunction(()=>typeof document.getElementById('btn-tab-more').onclick==='function'&&window.__tracery?.state.currentPath);
 await page.goto(BASE,{waitUntil:'networkidle0'});await ready();
 // 所有导航状态下同一行的位置均不变，分割线/工具行在按钮下方。
 const positions=[];
 for(const pane of ['library','pinned','recent','groups']){
  await page.click(`[data-pane-id="${pane}"]`);await sleep(60);
  positions.push(await page.$eval('.library-tabs',el=>{const r=el.getBoundingClientRect();return {top:r.top,height:r.height};}));
  await page.screenshot({path:path.join(OUT,`sidebar-${pane}.png`)});
  if(pane==='library')assert.ok(await page.evaluate(()=>document.querySelector('.panel-actions').getBoundingClientRect().top>=document.querySelector('.library-tabs').getBoundingClientRect().bottom));
 }
 assert.ok(positions.every(p=>p.top===positions[0].top&&p.height===positions[0].height));
 assert.ok(await page.evaluate(()=>Math.abs(document.querySelector('.library-tabs').getBoundingClientRect().top+16-document.querySelector('.ribbon-btn[data-panel="files"]').getBoundingClientRect().top-18)<=2));
 console.log('PASS 四种侧栏导航高度固定、对齐功能栏、分割线无交叉');
 await page.evaluate(()=>{const root=window.__tracery.state.vault.root;localStorage.setItem(`tracery.tabs.${root}`,JSON.stringify({tabs:['课堂.md','复习.md','写作.md'],active:0,groups:[{id:'class',name:'课堂资料',color:'teal',tabs:['课堂.md','复习.md'],collapsed:false}]}));localStorage.setItem('tracery.layoutPresets',JSON.stringify([{id:'legacy',name:'旧布局',layout:{leftWidth:280}}]));});
 await page.reload({waitUntil:'networkidle0'});await ready();
 await page.evaluate(async()=>{const {updateSettings}=await import('/js/settings.js');updateSettings({layout:{leftWidth:285,navigationSide:'right',panels:{navigation:['pinned','library','recent','groups'],context:['outline','links','info']}}});const {panelDock}=await import('/js/pane-docking.js');panelDock().select('pinned');window.__editor.setMode('source');window.__editor.view.dispatch({selection:{anchor:150}});});
 await sleep(200);await page.evaluate(()=>window.__editor.view.scrollDOM.scrollTop=1800);await sleep(250);
 const savedTop=await page.evaluate(()=>window.__editor.view.scrollDOM.scrollTop);assert.ok(savedTop>1000);
 await openLayoutSettings(page);
 assert.ok(await page.$eval('#layout-preset-select',el=>[...el.options].some(o=>o.textContent==='旧布局')));
 const save=async name=>{await page.click('#layout-preset-save');await page.waitForFunction(()=>document.querySelector('.dialog-input')===document.activeElement);await sleep(180);await page.$eval('.dialog-input',el=>el.value='');await page.type('.dialog-input',name);await page.click('.dialog-ok');await page.waitForFunction(name=>document.querySelector('#layout-preset-select').selectedOptions[0]?.textContent===name,{},name);};
 await save('上课');
 const snapshot=await page.evaluate(async()=> (await import('/js/layout-presets.js')).readPresets().find(p=>p.name==='上课'));
 assert.deepEqual(snapshot.session.tabs,['课堂.md','复习.md','写作.md']);assert.equal(snapshot.session.groups[0].color,'teal');assert.equal(snapshot.session.positions['课堂.md'].top,savedTop);assert.equal(snapshot.session.dock.navigation,'pinned');
 await page.screenshot({path:path.join(OUT,'workspace-settings.png')});await page.click('#set-done');
 await page.evaluate(async()=>{const {updateSettings}=await import('/js/settings.js');updateSettings({layout:{navigationSide:'left',leftWidth:240}});await window.__tracery.openNote('写作.md');window.__editor.view.scrollDOM.scrollTop=0;});
 const choose=async name=>{await page.click('#btn-tab-more');await page.evaluate(name=>[...document.querySelectorAll('.context-menu button')].find(b=>b.textContent.includes('工作区：'+name)).click(),name);};
 await choose('上课');await page.waitForFunction(()=>window.__tracery.state.currentPath==='课堂.md'&&window.__editor.mode==='source'&&window.__editor.view.scrollDOM.scrollTop>1000);await sleep(150);
 assert.ok(Math.abs(await page.evaluate(()=>window.__editor.view.scrollDOM.scrollTop)-savedTop)<5);
 assert.equal(await page.evaluate(()=>window.__tracery.state.settings.layout.navigationSide),'right');assert.ok(await page.$eval('[data-pane-id="pinned"]',el=>el.getAttribute('aria-selected')==='true'));
 await page.screenshot({path:path.join(OUT,'workspace-restored.png')});
 await page.evaluate(async()=>{await window.__tracery.openNote('复习.md');window.__editor.setMode('read');window.__editor.view.scrollDOM.scrollTop=1100;});await sleep(150);
 await openLayoutSettings(page);await save('复习');await page.click('#set-done');await choose('上课');await sleep(200);await choose('复习');await page.waitForFunction(()=>window.__tracery.state.currentPath==='复习.md'&&window.__editor.isRead&&window.__editor.view.scrollDOM.scrollTop>900);
 console.log('PASS 工作区保存/一键切换恢复笔记、活动标签、分组颜色、侧栏位置及活动页签、阅读模式与位置');
 // 保存失败必须保留当前工作区与输入。
 await page.evaluate(()=>{const e=window.__editor;e.setMode('live');window.__workspaceSave=e.opts.onSave;e.opts.onSave=async()=>false;e.insertText('未保存的工作区输入');});
 const before=await page.evaluate(()=>({tabs:window.__tracery.state.tabs,layout:window.__tracery.state.settings.layout,path:window.__tracery.state.currentPath}));
 await choose('上课');await sleep(200);assert.deepEqual(await page.evaluate(()=>({tabs:window.__tracery.state.tabs,layout:window.__tracery.state.settings.layout,path:window.__tracery.state.currentPath})),before);assert.ok(await page.evaluate(()=>window.__editor.dirty));
 await page.evaluate(async()=>{window.__editor.opts.onSave=window.__workspaceSave;await window.__editor.flush();});
 console.log('PASS 保存失败阻止切换且保留未保存正文');
 // 缺失笔记、空工作区、旧格式/恶意路径、导出不包含正文和绝对路径。
 await page.evaluate(async()=>{const m=await import('/js/layout-presets.js'),items=m.readPresets();const item=items.find(p=>p.name==='上课');item.session.tabs.push('缺失.md');item.session.active='缺失.md';items.push({id:'empty',name:'空白',layout:item.layout,session:{tabs:[],groups:[]}});m.writePresets(items);});
 await choose('上课');await page.waitForFunction(()=>window.__tracery.state.currentPath==='课堂.md');assert.ok(!(await page.evaluate(()=>window.__tracery.state.tabs)).includes('缺失.md'));
 await choose('空白');await page.waitForFunction(()=>window.__tracery.state.tabs.length===0&&!document.getElementById('empty-note').hidden);
 const encoded=await page.evaluate(async()=>{const m=await import('/js/layout-presets.js');const old=m.decodePreset(JSON.stringify({format:'tracery-layout',version:1,name:'v1',layout:{}}));if(old.session!==null)throw Error('legacy');const clean=m.normalizeSession({tabs:['../evil.md','C:/evil.md','课堂.md','课堂.md'],positions:{'课堂.md':{top:Infinity,mode:'bad'}}});if(clean.tabs.length!==1||clean.positions['课堂.md'].mode!=='live')throw Error('unsafe import');return m.encodePreset(m.readPresets().find(p=>p.name==='上课'));});
 assert.ok(!encoded.includes(VAULT)&&!encoded.includes('第 200 段'));
 // 新库隔离，旧预设迁移只携带布局。
 await page.evaluate(async other=>{await window.__tracery.Api.openVault(other);},OTHER);await page.waitForFunction(root=>window.__tracery.state.vault.root===root,{},OTHER);await sleep(200);
 assert.deepEqual(await page.evaluate(async()=> (await import('/js/layout-presets.js')).readPresets().map(p=>p.name)),['旧布局']);
 await page.evaluate(async root=>{await window.__tracery.Api.openVault(root);},VAULT);await page.waitForFunction(root=>window.__tracery.state.vault.root===root,{},VAULT);await sleep(200);
 assert.ok(await page.evaluate(async()=> (await import('/js/layout-presets.js')).readPresets().some(p=>p.name==='上课')));
 await page.reload({waitUntil:'networkidle0'});await page.waitForFunction(()=>typeof document.getElementById('btn-tab-more').onclick==='function');await choose('复习');await page.waitForFunction(()=>window.__tracery.state.currentPath==='复习.md'&&window.__editor.isRead&&window.__editor.view.scrollDOM.scrollTop>900);await sleep(100);
 await page.evaluate(async()=>{window.__editor.setMode('live');await window.__tracery.openNote('课堂.md');});await sleep(120);assert.ok(await page.evaluate(()=>window.__editor.mode==='source'&&window.__editor.view.scrollDOM.scrollTop>1000));
 await page.evaluate(async()=>{const m=await import('/js/layout-presets.js'),item=m.readPresets().find(p=>p.name==='上课'),roundTrip=m.decodePreset(m.encodePreset(item));if(JSON.stringify(item.session)!==JSON.stringify(roundTrip.session))throw Error('session round trip');const original=Storage.prototype.setItem;try{m.setWorkspaceRoot(()=> 'quota-test');Storage.prototype.setItem=function(key,...args){if(key.startsWith('tracery.workspaces.'))throw new DOMException('full','QuotaExceededError');return original.call(this,key,...args);};if(!m.readPresets().some(p=>p.name==='旧布局'))throw Error('quota migration lost legacy');}finally{Storage.prototype.setItem=original;m.setWorkspaceRoot(()=>window.__tracery.state.vault.root);}});
 assert.deepEqual(errors,[]);assert.equal(fs.readFileSync(path.join(VAULT,'课堂.md'),'utf8'),source);assert.equal(fs.readFileSync(path.join(VAULT,'写作.md'),'utf8'),source);
 console.log('PASS 缺失笔记跳过、空工作区、旧预设迁移与格式校验、笔记库隔离、刷新持久化、无正文导出');
}finally{await browser?.close();server.kill();}
