import { readProperties, validDate } from '../public/js/note-properties.js';
import { localDate } from '../public/js/note-templates.js';
import { parseSearch, matchesSearch } from '../public/js/search-query.js';
const compare = (a, b) => String(a).localeCompare(String(b), 'zh-CN', { numeric: true });
export function noteCatalog(vault, params) {
  const query = parseSearch(params.get('q') || ''), course = (params.get('course') || '').trim().toLowerCase(), status = params.get('status') || '';
  const minimum = params.get('mastery'), due = params.get('due') === 'true', today = localDate();
  if (minimum && (!Number.isFinite(Number(minimum)) || Number(minimum) < 0 || Number(minimum) > 100)) throw Object.assign(Error('掌握程度应在 0–100 之间'), { status: 400 });
  const sort = ['name', 'course', 'status', 'mastery', 'review', 'modified'].includes(params.get('sort')) ? params.get('sort') : 'modified';
  const direction = params.get('direction') === 'asc' ? 1 : -1;
  const rows = [];
  for (const [path, note] of vault.notes) {
    const content = vault.contentCache.get(path) || '';
    if (!matchesSearch(query, { path, name: note.name, content, tags: note.tags })) continue;
    const parsed = readProperties(content), values = parsed.values;
    const properties = {
      course: typeof values.course === 'string' ? values.course : '', status: typeof values.status === 'string' ? values.status : '',
      mastery: typeof values.mastery === 'number' && values.mastery >= 0 && values.mastery <= 100 ? values.mastery : null,
      review: typeof values.review === 'string' && validDate(values.review) ? values.review : '',
    };
    if (course && !properties.course.toLowerCase().includes(course)) continue;
    if (status && properties.status !== status) continue;
    if (minimum && (properties.mastery === null || properties.mastery < Number(minimum))) continue;
    if (due && (!properties.review || properties.review > today)) continue;
    rows.push({ path, name: note.name, properties, tags: [...note.tags], modified: note.mtimeMs, propertyError: parsed.error });
  }
  const valueOf = row => sort === 'name' ? row.name : sort === 'modified' ? row.modified : row.properties[sort];
  rows.sort((a, b) => {
    const av = valueOf(a), bv = valueOf(b), am = av === null || av === '' || av === undefined, bm = bv === null || bv === '' || bv === undefined;
    if (am !== bm) return am ? 1 : -1;
    return (typeof av === 'number' && typeof bv === 'number' ? av - bv : compare(av ?? '', bv ?? '')) * direction || compare(a.path, b.path);
  });
  const offset = Math.max(0, Math.floor(Number(params.get('offset')) || 0));
  const limit = Math.max(1, Math.min(200, Math.floor(Number(params.get('limit')) || 100)));
  return { rows: rows.slice(offset, offset + limit), total: rows.length, offset, limit, root: vault.root };
}
