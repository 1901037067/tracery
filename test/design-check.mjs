/* 界面审查：截取 欢迎页 / 亮色 / 暗色 / 命令面板 四张图 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9595;
const BASE = `http://localhost:${PORT}`;
const SHOTS = 'test/screenshots';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, ['server/server.js'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),   // 仓库根目录，不硬编码
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'pipe',
});
for (let i = 0; i < 40; i++) { try { if ((await fetch(`${BASE}/api/state`)).ok) break; } catch {} await sleep(250); }

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1.5 },
  args: ['--no-sandbox'],
});
const page = await browser.newPage();
await page.goto(BASE, { waitUntil: 'networkidle0' });
await sleep(700);

// 欢迎页（临时切换显示，不改配置）
await page.evaluate(() => { document.getElementById('app').hidden = true; document.getElementById('welcome').hidden = false; });
await sleep(300);
await page.screenshot({ path: `${SHOTS}/design-welcome.png` });
await page.evaluate(() => { document.getElementById('app').hidden = false; document.getElementById('welcome').hidden = true; });

// 打开一篇内容丰富的笔记
await page.evaluate(() => {
  const items = [...document.querySelectorAll('#file-tree .tree-item')];
  items.find((i) => i.textContent.includes('Markdown 语法'))?.click();
});
await sleep(900);
await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
await sleep(400);
await page.screenshot({ path: `${SHOTS}/design-dark.png` });

// 亮色
await page.evaluate(() => document.documentElement.dataset.theme = 'light');
await sleep(400);
await page.screenshot({ path: `${SHOTS}/design-light.png` });

// 命令面板（暗色）
await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
await sleep(200);

// 命令面板
await page.keyboard.down('Control');
await page.keyboard.press('KeyP');
await page.keyboard.up('Control');
await sleep(500);
await page.evaluate(() => {
  const i = document.getElementById('palette-input');
  i.value = '双链';
  i.dispatchEvent(new Event('input', { bubbles: true }));
});
await sleep(400);
await page.screenshot({ path: `${SHOTS}/design-palette.png` });
await page.keyboard.press('Escape');
await sleep(300);

// 设置面板（暗色）
await page.evaluate(() => document.getElementById('btn-settings').click());
await sleep(700);
await page.screenshot({ path: `${SHOTS}/design-settings.png` });

// 编辑器分组
await page.evaluate(() => document.querySelector('#settings .settings-nav button[data-pane="editor"]').click());
await sleep(400);
await page.screenshot({ path: `${SHOTS}/design-settings-editor.png` });

await browser.close();
server.kill();
console.log('截图完成');
process.exit(0);
