/* 将数学引擎和字体随应用保存，运行时不访问 CDN。 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const root = path.resolve(import.meta.dirname, '..'), require = createRequire(import.meta.url);
const pkg = path.dirname(require.resolve('katex/package.json')), out = path.join(root, 'public/vendor/katex');
fs.mkdirSync(out, { recursive: true });
for (const file of ['katex.mjs', 'katex.min.css']) fs.copyFileSync(path.join(pkg, 'dist', file), path.join(out, file));
fs.cpSync(path.join(pkg, 'dist/fonts'), path.join(out, 'fonts'), { recursive: true });
fs.copyFileSync(path.join(pkg, 'LICENSE'), path.join(out, 'LICENSE'));
console.log('KaTeX ' + JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'))).version + ' 与字体已保存到 public/vendor/katex');
