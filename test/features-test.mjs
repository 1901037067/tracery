/**
 * 新特性回归：右栏三按钮切换 / 代码高亮 / 表格 Tab 跳格 / 星标 / 最近打开 / 导出 HTML
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 9590;
const HOME = path.join(process.env.TEMP || '/tmp', 'tracery-feat-home');
const VAULT = path.join(HOME, 'vault');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(VAULT, { recursive: true });
fs.writeFileSync(path.join(VAULT, '功能.md'), [
  '# 功能测试', '',
  '## 小节一', '',
  '```js', 'const x = 42; // 注释', 'function foo(a) { return "hi" + a; }', '```', '',
  '| 列A | 列B |', '| --- | --- |', '| 1 | 2 |', '', '段落', '',
].join('\n'), 'utf8');
fs.writeFileSync(path.join(VAULT, '第二篇.md'), '# 第二篇\n\n内容\n', 'utf8');

const server = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), TRACERY_HOME: HOME }, stdio: 'pipe',
});
for (let i = 0; i < 40; i++) {
  try { if ((await fetch(`http://localhost:${PORT}/api/state`)).ok) break; } catch { /* wait */ }
  await sleep(250);
}
const browser = await puppeteer.launch({
  executablePath: EDGE, headless: 'new', args: ['--no-sandbox'],
  defaultViewport: { width: 1280, height: 820 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const log = [];
const check = (name, ok, detail = '') => {
  log.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
};

await page.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle0' });
await sleep(1200);
await page.evaluate(async (vp) => {
  await fetch('/api/vault/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: vp }) });
}, VAULT.replace(/\\/g, '/'));
await sleep(1500);
await page.evaluate(() => document.querySelector('[data-path="功能.md"]')?.click());
await sleep(900);

/* ---------- ① 右栏三按钮切换 ---------- */
const rs = await page.evaluate(async () => {
  const out = [];
  for (const n of ['backlinks', 'note-tags', 'outline']) {
    document.querySelector(`.rs-tab[data-rs="${n}"]`).click();
    await new Promise((r) => setTimeout(r, 250));
    out.push({
      tab: document.querySelector('.rs-tab.active')?.dataset.rs,
      panels: [...document.querySelectorAll('#sidebar-right .panel.active')].map((p) => p.id),
    });
  }
  const tabs = [...document.querySelectorAll('.rs-tab')].map((b) => b.textContent.replace(/\d+/g, '').trim());
  return { out, tabs };
});
check('右栏三个切换按钮', rs.tabs.length === 3 && rs.tabs.join(',').includes('大纲'), rs.tabs.join(' / '));
check('点按钮只显示对应面板',
  rs.out.every((r) => r.tab === r.panels[0]?.replace('panel-', '') && r.panels.length === 1),
  JSON.stringify(rs.out.map((r) => `${r.tab}→${r.panels}`)));

/* ---------- ② 代码块语法高亮 ---------- */
const hl = await page.evaluate(() => ({
  kw: document.querySelectorAll('#editor-live .tok-kw').length,
  str: document.querySelectorAll('#editor-live .tok-str').length,
  com: document.querySelectorAll('#editor-live .tok-com').length,
  codeText: document.querySelector('#editor-live pre code')?.textContent || '',
}));
check('代码块高亮（关键字/字符串/注释）', hl.kw > 0 && hl.str > 0 && hl.com > 0, JSON.stringify(hl));
check('高亮不改变代码文本', hl.codeText.includes('const x = 42; // 注释'), hl.codeText.split('\n')[0]);

/* ---------- ③ 表格 Tab 跳格 + 回车加行 ---------- */
await page.evaluate(() => {
  const td = document.querySelector('#editor-live td');
  const r = document.createRange();
  r.setStart(td, 0);
  r.collapse(true);
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(r);
  document.getElementById('editor-live').focus();
});
await page.keyboard.press('Tab');
await sleep(200);
const col = await page.evaluate(() => {
  const s = getSelection();
  const pe = s.anchorNode?.nodeType === 1 ? s.anchorNode : s.anchorNode?.parentElement;
  return pe?.closest('td, th')?.cellIndex;
});
check('Tab 跳到下一个单元格', col === 1, String(col));
await page.keyboard.press('Enter');
await sleep(1500);
const mdNow = fs.readFileSync(path.join(VAULT, '功能.md'), 'utf8');
const rows = (mdNow.match(/^\| /gm) || []).length;
check('表格里回车新增一行', rows === 4, `rows=${rows}`);

/* ---------- ④ 星标 ---------- */
const pinned = await page.evaluate(async () => {
  const item = document.querySelector('#file-tree .tree-item[data-path="第二篇.md"]');
  const r = item.getBoundingClientRect();
  item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 20, clientY: r.top + 8 }));
  await new Promise((res) => setTimeout(res, 300));
  [...document.querySelectorAll('.context-menu button')].find((b) => b.textContent.includes('星标'))?.click();
  await new Promise((res) => setTimeout(res, 500));
  return {
    section: !!document.querySelector('.pinned-section'),
    count: document.querySelectorAll('.pinned-item').length,
    label: document.querySelector('.pinned-item .tree-label')?.textContent,
  };
});
check('右键星标 → 文件树顶部出现星标区', pinned.section && pinned.count === 1 && pinned.label === '第二篇', JSON.stringify(pinned));

/* ---------- ⑤ 最近打开（搜索面板空查询） ---------- */
await page.evaluate(() => document.querySelector('.ribbon-btn[data-panel="search"]').click());
await sleep(600);
const recent = await page.evaluate(() => ({
  section: document.querySelector('.search-section')?.textContent || '',
  count: document.querySelectorAll('#search-results .search-result').length,
}));
check('搜索面板空查询显示最近打开', recent.section === '最近打开' && recent.count >= 2, JSON.stringify(recent));

/* ---------- ⑥ 导出 HTML ---------- */
const client = await page.createCDPSession();
const dlDir = path.join(HOME, 'dl');
await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });
await page.evaluate(() => window.__tracery.exportHtml());
await sleep(2500);
const files = fs.existsSync(dlDir) ? fs.readdirSync(dlDir) : [];
const exported = files.length ? fs.readFileSync(path.join(dlDir, files[0]), 'utf8') : '';
check('导出 HTML 自包含（内联样式 + 高亮）',
  files.length > 0 && exported.includes('.markdown-body') && exported.includes('tok-kw') && exported.includes('<!DOCTYPE html>'),
  `${files[0] || '(无)'} ${exported.length}B`);

/* ---------- ⑦ 图片拖拽调尺寸 ---------- */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAIAAAD/gAIDAAAAJklEQVR4nO3BAQ0AAADCoPdPbQ8HFAAAAAAAAAAAAAAAAAAAAHwbXQAAAQ1l6X0AAAAASUVORK5CYII=', 'base64');
fs.mkdirSync(path.join(VAULT, '附件'), { recursive: true });
fs.writeFileSync(path.join(VAULT, '附件', 'pic.png'), PNG);
fs.writeFileSync(path.join(VAULT, '图.md'), '# 图片\n\n![[附件/pic.png|120]]\n', 'utf8');
await sleep(400);
await page.evaluate(async () => { await (await fetch('/api/tree')).json(); });
await page.evaluate(() => window.__tracery.openNote('图.md', null, { newTab: false }));
await sleep(900);
const grip = await page.evaluate(() => {
  const fig = document.querySelector('.embed-image');
  const g = fig?.querySelector('.img-grip');
  if (!g) return null;
  const r = g.getBoundingClientRect();
  return { x: r.left + 7, y: r.top + 7 };
});
if (grip) {
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.mouse.move(grip.x + 120, grip.y, { steps: 8 });
  await page.mouse.up();
}
await sleep(1500);
const imgMd = fs.readFileSync(path.join(VAULT, '图.md'), 'utf8');
check('拖拽图片右下角手柄改写尺寸', !!grip && /!\[\[附件\/pic\.png\|2\d\d\]\]/.test(imgMd), imgMd.trim());

/* ---------- ⑧ 全文替换 ---------- */
await page.evaluate(() => document.querySelector('.ribbon-btn[data-panel="search"]').click());
await sleep(400);
await page.evaluate(() => {
  const i = document.getElementById('search-input');
  i.value = '图片';
  i.dispatchEvent(new Event('input', { bubbles: true }));
});
await sleep(600);
const repVisible = await page.evaluate(() => !document.getElementById('search-replace').hidden);
await page.evaluate(() => {
  document.getElementById('replace-input').value = '插图';
  document.getElementById('btn-replace-all').click();
});
await sleep(400);
await page.evaluate(() => document.querySelector('.dialog-ok')?.click());
await sleep(1600);
const replaced = fs.readFileSync(path.join(VAULT, '图.md'), 'utf8');
check('搜索面板出现替换行并全部替换', repVisible && replaced.includes('# 插图'), JSON.stringify(replaced.trim().split('\n')[0]));

/* ---------- ⑨ 版本历史 ---------- */
const hist = await page.evaluate(async () => (await (await fetch(`/api/history?path=${encodeURIComponent('图.md')}`)).json()).items);
check('保存前自动留版本快照', Array.isArray(hist) && hist.length >= 1, `版本数=${hist.length}`);
if (hist.length) {
  const restore = await page.evaluate(async (id) => {
    const r = await fetch('/api/history/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '图.md', id }) });
    return r.ok;
  }, hist[0].id);
  await sleep(600);
  const back = fs.readFileSync(path.join(VAULT, '图.md'), 'utf8');
  check('可恢复到历史版本', restore && back.includes('# 图片'), JSON.stringify(back.trim().split('\n')[0]));
}

check('无渲染错误', errors.length === 0, errors.join(' | '));

await browser.close();
server.kill();
fs.rmSync(HOME, { recursive: true, force: true });
console.log('\n' + log.join('\n'));
process.exit(log.some((l) => l.startsWith('FAIL')) ? 1 : 0);
