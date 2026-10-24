/* 未保存内容按仓库和路径隔离；只在用户明确选择恢复后才写回编辑器。 */
import { askConfirm } from './dialog.js';
import { toast } from './api.js';
const keyOf = (root, path) => `tracery.unsaved:${JSON.stringify([root, path])}`;
let warned = false;

export function rememberDraft(root, path, content) {
  if (!root || !path) return false;
  try { localStorage.setItem(keyOf(root, path), JSON.stringify({ content, updatedAt: Date.now() })); return true; }
  catch { if (!warned) { warned = true; toast('设备存储空间不足，未保存内容请先复制备份'); } return false; }
}
export function archiveDraft(root, path, content) {
  try {
    localStorage.setItem(`tracery.recovery:${crypto.randomUUID()}`, JSON.stringify({ root, path, content, updatedAt: Date.now() }));
    return true;
  } catch { toast('无法保留恢复副本，请先导出或复制文字'); return false; }
}
export function listDrafts(root) {
  const items = [];
  for (const key of Object.keys(localStorage)) {
    try {
      const value = JSON.parse(localStorage.getItem(key));
      if (typeof value?.content !== 'string') continue;
      if (key.startsWith('tracery.unsaved:')) {
        const [r, path] = JSON.parse(key.slice('tracery.unsaved:'.length));
        if (r === root) items.push({ ...value, root: r, path, key });
      } else if (key.startsWith('tracery.recovery:') && value.root === root) items.push({ ...value, key });
    } catch { /* 一条损坏记录不隐藏其他可恢复内容。 */ }
  }
  return items.sort((a, b) => b.updatedAt - a.updatedAt);
}
export function showRecovery(root, restore) {
  document.getElementById('recovery-center')?.remove();
  const overlay = document.createElement('div'); overlay.id = 'recovery-center'; overlay.className = 'dialog-backdrop';
  const card = document.createElement('div'); card.className = 'dialog-card recovery-card'; card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true');
  const previousFocus = document.activeElement;
  const title = document.createElement('h2'); title.id = 'recovery-title'; title.textContent = '恢复中心'; card.setAttribute('aria-labelledby', title.id);
  const list = document.createElement('div'); list.className = 'recovery-list';
  const preview = document.createElement('textarea'); preview.readOnly = true; preview.setAttribute('aria-label', '恢复内容预览');
  const actions = document.createElement('div'); actions.className = 'dialog-actions';
  let selected;
  const add = (name, fn) => { const b = document.createElement('button'); b.className = 'btn-ghost'; b.textContent = name; b.onclick = fn; actions.append(b); return b; };
  function render() {
    list.replaceChildren(); selected = null; preview.value = '';
    const items = listDrafts(root);
    if (!items.length) list.textContent = '当前仓库没有待恢复的内容。';
    for (const item of items) {
      const b = document.createElement('button'); b.className = 'recovery-item';
      b.textContent = `${item.path} · ${new Date(item.updatedAt).toLocaleString()}`;
      b.onclick = () => { selected = item; preview.value = item.content; for (const row of list.children) row.classList.toggle('active', row === b); }; list.append(b);
    }
    list.firstElementChild?.click();
  }
  add('导出文字', () => {
    if (!selected) return;
    const url = URL.createObjectURL(new Blob([selected.content], { type: 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = selected.path.split('/').pop(); a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  add('另存为笔记', async () => { if (selected && await restore(selected)) { overlay.remove(); document.removeEventListener('keydown', onKey, true); } });
  add('移除记录', async () => { if (selected && await askConfirm({ title: '移除这条恢复记录？', desc: '只移除此设备上的恢复记录，不删除笔记。', danger: true })) { localStorage.removeItem(selected.key); render(); } });
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true); if (previousFocus?.isConnected) previousFocus.focus(); };
  const onKey = e => {
    if (document.querySelector('.dialog-backdrop:not(#recovery-center):not([hidden])')) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); }
    if (e.key === 'Tab') {
      const items = [...card.querySelectorAll('button, textarea')].filter(el => !el.disabled && el.getClientRects().length);
      const index = items.indexOf(document.activeElement);
      if ((e.shiftKey && index <= 0) || (!e.shiftKey && index === items.length - 1)) { e.preventDefault(); (e.shiftKey ? items.at(-1) : items[0])?.focus(); }
    }
  };
  const done = add('关闭', close); card.append(title, list, preview, actions); overlay.append(card); document.body.append(overlay); render(); done.focus();
  document.addEventListener('keydown', onKey, true);
}
export function clearSavedDraft(root, path, content) {
  try {
    const key = keyOf(root, path);
    if (JSON.parse(localStorage.getItem(key) || 'null')?.content === content) localStorage.removeItem(key);
  } catch { /* 损坏的数据不阻断保存 */ }
}
export async function recoverDraft(root, path, remote) {
  let draft;
  try { draft = JSON.parse(localStorage.getItem(keyOf(root, path)) || 'null'); } catch { return null; }
  if (typeof draft?.content !== 'string') return null;
  if (draft.content === remote) { clearSavedDraft(root, path, remote); return null; }
  const restore = await askConfirm({ title: '恢复未保存的内容？', desc: `「${path}」在此设备上有未保存的文字。恢复后将替换当前编辑内容；取消可先查看仓库里的版本。`, okText: '恢复内容' });
  if (restore) return draft.content;
  // 暂不恢复也不能让下一次输入抹掉原草稿；移入恢复中心后仍可预览、导出或另存。
  if (!archiveDraft(root, path, draft.content)) return false;
  clearSavedDraft(root, path, draft.content);
  return null;
}
