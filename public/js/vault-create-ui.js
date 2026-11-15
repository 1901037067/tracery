import { Api, toast } from './api.js';
import { enterModal, leaveModal } from './modal-focus.js';
import { uiIcon } from './ui-icons.js';

export function createVaultUI(actions) {
  const overlay = document.createElement('div');
  overlay.className = 'modal note-tools-overlay vault-create-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `<form class="note-tool-dialog vault-create-dialog" role="dialog" aria-modal="true" aria-labelledby="vault-create-title">
    <header class="vault-create-heading"><div><h2 id="vault-create-title">创建新仓库</h2><p>创建一个新的本地笔记仓库。</p></div><button type="button" class="tool-icon-button" id="vault-create-close" aria-label="关闭">${uiIcon('close')}</button></header>
    <div class="note-tool-body">
      <label class="tool-field" for="vault-create-name">仓库名称<input id="vault-create-name" placeholder="我的笔记" maxlength="120" autocomplete="off" required /></label>
      <label class="tool-field" for="vault-create-parent">存放位置<span class="vault-location-row"><input id="vault-create-parent" placeholder="选择仓库存放目录" spellcheck="false" required /><button type="button" class="btn-ghost electron-only" id="vault-create-browse">浏览…</button></span></label>
      <div class="vault-path-preview"><span>创建后的完整路径</span><strong id="vault-create-preview"></strong></div>
      <p class="tool-note">将在所选目录下创建一个以仓库名称命名的新文件夹。</p>
      <p id="vault-create-error" class="welcome-error" role="alert" hidden></p>
    </div>
    <footer class="vault-create-footer"><button type="button" class="btn-ghost" id="vault-create-cancel">取消</button><button type="submit" class="btn-primary" id="vault-create-submit">创建仓库</button></footer>
  </form>`;
  document.body.append(overlay);
  const el = id => overlay.querySelector('#vault-create-' + id);
  let busy = false;
  function preview() {
    const parent = el('parent').value.trim(), name = el('name').value.trim();
    const separator = parent.includes('\\') ? '\\' : '/';
    el('preview').textContent = parent ? parent.replace(/[\\/]+$/, '') + separator + (name || '我的笔记') : '请先选择存放位置';
  }
  function close() {
    if (busy || overlay.hidden) return;
    overlay.hidden = true; leaveModal(overlay);
  }
  el('close').onclick = close; el('cancel').onclick = close;
  el('name').oninput = preview; el('parent').oninput = preview;
  el('browse').onclick = async () => {
    try { const parent = await window.electronAPI?.pickVault?.('parent'); if (parent && !overlay.hidden) { el('parent').value = parent; preview(); } }
    catch (error) { toast(error.message); }
  };
  overlay.addEventListener('mousedown', event => { if (event.target === overlay) close(); });
  window.addEventListener('keydown', event => {
    if (!overlay.hidden && event.key === 'Escape' && !event.isComposing) { event.preventDefault(); event.stopImmediatePropagation(); close(); }
  }, true);
  overlay.querySelector('form').onsubmit = async event => {
    event.preventDefault(); if (busy) return;
    busy = true; el('error').hidden = true;
    for (const input of overlay.querySelectorAll('input, button')) input.disabled = true;
    el('submit').textContent = '正在创建…';
    try {
      if (!await actions.prepare()) throw Error('笔记尚未保存，请保存后再创建仓库');
      const result = await Api.createVault(el('name').value.trim(), el('parent').value.trim());
      busy = false; close(); await actions.open(result.path);
    } catch (error) { el('error').textContent = error.message; el('error').hidden = false; }
    finally { busy = false; for (const input of overlay.querySelectorAll('input, button')) input.disabled = false; el('submit').textContent = '创建仓库'; }
  };
  return { open() {
    if (!overlay.hidden) return;
    el('name').value = '我的笔记'; el('parent').value = ''; el('error').hidden = true;
    preview(); overlay.hidden = false; enterModal(overlay, el('name')); el('name').select();
  } };
}
