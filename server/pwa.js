/* 从实际发布资源生成缓存版本，前端更新后无需手工维护 service worker 的文件清单。 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function buildWorker(publicDir) {
  const assets = [];
  const hash = crypto.createHash('sha256');
  const walk = (dir, prefix = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else if (/\.(html|m?js|css|png|webmanifest|woff2)$/i.test(rel) && !/\/(sw\.js|cmlab\.(html|js))$/.test(rel)) {
        assets.push(rel);
        hash.update(rel).update(fs.readFileSync(path.join(dir, entry.name)));
      }
    }
  };
  walk(publicDir);
  const source = fs.readFileSync(path.join(publicDir, 'sw.js'), 'utf8');
  hash.update(source);
  return source.replace('__SHELL_VERSION__', hash.digest('hex').slice(0, 16)).replace('__SHELL_ASSETS__', JSON.stringify(assets));
}
