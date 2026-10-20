/* 手工重打 asar 也要包含运行时依赖的完整依赖树，否则 mDNS 在开发版正常、打包后缺模块。 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export function runtimeDependencies(root) {
  const seen = new Set(), base = path.join(root, 'node_modules') + path.sep;
  const walk = (dir) => {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    for (const name of Object.keys(pkg.dependencies || {})) {
      let manifest;
      try { manifest = require.resolve(`${name}/package.json`, { paths: [dir] }); }
      catch {
        let current = path.dirname(require.resolve(name, { paths: [dir] }));
        while (current !== path.dirname(current)) {
          const candidate = path.join(current, 'package.json');
          if (fs.existsSync(candidate) && JSON.parse(fs.readFileSync(candidate, 'utf8')).name === name) { manifest = candidate; break; }
          current = path.dirname(current);
        }
      }
      if (!manifest) throw new Error(`缺少运行时依赖 ${name}`);
      const dependency = path.dirname(manifest);
      if (!dependency.startsWith(base)) throw new Error(`运行时依赖位于项目外：${name}`);
      if (!seen.has(dependency)) { seen.add(dependency); walk(dependency); }
    }
  };
  walk(root); return [...seen];
}
