/**
 * EVNote preload（CommonJS .cjs：package.json 是 type:module）
 * 向渲染进程暴露最小化的窗口控制能力，不引入 Node 全能权限。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  platform: process.platform,
  minimize: () => ipcRenderer.send('evnote:win-minimize'),
  maximize: () => ipcRenderer.send('evnote:win-maximize'),
  close: () => ipcRenderer.send('evnote:win-close'),
  pickVault: () => ipcRenderer.invoke('evnote:pick-vault'),
});
