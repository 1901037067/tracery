/* 打包版 e2e 验证：用临时演示仓库走一遍核心功能（不动用户真实数据） */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const BASE = process.env.TRACERY_BASE || 'http://localhost:9540';
const CDP = process.env.TRACERY_CDP || 'http://localhost:9223';
const TEST_VAULT = path.join(os.tmpdir(), 'tracery-test-vault');

fs.rmSync(TEST_VAULT, { recursive: true, force: true });
fs.cpSync('demo-vault', TEST_VAULT, { recursive: true });
console.log('临时仓库:', TEST_VAULT);

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? '  — ' + extra : ''}`);
};

const res = await fetch(`${BASE}/api/vault/open`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ path: TEST_VAULT }),
});
check('打包版：通过 API 切换仓库', res.ok);

const graph = await (await fetch(`${BASE}/api/graph`)).json();
check('打包版：链接索引工作', graph.nodes.length === 10 && graph.links.length >= 28,
  `${graph.nodes.length} 篇 / ${graph.links.length} 条链接`);

const tags = await (await fetch(`${BASE}/api/tags`)).json();
check('打包版：标签索引工作', tags.tags.length >= 20, `${tags.tags.length} 个标签`);

const search = await (await fetch(`${BASE}/api/search?q=` + encodeURIComponent('双链'))).json();
check('打包版：全文搜索工作', search.results.length >= 2, `${search.results.length} 条结果`);

const v = await (await fetch(`${CDP}/json/version`)).json();
const browser = await puppeteer.connect({
  browserWSEndpoint: v.webSocketDebuggerUrl,
  defaultViewport: { width: 1280, height: 860 },
});
const page = (await browser.pages())[0];
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.reload({ waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 2200));
// 打开一篇包含全部要素的笔记（标题/任务列表/Callout/双链）
await page.evaluate(() => {
  const items = [...document.querySelectorAll('#file-tree .tree-item')];
  items.find((i) => i.textContent.includes('Markdown 语法'))?.click();
});
await new Promise((r) => setTimeout(r, 900));

const ui = await page.evaluate(() => ({
  welcomeHidden: document.getElementById('welcome').hidden,
  appVisible: !document.getElementById('app').hidden,
  treeItems: document.querySelectorAll('#file-tree .tree-item').length,
  headings: document.querySelectorAll('#editor-live h1, #editor-live h2, #editor-live h3').length,
  wikilinks: document.querySelectorAll('#editor-live a.wikilink').length,
  tasks: document.querySelectorAll('#editor-live li.task-list-item input[type=checkbox]').length,
  callouts: document.querySelectorAll('#editor-live .callout').length,
  outlineItems: document.querySelectorAll('#outline-list .outline-item').length,
  winControls: getComputedStyle(document.querySelector('.win-controls')).display !== 'none',
  themeIcons: [getComputedStyle(document.querySelector('.ic-sun')).display, getComputedStyle(document.querySelector('.ic-moon')).display].filter((d) => d !== 'none').length,
  electronAPI: !!window.electronAPI?.isElectron,
}));
check('打包版：主界面显示（欢迎页已隐藏）', ui.appVisible && ui.welcomeHidden);
check('打包版：文件树渲染', ui.treeItems >= 10, `${ui.treeItems} 项`);
check('打包版：笔记内容渲染（标题/双链/任务/Callout）',
  ui.headings >= 1 && ui.wikilinks >= 1 && ui.tasks >= 1 && ui.callouts >= 1,
  JSON.stringify({ h: ui.headings, wl: ui.wikilinks, t: ui.tasks, c: ui.callouts }));
check('打包版：大纲面板', ui.outlineItems >= 1, `${ui.outlineItems} 项`);
check('打包版：自定义标题栏 + 窗口控件', ui.winControls && ui.electronAPI);
check('打包版：主题按钮只显示一个图标', ui.themeIcons === 1, `可见图标数=${ui.themeIcons}`);
// 设置面板是懒加载的，先打开再查
await page.evaluate(() => document.getElementById('btn-settings').click());
await new Promise((r) => setTimeout(r, 500));
const hasSyncPane = await page.evaluate(() => !!document.querySelector('.settings-nav button[data-pane="sync"]'));
await page.keyboard.press('Escape');
check('打包版：设置里有同步页', hasSyncPane);
check('打包版：渲染进程无 JS 错误', errors.length === 0, errors.join('; '));
await browser.disconnect();

await fetch(`${BASE}/api/note`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ path: 'Markdown 语法.md', content: '# 测试\n\n打包版写入测试 [[双链与反链]]\n' }),
});
const reread = await (await fetch(`${BASE}/api/note?path=` + encodeURIComponent('Markdown 语法.md'))).json();
check('打包版：写入落到真实磁盘', reread.content.includes('打包版写入测试'));
const onDisk = fs.readFileSync(path.join(TEST_VAULT, 'Markdown 语法.md'), 'utf8');
check('打包版：文件系统确实被写入', onDisk.includes('打包版写入测试'));

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} 通过`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
