/**
 * 同步 v3：端到端加密的密码学底座
 * ------------------------------------------------------------------
 * 目标：同步服务端（NAS）**只看到密文和无关的哈希名**，看不到笔记内容、也看不到文件名。
 *
 * 密钥派生（只在设备端发生，密码与 masterKey 都不上传）：
 *   masterKey = scrypt(密码, salt, 32B, N=16384/r=8/p=1)
 *   encKey    = HKDF-SHA256(masterKey, salt, "tracery-v3-enc")   → AES-256-GCM
 *   nameKey   = HKDF-SHA256(masterKey, salt, "tracery-v3-name")  → 路径 HMAC
 * 为什么要分两把：内容密钥和「路径索引」密钥用途不同，混用会把某个环节的泄露放大。
 *
 * blob 格式（每个文件）：
 *   "TRC1"(4) | iv(12) | tag(16) | ciphertext
 *   - AES-256-GCM，AAD 固定为 "tracery-v3"（换版本 = 换 magic，旧数据不会被误读）
 *   - **IV 由 encKey 对明文哈希做 HMAC 派生**（确定性加密）：同样的明文永远得到同样的密文，
 *     于是「内容寻址 / 服务端去重 / 增量同步的 sha 比较」这三件事原样成立。
 *     代价是服务端能看出「两个文件内容相同」——这本来就是内容寻址同步的语义，可接受。
 *
 * 路径：manifest 的 key 用 HMAC(nameKey, 相对路径) 的十六进制代替明文路径。
 *   服务端只看到 64 位十六进制，无法反推文件名；设备端靠「加密索引 blob」把
 *   hmac → 路径 的映射带过去（见 server/sync.js 的 _ensureIndex）。
 */
import crypto from 'node:crypto';

const MAGIC = Buffer.from('TRC1', 'ascii');
const AAD = Buffer.from('tracery-v3');
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** 由密码 + salt 派生两把子密钥（都返回 Buffer） */
export function deriveKeys(password, saltHex) {
  const salt = Buffer.from(String(saltHex || ''), 'hex');
  if (salt.length < 8) throw new Error('salt 非法');
  const master = crypto.scryptSync(String(password), salt, 32, SCRYPT);
  const encKey = Buffer.from(crypto.hkdfSync('sha256', master, salt, 'tracery-v3-enc', 32));
  const nameKey = Buffer.from(crypto.hkdfSync('sha256', master, salt, 'tracery-v3-name', 32));
  return { encKey, nameKey };
}

export function newSalt() { return crypto.randomBytes(16).toString('hex'); }
export const keyToHex = (buf) => buf.toString('hex');
export const keyFromHex = (hex) => Buffer.from(String(hex || ''), 'hex');

/** 确定性 IV：HMAC(encKey, 明文) 前 12 字节 */
function ivFor(encKey, plain) {
  return crypto.createHmac('sha256', encKey).update('iv:').update(plain).digest().subarray(0, 12);
}

/** 明文 → 加密 blob（TRC1 | iv | tag | ct） */
export function encryptBuffer(encKey, plain) {
  const iv = ivFor(encKey, plain);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  cipher.setAAD(AAD);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ct]);
}

/** 加密 blob → 明文；格式不对/密码不对都抛错（GCM tag 校验失败） */
export function decryptBuffer(encKey, blob) {
  if (!Buffer.isBuffer(blob) || blob.length < MAGIC.length + 28) throw new Error('密文格式非法');
  if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('不是 Tracery v3 密文（magic 不匹配）');
  const iv = blob.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = blob.subarray(MAGIC.length + 12, MAGIC.length + 28);
  const ct = blob.subarray(MAGIC.length + 28);
  const d = crypto.createDecipheriv('aes-256-gcm', encKey, iv);
  d.setAAD(AAD);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

/** 路径 → manifest key（64 位十六进制） */
export function nameToken(nameKey, relPath) {
  return crypto.createHmac('sha256', nameKey).update(String(relPath)).digest('hex');
}

/** 密码校验串：解锁时只要它能解开，就说明密码对（索引解不开同理） */
export function makeCheck(encKey) {
  return encryptBuffer(encKey, Buffer.from('tracery-check-v3')).toString('base64');
}

export function verifyCheck(encKey, checkB64) {
  try {
    const plain = decryptBuffer(encKey, Buffer.from(String(checkB64 || ''), 'base64'));
    return plain.toString('utf8') === 'tracery-check-v3';
  } catch { return false; }
}
