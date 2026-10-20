/* 未保存内容按仓库和路径隔离；只在用户明确选择恢复后才写回编辑器。 */
import { askConfirm } from './dialog.js';
import { toast } from './api.js';
const keyOf = (root, path) => `tracery.unsaved:${JSON.stringify([root, path])}`;
let warned = false;

export function rememberDraft(root, path, content) {
  if (!root || !path) return;
  try { localStorage.setItem(keyOf(root, path), JSON.stringify({ content, updatedAt: Date.now() })); }
  catch { if (!warned) { warned = true; toast('设备存储空间不足，未保存内容请先复制备份'); } }
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
  return restore ? draft.content : null;
}
