/* 只清理可识别的旧测试工作副本；报告、日志、截图和所有发布产物均保留。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const within = (root, target) => { const rel = path.relative(root, target); return rel !== '' && !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep); };
function safe(root, target) {
  root = path.resolve(root); target = path.resolve(target);
  if (!within(root, target)) throw new Error('拒绝越界清理：' + target);
  for (let cursor = target; cursor !== root; cursor = path.dirname(cursor)) if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error('拒绝目录链接：' + cursor);
  if (!within(fs.realpathSync(root), fs.realpathSync(target))) throw new Error('真实路径越界：' + target);
  return target;
}
export function directoryBytes(directory, { rejectLinks = true } = {}) {
  let bytes = 0;
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isSymbolicLink()) { if (rejectLinks) throw new Error('拒绝包含链接的目录：' + file); continue; }
    bytes += item.isDirectory() ? directoryBytes(file, { rejectLinks }) : fs.statSync(file).size;
  }
  return bytes;
}
export function planCleanup(root, keep = 5) {
  root = path.resolve(root);
  const base = path.join(root, 'dist/test-runs'), runs = [], warnings = [];
  if (!fs.existsSync(base)) return { root, candidates: [], retained: [], warnings };
  safe(root, base);
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d{8}T\d{6}-\d+$/.test(entry.name)) continue;
    const dir = path.join(base, entry.name);
    try {
      safe(base, dir);
      const report = JSON.parse(fs.readFileSync(path.join(dir, 'results.json'), 'utf8'));
      if (!report.finishedAt || !Array.isArray(report.results) || !report.results.length || report.results.some(r => !/^[a-z0-9-]+$/.test(r.id) || !['PASS', 'FAIL', 'TIMEOUT'].includes(r.status))) throw new Error('报告缺失、未完成或格式未知');
      runs.push({ dir, id: entry.name, report, reasons: [] });
    } catch (error) { warnings.push({ path: dir, reason: error.message }); }
  }
  runs.sort((a, b) => a.id.localeCompare(b.id));
  for (const run of runs.slice(-keep)) run.reasons.push('最近 ' + keep + ' 次运行');
  const firstFailure = runs.find(run => run.report.results.some(r => r.status !== 'PASS'));
  if (firstFailure) firstFailure.reasons.push('首个失败记录');
  const latest = new Map(), latestPass = new Map();
  for (const run of runs) for (const result of run.report.results) {
    latest.set(result.id, { run, result });
    if (result.status === 'PASS') latestPass.set(result.id, run);
  }
  for (const { run, result } of latest.values()) if (result.status !== 'PASS') run.reasons.push('尚未通过：' + result.id);
  for (const [id, run] of latestPass) run.reasons.push('最终通过：' + id);
  const candidates = [], retained = [];
  for (const run of runs) {
    if (fs.existsSync(path.join(run.dir, '.keep'))) run.reasons.push('手工 .keep 标记');
    const resolved = path.join(run.dir, '.resolved');
    const diagnosed = fs.existsSync(resolved) && fs.lstatSync(resolved).isFile() && !fs.lstatSync(resolved).isSymbolicLink()
      && fs.statSync(resolved).size <= 8192 && fs.readFileSync(resolved, 'utf8').trim();
    if (run.report.results.some(row => row.status !== 'PASS') && !diagnosed) run.reasons.push('失败尚未用 .resolved 说明定位结论');
    if (run.reasons.length) { retained.push({ path: run.dir, reasons: run.reasons }); continue; }
    for (const result of run.report.results) {
      const work = path.join(run.dir, result.id, 'work');
      if (!fs.existsSync(work)) continue;
      try { safe(base, work); candidates.push({ path: work, bytes: directoryBytes(work), run: run.id, suite: result.id, reason: '旧工作副本；保留报告、日志、源码身份与截图' }); }
      catch (error) { warnings.push({ path: work, reason: error.message }); }
    }
  }
  return { root, candidates, retained, warnings };
}
export function applyCleanup(plan) {
  const base = path.join(plan.root, 'dist/test-runs');
  // 重新检查保留策略，不能直接信任调用方传来的任意删除路径。
  const approved = new Set(planCleanup(plan.root).candidates.map(item => item.path));
  for (const item of plan.candidates) {
    if (!approved.has(item.path)) throw new Error('清理计划已失效：' + item.path);
    const work = safe(base, item.path), suite = path.dirname(work);
    directoryBytes(work); // 最后一次检查目录内部也没有链接。
    const evidence = path.join(suite, 'preserved-evidence');
    if (fs.existsSync(evidence)) throw new Error('已有保存目录，拒绝覆盖：' + evidence);
    fs.mkdirSync(evidence);
    const preserve = (source, destination) => {
      if (!fs.existsSync(source)) return;
      for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        const file = path.join(source, entry.name), dest = path.join(destination, entry.name);
        if (entry.isSymbolicLink()) throw new Error('拒绝证据链接');
        if (entry.isDirectory()) { fs.mkdirSync(dest, { recursive: true }); preserve(file, dest); }
        else if (/\.(png|jpe?g|webp|gif|svg)$/i.test(entry.name)) { fs.mkdirSync(destination, { recursive: true }); fs.copyFileSync(file, dest, fs.constants.COPYFILE_EXCL); }
      }
    };
    preserve(path.join(work, 'dist'), path.join(evidence, 'dist'));
    preserve(path.join(work, 'test/screenshots'), path.join(evidence, 'screenshots'));
    if (fs.existsSync(path.join(work, 'package.json'))) fs.copyFileSync(path.join(work, 'package.json'), path.join(evidence, 'package.json'));
    safe(base, work);
    fs.rmSync(work, { recursive: true });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some(arg => arg !== '--apply')) throw new Error('用法：node scripts/clean.mjs [--apply]');
  const plan = planCleanup(path.resolve(import.meta.dirname, '..'));
  console.log(JSON.stringify({ mode: process.argv.includes('--apply') ? 'apply' : 'dry-run', ...plan }, null, 2));
  if (process.argv.includes('--apply')) applyCleanup(plan);
}
