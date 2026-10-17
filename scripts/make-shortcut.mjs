/**
 * 在桌面创建 Tracery 快捷方式（不使用 COM：部分环境会禁用 WScript.Shell）
 * 直接按 Shell Link (.LNK) 二进制格式写出文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// 从脚本位置推导，不再硬编码机器相关绝对路径（项目目录搬家/改名都不用改这里）
const ROOT = path.resolve(import.meta.dirname, '..');
const EXE = path.join(ROOT, 'dist', 'win-unpacked', 'Tracery.exe');
const WORKDIR = path.join(ROOT, 'dist', 'win-unpacked');

const desktop = process.env.TRACERY_DESKTOP || path.join(os.homedir(), 'Desktop');
const lnkPath = path.join(desktop, 'Tracery.lnk');

if (!fs.existsSync(EXE)) {
  console.error('exe 不存在：', EXE);
  process.exit(1);
}

/* ---------- 小工具 ---------- */
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n, 0); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };
const ansi = (s) => Buffer.from(s, 'latin1');
const utf16 = (s) => Buffer.from(s, 'utf16le');

/* ---------- ShellLinkHeader (76 字节) ---------- */
const FLAGS = 0x02   // HasLinkInfo
  | 0x04             // HasName
  | 0x10             // HasWorkingDir
  | 0x40             // HasIconLocation
  | 0x80;            // IsUnicode

const header = Buffer.concat([
  u32(0x4c),
  Buffer.from([0x01, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46]),
  u32(FLAGS),
  u32(0x20),                 // FILE_ATTRIBUTE_ARCHIVE
  Buffer.alloc(8),           // creation
  Buffer.alloc(8),           // access
  Buffer.alloc(8),           // write
  u32(0),                    // file size
  u32(0),                    // icon index
  u32(1),                    // SW_SHOWNORMAL
  u16(0),                    // hotkey
  Buffer.alloc(10),          // reserved
]);

/* ---------- LinkInfo ---------- */
const volumeLabel = ansi('');                     // 空卷标，Windows 会按路径自行定位
const volumeIdSize = 0x10 + volumeLabel.length + 1;
const localBasePath = ansi(EXE + '\0');
const suffix = ansi('\0');

const volumeIdOffset = 0x1c;
const localBasePathOffset = volumeIdOffset + volumeIdSize;
const suffixOffset = localBasePathOffset + localBasePath.length;

const volumeId = Buffer.concat([
  u32(volumeIdSize),
  u32(3),                    // DRIVE_FIXED
  u32(0),                    // serial
  u32(0x10),                 // label offset
  volumeLabel,
  Buffer.from([0]),
]);

const linkInfo = Buffer.concat([
  u32(suffixOffset + suffix.length),  // LinkInfoSize
  u32(0x1c),                          // HeaderSize
  u32(0x1),                           // VolumeIDAndLocalBasePath
  u32(volumeIdOffset),
  u32(localBasePathOffset),
  u32(0),                             // CommonNetworkRelativeLinkOffset
  u32(suffixOffset),
  volumeId,
  localBasePath,
  suffix,
]);

/* ---------- StringData（顺序必须与 flags 一致） ---------- */
const strData = (s, encoding = 'utf16') => {
  const body = encoding === 'utf16' ? utf16(s) : ansi(s);
  return Buffer.concat([u16(s.length), body]);
};

const strings = Buffer.concat([
  strData('Tracery'),                                  // NAME_STRING
  strData(WORKDIR),                                   // WORKING_DIR
  strData(EXE + ',0'),                                // ICON_LOCATION
]);

const total = Buffer.concat([header, linkInfo, strings, u32(0)]);
fs.mkdirSync(desktop, { recursive: true });
fs.writeFileSync(lnkPath, total);

console.log('已创建：', lnkPath);
console.log('大小：', total.length, '字节');
console.log('目标：', EXE);
