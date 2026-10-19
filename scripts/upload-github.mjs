/**
 * 用 GitHub API 上传发行版附件（网页上传被中断时的备选）
 * 用法：node scripts/upload-github.mjs [文件] [--dry-run]
 *   - 不给文件：自动挑 dist/ 里当前版本最新的 .7z（没有就 .zip）
 *   - 凭据：读本机 git 已保存的 github.com 凭据（不打印、不落盘）
 *   - 发行版不存在时自动创建（tag = package.json 的版本）
 *   - 失败重试 3 次；支持 10s 无数据超时重连
 * 为什么需要它：网页上传走浏览器，到 GitHub 的链路一慢（<200KB/s）就会被判
 * "inactivity" 中断，页面提示 "Something went really wrong..."。
 */
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const OWNER = '1901037067';
const REPO = 'tracery';
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const TAG = `v${pkg.version}`;
const dryRun = process.argv.includes('--dry-run');

function pickFile() {
  const given = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (given) return path.resolve(ROOT, given);
  const dir = path.join(ROOT, 'dist');
  const want = `Tracery-${pkg.version}-win32-x64.7z`;
  const alt = `Tracery-${pkg.version}-win32-x64.zip`;
  for (const name of [want, alt]) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`dist 里找不到 ${want} 或 ${alt}，先跑 npm run release`);
}

/** git credential fill：拿本机已保存的 token（只走 stdin/stdout，不落文件） */
function githubToken() {
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  });
  const m = /^password=(.+)$/m.exec(out);
  if (!m) throw new Error('本机没有保存 github.com 的凭据，请先 git push 一次');
  return m[1].trim();
}

function api(method, url, { token, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      method, hostname: u.hostname, path: u.pathname + u.search,
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'tracery-release', ...headers },
      timeout: 30000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = {}; try { data = text ? JSON.parse(text) : {}; } catch { /* ignore */ }
        resolve({ status: res.statusCode, data, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('API 请求超时')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  const file = pickFile();
  const size = fs.statSync(file).size;
  const name = path.basename(file);
  console.log(`文件：${name}  ${(size / 1024 / 1024).toFixed(1)} MB`);
  if (dryRun) { console.log('（dry-run：只检查凭据与发行版，不上传）'); }

  const token = githubToken();
  const who = await api('GET', 'https://api.github.com/user', { token });
  console.log(`凭据可用：${who.data.login}`);

  let rel = await api('GET', `https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${TAG}`, { token });
  if (rel.status === 404) {
    const body = fs.existsSync(path.join(ROOT, 'docs', `RELEASE-${pkg.version}.md`))
      ? fs.readFileSync(path.join(ROOT, 'docs', `RELEASE-${pkg.version}.md`), 'utf8')
      : `Tracery ${TAG}`;
    rel = await api('POST', `https://api.github.com/repos/${OWNER}/${REPO}/releases`, {
      token,
      body: JSON.stringify({ tag_name: TAG, name: `Tracery ${TAG}`, body }),
      headers: { 'Content-Type': 'application/json' },
    });
    if (rel.status >= 300) throw new Error(`创建发行版失败：${rel.status} ${rel.text.slice(0, 200)}`);
    console.log(`已创建发行版 ${TAG}`);
  } else if (rel.status >= 300) {
    throw new Error(`查询发行版失败：${rel.status} ${rel.text.slice(0, 200)}`);
  }
  const releaseId = rel.data.id;
  if ((rel.data.assets || []).some((a) => a.name === name)) {
    console.log('这个附件已经在发行版里了，无需重复上传');
    return;
  }
  if (dryRun) { console.log(`发行版 id=${releaseId}，准备上传 ${name}`); return; }

  const url = `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ok = await uploadOnce(url, token, file, name, size);
    if (ok) { console.log(`✓ 上传成功：https://github.com/${OWNER}/${REPO}/releases/tag/${TAG}`); return; }
    console.log(`第 ${attempt} 次失败，等 5 秒重试…`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error('三次都失败：多半是到 GitHub 的带宽太低（<200KB/s 会被判超时），换个网络再试');
}

function uploadOnce(url, token, file, name, size) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = https.request({
      method: 'POST', hostname: u.hostname, path: u.pathname + u.search,
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'tracery-release',
        'Content-Type': 'application/octet-stream',
        'Content-Length': size,
      },
      timeout: 60000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode === 201) { resolve(true); return; }
        console.log(`  GitHub 返回 ${res.statusCode}: ${text.slice(0, 200)}`);
        resolve(false);
      });
    });
    req.on('timeout', () => { req.destroy(new Error('上传超时')); });
    req.on('error', (e) => { console.log(`  网络错误：${e.message}`); resolve(false); });
    const stream = fs.createReadStream(file);
    let sent = 0, lastPct = 0;
    stream.on('data', (chunk) => {
      sent += chunk.length;
      const pct = Math.floor((sent / size) * 100);
      if (pct >= lastPct + 10) { lastPct = pct - (pct % 10); process.stdout.write(`  已传 ${lastPct}%\r`); }
    });
    stream.on('error', () => resolve(false));
    stream.pipe(req);
  });
}

main().catch((e) => { console.error(`✗ ${e.message}`); process.exit(1); });
