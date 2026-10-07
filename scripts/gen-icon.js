'use strict';
// 生成应用图标 build/icon.png（256x256），无需任何第三方依赖。
// electron-builder 会据此自动生成 Windows 所需的 .ico。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 256;
const px = Buffer.alloc(S * S * 4);

function blend(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= S || y >= S || a <= 0) return;
  const i = (y * S + x) * 4;
  const ia = px[i + 3] / 255;
  const oa = a + ia * (1 - a);
  px[i] = Math.round((r * a + px[i] * ia * (1 - a)) / oa);
  px[i + 1] = Math.round((g * a + px[i + 1] * ia * (1 - a)) / oa);
  px[i + 2] = Math.round((b * a + px[i + 2] * ia * (1 - a)) / oa);
  px[i + 3] = Math.round(oa * 255);
}

// 以 4x4 超采样绘制带抗锯齿的形状
function fill(inside, color) {
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let hit = 0;
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) if (inside(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4)) hit++;
      if (hit) blend(x, y, color[0], color[1], color[2], (hit / 16) * (color[3] ?? 1));
    }
  }
}

function roundRect(x0, y0, x1, y1, r) {
  return (x, y) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = Math.min(Math.max(x, x0 + r), x1 - r);
    const cy = Math.min(Math.max(y, y0 + r), y1 - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
}

function segment(ax, ay, bx, by, w) {
  return (x, y) => {
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    return (x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2 <= (w / 2) ** 2;
  };
}

// 背景：蓝色圆角方块
fill(roundRect(16, 16, 240, 240, 48), [74, 144, 226]);
// 便签纸
fill(roundRect(56, 52, 200, 208, 16), [255, 255, 255]);
// 顶部色条
fill(roundRect(56, 52, 200, 80, 12), [242, 194, 48]);
fill((x, y) => x >= 56 && x <= 200 && y >= 70 && y <= 82, [255, 255, 255]);
// 三行待办：对勾 + 横线
const rows = [112, 148, 184];
rows.forEach((cy, i) => {
  if (i === 0) {
    fill(segment(76, cy, 86, cy + 10, 9), [90, 172, 68]);
    fill(segment(86, cy + 10, 104, cy - 10, 9), [90, 172, 68]);
  } else {
    fill((x, y) => (x - 90) ** 2 + (y - cy) ** 2 <= 100 && (x - 90) ** 2 + (y - cy) ** 2 >= 36, [160, 170, 180]);
  }
  fill(segment(118, cy, 180, cy, 9), i === 0 ? [190, 198, 206] : [120, 132, 146]);
});

// 编码 PNG
function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
]);
const out = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log('wrote', out, png.length, 'bytes');
