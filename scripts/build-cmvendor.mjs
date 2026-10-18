/**
 * build-cmvendor.mjs — 把 CodeMirror 6 依赖树离线打包进 public/vendor/cm/
 * ------------------------------------------------------------------
 * 背景：EDITOR-MIGRATION.md 第 3 节计划「依赖可离线打进 public/vendor/」。
 * 浏览器加载 ESM 时不认识 node_modules 的裸导入名（@codemirror/view 等），
 * 本脚本做三件事：
 *   1. 从入口包出发走完整 dependencies 树，解析每个包的浏览器 ESM 入口
 *      （exports.import / module / main，优先级从高到低）；
 *   2. 平铺复制到 public/vendor/cm/<包名>/index.js（保留 @scope 目录），
 *      包间相对路径全部保持原样（它们互相用裸名导入，由 importmap 接管）；
 *   3. 生成 importmap 并注入目标 HTML 的 <!-- IMPORTMAP:BEGIN/END --> 标记之间，
 *      同时扫描所有拷贝文件里的裸导入名，逐一核对能被 importmap 覆盖（漏一个都报错）。
 *
 * 用法：node scripts/build-cmvendor.mjs [--entries a,b,c] [--html public/cmlab.html]
 * 默认入口即迁移文档 P0 安装的五个包。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'public', 'vendor', 'cm');
const require = createRequire(path.join(ROOT, 'package.json'));

const DEFAULT_ENTRIES = [
  '@codemirror/state',
  '@codemirror/view',
  '@codemirror/commands',
  '@codemirror/lang-markdown',
  '@lezer/markdown',
];

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { entries: DEFAULT_ENTRIES, html: 'public/cmlab.html' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--entries') out.entries = args[++i].split(',').map((s) => s.trim());
    if (args[i] === '--html') out.html = args[++i];
  }
  return out;
}

/** 解析一个包的浏览器 ESM 入口绝对路径 */
function resolveEsmEntry(pkg) {
  // exports 普遍不开放 ./package.json 子路径：先解析任一入口，再向上找包目录
  const anchor = require.resolve(pkg);
  let dir = path.dirname(anchor);
  while (!fs.existsSync(path.join(dir, 'package.json'))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`找不到 ${pkg} 的包目录`);
    dir = parent;
  }
  const pkgJsonPath = path.join(dir, 'package.json');
  const json = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  const candidates = [];
  const ex = json.exports;
  if (typeof ex === 'string') candidates.push(ex);
  else if (ex && typeof ex === 'object') {
    const top = ex['.'] || ex;
    if (typeof top === 'string') candidates.push(top);
    else if (top && typeof top === 'object') {
      for (const cond of ['import', 'module', 'browser', 'default']) {
        if (typeof top[cond] === 'string') candidates.push(top[cond]);
      }
    }
  }
  if (json.module) candidates.push(json.module);
  if (json.main) candidates.push(json.main);
  for (const rel of candidates) {
    if (!rel || !rel.startsWith('.')) continue;
    const abs = path.join(dir, rel);
    if (fs.existsSync(abs) && abs.endsWith('.js')) return { pkgDir: dir, entry: abs };
  }
  throw new Error(`无法解析 ${pkg} 的 ESM 入口（exports=${JSON.stringify(ex)}）`);
}

/** 走依赖树，返回 Map<包名, {pkgDir, entry}> */
function walk(entries) {
  const seen = new Map();
  const queue = [...entries];
  while (queue.length) {
    const pkg = queue.shift();
    if (seen.has(pkg)) continue;
    const found = resolveEsmEntry(pkg);
    seen.set(pkg, found);
    const json = JSON.parse(fs.readFileSync(path.join(found.pkgDir, 'package.json'), 'utf8'));
    for (const dep of Object.keys(json.dependencies || {})) queue.push(dep);
  }
  return seen;
}

/** 从文件文本里提取所有裸导入/动态导入名（排除相对路径与 node: 内置） */
function extractBareSpecifiers(code) {
  const names = new Set();
  // 只认语句边界（行首 / ; { } 后）的 import/export，避免匹配到字符串字面量里的
  // "import export from" 之类的关键词表；捕获后还要过一遍 specifier 合法性检查。
  const re = /(?:^|[;{}\n)])\s*(?:import|export)\b[^;'"()]*?from\s*['"]([^'"]+)['"]|(?:^|[;{}\n)])\s*import\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|[;{}\n)])\s*import\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(code))) {
    const spec = m[1] || m[2] || m[3];
    if (!spec || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue;
    if (!/^[@\w][\w@./-]*$/.test(spec)) continue; // 合法模块名不会含空格/逗号/冒号
    names.add(spec);
  }
  return [...names];
}

const { entries, html } = parseArgs();
const tree = walk(entries);

// 1) 复制文件
fs.rmSync(OUT_DIR, { recursive: true, force: true });
let totalBytes = 0;
const importmap = {};
for (const [pkg, { entry: src }] of tree) {
  const dest = path.join(OUT_DIR, pkg, 'index.js');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  const size = fs.statSync(dest).size;
  totalBytes += size;
  importmap[pkg] = `/vendor/cm/${pkg}/index.js`;
  console.log(`  ${pkg.padEnd(32)} ${(size / 1024).toFixed(1).padStart(8)} KB  <- ${path.relative(ROOT, src)}`);
}

// 2) 校验：所有拷贝文件里的裸导入都必须被 importmap 覆盖
const missing = [];
for (const [pkg, { entry: src }] of tree) {
  const code = fs.readFileSync(src, 'utf8');
  for (const spec of extractBareSpecifiers(code)) {
    if (!importmap[spec]) missing.push(`${pkg} -> ${spec}`);
  }
}
if (missing.length) {
  console.error('\n[build-cmvendor] 以下裸导入没有对应 vendor 副本：');
  for (const m of missing) console.error('  ' + m);
  process.exit(1);
}

// 3) 生成 importmap 并注入 HTML 标记区
const mapJson = JSON.stringify({ imports: importmap }, null, 2);
fs.writeFileSync(path.join(OUT_DIR, 'importmap.json'), mapJson + '\n');
const htmlPath = path.join(ROOT, html);
if (fs.existsSync(htmlPath)) {
  const htmlText = fs.readFileSync(htmlPath, 'utf8');
  const blockRe = /<!-- IMPORTMAP:BEGIN[\s\S]*?IMPORTMAP:END -->/;
  if (!blockRe.test(htmlText)) {
    console.error(`\n[build-cmvendor] ${html} 里找不到 IMPORTMAP:BEGIN/END 标记，未注入`);
    process.exit(1);
  }
  const block = `<!-- IMPORTMAP:BEGIN (由 scripts/build-cmvendor.mjs 生成，勿手改) -->\n<script type="importmap">\n${mapJson}\n</script>\n<!-- IMPORTMAP:END -->`;
  // 注意：用「正则是否命中」判断，不能用「替换后文本是否变化」——
  // 幂等重跑时 importmap 没变，替换前后一致，会被误判成找不到标记
  fs.writeFileSync(htmlPath, htmlText.replace(blockRe, block));
}

console.log(`\n[build-cmvendor] ${tree.size} 个包，合计 ${(totalBytes / 1024).toFixed(1)} KB -> public/vendor/cm/`);
console.log(`[build-cmvendor] importmap 已注入 ${html}（${Object.keys(importmap).length} 条映射，裸导入全覆盖校验通过）`);
