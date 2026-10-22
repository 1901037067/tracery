/* 一键验收为旧套件提供稳定浏览器启动，并在套件异常退出时关闭它启动的本地服务。 */
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import puppeteer from 'puppeteer-core';
import { launchBrowser } from '../scripts/lib/browser.mjs';
const children = new Set(), spawn = childProcess.spawn;
childProcess.spawn = (...args) => {
  const child = spawn(...args); children.add(child); child.once('exit', () => children.delete(child)); return child;
};
syncBuiltinESMExports();
process.once('exit', () => { for (const child of children) { try { child.kill(); } catch {} } });
puppeteer.launch = options => launchBrowser(options);
