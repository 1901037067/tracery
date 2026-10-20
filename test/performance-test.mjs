/* 一万篇真实临时文件 + Edge：同时量冷 / 热索引与真实滚动，防止靠减少数据伪造性能。 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { Vault } from '../server/vault.js';
const ROOT = path.resolve(import.meta.dirname, '..');
const TEMP = path.join(os.tmpdir(), 'tracery-performance-test');
if (!path.resolve(TEMP).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('临时路径越界');
fs.rmSync(TEMP, { recursive: true, force: true });
const VAULT = path.join(TEMP, 'vault'), HOME = path.join(TEMP, 'home');
fs.mkdirSync(VAULT, { recursive: true }); fs.mkdirSync(HOME);
const OUT = path.join(ROOT, 'dist/performance-preview'); fs.mkdirSync(OUT, { recursive: true });
const COUNT = 10000, PORT = 9603, BASE = `http://127.0.0.1:${PORT}`;
const checks = [], metrics = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, detail = '') { checks.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); }
const name = (i) => `笔记${String(i).padStart(5, '0')}`;
const rel = (i) => `分类${String(Math.floor(i / 500)).padStart(2, '0')}/${name(i)}.md`;
for (let i = 0; i < COUNT; i++) {
  const dest = path.join(VAULT, rel(i)); fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, `# ${name(i)}\n\n[[${name((i + 1) % COUNT)}]] #性能\n\n${'用于验证真实仓库内容检索与索引复用。'.repeat(30)}\n`);
}
fs.writeFileSync(path.join(VAULT, '入口.md'), '# 入口\n\n[[笔记09999]]\n');
let server, browser;
try {
  // 固定到优化前的提交，后续重跑仍可比较同一基线，临时模块只落忽略的 dist。
  let old;
  try { old = execFileSync('git', ['show', '4a306b5:server/server.js'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { console.log('INFO 浅克隆无历史基线，仍执行所有正确性与规模断言'); }
  if (old) {
    const cls = old.slice(old.indexOf('class Vault {'), old.indexOf('\nlet vault = null;'));
    const baseFile = path.join(OUT, 'vault-baseline.mjs');
    fs.writeFileSync(baseFile, `import fsp from 'node:fs/promises';import path from 'node:path';const IGNORED_DIRS=new Set(['.tracery','.evnote','.obsidian','.git','node_modules','.trash']);const TEXT_EXT=new Set(['.md','.markdown','.txt']);export ${cls}`);
    const { Vault: Baseline } = await import(pathToFileURL(baseFile));
    const baseline = new Baseline(VAULT), t0 = performance.now(); await baseline.open(); metrics.baselineMs = Math.round(performance.now() - t0);
  }
  const cold = new Vault(VAULT); await cold.open(); metrics.cold = { ...cold.stats };
  check('一万篇冷启动完整建立索引并落盘', cold.notes.size === COUNT + 1 && cold.stats.parsed === COUNT + 1 && fs.existsSync(path.join(VAULT, '.tracery/index.json')));
  const warm = new Vault(VAULT); await warm.open(); metrics.warm = { ...warm.stats };
  check('热启动不重读、不重解析未改变的笔记', warm.stats.reads === 0 && warm.stats.parsed === 0 && warm.stats.reused === COUNT + 1, JSON.stringify(metrics));
  check('热索引保留搜索、标签、出链与反链', warm.search('笔记09999').some((n) => n.path === rel(9999)) && warm.allTags().some((t) => t.tag === '性能' && t.count === COUNT) && warm.notes.get(rel(1)).backlinks.has(rel(0)));
  const target = path.join(VAULT, rel(0));
  const originalStat = fs.statSync(target), original = fs.readFileSync(target, 'utf8');
  fs.writeFileSync(target, original.replace(name(1), name(2)));
  fs.utimesSync(target, originalStat.atime, originalStat.mtime);
  const builds = warm.stats.graphBuilds, reads = warm.stats.reads;
  const change = await warm.applyChanges([rel(0), rel(0)]);
  check('同尺寸且还原 mtime 的修改也能发现，只读一次', warm.stats.reads === reads + 1 && change.treeChanged === false);
  check('单篇保存只更新相关反链，不重建全图', warm.stats.graphBuilds === builds && !warm.notes.get(rel(1)).backlinks.has(rel(0)) && warm.notes.get(rel(2)).backlinks.has(rel(0)));
  const readOnce = warm.stats.reads; await warm.applyChanges([rel(0)]);
  check('重复监听事件不重读同一文件', warm.stats.reads === readOnce);
  await warm.persist();
  fs.writeFileSync(path.join(VAULT, rel(3)), '# 改过的笔记\n\n#新标签\n');
  const changed = new Vault(VAULT); await changed.open();
  check('重新启动只解析磁盘上改变的一篇', changed.stats.parsed === 1 && changed.stats.reused === COUNT && changed.contentCache.get(rel(0)).includes(name(2)));
  // 创建 / 删除同名目标必须全局重新判定，不能把唯一匹配缓存成永久结果。
  fs.mkdirSync(path.join(VAULT, '重复')); fs.writeFileSync(path.join(VAULT, '重复', name(2) + '.md'), '# 重名');
  await changed.applyChange(`重复/${name(2)}.md`);
  check('新增同名文件后跨目录双链变为未解析', changed.resolve(name(2), '入口.md') === null);
  fs.unlinkSync(path.join(VAULT, '重复', name(2) + '.md')); await changed.applyChange(`重复/${name(2)}.md`);
  check('删除重名文件后唯一双链恢复', changed.resolve(name(2), '入口.md') === rel(2));
  fs.renameSync(path.join(VAULT, '分类19'), path.join(VAULT, '改名目录')); await changed.applyChange('分类19');
  check('外部目录改名后旧路径清理、新路径完整', !changed.notes.has(rel(9999)) && changed.notes.has(`改名目录/${name(9999)}.md`) && changed.stats.parsed === 500);
  const scanning = changed.open(); await new Promise(setImmediate);
  check('重新扫描期间仍提供完整的上一版索引', changed.notes.size === COUNT + 1 && changed.notes.has(`改名目录/${name(9999)}.md`));
  await scanning;
  // 格式损坏 / 版本不匹配必须重建，可删除的缓存不能变成启动依赖。
  await changed.persist();
  const indexPath = path.join(VAULT, '.tracery/index.json'), validIndex = fs.readFileSync(indexPath);
  fs.writeFileSync(indexPath, '{broken'); const broken = new Vault(VAULT); await broken.open();
  check('索引损坏能自动重建且原笔记不变', broken.notes.size === COUNT + 1 && broken.stats.parsed === COUNT + 1 && fs.readFileSync(target, 'utf8').includes(name(2)));
  fs.writeFileSync(indexPath, validIndex);
  const cache = JSON.parse(validIndex); cache.version = -1; fs.writeFileSync(indexPath, JSON.stringify(cache));
  const version = new Vault(VAULT); await version.open();
  check('旧格式索引自动失效', version.stats.parsed === COUNT + 1);
  const readonly = path.join(TEMP, 'cache-unwritable'); fs.mkdirSync(path.join(readonly, '.tracery/index.json'), { recursive: true });
  fs.writeFileSync(path.join(readonly, '正常笔记.md'), '# 原内容');
  const fallback = new Vault(readonly); await fallback.open();
  check('缓存无法写入时仍正常打开笔记', fallback.notes.size === 1 && fallback.contentCache.get('正常笔记.md') === '# 原内容' && await fallback.persist() === false);
  fs.writeFileSync(path.join(HOME, 'tracery.config.json'), JSON.stringify({ currentVault: VAULT, settings: { startup: 'empty' } }));
  server = spawn(process.execPath, ['server/server.js'], { cwd: ROOT, env: { ...process.env, TRACERY_HOME: HOME, PORT: String(PORT) }, stdio: 'pipe' });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/api/state')).ok) break; } catch {} await sleep(200); }
  browser = await puppeteer.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true, args: ['--no-sandbox'], defaultViewport: { width: 1360, height: 860 } });
  const page = await browser.newPage(), errors = [], requests = [];
  page.on('pageerror', (e) => errors.push(e.message)); page.on('request', (req) => requests.push(new URL(req.url()).pathname));
  const start = performance.now(); await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.virtual-tree .tree-item'); metrics.browserReadyMs = Math.round(performance.now() - start);
  const nodes = await page.$eval('#file-tree', (el) => ({ dom: el.querySelectorAll('.tree-item').length, height: el.scrollHeight })); metrics.tree = nodes;
  check('一万篇文件树只创建可视行 DOM', nodes.dom < 80 && nodes.height > 300000, JSON.stringify(nodes));
  check('编辑界面启动不请求隐藏图谱', !requests.includes('/api/graph'));
  await page.$eval('#file-tree', (el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForSelector('#file-tree [data-path="入口.md"]');
  await page.click('#file-tree [data-path="入口.md"]'); await page.waitForFunction(() => window.__tracery.state.currentPath === '入口.md');
  check('滚到末尾可打开真实笔记', await page.$eval('#note-path', (el) => el.textContent === '入口.md'));
  // 滚动可视节点后，从编辑器右键定位到屏幕外的文件。
  await page.evaluate(() => window.__tracery.revealInTree('改名目录/笔记09999.md'));
  await page.waitForSelector('#file-tree [data-path="改名目录/笔记09999.md"]');
  check('定位屏幕外文件能展开并滚到正确行', await page.$eval('#file-tree [data-path="改名目录/笔记09999.md"]', (el) => { const r = el.getBoundingClientRect(); return r.top >= 60 && r.bottom < innerHeight; }));
  await page.click('#file-tree [data-path="改名目录/笔记09999.md"]');
  await page.waitForFunction(() => window.__tracery.state.currentPath === '改名目录/笔记09999.md');
  const beforeTree = await page.$('.virtual-tree .tree-item');
  await page.evaluate(() => window.__tracery.editor.insertText('性能保存验证'));
  const requestStart = requests.length; await page.evaluate(() => window.__tracery.editor.flush()); await sleep(600);
  check('保存不请求全树和隐藏图谱', !requests.slice(requestStart).some((p) => ['/api/tree', '/api/graph'].includes(p)), requests.slice(requestStart).join(','));
  check('打开笔记与普通保存不重建可视树行', await page.evaluate((el) => el.isConnected, beforeTree));
  await page.screenshot({ path: path.join(OUT, 'large-vault.png') });
  await page.click('#btn-collapse-tree'); await sleep(200);
  check('折叠全部后可见目录与根文件完整', await page.$$eval('#file-tree .tree-item', (els) => els.length === 22));
  await page.click('#btn-collapse-tree'); await sleep(200);
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.tap('#btn-toggle-left'); await sleep(200);
  check('手机抽屉同样使用虚拟行且无横向溢出', await page.$eval('#file-tree', (el) => el.querySelectorAll('.tree-item').length < 80 && document.documentElement.scrollWidth === innerWidth));
  await page.screenshot({ path: path.join(OUT, 'large-vault-mobile.png') });
  check('无浏览器脚本错误', !errors.length, errors.join(' | '));
} finally { await browser?.close(); server?.kill(); }
fs.writeFileSync(path.join(OUT, 'metrics.json'), JSON.stringify(metrics, null, 2));
console.log(`${checks.filter(Boolean).length}/${checks.length} 通过`);
process.exit(checks.every(Boolean) ? 0 : 1);
