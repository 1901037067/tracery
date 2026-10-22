/* 免签名打包仍应有正确的资源管理器图标；Windows 原生资源更新后立即比对每个尺寸。 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';
export function patchWindowsIcon(executable, root, verifyOnly = false) {
  if (process.platform !== 'win32') throw new Error('Windows exe 图标资源更新需要在 Windows 上运行');
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/patch-exe-icon.ps1'),
    '-Executable', executable, '-Icon', path.join(root, 'build/icon.ico'), ...(verifyOnly ? ['-VerifyOnly'] : [])], { stdio: 'inherit', windowsHide: true });
}
