/* 同目录替换与上一份有效副本；同步调用保持配置补丁的提交顺序。
 * fsync 文件不等于所有平台/磁盘均保证断电持久性。损坏原件先留证，权限错误直接上报。 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

function preserveCorrupt(file, text) {
  const evidence = `${file}.corrupt-${createHash('sha256').update(text).digest('hex')}`;
  try { fs.copyFileSync(file, evidence, fs.constants.COPYFILE_EXCL); }
  catch (error) {
    if (error.code !== 'EEXIST' || fs.readFileSync(evidence, 'utf8') !== text) throw error;
  }
  return evidence;
}

function replace(file, text) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
export function readJson(file, fallback, { validate = object, legacy, warn = console.warn } = {}) {
  for (const candidate of [file, `${file}.bak`, ...(legacy ? [legacy] : [])]) {
    let text;
    try { text = fs.readFileSync(candidate, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    try {
      const data = JSON.parse(text);
      if (!validate(data)) throw Error('invalid JSON shape');
      if (candidate !== file) warn(`[storage] ${path.basename(file)} 已从${candidate === legacy ? '旧版配置' : '备份'}恢复`);
      return data;
    } catch {
      // 留证失败则停止，绝不随后覆盖唯一的损坏原件。
      const evidence = preserveCorrupt(candidate, text);
      warn(`[storage] ${path.basename(candidate)} 损坏，已保留 ${path.basename(evidence)}`);
    }
  }
  return fallback;
}
export function writeJson(file, value, { validate = data => Array.isArray(value) ? Array.isArray(data) : object(data) } = {}) {
  const text = JSON.stringify(value, null, 2);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let previous;
  try { previous = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous !== undefined) {
    try { if (!validate(JSON.parse(previous))) throw Error('invalid JSON shape'); }
    catch {
      preserveCorrupt(file, previous);
      previous = undefined;
    }
    if (previous !== undefined) replace(`${file}.bak`, previous);
  }
  replace(file, text);
}
