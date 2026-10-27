import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { launchBrowser } from './browser.mjs';
import { openLayoutSettings } from './settings-entry.mjs';
const ROOT=path.resolve(import.meta.dirname,'..'), HOME=fs.mkdtempSync(path.join(os.tmpdir(),'tracery-ui-refresh-')), VAULT=path.join(HOME,'vault');
fs.mkdirSync(VAULT); const names=['第一篇.md','第二篇.md','第三篇.md','第四篇.md'];
for(const name of names)fs.writeFileSync(path.join(VAULT,name),'# '+name+'\n原始正文');
fs.writeFileSync(path.join(HOME,'tracery.config.json'),JSON.stringify({currentVault:VAULT,settings:{themeMode:'light'}}));
const OUT=path.join(ROOT,'dist/ui-refresh');fs.mkdirSync(OUT,{recursive:true});
const BASE='http://localhost:9646',sleep=ms=>new Promise(r=>setTimeout(r,ms));
const packed=process.env.TRACERY_TEST_EXE;
const server=spawn(packed||process.execPath,[packed?path.join(path.dirname(packed),'resources/app.asar/server/server.js'):'server/server.js'],{cwd:ROOT,env:{...process.env,PORT:'9646',TRACERY_HOME:HOME,...(packed?{ELECTRON_RUN_AS_NODE:'1'}:{})},windowsHide:true,stdio:'pipe'});let browser;
try{
  for(let i=0;i<80;i++){try{if((await fetch(BASE+'/api/state')).ok)break;}catch{}await sleep(150);}
  browser=await launchBrowser({width:1440,height:940});const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(BASE,{waitUntil:'networkidle0'});await page.waitForFunction(()=>typeof document.getElementById('btn-tab-more').onclick==='function');
  assert.equal(await page.$('#btn-layout'),null);await openLayoutSettings(page);
  const nav=await page.$$eval('.settings-nav button',els=>els.map(el=>{const icon=el.querySelector('svg').getBoundingClientRect(),text=el.querySelector('span').getBoundingClientRect();return {icons:el.querySelectorAll('svg').length,aligned:text.left>icon.right};}));
  assert.equal(nav.length,8);assert.ok(nav.every(n=>n.icons===1&&n.aligned));
  assert.equal(await page.$$eval('#settings select:not([hidden])',els=>els.length),0);
  for(const name of ['Alpha','Beta']){await page.click('#layout-preset-save');await page.waitForSelector('.dialog-backdrop:not([hidden]) .dialog-input');await page.waitForFunction(()=>document.activeElement?.classList.contains('dialog-input'));await sleep(180);await page.$eval('.dialog-input',el=>{el.value='';});await page.type('.dialog-input',name);await page.click('.dialog-ok');await page.waitForFunction(name=>document.querySelector('#layout-preset-select').selectedOptions[0]?.textContent===name,{},name);}
  const preset='.select-trigger[aria-label="工作区"]';
  await page.click(preset);await page.waitForSelector('.select-popover');await page.keyboard.press('Home');await page.keyboard.press('Enter');
  assert.ok(await page.$eval('#layout-preset-apply',el=>el.disabled));
  await page.click(preset);await page.keyboard.press('b');await page.keyboard.press('Enter');
  assert.equal(await page.$eval(preset,el=>el.textContent),'Beta');
  await page.click(preset);await page.keyboard.press('Escape');assert.equal(await page.$('.select-popover'),null);assert.ok(await page.$eval('#settings',el=>!el.hidden));
  for(const [themeName,themeMode]of [['apple','light'],['obsidian','dark']]){
    await page.evaluate(patch=>window.__tracery.Api.saveSettings(patch),{themeName,themeMode});await sleep(250);await page.click(preset);
    const rect=await page.$eval('.select-popover',el=>({r:el.getBoundingClientRect().toJSON(),radius:parseFloat(getComputedStyle(el).borderRadius)}));assert.ok(rect.radius>=8&&rect.r.right<=1440&&rect.r.bottom<=940);
    await sleep(170);await page.screenshot({path:path.join(OUT,`settings-${themeName}-${themeMode}.png`)});await page.keyboard.press('Escape');
  }
  await page.$eval('[data-pane-control="pinned"]',el=>el.scrollIntoView({block:'center'}));
  await page.click('[data-pane-control="pinned"] .select-trigger');
  const option=await page.evaluateHandle(()=>[...document.querySelectorAll('.select-option')].find(el=>el.textContent.includes('辅助侧栏')));await option.asElement().click();await option.dispose();
  await page.waitForFunction(()=>window.__tracery.state.settings.layout.panels.context.includes('pinned'));
  assert.ok(await page.$eval('[data-pane-control="pinned"] .select-value',el=>el.textContent.includes('辅助侧栏')));
  await page.setViewport({width:390,height:844});await page.$eval('.settings-pane.active',el=>el.scrollTop=0);await page.click(preset);
  const mobile=await page.$eval('.select-popover',el=>el.getBoundingClientRect().toJSON());assert.ok(mobile.left>=0&&mobile.right<=390&&mobile.bottom<=844);
  await sleep(170);await page.screenshot({path:path.join(OUT,'settings-mobile.png')});await page.keyboard.press('Escape');
  await page.$eval('[data-pane-control="info"]',el=>el.scrollIntoView({block:'center'}));await page.click('[data-pane-control="info"] .select-trigger');
  const nearBottom=await page.$eval('.select-popover',el=>el.getBoundingClientRect().toJSON());assert.ok(nearBottom.top>=0&&nearBottom.bottom<=844);
  await page.keyboard.press('Escape');await page.setViewport({width:1440,height:940});
  await page.click('#set-done');console.log('PASS 删除顶部布局键、八组设置图标、自定义选单/键盘/禁用/主题/跨栏值同步');
  // 固定分组夹具，真实指针移动时不改变保存数据，松手结果与预览完全一致。
  await page.evaluate(names=>{const root=window.__tracery.state.vault.root;localStorage.setItem(`tracery.tabs.${root}`,JSON.stringify({tabs:names,active:0,groups:[{id:'g1',name:'课程',color:'teal',tabs:names.slice(0,2),collapsed:false},{id:'g2',name:'资料',color:'orange',tabs:[names[2]],collapsed:false}]}));},names);
  await page.reload({waitUntil:'networkidle0'});await page.waitForFunction(()=>document.querySelectorAll('.tab-group-header').length===2);await sleep(150);
  const state=()=>page.evaluate(()=>({tabs:[...window.__tracery.state.tabs],groups:JSON.parse(JSON.stringify(window.__tracery.state.tabGroups))}));
  const settled=()=>page.waitForFunction(()=>!document.getAnimations().some(animation=>animation.playState==='running'||animation.pending));
  const drag=async(source,target,ratio,file)=>{
    await settled();
    const before=await state(),a=await page.$eval(source,el=>el.getBoundingClientRect().toJSON()),b=await page.$eval(target,el=>el.getBoundingClientRect().toJSON());
    await page.mouse.move(a.left+a.width/2,a.top+a.height/2);await page.mouse.down();await page.mouse.move(b.left+b.width*ratio,b.top+b.height/2,{steps:16});await sleep(170);
    assert.deepEqual(await state(),before);
    const planned=await page.$$eval('.tab-drop-note',els=>els.map(el=>el.dataset.key));
    if(!planned.length){await page.screenshot({path:path.join(OUT,'drag-failure.png')});console.log('drag geometry',JSON.stringify({source,target,a,b,hit:await page.evaluate(({a,b,ratio})=>({source:document.elementFromPoint(a.left+a.width/2,a.top+a.height/2)?.outerHTML,target:document.elementFromPoint(b.left+b.width*ratio,b.top+b.height/2)?.outerHTML,animations:document.getAnimations().map(animation=>animation.playState)}),{a,b,ratio})}));}
    assert.ok(planned.length);
    assert.ok(await page.$('.tab-drop-marker'));assert.ok(await page.$eval('.tab-drop-caption',el=>el.textContent.includes('松开后')));
    await page.screenshot({path:path.join(OUT,file)});await page.mouse.up();await sleep(80);
    const after=await state(),visible=after.tabs.filter(key=>!after.groups.some(g=>g.collapsed&&g.tabs.includes(key)));assert.deepEqual(visible,planned);
    assert.equal(await page.$('.tab-drag-preview'),null);return after;
  };
  let after=await drag('.tab[data-index="3"]','.tab[data-index="0"]',.1,'tab-drop-preview.png');assert.equal(after.tabs[0],names[3]);
  after=await drag('.tab-group-header[data-group="g1"]','.tab-group-header[data-group="g2"]',.9,'group-drop-preview.png');assert.equal(after.tabs[0],names[2]);
  await page.click('.tab-group-header[data-group="g2"]');
  await page.waitForFunction(()=>window.__tracery.state.tabGroups.find(group=>group.id==='g2').collapsed);await settled();
  const index=after.tabs.indexOf(names[0]);after=await drag(`.tab[data-index="${index}"]`,'.tab-group-header[data-group="g2"]',.5,'join-group-preview.png');assert.ok(after.groups.find(g=>g.id==='g2').tabs.includes(names[0]));
  const beforeCancel=await state(),source=await page.$eval('.tab:not([hidden])',el=>el.getBoundingClientRect().toJSON());
  await page.mouse.move(source.left+source.width/2,source.top+source.height/2);await page.mouse.down();await page.mouse.move(800,300,{steps:10});await page.mouse.up();assert.deepEqual(await state(),beforeCancel);
  await page.reload({waitUntil:'networkidle0'});assert.deepEqual(await state(),beforeCancel);
  console.log('PASS 标签/整组让位与松手排列预览、折叠组接收、松手一致、取消及刷新恢复');
  await page.click('#btn-draw');await page.waitForSelector('.draw-overlay:not([hidden])');
  for(const width of [1440,1024,901,390]){
    await page.setViewport({width,height:940});await sleep(200);
    const geometry=await page.evaluate(()=>{const el=document.querySelector('.draw-tools'),r=el.getBoundingClientRect(),children=[...el.querySelectorAll('button')].map(el=>el.getBoundingClientRect().toJSON());return {scroll:el.scrollWidth,client:el.clientWidth,r:r.toJSON(),children,width:innerWidth};});
    assert.ok(geometry.scroll<=geometry.client+1,JSON.stringify(geometry));assert.ok(geometry.r.left>=0&&geometry.r.right<=width);
    assert.ok(geometry.children.every(r=>r.left>=geometry.r.left&&r.right<=geometry.r.right+1&&r.top>=geometry.r.top&&r.bottom<=geometry.r.bottom+1));
    await page.screenshot({path:path.join(OUT,`toolbar-${width}.png`)});
  }
  assert.deepEqual(errors,[]);for(const name of names)assert.equal(fs.readFileSync(path.join(VAULT,name),'utf8'),'# '+name+'\n原始正文');
  console.log('PASS 绘图工具全宽无滚动、窄屏自动换行、控件均可见、未修改笔记正文');
}finally{await browser?.close();server.kill();}
