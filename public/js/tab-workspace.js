/** 标签身份保持为字符串，兼容旧版按仓库保存的标签列表。空白页不对应磁盘文件。 */
export const GROUP_COLORS = [
  ['orange', '橙色', '#c65b13'], ['teal', '青色', '#00838f'], ['blue', '蓝色', '#3478d4'],
  ['purple', '紫色', '#8861c2'], ['pink', '粉色', '#c54f82'], ['green', '绿色', '#3b8b50'],
  ['red', '红色', '#c84d4d'], ['gray', '灰色', '#777c87'],
];
const BLANK_PREFIX = 'tracery:blank:';
export const isBlankTab = key => typeof key === 'string' && key.startsWith(BLANK_PREFIX);
export const newBlankKey = () => BLANK_PREFIX + crypto.randomUUID();
export const groupForTab = (workspace, key) => workspace.tabGroups.find(group => group.tabs.includes(key));

/** 删除失效成员、空组和重复归属，并让同组标签连续。保留活动标签的身份。 */
export function tidyTabGroups(workspace) {
  const active = workspace.tabs[workspace.activeTab], seen = new Set(), ids = new Set();
  workspace.tabGroups = (workspace.tabGroups || []).filter(group => {
    if (!group || typeof group.id !== 'string' || ids.has(group.id)) return false;
    ids.add(group.id);
    group.name = String(group.name || '未命名分组').slice(0, 40);
    group.color = GROUP_COLORS.some(([key]) => key === group.color) ? group.color : 'orange';
    group.collapsed = group.collapsed === true;
    group.tabs = (Array.isArray(group.tabs) ? group.tabs : []).filter(key => {
      if (!workspace.tabs.includes(key) || seen.has(key)) return false;
      seen.add(key); return true;
    });
    return group.tabs.length;
  });
  const ordered = [], emitted = new Set();
  for (const key of workspace.tabs) {
    const group = groupForTab(workspace, key);
    if (!group) ordered.push(key);
    else if (!emitted.has(group.id)) {
      emitted.add(group.id);
      group.tabs = workspace.tabs.filter(tab => group.tabs.includes(tab));
      ordered.push(...group.tabs);
    }
  }
  workspace.tabs = ordered;
  workspace.tabGroups.sort((a, b) => ordered.indexOf(a.tabs[0]) - ordered.indexOf(b.tabs[0]));
  workspace.activeTab = active ? ordered.indexOf(active) : -1;
}

export function moveTabToGroup(workspace, key, groupId) {
  if (!workspace.tabs.includes(key)) return;
  const active = workspace.tabs[workspace.activeTab];
  const target = workspace.tabGroups.find(group => group.id === groupId);
  if (groupId && !target) return;
  for (const group of workspace.tabGroups) group.tabs = group.tabs.filter(tab => tab !== key);
  if (target) {
    if (target.tabs.length) {
      workspace.tabs = workspace.tabs.filter(tab => tab !== key);
      workspace.tabs.splice(workspace.tabs.indexOf(target.tabs.at(-1)) + 1, 0, key);
    }
    target.tabs.push(key);
    target.collapsed = false;
  }
  workspace.activeTab = workspace.tabs.indexOf(active);
  tidyTabGroups(workspace);
}

export function renameTabKeys(workspace, map) {
  workspace.tabs = workspace.tabs.map(map);
  for (const group of workspace.tabGroups) group.tabs = group.tabs.map(map);
}
