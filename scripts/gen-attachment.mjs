// 生成演示用附件图片（无依赖，直接写 PNG）
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const W = 640, H = 360;
const px = Buffer.alloc(W * H * 4);

// 渐变背景 + 一个圆角「笔记本」轮廓 + 链接节点
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const t = x / W;
    px[i] = Math.round(30 + t * 40);
    px[i + 1] = Math.round(30 + (1 - t) * 30);
    px[i + 2] = Math.round(46 + t * 90);
    px[i + 3] = 255;
  }
}
const circle = (cx, cy, r, col) => {
  for (let y = Math.max(0, cy - r); y < Math.min(H, cy + r); y++) {
    for (let x = Math.max(0, cx - r); x < Math.min(W, cx + r); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) {
        const i = (y * W + x) * 4;
        px[i] = col[0]; px[i + 1] = col[1]; px[i + 2] = col[2]; px[i + 3] = 255;
      }
    }
  }
};
const line = (x1, y1, x2, y2, col) => {
  const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
  for (let s = 0; s <= steps; s++) {
    const x = Math.round(x1 + ((x2 - x1) * s) / steps);
    const y = Math.round(y1 + ((y2 - y1) * s) / steps);
    const i = (y * W + x) * 4;
    px[i] = col[0]; px[i + 1] = col[1]; px[i + 2] = col[2]; px[i + 3] = 255;
  }
};
// 模仿图谱：几个节点 + 连线
const nodes = [[160, 120], [320, 90], [480, 150], [240, 250], [400, 260]];
const edges = [[0, 1], [1, 2], [0, 3], [1, 3], [3, 4], [2, 4]];
for (const [a, b] of edges) line(nodes[a][0], nodes[a][1], nodes[b][0], nodes[b][1], [110, 90, 200]);
for (const [x, y] of nodes) circle(x, y, 14, [180, 160, 255]);
circle(320, 90, 20, [139, 92, 246]);

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(td) : crc32(td));
  return Buffer.concat([len, td, crc]);
}
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
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
const out = path.join(__dirname, '..', 'demo-vault', '附件', '图谱示例.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log('written:', out, png.length, 'bytes');
