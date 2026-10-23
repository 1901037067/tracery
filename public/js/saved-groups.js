import { GROUP_COLORS, isBlankTab, groupForTab, tidyTabGroups } from './tab-workspace.js';
import { toast } from './api.js';

/** 保存的是仓库内的笔记路径快照，和当前打开的标签组互相独立。 */
export function createSavedGroups({ state, openNote, prepare, activate, changed }) {
  let groups = [], opening = false, signature = '';
  const key = () => `tracery.savedGroups:${state.vault?.root || ''}`;
  const box = document.getElementById('saved-groups');
  const persist = () => { localStorage.setItem(key(), JSON.stringify(groups)); render(); };
  const button = (text, className, click) => {
    const el = document.createElement('button'); el.textContent = text; el.className = className; el.onclick = click; return el;
  };
  function load() {
    let raw; try { raw = JSON.parse(localStorage.getItem(key()) || '[]'); } catch { raw = []; }
    const seen = new Set();
    groups = (Array.isArray(raw) ? raw : []).filter(g => g && typeof g.id === 'string' && !seen.has(g.id) && seen.add(g.id)).map(g => ({
      id: g.id, name: String(g.name || '未命名分组').slice(0, 40),
      color: GROUP_COLORS.some(([c]) => c === g.color) ? g.color : 'orange',
      tabs: [...new Set((Array.isArray(g.tabs) ? g.tabs : []).filter(p => typeof p === 'string' && !isBlankTab(p)))],
    }));
    render();
  }
  function save(group) {
    const tabs = group.tabs.filter(p => !isBlankTab(p) && state.files.has(p));
    if (!tabs.length) { toast('分组中还没有可保存的笔记'); return; }
    const index = groups.findIndex(g => g.id === group.id);
    const snapshot = { id: group.id, name: group.name, color: group.color, tabs: [...tabs] };
    if (index < 0) groups.push(snapshot); else groups[index] = snapshot;
    persist(); toast(index < 0 ? '分组已保存，可在左侧「分组」中找回' : '已更新保存的分组');
  }
  async function openAll(saved) {
    if (opening) return;
    opening = true;
    const root = state.vault?.root;
    try {
      if (!await prepare() || root !== state.vault?.root) return;
      const missing = saved.tabs.filter(p => !state.files.has(p));
      const conflicts = saved.tabs.filter(p => state.files.has(p) && groupForTab(state, p)?.id && groupForTab(state, p).id !== saved.id);
      const paths = saved.tabs.filter(p => state.files.has(p) && !conflicts.includes(p));
      if (paths.length) {
        let group = state.tabGroups.find(g => g.id === saved.id);
        if (!group) { group = { id: saved.id, name: saved.name, color: saved.color, collapsed: false, tabs: [] }; state.tabGroups.push(group); }
        // 已打开的同一组允许保留尚未保存的新成员；重复打开不会复制标签。
        group.collapsed = false;
        for (const p of paths) { if (!state.tabs.includes(p)) state.tabs.push(p); if (!group.tabs.includes(p)) group.tabs.push(p); }
        tidyTabGroups(state); changed(); await activate(state.tabs.indexOf(paths[0]));
      }
      const notes = [];
      if (missing.length) notes.push(`${missing.length} 篇笔记已不存在`);
      if (conflicts.length) notes.push(`${conflicts.length} 篇已在其他分组中，保留原归属`);
      if (notes.length) toast(notes.join('；'));
      else if (!paths.length) toast('此分组没有可打开的笔记');
    } finally { opening = false; }
  }
  function render() {
    if (!box) return;
    // 打开笔记会刷新文件树和最近记录；内容未变时保留按钮与键盘焦点。
    const next = JSON.stringify([state.vault?.root, groups, groups.flatMap(g => g.tabs.map(p => state.files.has(p)))]);
    if (next === signature) return;
    signature = next;
    const expanded = new Set([...box.querySelectorAll('details[open]')].map(el => el.dataset.id));
    box.replaceChildren();
    for (const group of groups) {
      const card = document.createElement('article'); card.className = 'saved-group';
      card.style.setProperty('--group-color', GROUP_COLORS.find(([c]) => c === group.color)[2]);
      const detail = document.createElement('details'); detail.dataset.id = group.id; detail.open = expanded.has(group.id);
      const summary = document.createElement('summary'); summary.title = group.name;
      const name = document.createElement('span'); name.className = 'saved-group-name'; name.textContent = group.name;
      const dot = document.createElement('span'); dot.className = 'saved-group-dot'; dot.setAttribute('aria-hidden', 'true');
      summary.setAttribute('aria-label', `${group.name}，${group.tabs.length} 篇笔记`); summary.append(name, dot); detail.append(summary);
      for (const path of group.tabs) {
        const exists = state.files.has(path);
        const item = button(path.split('/').pop().replace(/\.(md|markdown|txt)$/i, '') + (exists ? '' : '（已不存在）'), 'saved-group-note', () => openNote(path));
        item.title = path; item.dataset.path = path; item.disabled = !exists; detail.append(item);
      }
      const actions = document.createElement('div'); actions.className = 'saved-group-actions';
      actions.append(button('全部打开', 'saved-group-open', () => openAll(group)));
      const remove = button('移除', 'saved-group-remove', () => { groups = groups.filter(g => g !== group); persist(); });
      remove.title = '移除保存的分组，笔记和已打开的标签不受影响'; actions.append(remove);
      card.append(detail, actions); box.append(card);
    }
    if (!groups.length) { const empty = document.createElement('p'); empty.className = 'panel-empty'; empty.textContent = '右键顶部的分组名称，选择「保存分组」。名称、颜色和笔记会一起保存到此设备。'; box.append(empty); }
  }
  function rename(map) { for (const group of groups) group.tabs = [...new Set(group.tabs.map(map))]; persist(); }
  return { load, save, render, rename, has: id => groups.some(g => g.id === id) };
}
