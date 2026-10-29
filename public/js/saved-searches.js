import { askText, askConfirm } from './dialog.js';
import { toast } from './api.js';
import { parseSearch } from './search-query.js';
import { upgradeSelects, refreshSelect } from './select-control.js';
export function initSavedSearches({ root, run }) {
  const select = document.querySelector('#saved-search-select'), input = document.querySelector('#search-input');
  const key = () => `tracery.savedSearches.${root()}`;
  const read = () => {
    try { const rows = JSON.parse(localStorage.getItem(key()) || '[]'); return Array.isArray(rows) ? rows.filter(row => typeof row.name === 'string' && row.name.length <= 80 && typeof row.query === 'string' && row.query.length <= 2048).slice(0, 30) : []; }
    catch { return []; }
  };
  const refresh = () => {
    select.replaceChildren(new Option('已保存的搜索', ''));
    read().forEach((row, index) => select.add(new Option(row.name, String(index))));
    document.querySelector('#remove-saved-search').disabled = true;
    refreshSelect(select);
  };
  select.onchange = () => {
    const row = read()[Number(select.value)];
    document.querySelector('#remove-saved-search').disabled = select.value === '';
    if (select.value !== '' && row) { input.value = row.query; run(row.query); }
  };
  document.querySelector('#save-search').onclick = async () => {
    const vault = root(), query = input.value.trim();
    try {
      if (!query) throw Error('先输入要保存的搜索条件'); parseSearch(query);
      const name = await askText({ title: '保存搜索', desc: '保存到当前仓库，之后可一键重新查询。', value: query.slice(0, 80), okText: '保存' });
      if (!name) return; if (name.length > 80) throw Error('名称最多 80 个字符');
      if (root() !== vault) throw Error('仓库已切换，请在原仓库保存搜索');
      const rows = read(), index = rows.findIndex(row => row.name === name);
      if (index >= 0 && !await askConfirm({ title: '更新同名搜索？', desc: name, okText: '更新' })) return;
      if (root() !== vault) throw Error('仓库已切换');
      if (index >= 0) rows[index] = { name, query }; else { if (rows.length >= 30) throw Error('最多保存 30 项，请先移除不再使用的搜索'); rows.push({ name, query }); }
      localStorage.setItem(key(), JSON.stringify(rows)); refresh(); toast('搜索已保存');
    } catch (error) { toast(error.message); }
  };
  document.querySelector('#remove-saved-search').onclick = async () => {
    const vault = root(), index = Number(select.value), row = read()[index]; if (select.value === '' || !row) return;
    if (!await askConfirm({ title: '移除保存的搜索？', desc: row.name + '。笔记内容保留。', okText: '移除' }) || vault !== root()) return;
    try { const rows = read(); if (rows[index]?.name !== row.name || rows[index]?.query !== row.query) throw Error('搜索列表已变化，请重新选择'); rows.splice(index, 1); localStorage.setItem(key(), JSON.stringify(rows)); refresh(); }
    catch (error) { toast(error.message); }
  };
  upgradeSelects(document.querySelector('#saved-searches')); refresh();
  return { refresh };
}
