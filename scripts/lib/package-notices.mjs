import fs from 'node:fs';
import path from 'node:path';

/** Keep application and dependency notices readable without opening app.asar. */
export function writePackageNotices(output, root) {
  const summary = fs.readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  const notices = [];
  for (const line of summary.split('\n')) {
    const match = line.match(/((?:public\/vendor|node_modules)\/[^)\s|\]]+)/);
    if (match) notices.push(line + '\n\n' + fs.readFileSync(path.join(root, match[1]), 'utf8'));
  }
  if (!notices.length) throw Error('No bundled dependency notices found');
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(output, 'LICENSE-Tracery.txt'));
  fs.copyFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), path.join(output, 'THIRD_PARTY_NOTICES.md'));
  fs.writeFileSync(path.join(output, 'THIRD_PARTY_LICENSES.txt'), notices.join('\n\n' + '='.repeat(72) + '\n\n'));
}
