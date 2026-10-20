/* 沿用现有产品图标，确定性生成主屏幕图标与留足安全区的 maskable 版本。 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
const root = path.resolve(import.meta.dirname, '..');
const browser = await puppeteer.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  const source = 'data:image/png;base64,' + fs.readFileSync(path.join(root, 'public/icon.png')).toString('base64');
  const out = path.join(root, 'public/icons'); fs.mkdirSync(out, { recursive: true });
  for (const [name, size, inset] of [['icon-192', 192, 0], ['icon-512', 512, 0], ['maskable-512', 512, .18], ['apple-touch-icon', 180, .08]]) {
    const data = await page.evaluate(async ({ source, size, inset }) => {
      const img = new Image(); img.src = source; await img.decode();
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#f6f6f8'; ctx.fillRect(0, 0, size, size);
      const pad = size * inset; ctx.drawImage(img, pad, pad, size - 2 * pad, size - 2 * pad);
      return canvas.toDataURL('image/png').split(',')[1];
    }, { source, size, inset });
    fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(data, 'base64'));
  }
} finally { await browser.close(); }
