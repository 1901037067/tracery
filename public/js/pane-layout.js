export const PANE_NAMES = Object.freeze({ library: '文档库', pinned: '星标', recent: '最近打开', groups: '分组', outline: '大纲', links: '关联', info: '笔记信息' });
export const DEFAULT_PANELS = Object.freeze({ navigation: Object.freeze(['library', 'pinned', 'recent', 'groups']), context: Object.freeze(['outline', 'links', 'info']) });
export function normalizePanels(value, base = DEFAULT_PANELS) {
  const panels = { navigation: [], context: [] }, seen = new Set();
  for (const host of Object.keys(panels)) {
    const items = Array.isArray(value?.[host]) ? value[host] : base?.[host] || DEFAULT_PANELS[host];
    for (const id of items) if (Object.hasOwn(PANE_NAMES, id) && !seen.has(id)) { panels[host].push(id); seen.add(id); }
  }
  for (const id of Object.keys(PANE_NAMES)) if (!seen.has(id)) {
    const host = base?.context?.includes(id) ? 'context' : base?.navigation?.includes(id) ? 'navigation' : DEFAULT_PANELS.context.includes(id) ? 'context' : 'navigation';
    panels[host].push(id);
  }
  return panels;
}
export function movePane(panels, id, host, index) {
  const next = normalizePanels(panels);
  if (!Object.hasOwn(PANE_NAMES, id) || !Object.hasOwn(next, host)) return next;
  for (const key of Object.keys(next)) next[key] = next[key].filter(item => item !== id);
  next[host].splice(Math.max(0, Math.min(next[host].length, index)), 0, id);
  return next;
}
