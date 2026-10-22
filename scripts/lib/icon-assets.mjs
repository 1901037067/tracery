/* 原始标志只保存一份；所有平台图标均确定性地缩放自用户提供的 PNG。 */
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser } from './browser.mjs';

export function makeIco(frames) {
  const header = Buffer.alloc(6 + frames.length * 16);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach(({ size, png }, index) => {
    const p = 6 + index * 16;
    header[p] = header[p + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, p + 4); header.writeUInt16LE(32, p + 6);
    header.writeUInt32LE(png.length, p + 8); header.writeUInt32LE(offset, p + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...frames.map(frame => frame.png)]);
}

export async function generateIcons(root, { pwaOnly = false } = {}) {
  const source = 'data:image/png;base64,' + fs.readFileSync(path.join(root, 'build/icon-source.png')).toString('base64');
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    async function resize(size, inset = 0) {
      const data = await page.evaluate(async ({ source, size, inset }) => {
        const image = new Image(); image.src = source; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, size, size);
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
        const pad = Math.round(size * inset); ctx.drawImage(image, pad, pad, size - pad * 2, size - pad * 2);
        return canvas.toDataURL('image/png').split(',')[1];
      }, { source, size, inset });
      return Buffer.from(data, 'base64');
    }
    fs.mkdirSync(path.join(root, 'public/icons'), { recursive: true });
    if (!pwaOnly) {
      const png = await resize(512);
      fs.writeFileSync(path.join(root, 'build/icon.png'), png);
      fs.writeFileSync(path.join(root, 'public/icon.png'), png);
      const frames = [];
      for (const size of [16, 24, 32, 48, 64, 128, 256]) frames.push({ size, png: await resize(size) });
      fs.writeFileSync(path.join(root, 'build/icon.ico'), makeIco(frames));
    }
    for (const [name, size, inset] of [
      ['favicon-16', 16, 0], ['favicon-32', 32, 0], ['icon-192', 192, 0], ['icon-512', 512, 0],
      ['maskable-512', 512, .18], ['apple-touch-icon', 180, .08],
    ]) fs.writeFileSync(path.join(root, 'public/icons', `${name}.png`), await resize(size, inset));
    console.log('已生成桌面 / 网页 / 手机图标');
  } finally { await browser.close(); }
}
