/**
 * 应用内对话框（替代 prompt / confirm）
 * ------------------------------------------------------------------
 * 为什么必须自己写：Electron 渲染进程不支持 window.prompt（调用直接无效），
 * 所以「新建笔记」「重命名」这类操作用户点了会毫无反应。
 * confirm 虽然能用，但样式与整套 UI 不匹配，一并换掉。
 */

let overlay = null;
let resolver = null;
let keyHandler = null;

function ensureEl() {
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.className = 'dialog-backdrop';
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="dialog-card" role="dialog" aria-modal="true">
      <div class="dialog-title"></div>
      <div class="dialog-desc"></div>
      <input class="dialog-input" type="text" spellcheck="false" autocomplete="off" />
      <div class="dialog-error" hidden></div>
      <div class="dialog-actions">
        <button class="dialog-cancel btn-ghost">取消</button>
        <button class="dialog-ok btn-primary">确定</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) finish(null);
  });
  overlay.querySelector('.dialog-cancel').onclick = () => finish(null);
  overlay.querySelector('.dialog-ok').onclick = () => submit();
  overlay.querySelector('.dialog-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
  });
  return overlay;
}

function open({ title, desc = '', value = '', placeholder = '', okText = '确定', danger = false, input = true }) {
  const el = ensureEl();
  el.querySelector('.dialog-title').textContent = title;
  const d = el.querySelector('.dialog-desc');
  d.textContent = desc;
  d.hidden = !desc;
  const inp = el.querySelector('.dialog-input');
  inp.hidden = !input;
  inp.value = value;
  inp.placeholder = placeholder;
  el.querySelector('.dialog-error').hidden = true;
  const ok = el.querySelector('.dialog-ok');
  ok.textContent = okText;
  ok.classList.toggle('danger', !!danger);
  el.querySelector('.dialog-cancel').textContent = input ? '取消' : '取消';
  el.hidden = false;
  // 下一帧聚焦，避免刚显示时滚动跳动
  requestAnimationFrame(() => {
    if (input) { inp.focus(); inp.select(); }
    else ok.focus();
  });
  return new Promise((resolve) => { resolver = resolve; });
}

function finish(result) {
  if (!overlay || overlay.hidden) return;
  overlay.hidden = true;
  const r = resolver;
  resolver = null;
  if (keyHandler) { document.removeEventListener('keydown', keyHandler, true); keyHandler = null; }
  r?.(result);
}

function submit() {
  const inp = overlay.querySelector('.dialog-input');
  if (inp.hidden) return finish(true);
  const val = inp.value.trim();
  if (!val) {
    const err = overlay.querySelector('.dialog-error');
    err.textContent = '不能为空';
    err.hidden = false;
    inp.focus();
    return;
  }
  finish(val);
}

/** 文本输入：返回字符串，取消返回 null */
export function askText(opts) {
  ensureEl();
  if (!keyHandler) {
    keyHandler = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); finish(null); }
    };
    document.addEventListener('keydown', keyHandler, true);
  }
  return open({ input: true, ...opts });
}

/** 确认框：返回 true / false */
export function askConfirm(opts) {
  ensureEl();
  if (!keyHandler) {
    keyHandler = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); finish(false); }
    };
    document.addEventListener('keydown', keyHandler, true);
  }
  return open({ input: false, ...opts });
}
