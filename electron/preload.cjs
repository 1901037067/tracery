/**
 * Tracery preload（CommonJS .cjs：package.json 是 type:module）
 * 向渲染进程暴露最小化的窗口控制能力，不引入 Node 全能权限。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  platform: process.platform,
  minimize: () => ipcRenderer.send('tracery:win-minimize'),
  maximize: () => ipcRenderer.send('tracery:win-maximize'),
  close: () => ipcRenderer.send('tracery:win-close'),
  pickVault: () => ipcRenderer.invoke('tracery:pick-vault'),
  reveal: (p) => ipcRenderer.send('tracery:reveal', p),
  openPath: (p) => ipcRenderer.send('tracery:open-path', p),
  exportPdf: (html, name) => ipcRenderer.invoke('tracery:export-pdf', { html, name }),
});
