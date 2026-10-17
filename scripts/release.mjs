/**
 * 一键发布打包：repack app.asar → 压 zip → （可选）桌面快捷方式
 * 用法：node scripts/release.mjs [--shortcut]
 * 前提：dist/win-unpacked 已由 `npm run dist:dir` 生成过一次（见 repack.mjs）
 *
 * 为什么这样做：
 * 1. electron-builder 在普通 Windows 账户上解 winCodeSign 要符号链接权限（HANDOFF §6），
 *    所以发布链路固定为 dist:dir 出目录 + repack 只重打 asar + 压 zip。
 * 2. 压缩引擎优先 7za/7z（快），找不到就回退 PowerShell 的 Compress-Archive（系统自带）。
 * 3. 先压成 <name>.new.zip 成功后才改名覆盖——压缩中途失败不会毁掉上一版发布包。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'dist', 'win-unpacked');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const ZIP_NAME = `Tracery-${VERSION}-win32-x64.zip`;
const ZIP = path.join(ROOT, 'dist', ZIP_NAME);
const ZIP_NEW = `${ZIP}.new.zip`;

if (!fs.existsSync(path.join(OUT, 'Tracery.exe'))) {
  console.error('✗ 找不到 dist/win-unpacked/Tracery.exe，先跑一次 npm run dist:dir');
  process.exit(1);
}

console.log('==> 1/3 重打 app.asar');
execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'repack.mjs')], { stdio: 'inherit' });

console.log('==> 2/3 压缩 zip');
const tool = ['7za', '7z'].find((t) => spawnSync('where', [t], { encoding: 'utf8' }).status === 0);
if (tool) {
  execFileSync(tool, ['a', '-tzip', ZIP_NEW, `${OUT}\\*`], { stdio: 'inherit' });
} else {
  console.log('    未找到 7za/7z，改用 PowerShell Compress-Archive（慢一些，正常）');
  execFileSync(
    'powershell',
    ['-NoProfile', '-Command', `Compress-Archive -Path '${OUT}\\*' -DestinationPath '${ZIP_NEW}' -Force`],
    { stdio: 'inherit' }
  );
}
// 兜底校验：压缩子进程被拦截/静默失败时不会抛错，但文件不会出现——
// 不查这一步，下一步 rename 会报一个莫名其妙的 ENOENT
if (!fs.existsSync(ZIP_NEW)) {
  console.error('压缩失败：临时 zip 未生成。常见原因：压缩进程被安全策略拦截，或目标文件被占用（关掉正在运行的打包版再试）');
  process.exit(1);
}
fs.renameSync(ZIP_NEW, ZIP);
const mb = (fs.statSync(ZIP).size / 1024 / 1024).toFixed(1);

if (process.argv.includes('--shortcut')) {
  console.log('==> 3/3 生成桌面快捷方式');
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'make-shortcut.mjs')], { stdio: 'inherit' });
} else {
  console.log('==> 3/3 跳过快捷方式（需要时加 --shortcut）');
}

console.log(`✓ 发布包就绪：dist/${ZIP_NAME}（${mb} MB）`);
console.log('  下一步：Gitee → 仓库 → Releases → 基于 tag 上传该 zip');
