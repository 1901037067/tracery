/* 真 UDP 5353 + 三个隔离应用：关闭旧广播后仍能发现 / 配对，不能把 fallback 当成 mDNS 测试通过。 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { Bonjour } from 'bonjour-service';
import puppeteer from 'puppeteer-core';
import { browse, advertise, serviceCandidate, reachable, SERVICE_TYPE } from '../server/mdns.js';
import { broadcastAddrs } from '../server/lan.js';
import { runtimeDependencies } from '../scripts/runtime-deps.mjs';
const ROOT = path.resolve(import.meta.dirname, '..'), TMP = path.join(os.tmpdir(), 'tracery-mdns-test');
if (!path.resolve(TMP).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('临时路径越界');
fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(TMP, { recursive: true });
const OUT = path.join(ROOT, 'dist/mdns-preview'); fs.mkdirSync(OUT, { recursive: true });
const A = 'http://127.0.0.1:9621', B = 'http://127.0.0.1:9622', C = 'http://127.0.0.1:9623';
const checks = [], procs = []; let browser, observer, observerBrowser, fakeHttp;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, detail = '') { checks.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); }
async function api(base, route, body) {
  const r = await fetch(base + route, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await r.json(); if (!r.ok) throw new Error(data.error); return data;
}
try {
  const subnets = broadcastAddrs([{ address: '10.2.3.4', netmask: '255.255.0.0' }, { address: '192.168.2.7', netmask: '255.255.254.0' }]);
  check('UDP 兼容发现使用真实子网掩码', subnets.includes('10.2.255.255') && subnets.includes('192.168.3.255'));
  const valid = { type: SERVICE_TYPE, protocol: 'tcp', txt: { app: 'tracery', v: '1', id: 'a'.repeat(32), device: '<设备>', vault: '仓库' }, port: 5000, addresses: ['127.0.0.1', '8.8.8.8'] };
  check('公告过滤不兼容协议、无效端口和公网探测地址', serviceCandidate(valid)?.addresses.length === 1 && !serviceCandidate({ ...valid, port: 0 }) && !serviceCandidate({ ...valid, txt: { ...valid.txt, v: '99' } }));
  let destroyed = 0;
  const unavailable = await browse({ factory: (fail) => { queueMicrotask(fail); return { find: () => Object.assign(new EventEmitter(), { stop() {} }), destroy: () => destroyed++ }; } });
  check('5353 绑定错误可降级并释放实例', !unavailable.available && destroyed === 1);
  const broken = await advertise({ id: 'a'.repeat(32), port: 5000 }, { factory: () => { throw new Error('占用'); } });
  check('公告创建失败不会崩溃', !broken.state.available);
  fakeHttp = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true,"app":"other-app"}'); });
  await new Promise((resolve) => fakeHttp.listen(0, '127.0.0.1', resolve));
  check('发现后拒绝冒充的非 Tracery HTTP 服务', !await reachable({ ...serviceCandidate(valid), port: fakeHttp.address().port }));
  fakeHttp.close(); fakeHttp = null;
  // 验证手工 repack 使用的完整运行时依赖闭包，不能借用项目根目录 node_modules。
  const deps = runtimeDependencies(ROOT), stage = path.join(TMP, 'runtime');
  for (const src of deps) { const dest = path.join(stage, path.relative(ROOT, src)); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.cpSync(src, dest, { recursive: true }); }
  const loaded = await import(pathToFileURL(path.join(stage, 'node_modules/bonjour-service/dist/index.js')));
  check('手工重打包收集 mDNS 的传递依赖', typeof loaded.default === 'function' && deps.some((d) => d.endsWith('dns-packet')) && deps.some((d) => d.endsWith('thunky')));
  observer = new Bonjour({}, () => {}); observer.server.mdns.on('error', () => {});
  const announced = [];
  observerBrowser = observer.find({ type: SERVICE_TYPE }, (s) => announced.push(s));
  for (const [key, port] of [['甲', 9621], ['乙', 9622], ['客户端', 9623]]) {
    const vault = path.join(TMP, key), home = path.join(TMP, 'home-' + key);
    fs.mkdirSync(vault); fs.mkdirSync(home);
    fs.writeFileSync(path.join(vault, key + '.md'), '# ' + key);
    fs.writeFileSync(path.join(home, 'tracery.config.json'), JSON.stringify({ currentVault: vault }));
    const proc = spawn(process.execPath, ['server/server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), TRACERY_HOME: home, TRACERY_DISABLE_LAN_UDP: '1', TRACERY_DISABLE_MDNS: '0' }, stdio: 'pipe' });
    proc.stderr.on('data', (d) => process.stderr.write(String(d))); procs.push(proc);
  }
  await Promise.all([A, B, C].map(async (base) => { for (let i = 0; i < 60; i++) { try { await api(base, '/api/state'); return; } catch {} await sleep(200); } throw new Error('启动超时'); }));
  const [hostA, hostB] = await Promise.all([api(A, '/api/sync/lan/start', {}), api(B, '/api/sync/lan/start', {})]);
  check('两个主机使用真实 mDNS，旧 UDP 广播已关闭', hostA.lan.mdns.available && hostB.lan.mdns.available && !hostA.lan.legacyAvailable && !hostB.lan.legacyAvailable);
  const found = await api(C, '/api/sync/lan/devices');
  const peers = found.devices.filter((d) => ['甲', '乙'].includes(d.vault));
  check('相同设备名的两个仓库可分别发现', peers.length === 2 && peers[0].id !== peers[1].id && peers.every((d) => d.source === 'mdns'), JSON.stringify(peers));
  const target = peers.find((d) => d.vault === '甲'); if (!target) throw new Error('未发现真实 mDNS 目标');
  const advertised = announced.filter((s) => s.txt?.id === target.id);
  check('DNS-SD TXT 和设备列表不包含通行码、token 或仓库绝对路径', advertised.length > 0 && advertised.every((s) => Object.keys(s.txt).sort().join(',') === 'app,device,id,v,vault') && !JSON.stringify(peers).includes(hostA.lan.code) && !JSON.stringify(peers).includes(TMP));
  const landing = await (await fetch(target.url)).text();
  check('共享 HTTP 状态页不泄露通行码', !landing.includes(hostA.lan.code));
  const again = await Promise.all([api(A, '/api/sync/lan/start', {}), api(A, '/api/sync/lan/start', {})]);
  check('重复开启共享保持同一会话', again.every((r) => r.lan.port === hostA.lan.port && r.lan.code === hostA.lan.code));
  browser = await puppeteer.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true, args: ['--no-sandbox'], defaultViewport: { width: 1280, height: 860, isMobile: true, hasTouch: true } });
  const page = await browser.newPage(), errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(C, { waitUntil: 'networkidle0' }); await page.click('#btn-settings');
  await page.click('.settings-nav [data-pane="sync"]');
  await page.waitForSelector(`#lan-peers [data-id="${target.id}"]`);
  check('设置面板自动展示附近设备', await page.$$eval('#lan-peers .lan-peer', (els) => els.length >= 2));
  await page.click(`#lan-peers [data-id="${target.id}"]`);
  await page.type('#lan-code-input', hostA.lan.code === '000000' ? '111111' : '000000');
  await page.click('#lan-find');
  await page.waitForFunction(() => !document.getElementById('lan-error').hidden);
  check('选择设备后仍需正确通行码', !(await api(C, '/api/sync/status')).configured && await page.$eval('#lan-error', (el) => /配对码/.test(el.textContent)));
  await page.screenshot({ path: path.join(OUT, 'nearby-devices.png') });
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.screenshot({ path: path.join(OUT, 'nearby-devices-mobile.png') });
  check('附近设备面板适配手机且不溢出', await page.$eval('.settings-box', (el) => el.scrollWidth <= el.clientWidth && document.documentElement.scrollWidth === innerWidth));
  await page.$eval('#lan-code-input', (el) => { el.value = ''; }); await page.type('#lan-code-input', hostA.lan.code);
  const pairing = page.waitForResponse((r) => r.url().endsWith('/api/sync/pair') && r.request().method() === 'POST');
  await page.tap('#lan-find'); await pairing;
  await page.waitForSelector('.sync-card');
  check('从真实 mDNS 列表配对并下载所选仓库', fs.existsSync(path.join(TMP, '客户端/甲.md')) && !fs.existsSync(path.join(TMP, '客户端/乙.md')));
  const hostPage = await browser.newPage(); await hostPage.goto(A, { waitUntil: 'networkidle0' }); await hostPage.click('#btn-settings'); await hostPage.click('.settings-nav [data-pane="sync"]');
  await hostPage.waitForSelector('.lan-banner');
  check('重新打开设置仍可看到共享通行码和停止按钮', await hostPage.$eval('.lan-banner', (el, code) => el.textContent.includes(code) && !!el.querySelector('#lan-stop'), hostA.lan.code));
  await api(B, '/api/sync/lan/stop', {});
  const afterStop = await api(C, '/api/sync/lan/devices');
  check('停止共享后设备退出列表', !afterStop.devices.some((d) => d.vault === '乙') && afterStop.devices.some((d) => d.id === target.id));
  const other = path.join(TMP, '新仓库'); fs.mkdirSync(other); fs.writeFileSync(path.join(other, '新.md'), '# 新仓库');
  await api(A, '/api/vault/open', { path: other });
  const switched = await api(C, '/api/sync/lan/devices');
  check('切换仓库撤销旧公告和共享连接', !switched.devices.some((d) => d.id === target.id) && !(await api(A, '/api/sync/lan/status')).running && !(await api(A, '/api/sync/status')).configured);
  const restart = await api(A, '/api/sync/lan/start', {});
  check('共享停止后可在新仓库重新开启', restart.lan.mdns.available && restart.lan.vault === '新仓库');
  await api(A, '/api/sync/disconnect', {});
  check('断开同步同时关闭共享与公告', !(await api(A, '/api/sync/lan/status')).running && !(await api(C, '/api/sync/lan/devices')).devices.some((d) => d.vault === '新仓库'));
  check('无页面脚本错误', errors.length === 0, errors.join(' | '));
} finally {
  observerBrowser?.stop(); observer?.destroy(); fakeHttp?.close(); await browser?.close();
  for (const proc of procs) proc.kill();
}
console.log(`${checks.filter(Boolean).length}/${checks.length} 通过`);
process.exit(checks.every(Boolean) ? 0 : 1);
