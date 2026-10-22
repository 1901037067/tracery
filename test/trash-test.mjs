/**
 * 回收站回归
 * ------------------------------------------------------------------
 * 删除不再是永久删除：文件移进 TRACERY_HOME/trash/<仓库哈希>/，可恢复。
 * 覆盖：删除入回收站 → 列表可见 → 恢复回原地 → 再次删除 → 彻底删除。
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 9593;
const HOME = path.join(process.env.TEMP || '/tmp', 'tracery-trash-home');
const VAULT = path.join(HOME, 'vault');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(VAULT, { recursive: true });
fs.writeFileSync(path.join(VAULT, '要删的笔记.md'), '# 要删的笔记\n\n内容\n', 'utf8');
fs.writeFileSync(path.join(VAULT, '保留.md'), '# 保留\n\n内容\n', 'utf8');
// 删除文件夹的夹具：目录里带一层子目录，验证「整棵树」一起进出回收站
fs.mkdirSync(path.join(VAULT, '要删的文件夹', '子目录'), { recursive: true });
fs.writeFileSync(path.join(VAULT, '要删的文件夹', '甲.md'), '# 甲\n', 'utf8');
fs.writeFileSync(path.join(VAULT, '要删的文件夹', '子目录', '乙.md'), '# 乙\n', 'utf8');

const server = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), TRACERY_HOME: HOME },
  stdio: 'pipe',
});
for (let i = 0; i < 40; i++) {
  try { if ((await fetch(`http://localhost:${PORT}/api/state`)).ok) break; } catch { /* wait */ }
  await sleep(250);
}
const browser = await puppeteer.launch({
  executablePath: EDGE, headless: 'new', args: ['--no-sandbox'],
  defaultViewport: { width: 1280, height: 860 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const log = [];
const check = (name, ok, detail = '') => {
  log.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
};
const fileExists = (p) => fs.existsSync(path.join(VAULT, p));

await page.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle0' });
await sleep(1200);
await page.evaluate(async (vp) => {
  await fetch('/api/vault/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: vp }) });
}, VAULT.replace(/\\/g, '/'));
await sleep(1500);

/* ---------- ① 右键删除 → 进回收站而不是删除 ---------- */
await page.evaluate(() => {
  const item = document.querySelector('#file-tree .tree-item[data-path="要删的笔记.md"]');
  const r = item.getBoundingClientRect();
  item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 20, clientY: r.top + 8 }));
});
await sleep(400);
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('.context-menu button')].find((b) => b.textContent.includes('删除'));
  btn.click();
});
await sleep(400);
await page.evaluate(() => document.querySelector('.dialog-ok')?.click());
await sleep(900);
check('删除后源文件已不在仓库', !fileExists('要删的笔记.md'));
const trash1 = await page.evaluate(async () => (await (await fetch('/api/trash')).json()).items);
check('回收站里能看到这一项', trash1.length === 1 && trash1[0].path === '要删的笔记.md', JSON.stringify(trash1.map((x) => x.path)));

/* ---------- ② 打开回收站面板并恢复 ---------- */
await page.evaluate(() => { document.getElementById('btn-file-more').click(); [...document.querySelectorAll('.context-menu button')].find(b => b.textContent.includes('回收站')).click(); });
await sleep(600);
const panel = await page.evaluate(() => ({
  open: !document.getElementById('trash-viewer').hidden,
  rows: document.querySelectorAll('.trash-item').length,
  name: document.querySelector('.trash-name')?.textContent || '',
}));
check('回收站面板打开且列出条目', panel.open && panel.rows === 1 && panel.name === '要删的笔记.md', JSON.stringify(panel));
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('.trash-item button')].find((b) => b.textContent === '恢复');
  btn.click();
});
await sleep(1200);
check('恢复后文件回到原位置', fileExists('要删的笔记.md'));
const trash2 = await page.evaluate(async () => (await (await fetch('/api/trash')).json()).items);
check('恢复后回收站清空', trash2.length === 0, String(trash2.length));

/* ---------- ③ 再次删除 → 彻底删除 ---------- */
const delAgain = await page.evaluate(async () => {
  await fetch('/api/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '要删的笔记.md' }) });
  return (await (await fetch('/api/trash')).json()).items.length;
});
check('再次删除重新入回收站', delAgain === 1, String(delAgain));
await page.evaluate(() => document.getElementById('trash-viewer')?.remove());
await page.evaluate(() => { document.getElementById('btn-file-more').click(); [...document.querySelectorAll('.context-menu button')].find(b => b.textContent.includes('回收站')).click(); });
await sleep(600);
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('.trash-item button')].find((b) => b.textContent === '彻底删除');
  btn.click();
});
await sleep(400);
await page.evaluate(() => document.querySelector('.dialog-ok')?.click());
await sleep(800);
const trash3 = await page.evaluate(async () => (await (await fetch('/api/trash')).json()).items);
check('彻底删除后回收站条目消失', trash3.length === 0, String(trash3.length));
check('彻底删除后文件确实不在仓库', !fileExists('要删的笔记.md'));

/* ---------- ④ 未删除的文件不受影响 ---------- */
check('无关文件未被波及', fileExists('保留.md'));

/* ---------- ⑤ 删除文件夹：整棵树进回收站 → 整棵树恢复（2026-10-19 新增） ---------- */
await page.evaluate(() => {
  const item = [...document.querySelectorAll('#file-tree .tree-item')]
    .find((el) => !el.dataset.path && el.textContent.trim() === '要删的文件夹');
  const r = item.getBoundingClientRect();
  item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 20, clientY: r.top + 8 }));
});
await sleep(400);
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('.context-menu button')].find((b) => b.textContent.includes('删除'));
  btn.click();
});
await sleep(400);
const folderConfirm = await page.evaluate(() => document.querySelector('.dialog-title')?.textContent || '');
check('删除文件夹前有确认框（说明会移入回收站）', folderConfirm.includes('要删的文件夹'), folderConfirm);
await page.evaluate(() => document.querySelector('.dialog-ok')?.click());
await sleep(1200);
check('删除文件夹后整棵目录消失',
  !fileExists('要删的文件夹') && !fileExists('要删的文件夹/子目录/乙.md'));
const trashFolder = await page.evaluate(async () => (await (await fetch('/api/trash')).json()).items);
check('回收站里是「整个文件夹」一条',
  trashFolder.length === 1 && trashFolder[0].path === '要删的文件夹',
  JSON.stringify(trashFolder.map((x) => x.path)));
const dirsAfter = await page.evaluate(async () => (await (await fetch('/api/tree')).json()).dirs.map((d) => d.name));
check('删除后索引整仓重扫，不再留该文件夹', !dirsAfter.includes('要删的文件夹'), JSON.stringify(dirsAfter));
if (trashFolder[0]) {
  await page.evaluate(async (id) => {
    await fetch('/api/trash/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
  }, trashFolder[0].id);
  await sleep(1200);
}
check('恢复后文件夹连同子目录一起回来',
  fileExists('要删的文件夹/甲.md') && fileExists('要删的文件夹/子目录/乙.md'));

check('无渲染错误', errors.length === 0, errors.join(' | '));

await browser.close();
server.kill();
fs.rmSync(HOME, { recursive: true, force: true });
console.log('\n' + log.join('\n'));
process.exit(log.some((l) => l.startsWith('FAIL')) ? 1 : 0);
