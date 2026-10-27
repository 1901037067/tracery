/** 在 dist 内复制本轮工作区快照，所有测试、临时仓库和截图都写副本，避免污染原有修改。 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';
import { suites } from './suites.mjs';
import { runtimeDependencies } from '../scripts/runtime-deps.mjs';
import { directoryBytes } from '../scripts/clean.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2), mode = args[0] || 'smoke';
const selected = mode === 'smoke' ? suites.filter(s => s.smoke)
  : mode === 'full' ? suites
  : mode === 'core' ? suites.filter(s => !['performance', 'lan', 'mdns', 'sync', 'sync-ui', 'sync-enc'].includes(s.id))
  : mode === 'only' ? suites.filter(s => args.slice(1).includes(s.id)) : [];
if (!selected.length || (mode === 'only' && args.slice(1).some(id => !suites.some(s => s.id === id)))) {
  throw new Error('用法：node test/run-suite.mjs smoke | core | full | only <套件名…>');
}
const runId = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '') + '-' + process.pid;
const OUT = path.join(ROOT, 'dist/test-runs', runId);
fs.mkdirSync(OUT, { recursive: true });
const report = { runId, mode, startedAt: new Date().toISOString(), appVersion: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'))).version,
  isolation: '每个套件使用独立工作区副本与 TEMP/TMP；不向源笔记或源截图写入', results: [] };
try {
  report.sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  report.sourceDirty = !!execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
} catch { report.sourceRevision = 'unavailable'; }
console.log(`验收目录：${OUT}\n模式：${mode}，${selected.length} 个套件（串行执行）`);

function writeReport() {
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(report, null, 2));
  const rows = report.results.map(r => `| ${r.id} | ${r.area} | ${r.status} | ${r.seconds} 秒 | [日志](${r.id}/output.log) |`).join('\n');
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `# Tracery 本地自动验收\n\n版本：${report.appVersion} · 模式：${mode}\n\n${report.isolation}\n\n| 套件 | 覆盖 | 结果 | 耗时 | 证据 |\n|---|---|---|---|---|\n${rows}\n\n实体手机连通、不同路由器与系统图标显示仍需手工验收。自动通过不代表所有场景均已验证。\n`);
}
async function closeBrowsers(tmp) {
  const ports = [];
  function walk(dir, depth = 0) {
    if (depth > 4) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === 'DevToolsActivePort') ports.push(file);
      else if (entry.isDirectory() && (depth === 0 || /browser|profile/i.test(entry.name))) walk(file, depth + 1);
    }
  }
  walk(tmp);
  for (const portFile of ports) {
    try {
      const [port, endpoint] = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
      if (!/^\d+$/.test(port) || !endpoint.startsWith('/devtools/browser/')) continue;
      const browser = await puppeteer.connect({ browserWSEndpoint: `ws://127.0.0.1:${port}${endpoint}`, protocolTimeout: 2000 });
      await browser.close();
    } catch { /* 已被套件正常关闭，或启动没有完成 */ }
  }
}

for (const [index, suite] of selected.entries()) {
  const dir = path.join(OUT, suite.id), work = path.join(dir, 'work'), tmp = path.join(dir, 'tmp');
  fs.mkdirSync(work, { recursive: true }); fs.mkdirSync(tmp);
  for (const entry of ['public', 'server', 'sync-server', 'electron', 'build', 'demo-vault', 'docs', 'test', 'scripts', 'package.json', 'README.md', 'eslint.config.mjs', 'tsconfig.json', 'tsconfig.cm.json', 'tsconfig.lint.json']) {
    const source = path.join(ROOT, entry);
    fs.cpSync(source, path.join(work, entry), { recursive: true, filter: file => {
      const rel = path.relative(ROOT, file).replaceAll('\\', '/');
      return !rel.startsWith('test/screenshots/') && rel !== 'test/screenshots' && !rel.endsWith('.log');
    } });
  }
  fs.mkdirSync(path.join(work, 'test/screenshots'), { recursive: true });
  // mDNS 的打包闭包检查要读取真实的 node_modules；复制生产依赖，开发依赖仍由上层解析。
  for (const source of runtimeDependencies(ROOT)) {
    fs.cpSync(source, path.join(work, path.relative(ROOT, source)), { recursive: true });
  }
  const output = fs.createWriteStream(path.join(dir, 'output.log'));
  console.log(`[${index + 1}/${selected.length}] ${suite.id} · ${suite.area}`);
  const started = Date.now(); let timedOut = false, spawnError = '';
  const child = spawn(process.execPath, ['--import', pathToFileURL(path.join(work, 'test/browser-preload.mjs')).href, path.join(work, 'test', suite.script)], {
    cwd: work, env: { ...process.env, TEMP: tmp, TMP: tmp, TRACERY_TEST_EXE: '', TRACERY_HOME: path.join(tmp, 'app-home') }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  child.stdout.on('data', data => output.write(data)); child.stderr.on('data', data => output.write(data));
  const timer = setTimeout(() => {
    timedOut = true;
    if (process.platform === 'win32') { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {} }
    else child.kill('SIGKILL');
  }, 300000);
  const code = await new Promise(resolve => { child.once('error', error => { spawnError = error.message; resolve(-1); }); child.once('close', resolve); });
  clearTimeout(timer); if (spawnError) output.write(spawnError);
  await new Promise(resolve => output.end(resolve));
  await closeBrowsers(tmp);
  const result = { ...suite, status: timedOut ? 'TIMEOUT' : code === 0 ? 'PASS' : 'FAIL', exitCode: code, seconds: Math.round((Date.now() - started) / 1000), log: `${suite.id}/output.log` };
  report.results.push(result); writeReport();
  console.log(`  ${result.status} · ${result.seconds} 秒`);
  if (result.status !== 'PASS') console.log(fs.readFileSync(path.join(dir, 'output.log'), 'utf8').slice(-4500));
}
report.finishedAt = new Date().toISOString(); writeReport();
const failed = report.results.filter(result => result.status !== 'PASS');
try { console.log(`本轮占用 ${(directoryBytes(OUT, { rejectLinks: false }) / 1048576).toFixed(1)} MiB（不跟随链接）；清理预览：npm run clean（默认不删除）`); } catch (error) { console.log('磁盘统计跳过：' + error.message); }
console.log(`\n${report.results.length - failed.length}/${report.results.length} 套件通过\n报告：${path.join(OUT, 'REPORT.md')}`);
process.exitCode = failed.length ? 1 : 0;
