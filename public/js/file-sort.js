export const FILE_SORTS = [
  ['name-asc', '文件名（A–Z）'], ['name-desc', '文件名（Z–A）'],
  ['modified-desc', '编辑时间（从新到旧）'], ['modified-asc', '编辑时间（从旧到新）'],
  ['created-desc', '创建时间（从新到旧）'], ['created-asc', '创建时间（从旧到新）'],
];
const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
export const validSort = mode => FILE_SORTS.some(([key]) => key === mode) ? mode : 'name-asc';
export function sortTree(tree, mode) {
  mode = validSort(mode);
  const direction = mode.endsWith('-desc') ? -1 : 1;
  const name = (a, b) => collator.compare(a.name, b.name) || String(a.path || a.name).localeCompare(String(b.path || b.name));
  const field = mode.startsWith('modified') ? 'mtimeMs' : 'birthtimeMs';
  const compare = mode.startsWith('name') ? (a, b) => direction * name(a, b) : (a, b) => {
    const av = Number.isFinite(a[field]) && a[field] > 0 ? a[field] : 0;
    const bv = Number.isFinite(b[field]) && b[field] > 0 ? b[field] : 0;
    if (!av || !bv) return av ? -1 : bv ? 1 : name(a, b);
    return direction * (av - bv) || name(a, b);
  };
  const walk = node => ({ ...node,
    dirs: [...(node.dirs || [])].sort(mode.startsWith('name') ? (a, b) => direction * name(a, b) : name).map(walk),
    files: [...(node.files || [])].sort(compare),
  });
  return walk(tree);
}
