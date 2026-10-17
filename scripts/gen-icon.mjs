// 生成 Tracery 品牌图标：Apple 蓝渐变圆角方块 + 白色页面（无依赖）
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const W = 256, H = 256;
const px = Buffer.alloc(W * H * 4);

const crc32 = (buf) => {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};
const alpha = (x, y, col, a) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  const k = a / 255;
  px[i] = Math.round(px[i] * (1 - k) + col[0] * k);
  px[i + 1] = Math.round(px[i + 1] * (1 - k) + col[1] * k);
  px[i + 2] = Math.round(px[i + 2] * (1 - k) + col[2] * k);
  px[i + 3] = Math.max(px[i + 3], a);
};

// 1. Apple squircle（超椭圆）+ 蓝色渐变
const N = 5;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const nx = Math.abs((x - W / 2 + 0.5) / (W / 2 - 8));
    const ny = Math.abs((y - H / 2 + 0.5) / (H / 2 - 8));
    if (Math.pow(nx, N) + Math.pow(ny, N) <= 1) {
      const t = (x + y) / (W + H);
      const i = (y * W + x) * 4;
      px[i] = Math.round(18 - 18 * t);        // #0A84FF → #0066CC
      px[i + 1] = Math.round(140 - 38 * t);
      px[i + 2] = Math.round(255 - 51 * t);
      px[i + 3] = 255;
    }
  }
}

// 2. 白色页面（圆角矩形）
const page = { x0: 74, y0: 54, x1: 182, y1: 202, r: 18 };
for (let y = page.y0; y <= page.y1; y++) {
  for (let x = page.x0; x <= page.x1; x++) {
    const dx = Math.max(page.x0 + page.r - x, x - (page.x1 - page.r), 0);
    const dy = Math.max(page.y0 + page.r - y, y - (page.y1 - page.r), 0);
    if (dx * dx + dy * dy <= page.r * page.r) alpha(x, y, [255, 255, 255], 255);
  }
}

// 3. 笔记线 + 双链节点（白底上的系统蓝）
for (const [y, x1] of [[84, 156], [104, 166], [124, 146]]) {
  for (let x = 94; x <= x1; x++) {
    for (let dy = 0; dy < 7; dy++) alpha(x, y + dy, [10, 132, 255], 140);
  }
}
for (let y = 144; y <= 180; y++) {
  for (let x = 90; x <= 166; x++) {
    const d1 = Math.hypot(x - 102, y - 170);
    const d2 = Math.hypot(x - 154, y - 152);
    const onLine = x >= 102 && x <= 154
      && Math.abs((y - 170) - ((x - 102) * (152 - 170)) / (154 - 102)) < 3;
    if (d1 <= 10 || d2 <= 10) alpha(x, y, [10, 132, 255], 245);
    else if (onLine) alpha(x, y, [10, 132, 255], 125);
  }
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 6;
const raw = Buffer.alloc(H * (1 + W * 4));
for (let y = 0; y < H; y++) {
  raw[y * (1 + W * 4)] = 0;
  px.copy(raw, y * (1 + W * 4) + 1, y * W * 4, (y + 1) * W * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const dir = Buffer.alloc(6);
dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(1, 4);
const entry = Buffer.alloc(16);
entry[0] = 0; entry[1] = 0; entry[4] = 0; entry[5] = 0; entry[6] = 1; entry[7] = 32;
entry.writeUInt32LE(png.length, 8);
entry.writeUInt32LE(22, 12);
const ico = Buffer.concat([dir, entry, png]);

const root = path.join(__dirname, '..');
fs.mkdirSync(path.join(root, 'build'), { recursive: true });
fs.mkdirSync(path.join(root, 'public'), { recursive: true });
fs.writeFileSync(path.join(root, 'build', 'icon.png'), png);
fs.writeFileSync(path.join(root, 'build', 'icon.ico'), ico);
fs.writeFileSync(path.join(root, 'public', 'icon.png'), png);
console.log('icons written:', png.length, 'bytes');
