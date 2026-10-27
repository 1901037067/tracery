import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
import { launchBrowser } from './browser.mjs';
import { waitForLayout, waitForNote } from './waits.mjs';
import { readDiskNote, saveDiskNote, revisionOf } from '../server/note-store.js';
const ROOT = path.resolve(import.meta.dirname, '..'), HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tracery-reliability-'));
const VAULT = path.join(HOME, 'vault'), PORT = 9644, BASE = `http://localhost:${PORT}`;
const OUT = path.join(ROOT, 'dist/reliability'); fs.mkdirSync(OUT, { recursive: true }); fs.mkdirSync(VAULT);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const original = '# 可靠性\n\n原始内容';
for (const name of ['甲.md', '乙.md', '丙.md']) fs.writeFileSync(path.join(VAULT, name), original);
fs.writeFileSync(path.join(HOME, 'tracery.config.json'), JSON.stringify({ currentVault: VAULT }));
fs.writeFileSync(path.join(VAULT, 'BOM.md'), '\uFEFF# 编码标记');
await saveDiskNote(VAULT, 'BOM.md', '# 编码标记\n新内容', { expectedRevision: revisionOf('\uFEFF# 编码标记') });
assert.equal(await readDiskNote(VAULT, 'BOM.md'), '\uFEFF# 编码标记\n新内容');
// 写失败、落盘期间外部变化和同版本并发保存都不允许破坏原件。
await assert.rejects(saveDiskNote(VAULT, '甲.md', '不能落盘', { beforeCommit: () => { throw Error('模拟磁盘写入后故障'); } }));
assert.equal(await readDiskNote(VAULT, '甲.md'), original);
await assert.rejects(saveDiskNote(VAULT, '甲.md', '旧版本', { beforeCommit: () => fs.writeFileSync(path.join(VAULT, '甲.md'), '外部新版本') }), e => e.status === 409);
assert.equal(await readDiskNote(VAULT, '甲.md'), '外部新版本');
fs.writeFileSync(path.join(VAULT, '甲.md'), original);
const concurrent = await Promise.allSettled(['并发甲', '并发乙'].map(content => saveDiskNote(VAULT, '甲.md', content, { expectedRevision: revisionOf(original) })));
assert.equal(concurrent.filter(r => r.status === 'fulfilled').length, 1);
assert.equal(concurrent.find(r => r.status === 'rejected').reason.status, 409);
fs.writeFileSync(path.join(VAULT, '甲.md'), original);
// 在临时文件同步完成、替换原件前终止独立写入进程。
const childCode = `import {saveDiskNote} from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'server/note-store.js')).href)}; await saveDiskNote(${JSON.stringify(VAULT)}, '甲.md', '进程中止的新内容', {beforeCommit:()=>{console.log('STAGED');return new Promise(()=>setInterval(()=>{},1000));}});`;
const writer = spawn(process.execPath, ['--input-type=module', '-e', childCode], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((resolve, reject) => { writer.stdout.on('data', d => { if (String(d).includes('STAGED')) resolve(); }); writer.once('exit', code => reject(Error('写入探针提前退出 ' + code))); });
const killed = new Promise(resolve => writer.once('exit', resolve)); writer.kill(); await killed;
assert.equal(await readDiskNote(VAULT, '甲.md'), original);
console.log('PASS 同版本并发拒绝、写失败/外部插入修改/写入进程中止后原件完整');
const packed = process.env.TRACERY_TEST_EXE;
const server = spawn(packed || process.execPath, [packed ? path.join(path.dirname(packed), 'resources/app.asar/server/server.js') : path.join(ROOT, 'server/server.js')], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), TRACERY_HOME: HOME, ...(packed ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }, windowsHide: true, stdio: 'pipe' });
let browser;
let serverLog='';for(const stream of [server.stdout,server.stderr])stream.on('data',chunk=>{serverLog=(serverLog+chunk).slice(-6000);});
try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/api/state')).ok) break; } catch {} await sleep(150); }
  const unicode = '# 拆分边界\n世界中文与 emoji 👩‍💻📝';
  const body = Buffer.from(JSON.stringify({ path: '乙.md', content: unicode })), boundary = body.indexOf(Buffer.from('界')) + 1;
  await new Promise((resolve, reject) => {
    const req = http.request(BASE + '/api/note', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } }, res => { res.resume(); res.on('end', () => res.statusCode === 200 ? resolve() : reject(Error('分段请求失败 ' + res.statusCode))); });
    req.on('error', reject); req.write(body.subarray(0, boundary)); setTimeout(() => req.end(body.subarray(boundary)), 35);
  });
  assert.equal(fs.readFileSync(path.join(VAULT, '乙.md'), 'utf8'), unicode);
  console.log('PASS HTTP 分段强制切开汉字 UTF-8 字节，中文与 emoji 落盘无损');
  browser = await launchBrowser({ width: 1440, height: 940 }); let page = await browser.newPage(); const errors = [];
  await page.evaluateOnNewDocument(()=>{window.__connectionTrace=[];window.addEventListener('tracery:connection',event=>window.__connectionTrace.push(event.detail));document.addEventListener('securitypolicyviolation',event=>window.__connectionTrace.push({directive:event.effectiveDirective,blocked:event.blockedURI}));});
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  const booted = p => p.waitForFunction(() => window.__tracery && typeof document.getElementById('btn-tab-more').onclick === 'function'); await booted(page);
  await page.evaluate(async () => { await window.__tracery.openNote('甲.md'); window.__editor.setAutosave(60000); });
  let fail = true, slowRead = false, readHeld = false, releaseRead, holdAsset = false, assetHeld = false, releaseAsset;
  let staleReply, refreshHeld = false, releaseRefresh;
  await page.setRequestInterception(true);
  const fault = request => {
    const url = new URL(request.url());
    if (staleReply && request.method() === 'GET' && url.pathname === '/api/note' && url.searchParams.get('path') === '甲.md') { const body=staleReply; staleReply=null; refreshHeld=true; releaseRefresh=()=>request.respond({status:200,contentType:'application/json',body:JSON.stringify(body)}); }
    else if (holdAsset && request.method() === 'POST' && url.pathname === '/api/asset') { holdAsset=false; assetHeld=true; releaseAsset=()=>request.continue(); }
    else if (slowRead && request.method() === 'GET' && url.pathname === '/api/note' && url.searchParams.get('path') === '乙.md') { slowRead = false; readHeld = true; releaseRead = () => request.continue(); }
    else if (request.method() === 'PUT' && url.pathname === '/api/note' && fail) request.respond({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '模拟磁盘不可写' }) });
    else request.continue();
  };
  page.on('request', fault);
  await page.evaluate(() => window.__editor.insertText('未保存输入'));
  assert.equal(await page.evaluate(() => window.__editor.flush()), false);
  await page.evaluate(() => window.__tracery.openNote('乙.md'));
  assert.equal(await page.evaluate(() => window.__tracery.state.currentPath), '甲.md');
  await page.click('#tablist .tab.active .tab-close'); await sleep(180);
  assert.equal(await page.evaluate(() => window.__tracery.state.currentPath), '甲.md');
  assert.equal(await page.evaluate(() => window.__tracery.prepareClose()), false);
  assert.ok(await page.$eval('#save-notice', el => !el.hidden));
  await page.evaluate(() => { window.__setItem = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if (key.startsWith('tracery.unsaved:')) throw new DOMException('quota', 'QuotaExceededError'); return window.__setItem.call(this, key, value); }; window.__editor.insertText('配额故障输入'); });
  assert.equal(await page.evaluate(() => window.__editor.flush()), false);
  assert.ok(await page.$eval('#save-notice-text', el => el.textContent.includes('也未能保存')));
  await page.evaluate(() => { Storage.prototype.setItem = window.__setItem; delete window.__setItem; });
  assert.equal(fs.readFileSync(path.join(VAULT, '甲.md'), 'utf8'), original);
  fail = false; await page.click('#save-retry'); await page.waitForFunction(() => !window.__editor.dirty);
  assert.ok(fs.readFileSync(path.join(VAULT, '甲.md'), 'utf8').includes('未保存输入'));
  assert.ok(await page.$eval('#save-notice', el => el.hidden));
  console.log('PASS 保存失败拦截切换/关闭/退出、持续错误入口、重试成功才清除 dirty');
  // 读取下一篇的网络请求等待期间输入，不允许随后到达的响应抹掉这些字。
  slowRead = true;
  await page.evaluate(() => { window.__navigation = window.__tracery.openNote('乙.md', null, {newTab:true}); });
  for (let i = 0; i < 50 && !readHeld; i++) await sleep(30); assert.ok(readHeld);
  await page.evaluate(() => window.__editor.insertText('等待切换时继续输入')); releaseRead();
  await page.evaluate(() => window.__navigation);
  assert.ok(fs.readFileSync(path.join(VAULT, '甲.md'), 'utf8').includes('等待切换时继续输入'));
  assert.equal(await page.evaluate(() => window.__tracery.state.currentPath), '乙.md');
  await page.evaluate(() => window.__tracery.openNote('甲.md'));
  console.log('PASS 读取延迟时继续输入先落盘，再切换；存储配额故障明确提示');
  // 外部编辑和第二个窗口都不能被旧编辑内容覆盖。
  await page.evaluate(() => window.__editor.insertText('本地版本'));
  fs.writeFileSync(path.join(VAULT, '甲.md'), '磁盘外部版本');
  assert.equal(await page.evaluate(() => window.__editor.flush()), false);
  assert.equal(fs.readFileSync(path.join(VAULT, '甲.md'), 'utf8'), '磁盘外部版本');
  await page.screenshot({ path: path.join(OUT, 'save-conflict.png') });
  await page.click('#save-copy');
  await page.waitForFunction(() => document.getElementById('toast').textContent.startsWith('已保存副本'));
  assert.ok(fs.readdirSync(VAULT).some(name => name.includes('恢复副本') && fs.readFileSync(path.join(VAULT, name), 'utf8').includes('本地版本')));
  await page.click('#save-disk'); await page.waitForSelector('.dialog-ok'); await page.click('.dialog-ok');
  await page.waitForFunction(() => window.__editor.getContent() === '磁盘外部版本' && !window.__editor.dirty);
  await page.evaluate(() => window.__tracery.openRecoveryCenter()); await page.waitForSelector('#recovery-center textarea');
  assert.ok(await page.$eval('#recovery-center textarea', el => el.value.includes('本地版本')));
  await sleep(200); await page.screenshot({ path: path.join(OUT, 'recovery-center.png') });
  for (const [width,height] of [[390,844],[844,390]]) {
    await page.setViewport({width,height});
    // 等待应用处理 visualViewport.resize；setViewport 完成不代表 --app-height 已更新。
    await page.waitForFunction(height => Math.abs(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-height')) - height) < 1, {}, height);
    const bounds = await page.$eval('.recovery-card', el => {const r=el.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right};});
    assert.ok(bounds.top>=0 && bounds.bottom<=height && bounds.left>=0 && bounds.right<=width, JSON.stringify({width,height,bounds}));
    await page.screenshot({path:path.join(OUT,`recovery-${width}.png`)});
  }
  const downloads=path.join(OUT,'downloads'); fs.mkdirSync(downloads,{recursive:true});
  const downloadSession=await page.createCDPSession();await downloadSession.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});
  await page.click('#recovery-center .dialog-actions button:nth-child(1)');
  for(let i=0;i<50&&!fs.existsSync(path.join(downloads,'甲.md'));i++)await sleep(50);
  assert.ok(fs.readFileSync(path.join(downloads,'甲.md'),'utf8').includes('本地版本'));
  await page.click('#recovery-center .dialog-actions button:nth-child(2)');await page.waitForFunction(()=>!document.getElementById('recovery-center'));
  await page.evaluate(()=>window.__tracery.openRecoveryCenter());
  await page.click('#recovery-center .dialog-actions button:nth-child(3)');
  await page.click('.dialog-backdrop:not(#recovery-center):not([hidden]) .dialog-ok');
  await page.waitForFunction(()=>document.querySelector('#recovery-center .recovery-list').textContent.includes('没有待恢复'));
  await page.keyboard.press('Escape'); await page.setViewport({width:1440,height:940});
  await page.bringToFront();await waitForLayout(page);
  console.log('PASS 外部版本冲突保留双份内容、另存副本、查看磁盘与恢复中心预览');
  // 快速导航串行化；请求期间继续输入也要保存旧笔记的最新内容。
  await page.evaluate(async () => { await Promise.all(['乙.md','丙.md','甲.md'].map(name => window.__tracery.openNote(name, null, {newTab:true}))); });
  assert.equal(await page.evaluate(() => window.__tracery.state.currentPath), '甲.md');
  for (let i = 0; i < 15; i++) for (const name of ['乙.md','丙.md','甲.md']) {
    await page.evaluate(name=>window.__tracery.openNote(name),name);await waitForNote(page,name);
  }
  await page.evaluate(() => window.__editor.setMode('source'));
  const undoBefore = await page.evaluate(() => { window.__editor.insertText('撤销基线'); return window.__editor.getContent(); });
  await page.evaluate(() => window.__editor.flush()); await sleep(350);
  await page.evaluate(() => window.__editor.undo());
  assert.notEqual(await page.evaluate(() => window.__editor.getContent()), undoBefore);
  await page.evaluate(() => window.__editor.redo()); assert.equal(await page.evaluate(() => window.__editor.getContent()), undoBefore);
  await page.evaluate(() => window.__editor.flush());
  console.log('PASS 连续导航后标签与内容一致，自身保存通知不清空撤销历史');
  staleReply = await (await fetch(BASE + '/api/note?path=' + encodeURIComponent('甲.md'))).json();
  // 监听可回退为 5 秒轮询；等待真实读取请求，不能用 80×30ms 抢在轮询前判失败。
  const awaitedRefresh = page.waitForRequest(request => { const url = new URL(request.url()); return request.method() === 'GET' && url.pathname === '/api/note' && url.searchParams.get('path') === '甲.md'; }, { timeout: 15000 });
  // Linux 的递归文件监听不一定转发仅 utimes 的属性事件；实际重写同一正文，保持版本不变。
  fs.writeFileSync(path.join(VAULT, '甲.md'), fs.readFileSync(path.join(VAULT, '甲.md')));
  fs.utimesSync(path.join(VAULT, '甲.md'), new Date(), new Date(Date.now() + 3000));
  try { await awaitedRefresh; assert.ok(refreshHeld); }
  catch(error){console.error('刷新请求诊断',await page.evaluate(()=>({path:window.__tracery.state.currentPath,dirty:window.__editor.dirty,connection:window.__connectionTrace})),serverLog);throw error;}
  await page.evaluate(async () => { window.__editor.insertText('晚到刷新不回滚'); await window.__editor.flush(); });
  await releaseRefresh(); await sleep(200);
  assert.ok(await page.evaluate(() => window.__editor.getContent().includes('晚到刷新不回滚') && !window.__editor.dirty));
  console.log('PASS 文件通知的旧响应晚到，不覆盖此后已经保存的新输入');
  holdAsset = true;
  await page.evaluate(() => { window.__asset = window.__editor._onAssetFile(new File([new Uint8Array([137,80,78,71])], '延迟附件.png', {type:'image/png'})); });
  for (let i = 0; i < 60 && !assetHeld; i++) await sleep(30); assert.ok(assetHeld);
  await page.evaluate(() => window.__tracery.openNote('乙.md')); releaseAsset(); await page.evaluate(() => window.__asset);
  assert.ok(!await page.evaluate(() => window.__editor.getContent().includes('延迟附件')));
  assert.ok(fs.readdirSync(VAULT, {recursive:true}).some(name => name.endsWith('延迟附件.png')));
  const wrongRoot = await fetch(BASE + '/api/asset', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({vaultRoot:HOME,data:'data:image/png;base64,AQID',name:'错误仓库'})});
  assert.equal(wrongRoot.status,409);
  await page.evaluate(() => window.__tracery.openNote('甲.md'));
  console.log('PASS 延迟附件落在原目录且不插入新笔记，错误仓库的附件请求被拒绝');
  // 长文 + Chromium 输入法组合，再检查三种模式保真。
  const long = '# 长文\n\n' + '中文长文与链接 [[乙]]，保留标点和空格。\n'.repeat(5000);
  await page.evaluate(text => { const ed = window.__editor; ed.setAutosave(60000); ed.view.dispatch({changes:{from:0,to:ed.view.state.doc.length,insert:text},selection:{anchor:text.length}}); }, long);
  await page.focus('.cm-content'); const client = await page.createCDPSession();
  await client.send('Input.imeSetComposition', { text: 'zhongwen', selectionStart: 8, selectionEnd: 8 });
  assert.equal(await page.evaluate(() => window.__editor.flush()), false);
  await client.send('Input.insertText', { text: '中文输入法完成' }); await sleep(100);
  await page.evaluate(async () => { for(const mode of ['live','read','source']) window.__editor.setMode(mode); await window.__editor.flush(); });
  const longSaved = fs.readFileSync(path.join(VAULT, '甲.md'), 'utf8');
  assert.ok(longSaved.includes('中文输入法完成')); assert.ok(!longSaved.includes('zhongwen')); assert.ok(longSaved.startsWith('# 长文'));
  assert.ok(await page.evaluate(saved => window.__editor.getContent() === saved, longSaved), '长文编辑器与磁盘必须逐字一致');
  console.log('PASS 5000 行长文、真实输入法组合、模式切换与落盘一致');
  // 关闭渲染页绕过 beforeunload，重开后暂不恢复也不会被后续编辑抹掉。
  await page.evaluate(() => { window.__editor.setAutosave(60000); window.__editor.insertText('意外中止待恢复'); });
  fail = true;
  // SystemInfo 只列本套件独立浏览器实例的进程，不查找或终止用户浏览器。
  for (const targetPage of await browser.pages()) targetPage.on('error', () => {});
  const system = await browser.target().createCDPSession();
  const { processInfo } = await system.send('SystemInfo.getProcessInfo');
  const renderers = processInfo.filter(info => info.type === 'renderer'); assert.ok(renderers.length);
  for (const info of renderers) process.kill(info.id);
  await sleep(300);
  page = await browser.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE, {waitUntil:'networkidle0'}); await page.waitForSelector('.dialog-backdrop:not([hidden]) .dialog-cancel'); await page.click('.dialog-cancel'); await booted(page);
  await page.evaluate(async () => { window.__editor.insertText('新一轮输入'); await window.__editor.flush(); window.__tracery.openRecoveryCenter(); });
  const records = await page.evaluate(async () => (await import('/js/recovery.js')).listDrafts(window.__tracery.state.vault.root));
  assert.ok(records.some(item => item.content.includes('意外中止待恢复')));
  assert.deepEqual(errors, []);
  console.log('PASS 渲染页中止后恢复提示、暂不恢复后草稿仍可找回、全程无页面错误');
} finally { await browser?.close(); server.kill(); }
