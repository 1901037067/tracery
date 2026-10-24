/**
 * Tracery Electron 主进程（CommonJS）
 * 架构对应（详见 docs/OBSIDIAN_ANALYSIS.md）：
 *   Obsidian = Electron 主进程 + 渲染进程；Tracery 原本是 Node 服务端 + 浏览器。
 *   打包形态把两者合一：服务端逻辑（server/server.js）作为子进程运行
 *   （Electron 以 Node 模式启动，ELECTRON_RUN_AS_NODE=1），BrowserWindow 加载本地 HTTP 服务。
 *   —— 多进程模型与 Obsidian 一致，也避开 Electron 主进程 ESM 的已知坑。
 */
const { app, BrowserWindow, shell, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

// 环境自愈：某些环境（如把 Electron 当 Node 用的沙箱/CI）会预设 ELECTRON_RUN_AS_NODE，
// 这会让 Electron 退化成纯 Node（require('electron') 拿不到 API）。此时去掉它重启自己。
if (process.env.TRACERY_REEXEC !== '1' && process.env.ELECTRON_RUN_AS_NODE) {
  const env = { ...process.env, TRACERY_REEXEC: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(process.execPath, process.argv.slice(1), {
    env,
    detached: true,
    stdio: 'inherit',
  });
  child.unref();
  process.exit(0);
}

const HOME = app.getPath('userData');
const PORT = process.env.PORT || '9520';

// 打包版没有控制台：日志落盘，方便用户反馈问题时排查
const logStream = fs.createWriteStream(path.join(HOME, 'tracery.log'), { flags: 'a' });
const log = (...args) => logStream.write(`[${new Date().toISOString()}] ${args.map(String).join(' ')}\n`);
log('Tracery 启动中…');

// 首次以 Tracery 身份启动：把旧版 EVNote 用户目录里的配置拷过来。
// 为什么需要：userData 目录名跟着产品名走（EVNote → Tracery），
// 不搬的话老用户的「最近仓库 / 设置 / 当前仓库」看起来像丢了。
// 只拷贝不删除旧目录，想回退旧版本随时能用。
const LEGACY_HOME = path.join(app.getPath('appData'), 'EVNote');
if (!process.env.TRACERY_HOME && !process.env.EVNOTE_HOME
    && !fs.existsSync(path.join(HOME, 'tracery.config.json'))
    && fs.existsSync(path.join(LEGACY_HOME, 'evnote.config.json'))) {
  try {
    fs.mkdirSync(HOME, { recursive: true });
    fs.copyFileSync(path.join(LEGACY_HOME, 'evnote.config.json'), path.join(HOME, 'tracery.config.json'));
    log('已从旧版 EVNote 用户目录迁移配置文件');
  } catch (e) {
    log('配置迁移失败（不影响启动，按首次使用处理）：', e.message);
  }
}

let mainWindow = null;
let serverProc = null;

function startServer() {
  const serverPath = path.join(__dirname, '..', 'server', 'server.js');
  serverProc = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',   // 让 Electron 二进制以纯 Node 模式运行服务端
      TRACERY_HOME: process.env.TRACERY_HOME || process.env.EVNOTE_HOME || HOME,  // asar 只读 → 配置/仓库写用户目录（可用环境变量重定向，便于便携模式/测试；兼容旧名 EVNOTE_HOME）
      PORT: String(PORT),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', (d) => log('[server]', String(d).trimEnd()));
  serverProc.stderr.on('data', (d) => log('[server:err]', String(d).trimEnd()));
  serverProc.on('exit', (code) => log('[server] 退出, code =', code));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 760,
    minHeight: 480,
    frame: false,               // 无边框，用应用内自定义标题栏（仿 Obsidian）
    titleBarStyle: 'hidden',
    backgroundColor: '#1e1e1e',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      plugins: true,            // 启用 Chromium 内置 PDF 阅读器（应用内看 PDF 用）
    },
    show: false,
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(`http://localhost:${PORT}`);

  // 系统关闭、标题栏关闭和应用退出都先等待渲染进程确认落盘。
  let closePending = false;
  mainWindow.on('close', (event) => {
    const win = mainWindow;
    if (win.traceryCloseApproved) return;
    event.preventDefault();
    if (closePending) return;
    closePending = true;
    let timer;
    Promise.race([
      win.webContents.executeJavaScript('window.__tracery?.prepareClose ? window.__tracery.prepareClose() : true'),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('等待保存超时')), 35000); }),
    ]).then(ok => {
      if (ok && !win.isDestroyed()) { win.traceryCloseApproved = true; win.close(); }
    }).catch(error => {
      if (!win.isDestroyed()) dialog.showMessageBox(win, { type: 'warning', title: '尚未退出', message: '未能确认笔记保存完成，窗口保持打开。', detail: `${error.message}。请重试保存，或先复制、导出未保存的文字。` });
    }).finally(() => { clearTimeout(timer); closePending = false; });
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  // 外链交给系统浏览器，不在应用内开新窗
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  ipcMain.on('tracery:win-minimize', () => mainWindow && mainWindow.minimize());
  ipcMain.on('tracery:win-maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.on('tracery:win-close', () => mainWindow && mainWindow.close());

  // 附件右键菜单用：在资源管理器中定位 / 用系统默认应用打开（只接受绝对路径）
  ipcMain.on('tracery:reveal', (e, p) => {
    if (typeof p === 'string' && path.isAbsolute(p)) shell.showItemInFolder(p);
  });
  ipcMain.on('tracery:open-path', (e, p) => {
    if (typeof p === 'string' && path.isAbsolute(p)) shell.openPath(p);
  });

  // 导出 PDF：隐藏窗口渲染 HTML → printToPDF → 保存对话框
  ipcMain.handle('tracery:export-pdf', async (e, { html, name } = {}) => {
    if (typeof html !== 'string') return null;
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: '导出 PDF',
      defaultPath: name || 'note.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (canceled || !filePath) return null;
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    try {
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      await new Promise((r) => setTimeout(r, 400));   // 等字体/图片就位
      const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
      fs.writeFileSync(filePath, pdf);
      return filePath;
    } finally {
      win.destroy();
    }
  });

  // 原生「选择仓库文件夹」对话框
  ipcMain.handle('tracery:pick-vault', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '选择仓库文件夹',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '打开仓库',
    });
    if (res.canceled || !res.filePaths?.length) return null;
    return res.filePaths[0];
  });
}

app.whenReady().then(() => {
  startServer();
  // 等服务端就绪再开窗口（最多等 10 秒）
  const waitAndOpen = async () => {
    for (let i = 0; i < 50; i++) {
      try {
        const res = await fetch(`http://localhost:${PORT}/api/state`);
        if (res.ok) break;
      } catch { /* 重试 */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!mainWindow) createWindow();
  };
  waitAndOpen();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// 退出时确保服务端子进程一起退（否则端口被占）
app.on('before-quit', event => {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.traceryCloseApproved) {
    event.preventDefault(); mainWindow.close(); return;
  }
  if (serverProc && !serverProc.killed) {
    serverProc.kill();
    serverProc = null;
  }
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
