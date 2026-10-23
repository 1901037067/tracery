const EXT = /\.(md|markdown|txt)$/i;
export function wikiParts(raw) {
  const [link, ...aliases] = String(raw || '').split('|');
  const hash = link.indexOf('#');
  return { target: (hash < 0 ? link : link.slice(0, hash)).trim().replace(/\\/g, '/'),
    heading: hash < 0 ? '' : link.slice(hash + 1).trim(), alias: aliases.join('|') };
}
export function normalizeNotePath(value) {
  const parts = [];
  for (const part of value.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(part);
  }
  return parts.join('/');
}
export function noteIndex(paths) {
  const exact = new Set(), folded = new Map(), names = new Map();
  const add = (map, key, path) => { if (!map.has(key)) map.set(key, []); map.get(key).push(path); };
  for (const path of paths) {
    if (!EXT.test(path)) continue;
    exact.add(path); add(folded, path.toLowerCase(), path);
    add(names, path.split('/').pop().replace(EXT, '').toLowerCase(), path);
  }
  return { exact, folded, names };
}
export function resolveNote(raw, from = '', index) {
  const { target } = wikiParts(raw);
  if (!target) return String(raw || '').includes('#') && index.exact.has(from) ? from : null;
  const folder = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
  const relative = /^\.{1,2}\//.test(target);
  const paths = relative ? [normalizeNotePath(`${folder}/${target}`)]
    : target.includes('/') ? [normalizeNotePath(target)] : [folder ? `${folder}/${target}` : target, target];
  for (const path of paths) {
    if (!path) continue;
    for (const candidate of EXT.test(path) ? [path] : [path + '.md', path + '.markdown', path + '.txt']) {
      if (index.exact.has(candidate)) return candidate;
      const matches = index.folded.get(candidate.toLowerCase());
      if (matches?.length === 1) return matches[0];
    }
  }
  if (target.includes('/')) return null;
  const matches = index.names.get(target.replace(EXT, '').toLowerCase());
  return matches?.length === 1 ? matches[0] : null;
}
export function missingNotePath(raw, from = '') {
  const { target } = wikiParts(raw);
  const folder = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
  const path = normalizeNotePath(/^\.{1,2}\//.test(target) ? `${folder}/${target}` : target);
  return path ? EXT.test(path) ? path : path + '.md' : null;
}
