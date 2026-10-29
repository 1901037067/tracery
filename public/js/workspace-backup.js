/* 只保存会话/布局，不收集草稿、正文、同步状态或任意 localStorage 键。 */
const keys = root => ({ tabs: `tracery.tabs.${root}`, workspaces: `tracery.workspaces.${root}`, shortcuts: `tracery.shortcuts:${root}`,
  groups: `tracery.savedGroups:${root}`, sort: `tracery.fileSort:${root}`, collapsed: 'tracery.collapsed',
  navigation: 'tracery.dockActive.navigation', context: 'tracery.dockActive.context', savedSearches: `tracery.savedSearches.${root}` });
export function safeClientState(value = {}) {
  const result = {};
  for (const name of Object.keys(keys(''))) if (typeof value[name] === 'string') result[name] = value[name];
  if (JSON.stringify(result).length > 2 * 1024 * 1024) throw Error('工作区会话超过 2 MiB，请减少保存的标签或工作区后备份');
  return result;
}
export function captureBrowserState(root) {
  const result = {}; for (const [name, key] of Object.entries(keys(root))) { const value = localStorage.getItem(key); if (value !== null) result[name] = value; }
  return safeClientState(result);
}
export function applyBrowserState(root, state) {
  const saved = [], map = keys(root), values = safeClientState(state);
  const rollback = () => { for (const [key, value] of saved.reverse()) { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } };
  try { for (const [name, value] of Object.entries(values)) { const key = map[name]; saved.push([key, localStorage.getItem(key)]); localStorage.setItem(key, value); } }
  catch (error) { rollback(); throw error; }
  return rollback;
}
