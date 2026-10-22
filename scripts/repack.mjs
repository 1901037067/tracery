/**
 * 重新打包 app.asar（绕过 electron-builder 在 Windows 上的 winCodeSign 符号链接问题）
 * 用法：node scripts/repack.mjs
 * 前提：dist/win-unpacked 已由 `npm run dist:dir` 生成过一次（含 Tracery.exe 与 Electron 运行时）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runtimeDependencies } from './runtime-deps.mjs';
import { patchWindowsIcon } from './lib/windows-icon.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'dist', 'win-unpacked');
const STAGE = path.join(ROOT, 'dist', 'app-stage');
const ASAR = path.join(OUT, 'resources', 'app.asar');
const ASAR_BIN = path.join(ROOT, 'node_modules', '@electron', 'asar', 'bin', 'asar.js');

if (!fs.existsSync(path.join(OUT, 'Tracery.exe'))) {
  console.error('✗ 找不到 dist/win-unpacked/Tracery.exe，先跑一次 npm run dist:dir');
  process.exit(1);
}

fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });

for (const item of ['electron', 'server', 'public', 'demo-vault', 'sync-server']) {
  fs.cpSync(path.join(ROOT, item), path.join(STAGE, item), { recursive: true });
}
fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(STAGE, 'package.json'));
// 运行时依赖（ws、node-diff3…）必须一起进去，否则 asar 里 import 会失败
fs.mkdirSync(path.join(STAGE, 'node_modules'), { recursive: true });
for (const src of runtimeDependencies(ROOT)) {
  const dest = path.join(STAGE, path.relative(ROOT, src));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}
fs.mkdirSync(path.join(STAGE, 'build'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'build', 'icon.png'), path.join(STAGE, 'build', 'icon.png'));

execFileSync(process.execPath, [ASAR_BIN, 'pack', STAGE, ASAR], { stdio: 'inherit' });
patchWindowsIcon(path.join(OUT, 'Tracery.exe'), ROOT);
fs.rmSync(STAGE, { recursive: true, force: true });

const size = (fs.statSync(ASAR).size / 1024).toFixed(0);
console.log(`✓ app.asar 已更新：${ASAR}（${size} KB）`);
console.log('  发布：把 dist/win-unpacked 压成 zip 即可');
