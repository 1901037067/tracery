import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { resolveInVault } from '../server/path-guard.js';
import { isLocalClient } from '../server/request-guard.js';

const ROOT = path.resolve(import.meta.dirname, '..'), HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tracery-security-'));
const VAULT = path.join(HOME, 'vault'), OUTSIDE = path.join(HOME, 'vault-evil');
fs.mkdirSync(VAULT); fs.mkdirSync(OUTSIDE);
fs.writeFileSync(path.join(OUTSIDE, 'sentinel.md'), 'outside unchanged');
fs.writeFileSync(path.join(VAULT, '原笔记.md'), '# 原内容');
fs.symlinkSync(OUTSIDE, path.join(VAULT, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
fs.writeFileSync(path.join(HOME, 'tracery.config.json'), JSON.stringify({ currentVault: VAULT }));
assert.equal(isLocalClient({ socket: { remoteAddress: '::ffff:127.0.0.1' } }), true);
assert.equal(isLocalClient({ socket: { remoteAddress: '203.0.113.77' } }), false);
for (const rel of ['../vault-evil/sentinel.md', '..\\vault-evil\\sentinel.md', VAULT, 'C:\\outside.md', '/outside.md', '\\\\server\\share\\a.md', '', '.', 'a/../b.md', 'a.md:stream', 'NUL.md', 'a\0b', 'outside-link/new.md']) assert.throws(() => resolveInVault(VAULT, rel), /路径|链接/);
const PORT = 9641, BASE = `http://localhost:${PORT}`, sleep = ms => new Promise(r => setTimeout(r, ms));
const packed = process.env.TRACERY_TEST_EXE;
const entry = packed ? path.join(path.dirname(packed), 'resources/app.asar/server/server.js') : path.join(ROOT, 'server/server.js');
const server = spawn(packed || process.execPath, [entry], { cwd: ROOT, env: { ...process.env, TRACERY_HOME: HOME, PORT: String(PORT), ...(packed ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }, windowsHide: true, stdio: 'pipe' });
const request = (route, { method = 'GET', body, headers = {} } = {}) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const req = http.request(BASE + route, { method, headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } }, res => { let text = ''; res.on('data', d => { text += d; }); res.on('end', () => resolve({ status: res.statusCode, data: (() => { try { return JSON.parse(text); } catch { return text; } })() })); });
  req.on('error', reject); req.end(data);
});
try {
  for (let i = 0; i < 80; i++) { try { if ((await request('/api/state')).status === 200) break; } catch {} await sleep(200); }
  const blocked = async (route, options) => { const response = await request(route, options); assert.ok([400, 403, 404, 415].includes(response.status), `${route}: ${response.status}`); };
  for (const rel of ['../vault-evil/sentinel.md', '..\\vault-evil\\sentinel.md', 'outside-link/sentinel.md']) {
    await blocked('/api/note', { method: 'PUT', body: { path: rel, content: 'changed' } });
    await blocked('/api/note/create', { method: 'POST', body: { path: rel, content: 'changed' } });
    await blocked('/api/delete', { method: 'POST', body: { path: rel } });
    await blocked('/api/rename', { method: 'POST', body: { path: rel, newPath: 'moved.md' } });
    await blocked('/api/rename', { method: 'POST', body: { path: '原笔记.md', newPath: rel } });
    await blocked('/api/file?path=' + encodeURIComponent(rel));
    await blocked('/api/history?path=' + encodeURIComponent(rel));
    await blocked('/api/history/content?path=' + encodeURIComponent(rel) + '&id=1');
    await blocked('/api/history/restore', { method: 'POST', body: { path: rel, id: 1 } });
    await blocked('/api/asset', { method: 'POST', body: { overwrite: rel, data: 'data:image/png;base64,aGVsbG8=' } });
  }
  await blocked('/api/delete', { method: 'POST', body: { path: '.' } });
  assert.equal(fs.readFileSync(path.join(OUTSIDE, 'sentinel.md'), 'utf8'), 'outside unchanged');
  assert.equal(fs.readFileSync(path.join(VAULT, '原笔记.md'), 'utf8'), '# 原内容');
  assert.equal((await request('/api/search?q=' + encodeURIComponent('outside unchanged'))).data.results.length, 0);
  console.log('PASS 写入/创建/重命名双端/删除/文件/历史/附件的越界、前缀同名和目录链接拒绝，仓库外原件未变');
  await blocked('/api/note', { method: 'PUT', body: { path: '原笔记.md', content: 'evil' }, headers: { Origin: 'https://evil.example' } });
  await blocked('/api/note/create', { method: 'POST', body: { path: 'evil.md' }, headers: { 'Content-Type': 'text/plain' } });
  await blocked('/api/note/create', { method: 'POST', body: { path: 'evil.md' }, headers: { 'Sec-Fetch-Site': 'cross-site' } });
  await blocked('/api/state', { headers: { Host: `evil.example:${PORT}` } });
  await blocked('/api/state', { headers: { Host: 'localhost:1' } });
  await blocked('/api/state', { headers: { Origin: 'null' } });
  assert.equal(fs.existsSync(path.join(VAULT, 'evil.md')), false);
  const socketResult = origin => new Promise(resolve => { const socket = new WebSocket(`ws://localhost:${PORT}/ws`, { origin }); socket.on('open', () => { socket.close(); resolve(101); }); socket.on('unexpected-response', (_, res) => { res.resume(); resolve(res.statusCode); }); socket.on('error', () => resolve(0)); });
  assert.equal(await socketResult('http://evil.example'), 403); assert.equal(await socketResult(BASE), 101);
  console.log('PASS 跨来源/跨站/非 JSON 写入、恶意 Host 与跨源 WebSocket 被拒绝，同源仍可连接');
  assert.equal((await request('/api/note', { method: 'PUT', body: { path: '子目录/新笔记.md', content: '# 一' }, headers: { Origin: BASE } })).status, 200);
  assert.equal((await request('/api/note', { method: 'PUT', body: { path: '子目录/新笔记.md', content: '# 二' } })).status, 200);
  const history = (await request('/api/history?path=' + encodeURIComponent('子目录/新笔记.md'))).data.items;
  assert.ok(history.length); assert.equal((await request('/api/history/restore', { method: 'POST', body: { path: '子目录/新笔记.md', id: history[0].id } })).status, 200);
  assert.equal(fs.readFileSync(path.join(VAULT, '子目录/新笔记.md'), 'utf8'), '# 一');
  assert.equal((await request('/api/delete', { method: 'POST', body: { path: '子目录/新笔记.md' } })).status, 200);
  const trash = (await request('/api/trash')).data.items;
  assert.equal((await request('/api/trash/restore', { method: 'POST', body: { id: trash[0].id } })).status, 200);
  for (let i = 0; i < 2; i++) assert.equal((await request('/api/asset', { method: 'POST', body: { dir: '', name: '根目录图片', data: 'data:image/png;base64,aGVsbG8=' } })).status, 200);
  assert.ok(fs.existsSync(path.join(VAULT, '根目录图片-2.png')));
  assert.equal((await request('/js/app.js')).status, 200);
  console.log('PASS 合法同源和本机客户端写入、历史恢复、回收站恢复、根目录附件重名及静态资源');
} finally { server.kill(); }
