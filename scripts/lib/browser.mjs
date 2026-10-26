/* Edge 会交接启动进程；从独立配置目录读取调试端口，构建脚本和测试共用这一入口。 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

export function browserExecutable(options = {}) {
  if (process.env.TRACERY_BROWSER) return process.env.TRACERY_BROWSER;
  if (options.executablePath) return options.executablePath;
  const candidates = process.platform === 'win32'
    ? ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe']
    : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
    : ['/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome'];
  const executable=candidates.find(file=>fs.existsSync(file));
  if(!executable)throw Error('未找到浏览器，请通过 TRACERY_BROWSER 指定 Chromium、Chrome 或 Edge 的完整路径');
  return executable;
}

export async function launchBrowser(options = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tracery-browser-'));
  const executable = browserExecutable(options);
  const child = spawn(executable, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    // 与 Puppeteer 默认参数一致，避免 Windows 后台/遮挡节流暂停 rAF 和可见性测量。
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    ...(options.args || []), '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let failure;
  child.once('error', error => { failure = error; });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !failure && !fs.existsSync(portFile); i++) await new Promise(resolve => setTimeout(resolve, 200));
  if (failure || !fs.existsSync(portFile)) throw failure || new Error('浏览器未能启动调试端口');
  const [port, endpoint] = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
  const browser = await puppeteer.connect({ browserWSEndpoint: `ws://127.0.0.1:${port}${endpoint}`,
    protocolTimeout: options.protocolTimeout ?? 30000,
    defaultViewport: options.defaultViewport ?? { width: 1440, height: 900 } });
  const close = browser.close.bind(browser);
  browser.close = async () => {
    await close();
    // Windows 的 GPU/崩溃处理子进程可能晚于 DevTools 连接退出；清理失败不伪装成产品断言失败。
    try { await fs.promises.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 }); }
    catch (error) { console.warn(`浏览器已关闭，临时配置目录待系统释放：${profile} (${error.code})`); }
  };
  return browser;
}
