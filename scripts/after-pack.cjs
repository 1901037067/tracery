/* electron-builder 关闭签名/资源编辑时，仍把产品图标写入最终 exe。 */
const path = require('node:path');
module.exports = async context => {
  const { writePackageNotices } = await import('./lib/package-notices.mjs');
  writePackageNotices(context.appOutDir, context.packager.projectDir);
  if (context.electronPlatformName !== 'win32') return;
  const { patchWindowsIcon } = await import('./lib/windows-icon.mjs');
  patchWindowsIcon(path.join(context.appOutDir, 'Tracery.exe'), context.packager.projectDir);
};
