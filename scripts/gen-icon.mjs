// 生成 Tracery 品牌图标：蓝底 + 白色「窗棂」格窗（田字格）
// 取名 Tracery（窗花格），标志就用一个极简格窗：圆角方框 + 十字棂条。
// 小尺寸（16px）退化成蓝底白「田」，仍然可辨；大尺寸看得到圆角与抗锯齿。
// 无第三方依赖：直接写像素 → PNG（zlib）→ ICO 包装。
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
  if (x < 0 || y < 0 || x >= W || y >= H || a <= 0) return;
  const i = (y * W + x) * 4;
  const k = a / 255;
  px[i] = Math.round(px[i] * (1 - k) + col[0] * k);
  px[i + 1] = Math.round(px[i + 1] * (1 - k) + col[1] * k);
  px[i + 2] = Math.round(px[i + 2] * (1 - k) + col[2] * k);
  px[i + 3] = Math.max(px[i + 3], a);
};

/** 圆角矩形有向距离（<0 在内部），用于画框并做 1px 抗锯齿 */
const sdRoundRect = (x, y, x0, y0, x1, y1, r) => {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const hw = (x1 - x0) / 2 - r;
  const hh = (y1 - y0) / 2 - r;
  const qx = Math.abs(x - cx) - hw;
  const qy = Math.abs(y - cy) - hh;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const clamp01 = (v) => Math.min(1, Math.max(0, v));

// 1) 底：超椭圆（Apple squircle 风格）+ 对角蓝渐变
const N = 5;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const nx = Math.abs((x - W / 2 + 0.5) / (W / 2 - 8));
    const ny = Math.abs((y - H / 2 + 0.5) / (H / 2 - 8));
    if (Math.pow(nx, N) + Math.pow(ny, N) <= 1) {
      const t = (x * 0.45 + y * 0.55) / (W + H);   // 左上亮 → 右下深
      const i = (y * W + x) * 4;
      px[i] = Math.round(74 - 30 * t * 2);         // #4A7DFF → #1E46D8
      px[i + 1] = Math.round(125 - 61 * t * 2);
      px[i + 2] = Math.round(255 - 39 * t * 2);
      px[i + 3] = 255;
    }
  }
}

// 2) 白色格窗：外框（圆角方）+ 十字棂条
const FX0 = 62, FY0 = 62, FX1 = 194, FY1 = 194, FR = 34;   // 外框
const STROKE = 22;                                          // 棂条粗
const half = STROKE / 2;
const WHITE = [255, 255, 255];
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    let a = 0;
    // 外框：到「外框内缩半个线宽」的圆角矩形边界的距离
    const sd = sdRoundRect(x + 0.5, y + 0.5, FX0 + half, FY0 + half, FX1 - half, FY1 - half, FR - half);
    a = Math.max(a, clamp01(half - Math.abs(sd) + 0.5));
    // 十字棂条（只在框内画）
    const inFrame = x > FX0 && x < FX1 && y > FY0 && y < FY1;
    if (inFrame) {
      const dx = Math.abs(x + 0.5 - 128);
      const dy = Math.abs(y + 0.5 - 128);
      a = Math.max(a, clamp01(half - dx + 0.5));
      a = Math.max(a, clamp01(half - dy + 0.5));
    }
    if (a > 0) alpha(x, y, WHITE, Math.round(a * 255));
  }
}

// 3) 右下格里放两条极短的「文字线」：大尺寸读作「一格笔记」，小尺寸自然消失
for (const [y0, x0, x1] of [[146, 148, 168], [162, 148, 160]]) {
  for (let y = y0; y < y0 + 6; y++) {
    for (let x = x0; x <= x1; x++) alpha(x, y, WHITE, 150);
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
