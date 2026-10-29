import { Api, debounce, toast } from './api.js';
import { enterModal, leaveModal } from './modal-focus.js';
import { citationMarkdown, pdfPage } from './pdf-reference.js';
import { upgradeSelects, refreshSelect, closeSelect } from './select-control.js';

const node = (tag, text, cls) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; };
export function createStudyUI(actions) {
  const context = () => actions.context(), drafts = new Map();
  const modal = node('div', undefined, 'modal note-tools-overlay citation-overlay'); modal.hidden = true; document.body.append(modal);
  let citation, target, targetRequest = 0, saving = false;
  const c = id => modal.querySelector('#' + id);
  const same = () => !modal.hidden && citation?.root === context().root;
  const message = text => { c('citation-message').textContent = text; };
  const key = item => item.root + '\n' + item.source;
  function closeCitation() {
    if (modal.hidden) return;
    drafts.set(key(citation), { text: c('citation-text').value, page: c('citation-page').value, path: c('citation-target').value });
    modal.hidden = true; targetRequest++; leaveModal(modal);
  }
  function lockCitation(value) {
    saving = value;
    for (const input of modal.querySelectorAll('input, textarea, button:not(#citation-close)')) input.disabled = value;
    c('citation-save').disabled ||= !target || context().readOnly;
  }
  function freezeCitation() {
    for (const input of modal.querySelectorAll('input, textarea, button:not(#citation-close)')) input.disabled = true;
    c('citation-text').disabled = false; c('citation-text').readOnly = true;
    message('仓库已切换，摘录仍保留供复制；请关闭窗口后返回原仓库。');
  }
  async function loadTarget() {
    if (!same()) return;
    const request = ++targetRequest, owner = citation, path = c('citation-target').value.trim().replace(/\\/g, '/');
    target = null; c('citation-save').disabled = true; c('citation-target-state').textContent = '正在核对目标…';
    try {
      if (!/\.(md|markdown)$/i.test(path)) throw Error('目标须为仓库内的 .md 或 .markdown 笔记路径');
      let note; try { note = await Api.note(path); } catch (error) { if (error.status !== 404) throw error; note = { revision: null }; }
      if (!same() || citation !== owner || request !== targetRequest) return;
      target = { path, revision: note.revision };
      c('citation-target-state').textContent = note.revision === null ? '将新建这篇笔记。' : '将追加到现有笔记末尾，保留已有正文。';
      c('citation-save').disabled = saving || context().readOnly;
    } catch (error) { if (same() && request === targetRequest) c('citation-target-state').textContent = error.message; }
  }
  async function cite() {
    const owner = context(), pdf = actions.pdf();
    if (!pdf) { toast('请先打开 PDF'); return; }
    if (owner.readOnly) { toast('当前会话仅可查看'); return; }
    if (saving) return;
    if (!modal.hidden) closeCitation();
    citation = { root: owner.root, source: pdf.path }; const opened = citation;
    modal.innerHTML = `<section class="note-tool-dialog" role="dialog" aria-modal="true" aria-labelledby="citation-title"><header class="note-tool-header"><h2 id="citation-title">PDF 摘录到笔记</h2><button class="btn-ghost" id="citation-close">关闭</button></header><div class="note-tool-body">
      <p class="tool-note" id="citation-source"></p><p class="tool-note">在阅读器中复制所选文字，再粘贴到下方。请确认 PDF 页码；内置阅读器的当前页码无法自动读取。</p>
      <div class="tool-fields"><label>PDF 页码（从 1 开始）<input id="citation-page" type="number" min="1" max="999999" step="1" required placeholder="填写阅读器中的当前页码" /></label><label>目标笔记路径<input id="citation-target" list="citation-notes" placeholder="例如：论文摘录/阅读笔记.md" spellcheck="false" /></label></div>
      <datalist id="citation-notes"></datalist><p class="tool-note" id="citation-target-state"></p><div class="tool-actions citation-recheck"><button id="citation-recheck" class="btn-ghost">重新核对目标</button></div>
      <label class="tool-field">摘录文字<textarea id="citation-text" rows="7" maxlength="32000" placeholder="粘贴刚复制的文字…"></textarea></label>
      <p class="tool-note">写入时自动附带来源文件和页码。未写入前的文字仅在本次应用会话保留。</p><div class="tool-actions"><button id="citation-paste" class="btn-ghost">粘贴已复制的文字</button><button id="citation-save" class="btn-primary" disabled>写入笔记</button><button id="citation-open" class="btn-ghost">打开目标笔记</button></div></div><footer class="note-tool-footer"><p id="citation-message" role="status" aria-live="polite"></p></footer></section>`;
    c('citation-source').textContent = '来源：' + pdf.path;
    for (const path of actions.notes().slice(0, 300)) c('citation-notes').append(new Option(path, path));
    const draft = drafts.get(key(citation));
    c('citation-page').value = draft?.page || ''; c('citation-text').value = draft?.text || '';
    c('citation-target').value = draft?.path || '论文摘录/' + pdf.path.split('/').pop().replace(/\.pdf$/i, '') + '.md';
    c('citation-close').onclick = closeCitation;
    c('citation-recheck').onclick = () => loadTarget();
    const delayedTarget = debounce(loadTarget, 200);
    c('citation-target').oninput = () => { targetRequest++; target = null; c('citation-save').disabled = true; delayedTarget(); };
    c('citation-paste').onclick = async () => {
      try { const text = await navigator.clipboard.readText(); if (same() && opened === citation) { if (text.length > 32000) throw Error('摘录最多 32000 字符'); c('citation-text').value = text; message('已粘贴，请确认内容及页码。'); } }
      catch (error) { if (same()) message('无法自动读取剪贴板，请在文字框按 Ctrl+V 粘贴。' + error.message); }
    };
    c('citation-save').onclick = async () => {
      if (saving || !target || !same() || context().readOnly) return;
      let written = false;
      try {
        const page = pdfPage(c('citation-page').value), excerpt = c('citation-text').value, destination = { ...target };
        citationMarkdown(citation.source, page, excerpt); // The server validates the same contract independently.
        lockCitation(true); message('正在写入摘录…');
        const result = await Api.citePdf({ source: citation.source, page, excerpt, path: destination.path, expectedRevision: destination.revision, vaultRoot: citation.root });
        written = true; drafts.delete(key(opened));
        if (!same() || opened !== citation) { toast('摘录已写入原仓库的目标笔记'); return; }
        target = { path: result.path, revision: result.revision }; c('citation-text').value = ''; c('citation-page').value = '';
        drafts.delete(key(citation)); message('摘录已写入：' + result.path); c('citation-target-state').textContent = '继续摘录时将追加到这篇笔记。';
        await actions.refresh();
      } catch (error) { if (same()) message(written ? '摘录已写入，列表刷新未完成，请稍后刷新。' : '写入未确认：' + error.message + '。请先打开目标笔记核对，摘录文字仍保留。'); }
      finally { saving = false; if (!modal.hidden && opened === citation) { lockCitation(false); if (!same()) freezeCitation(); } }
    };
    c('citation-open').onclick = async () => { if (!same() || saving) return; const path = c('citation-target').value.trim(); closeCitation(); await actions.refresh(); if (owner.root === context().root) await actions.open(path); };
    modal.hidden = false; enterModal(modal, c('citation-page')); await loadTarget();
  }
  modal.addEventListener('mousedown', event => { if (event.target === modal) closeCitation(); });
  window.addEventListener('keydown', event => {
    if (!modal.hidden && event.key === 'Escape' && !event.isComposing && !document.querySelector('.dialog-backdrop:not([hidden])')) { event.preventDefault(); event.stopImmediatePropagation(); closeCitation(); }
  }, true);

  const sheet = node('section', undefined, 'note-list-sheet task-sheet'); sheet.id = 'task-list-view'; sheet.hidden = true; sheet.setAttribute('aria-labelledby', 'task-title');
  sheet.innerHTML = `<header class="note-tool-header"><h2 id="task-title" tabindex="-1">全库任务</h2><div class="tool-actions"><button id="task-refresh" class="btn-ghost">刷新</button><button id="task-close" class="btn-ghost">返回编辑区</button></div></header>
    <div class="task-filters"><label>查找任务<input id="task-query" placeholder="关键词、path:目录、tag:标签" /></label><label>显示<select id="task-scope" aria-label="任务显示范围"><option value="open">未完成</option><option value="due">已到期</option><option value="all">全部</option><option value="done">已完成</option></select></label></div>
    <p class="note-list-summary" id="task-summary" role="status" aria-live="polite"></p><p class="task-message" id="task-message" role="status" aria-live="polite"></p>
    <div class="note-list-scroll"><table><thead><tr><th>任务</th><th>到期日期</th><th>来源笔记</th></tr></thead><tbody id="task-rows"></tbody></table></div><footer class="note-list-footer"><button id="task-prev" class="btn-ghost">上一页</button><span id="task-page"></span><button id="task-next" class="btn-ghost">下一页</button></footer>`;
  document.querySelector('#editor-area').append(sheet); const t = id => sheet.querySelector('#' + id);
  let root, requestId = 0, offset = 0, total = 0, toggling = false, returnFocus;
  function closeTasks() {
    if (sheet.hidden) return;
    requestId++; closeSelect(); sheet.hidden = true; document.querySelector('#editor-area').removeAttribute('data-note-view');
    if (returnFocus?.isConnected && returnFocus.getClientRects().length) returnFocus.focus({ preventScroll: true });
  }
  function lockTasks(value) { toggling = value; for (const el of sheet.querySelectorAll('input, select, button:not(#task-close)')) { el.disabled = value || (el.type === 'checkbox' && context().readOnly); if (el.tagName === 'SELECT') refreshSelect(el); } }
  async function loadTasks() {
    if (sheet.hidden) return;
    const request = ++requestId, owner = root; t('task-summary').textContent = '正在读取任务…'; t('task-prev').disabled = true; t('task-next').disabled = true;
    try {
      const result = await Api.tasks({ q: t('task-query').value, scope: t('task-scope').value, offset: String(offset), limit: '100' });
      if (sheet.hidden || request !== requestId || owner !== context().root || owner !== result.root) return;
      total = result.total;
      if (offset && offset >= result.total) { offset = Math.max(0, Math.floor((result.total - 1) / 100) * 100); await loadTasks(); return; }
      t('task-rows').replaceChildren();
      for (const row of result.rows) {
        const tr = node('tr'), body = node('td'), label = node('label', undefined, 'task-label'), check = node('input'); check.type = 'checkbox'; check.checked = row.completed; check.disabled = toggling || context().readOnly; check.setAttribute('aria-label', (row.completed ? '标为未完成：' : '完成：') + row.text);
        label.append(check, node('span', row.text)); body.append(label); body.dataset.label = '任务';
        const due = node('td', row.due || '—'); due.dataset.label = '到期日期';
        const source = node('td'), open = node('button', row.name + ' · 第 ' + row.line + ' 行', 'note-list-name'); source.dataset.label = '来源笔记'; open.title = row.path;
        open.onclick = () => actions.open(row.path, row.line); source.append(open, node('small', row.path)); tr.append(body, due, source); t('task-rows').append(tr);
        check.onchange = async () => {
          if (toggling || context().readOnly) { check.checked = row.completed; return; }
          const checked = check.checked; lockTasks(true); t('task-message').textContent = '正在更新原笔记…';
          try {
            if (owner !== context().root || !await actions.flush() || owner !== context().root) throw Error('仓库已切换或当前笔记未能保存');
            await Api.toggleTask({ path: row.path, line: row.line, expectedLine: row.raw, expectedRevision: row.revision, checked, vaultRoot: owner });
            if (!sheet.hidden && owner === context().root) { await loadTasks(); t('task-message').textContent = '原笔记已更新。'; }
          } catch (error) { if (!sheet.hidden && owner === context().root) { await loadTasks(); t('task-message').textContent = error.message + '；列表已重新核对。'; } }
          finally { lockTasks(false); if (!sheet.hidden) { t('task-prev').disabled = offset === 0; t('task-next').disabled = offset + 100 >= total; } }
        };
      }
      const counts = result.counts;
      t('task-summary').textContent = `未完成 ${counts.open} · 到期 ${counts.due} · 已完成 ${counts.done}。` + (result.total ? ` 当前 ${offset + 1}–${offset + result.rows.length} / ${result.total} 项` : ' 当前筛选没有任务。');
      t('task-page').textContent = '第 ' + (Math.floor(offset / 100) + 1) + ' 页'; t('task-prev').disabled = offset === 0; t('task-next').disabled = offset + 100 >= result.total;
    } catch (error) { if (!sheet.hidden && request === requestId) { t('task-rows').replaceChildren(); t('task-summary').textContent = '读取失败：' + error.message; } }
  }
  const delayedTasks = debounce(() => { offset = 0; t('task-message').textContent = ''; void loadTasks(); }, 200);
  t('task-query').oninput = delayedTasks; t('task-scope').onchange = delayedTasks;
  t('task-prev').onclick = () => { offset = Math.max(0, offset - 100); void loadTasks(); }; t('task-next').onclick = () => { offset += 100; void loadTasks(); };
  t('task-close').onclick = closeTasks; t('task-refresh').onclick = () => { t('task-message').textContent = ''; void loadTasks(); };
  sheet.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); closeTasks(); } });
  upgradeSelects(sheet);
  async function tasks() {
    const owner = context().root; if (!owner) return;
    if (!await actions.flush() || owner !== context().root) { toast('请先处理未保存的笔记'); return; }
    if (root !== owner) { t('task-query').value = ''; t('task-scope').value = 'open'; refreshSelect(t('task-scope')); }
    root = owner; offset = 0; returnFocus = document.activeElement; actions.showTasks(); sheet.hidden = false; document.querySelector('#editor-area').dataset.noteView = 'tasks'; t('task-title').focus({ preventScroll: true }); t('task-message').textContent = ''; await loadTasks();
  }
  return { cite, tasks, closeTasks, changed: () => {
    if (!sheet.hidden) { if (context().root !== root) closeTasks(); else if (!toggling) void loadTasks(); }
    if (!modal.hidden && !same()) freezeCitation();
  } };
}
