/**
 * 附件管理验证：新附件落点（指定文件夹 / 跟随笔记 / 仓库根目录）、
 * 粘贴与拖拽入库、路径穿越拦截、旧客户端（不带 dir）兼容。
 * 全部用临时仓库副本 + 临时 TRACERY_HOME，不碰真实数据和 demo-vault。
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 9592;
const HOME = path.join(process.env.TEMP || '/tmp', 'tracery-asset-home');
const VAULT = path.join(HOME, 'test-vault');
const NOTE = '日记/2026-10-16.md';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
fs.cpSync(path.join(ROOT, 'demo-vault'), VAULT, { recursive: true });

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
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-sandbox'],
  defaultViewport: { width: 1280, height: 860 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const log = [];

function check(name, ok, detail = '') {
  log.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function waitFor(cond, timeout = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await cond()) return true;
    await sleep(150);
  }
  return false;
}

/** 切到临时仓库并打开目标笔记 */
async function openNoteInTestVault() {
  await fetch(`http://localhost:${PORT}/api/vault/open`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: VAULT.replace(/\\/g, '/') }),
  });
  await sleep(1500);
  await page.evaluate(() => {
    document.querySelector('[data-path="日记/2026-10-16.md"]')?.click();
  });
  await sleep(900);
}

/** 改附件设置（服务端会 WS 广播，页面实时生效，不用重载） */
async function setAttachment(patch) {
  await fetch(`http://localhost:${PORT}/api/settings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ attachment: patch }),
  });
  await sleep(900);
}

/** 在页面里派发粘贴事件（图片走 /icon.png 取真字节）。
 *  注意目标元素：块级的 paste 监听挂在 #editor-live，cm 的挂在 CM 的 .cm-content
 *  （事件只向祖先冒泡，挂错元素处理器收不到）。 */
async function pasteImage(name = 'image.png') {
  // cm 的 paste 处理器挂在 CM 的 .cm-content 上，且要编辑器处于聚焦态才走真实粘贴链路
  //（等价于用户先点进编辑区再 Ctrl+V）——源事件派发前先点一下内容区聚焦。
  if (IS_CM) { try { await page.click('#editor-live .cm-content'); await sleep(150); } catch { /* 忽略 */ } }
  const dbg = await page.evaluate(async (n) => {
    const blob = await (await fetch('/icon.png')).blob();
    const dt = new DataTransfer();
    dt.items.add(new File([blob], n, { type: 'image/png' }));
    // 用普通 Event + defineProperty 塞 clipboardData：`new ClipboardEvent(.., {clipboardData})`
    // 在部分 Chromium 版本里 init 字典不进 clipboardData，合成粘贴会「有事件没文件」。
    const ev = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', { value: dt });
    const target = document.querySelector('#editor-live .cm-content') || document.getElementById('editor-live');
    target.dispatchEvent(ev);
    return ev.defaultPrevented;   // true = 内核拦下了默认粘贴（否则说明处理器没走到）
  }, name);
  if (!dbg) console.log('  [提示] 粘贴事件未被内核拦截');
}

/** 在页面里派发拖拽事件（任意字节，用于 PDF / 非法类型） */
async function dropFile(b64, name, type) {
  await page.evaluate(async ({ b64: b, name: n, type: t }) => {
    const bin = atob(b);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], n, { type: t }));
    const target = document.querySelector('#editor-live .cm-content') || document.getElementById('editor-live');
    target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, { b64, name, type });
}

const noteAbs = path.join(VAULT, NOTE);
const noteHas = (re) => { try { return new RegExp(re).test(fs.readFileSync(noteAbs, 'utf8')); } catch { return false; } };

const ENGINE = process.env.TRACERY_TEST_ENGINE || 'block';   // 内核：默认 block（回归网），cm 用 TRACERY_TEST_ENGINE=cm
const IS_CM = ENGINE === 'cm';
await page.goto(`http://localhost:${PORT}/?engine=${ENGINE}`, { waitUntil: 'networkidle0' });
await sleep(1200);
await openNoteInTestVault();

/* ---------- 1. 默认（指定文件夹 附件/） ---------- */
await pasteImage();
const ok1 = await waitFor(() => {
  try {
    const files = fs.readdirSync(path.join(VAULT, '附件'));
    return files.some((f) => /^粘贴的图片 \d{8}-\d{6}\.png$/.test(f));
  } catch { return false; }
});
check('默认落点：粘贴图片进 附件/', ok1);
check('笔记里插入 ![[附件/...]] 双链', await waitFor(() => noteHas('!\\[\\[附件/粘贴的图片 \\d{8}-\\d{6}\\.png\\]\\]')));

/* ---------- 2. HTTP 层：路径穿越与旧客户端 ---------- */
const assetPost = (body) => fetch(`http://localhost:${PORT}/api/asset`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const evil = await assetPost({ data: `data:image/png;base64,${PNG_1PX}`, name: 'evil', dir: '../evil' });
check('dir=../evil 被服务端拒绝（400）', evil.status === 400, `status=${evil.status}`);
const evil2 = await assetPost({ data: `data:image/png;base64,${PNG_1PX}`, name: 'evil2', dir: 'a/../../b' });
check('dir=a/../../b 被拒绝（400）', evil2.status === 400, `status=${evil2.status}`);
check('仓库外没有写出文件', !fs.existsSync(path.join(HOME, 'evil')) && !fs.existsSync(path.join(HOME, 'b')));

const legacy = await assetPost({ data: `data:image/png;base64,${PNG_1PX}`, name: '旧客户端图片' });
check('不带 dir 的旧请求仍落 附件/（兼容）', legacy.status === 200 && JSON.parse(await legacy.text()).path === '附件/旧客户端图片.png');

/* ---------- 3. 跟随笔记模式 ---------- */
await setAttachment({ mode: 'note' });
await pasteImage();
const okNote = await waitFor(() => {
  try {
    return fs.readdirSync(path.join(VAULT, '日记')).some((f) => /^粘贴的图片 \d{8}-\d{6}\.png$/.test(f));
  } catch { return false; }
});
check('跟随笔记：图片落到笔记所在目录 日记/', okNote);
check('插入的是 vault 相对路径 ![[日记/...]]', await waitFor(() => noteHas('!\\[\\[日记/粘贴的图片 \\d{8}-\\d{6}\\.png\\]\\]')));

/* ---------- 4. 仓库根目录模式 + 拖入 PDF ---------- */
await setAttachment({ mode: 'root' });
await pasteImage();
const okRoot = await waitFor(() => {
  try { return fs.readdirSync(VAULT).some((f) => /^粘贴的图片 \d{8}-\d{6}\.png$/.test(f)); } catch { return false; }
});
check('仓库根目录：图片落到 vault 根', okRoot);

await dropFile('JVBERi0xLjQKZmFrZQ==', '测试论文.pdf', 'application/pdf');
const okPdf = await waitFor(() => fs.existsSync(path.join(VAULT, '测试论文.pdf')));
check('拖入 PDF 也入库（根目录）', okPdf);
check('PDF 也插入双链', await waitFor(() => noteHas('!\\[\\[测试论文\\.pdf\\]\\]')));

/* ---------- 5. 自定义文件夹 ---------- */
await setAttachment({ mode: 'folder', folder: '附件/图片' });
await pasteImage();
const okSub = await waitFor(() => {
  try {
    return fs.readdirSync(path.join(VAULT, '附件', '图片')).some((f) => /^粘贴的图片 \d{8}-\d{6}\.png$/.test(f));
  } catch { return false; }
});
check('自定义子目录：落到 附件/图片/', okSub);

/* ---------- 6. 不支持的类型被拒绝且不落盘 ---------- */
const before = fs.readdirSync(VAULT).length;
await dropFile('aGVsbG8gdG90YWw=', '笔记.txt', 'text/plain');
await sleep(1500);
const after = fs.readdirSync(VAULT).length;
check('拖入 txt 被拒绝、不落盘、不插链', after === before && !noteHas('笔记\\.txt'));

/* ---------- 7. 设置清洗：非法文件夹名被服务端挡下 ---------- */
const bad = await fetch(`http://localhost:${PORT}/api/settings`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ attachment: { folder: '../../etc' } }),
});
const state = JSON.parse(await (await fetch(`http://localhost:${PORT}/api/state`)).text());
check('非法附件文件夹名被清洗（保持原值）', bad.status === 200 && state.settings?.attachment?.folder === '附件/图片', state.settings?.attachment?.folder);

check('无渲染错误', errors.length === 0, errors.join(' | '));

await browser.close();
server.kill();
fs.rmSync(HOME, { recursive: true, force: true });
console.log('\n' + log.join('\n'));
process.exit(log.some((l) => l.startsWith('FAIL')) ? 1 : 0);
