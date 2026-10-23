import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { noteIndex, resolveNote, missingNotePath } from '../public/js/wiki-path.js';
import { launchBrowser } from './browser.mjs';
const ROOT = path.resolve(import.meta.dirname, '..'), HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tracery-path-tabs-'));
const VAULT = path.join(HOME, 'vault'), OUT = path.join(ROOT, 'dist/path-tabs-preview'); fs.mkdirSync(OUT, { recursive: true });
const content = '# 入口\n\n[[项目/计划]]\n\n[[./同级]]\n\n[[../共享/目标.md#章节|说明]]\n\n[[唯一]]\n\n[[同名]]\n';
const notes = { '笔记/入口.md': content, '笔记/同级.md': '# 同级', '项目/计划.md': '# 计划', '共享/目标.md': '# 目标\n\n## 章节\n正文',
  '资料/唯一.markdown': '# 唯一', '甲/同名.md': '# 甲', '乙/同名.md': '# 乙' };
for (const [rel, text] of Object.entries(notes)) { fs.mkdirSync(path.dirname(path.join(VAULT, rel)), { recursive: true }); fs.writeFileSync(path.join(VAULT, rel), text); }
const index = noteIndex(Object.keys(notes));
for (const [raw, expected] of [['项目/计划', '项目/计划.md'], ['./同级', '笔记/同级.md'], ['../共享/目标.md#章节|说明', '共享/目标.md'],
  ['唯一', '资料/唯一.markdown'], ['同名', null], ['不存在/计划', null], ['../../越界', null], ['#本页', '笔记/入口.md']]) {
  assert.equal(resolveNote(raw, '笔记/入口.md', index), expected);
}
assert.equal(missingNotePath('./新文件夹/新笔记', '笔记/入口.md'), '笔记/新文件夹/新笔记.md');
assert.equal(missingNotePath('../../越界', '笔记/入口.md'), null);
const PORT = 9633, BASE = `http://127.0.0.1:${PORT}`, sleep = ms => new Promise(r => setTimeout(r, ms));
fs.writeFileSync(path.join(HOME, 'tracery.config.json'), JSON.stringify({ currentVault: VAULT }));
const packed = process.env.TRACERY_TEST_EXE, entry = packed ? path.join(path.dirname(packed), 'resources/app.asar/server/server.js') : path.join(ROOT, 'server/server.js');
const server = spawn(packed || process.execPath, [entry], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), TRACERY_HOME: HOME, ...(packed ? { ELECTRON_RUN_AS_NODE:'1' } : {}) }, stdio:'pipe', windowsHide:true });
let browser;
try {
  for (let i=0;i<80;i++) { try { if ((await fetch(BASE+'/api/state')).ok) break; } catch {} await sleep(200); }
  browser = await launchBrowser({width:1440,height:900}); const page = await browser.newPage(), errors=[]; page.on('pageerror', e=>errors.push(e.message));
  await page.goto(BASE,{waitUntil:'networkidle0'});
  for (const [raw, expected] of [['项目/计划','项目/计划.md'], ['./同级','笔记/同级.md'], ['../共享/目标.md#章节|说明','共享/目标.md'], ['唯一','资料/唯一.markdown']]) {
    await page.evaluate(async () => window.__tracery.openNote('笔记/入口.md'));
    await page.waitForFunction(raw => [...document.querySelectorAll('.cm-lp-wikilink')].some(e=>e.textContent===raw),{},raw);
    const point = await page.evaluate(raw=>{ const e=[...document.querySelectorAll('.cm-lp-wikilink')].find(e=>e.textContent===raw); const r=e.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,unresolved:e.classList.contains('cm-lp-unresolved')}; },raw);
    assert.equal(point.unresolved,false); await page.mouse.click(point.x,point.y);
    await page.waitForFunction(p=>window.__tracery.state.currentPath===p,{},expected);
    if (raw.includes('#')) await page.waitForFunction(()=>{const v=window.__tracery.editor.view;return v.state.doc.lineAt(v.state.selection.main.head).number===3;});
  }
  const links=await (await fetch(BASE+'/api/links?path='+encodeURIComponent('笔记/入口.md'))).json();
  assert.ok(links.outgoing.some(l=>l.resolved==='项目/计划.md'));
  assert.ok(links.unresolved.some(l=>l.raw==='同名'));
  console.log('PASS 绝对/相对路径、后缀、锚点别名和唯一名称；重名/越界不误跳；前后端一致与真实鼠标跳转');
  await page.click('#btn-draw'); await page.waitForSelector('.draw-overlay:not([hidden])');
  const canvas=await page.$eval('#draw-canvas',e=>e.getBoundingClientRect().toJSON());
  const x=canvas.left+400,y=canvas.top+250;
  await page.mouse.move(x,y); await page.mouse.down(); await page.mouse.move(x+160,y+110,{steps:8}); await sleep(60);
  const fill=await page.$eval('#draw-canvas',c=>{const d=devicePixelRatio; return [...c.getContext('2d').getImageData(435*d,285*d,1,1).data];});
  assert.ok(fill[2]>fill[0] && fill[0]<255,`框选区域未着色：${fill}`);
  await page.screenshot({path:path.join(OUT,'marquee.png')});
  await page.mouse.up(); await sleep(60);
  const cleared=await page.$eval('#draw-canvas',c=>{const d=devicePixelRatio; return [...c.getContext('2d').getImageData(435*d,285*d,1,1).data];});
  assert.ok(cleared[0]>=250 && cleared[1]>=250);
  await page.click('#draw-cancel');
  const blankHeader = await page.evaluate(() => {
    const list = document.querySelector('#tablist'), last = list.lastElementChild.getBoundingClientRect(), bounds = list.getBoundingClientRect();
    const plus = document.querySelector('#btn-tab-new').getBoundingClientRect(), more = document.querySelector('#btn-tab-more').getBoundingClientRect();
    return { gap: plus.left - last.right, dragGap: more.left - plus.right, region: getComputedStyle(list).getPropertyValue('-webkit-app-region'), tab: getComputedStyle(list.lastElementChild).getPropertyValue('-webkit-app-region'), more: getComputedStyle(document.querySelector('#btn-tab-more')).getPropertyValue('-webkit-app-region') };
  });
  assert.ok(blankHeader.gap <= 8); assert.ok(blankHeader.dragGap >= 96); assert.equal(blankHeader.region, 'drag'); assert.equal(blankHeader.tab, 'no-drag'); assert.equal(blankHeader.more, 'no-drag');
  await page.evaluate(async () => {for(let i=0;i<22;i++){const p=`很多标签 ${i}.md`;await window.__tracery.Api.createNote(p,'# 标签');await window.__tracery.openNote(p,null,{newTab:true});}});
  const header=()=>page.evaluate(()=>{const r=q=>document.querySelector(q).getBoundingClientRect().toJSON(); return {drag:r('.window-drag-space'),tabs:r('#tablist'),active:r('#tablist .tab.active'),controls:r('.titlebar-right'),region:getComputedStyle(document.querySelector('.window-drag-space')).getPropertyValue('-webkit-app-region'),scroll:document.getElementById('tablist').scrollWidth>document.getElementById('tablist').clientWidth};});
  for(const width of [1440,1024]) {await page.setViewport({width,height:900}); await sleep(150); const h=await header();assert.ok(h.drag.width>=95);assert.equal(h.region,'drag');assert.ok(h.tabs.right<=h.drag.left && h.drag.right<=h.controls.left);assert.equal(h.scroll,false);assert.ok(h.active.left>=h.tabs.left-1 && h.active.right<=h.tabs.right+1);}
  await page.screenshot({path:path.join(OUT,'many-tabs.png')});
  assert.deepEqual(errors,[]); console.log('PASS 空画布拖动也显示框选区域、松开清除；22 标签压缩且保留独立拖窗区');
}finally{await browser?.close();server.kill();}
