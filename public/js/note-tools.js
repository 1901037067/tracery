import { Api, debounce, toast } from './api.js';
import { askText, askConfirm } from './dialog.js';
import { enterModal, leaveModal } from './modal-focus.js';
import { BUILTIN_TEMPLATES, renderTemplate, localDate } from './note-templates.js';
import { PROPERTY_FIELDS, readProperties, writeProperties } from './note-properties.js';
import { upgradeSelects, refreshSelect, closeSelect } from './select-control.js';

function notePath(folder, title) {
  const name = title.trim().replace(/\.md$/i, '');
  const dir = folder.trim().replace(/\\/g, '/');
  const invalid = part => !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part);
  if (!name || name.length > 120 || /[\/\\]/.test(name) || invalid(name)) throw Error('请输入有效笔记名称，不含路径或特殊字符');
  if (dir && (dir.startsWith('/') || dir.split('/').some(invalid))) throw Error('文件夹请填写仓库内的相对路径');
  return (dir ? dir + '/' : '') + name + '.md';
}
const node = (tag, text, className) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; };

export function createNoteTools(actions) {
  const overlay = node('div', undefined, 'modal note-tools-overlay'); overlay.hidden = true;
  document.body.append(overlay);
  let snapshot, mode, busy = false, templateLoading = false, templateError = false, templateRequest = 0, templateRevision, templatePath;
  const $ = id => overlay.querySelector('#' + id);
  const context = () => actions.context();
  const current = () => !overlay.hidden && snapshot?.root === context().root;
  const message = text => { if ($('note-tools-message')) $('note-tools-message').textContent = text; };
  const draftKey = root => 'tracery.capture.' + root;
  const saveDraft = () => {
    if (mode !== 'capture' || overlay.hidden) return true;
    try { localStorage.setItem(draftKey(snapshot.root), JSON.stringify({ title: $('capture-title').value, folder: $('capture-folder').value, content: $('capture-text').value })); return true; }
    catch { if ($('capture-discard')) $('capture-discard').hidden = false; message('此设备无法保留记录草稿。请复制内容、创建笔记，或明确放弃这次记录。'); return false; }
  };
  function close() { if (!saveDraft()) return false; closeSelect(); overlay.hidden = true; templateRequest++; leaveModal(overlay); return true; }
  overlay.addEventListener('mousedown', event => { if (event.target === overlay) close(); });
  window.addEventListener('keydown', event => {
    if (!overlay.hidden && event.key === 'Escape' && !event.isComposing && !document.querySelector('.dialog-backdrop:not([hidden])')) { event.preventDefault(); event.stopImmediatePropagation(); close(); }
  }, true);
  function lock(value) {
    busy = value;
    for (const button of overlay.querySelectorAll('[data-tool-write]')) button.disabled = value || templateLoading || templateError || snapshot.accessReadOnly;
    if ($('template-insert')) $('template-insert').disabled ||= !snapshot.path || snapshot.isRead;
    if (mode === 'template' || mode === 'capture') for (const control of overlay.querySelectorAll('input, textarea:not([readonly]), select')) { control.disabled = value || templateLoading; if (control.tagName === 'SELECT') refreshSelect(control); }
    if (mode === 'properties') for (const input of overlay.querySelectorAll('.property-fields input')) input.disabled = value || input.dataset.editable === 'false';
    if ($('capture-discard')) $('capture-discard').disabled = value;
  }
  function shell(title, body) {
    if (!overlay.hidden && !close()) return false;
    snapshot = { ...context(), now: new Date() };
    if (!snapshot.root) { toast('请先打开笔记仓库'); return false; }
    overlay.innerHTML = `<section class="note-tool-dialog" role="dialog" aria-modal="true" aria-labelledby="note-tools-title"><header class="note-tool-header"><h2 id="note-tools-title"></h2><button id="note-tools-close" class="btn-ghost" aria-label="关闭">关闭</button></header><div class="note-tool-body">${body}</div><footer class="note-tool-footer"><p id="note-tools-message" role="status" aria-live="polite"></p></footer></section>`;
    $('note-tools-title').textContent = title; $('note-tools-close').onclick = close; overlay.hidden = false;
    return true;
  }
  function preview() {
    const rendered = renderTemplate($('template-source').value, { title: $('capture-title').value.trim().replace(/\.md$/i, ''), selection: snapshot.selection, now: snapshot.now });
    $('template-preview').value = rendered + ($('capture-text').value ? '\n\n' + $('capture-text').value : '');
    saveDraft();
  }
  async function loadTemplate() {
    const request = ++templateRequest, value = $('template-choice').value; templateLoading = true; templateError = false; lock(busy);
    templatePath = null; templateRevision = undefined; $('template-source').disabled = true;
    try {
      const builtin = BUILTIN_TEMPLATES.find(item => item.id === value);
      const note = builtin ? { content: builtin.content } : await Api.note(value);
      if (request !== templateRequest || !current()) return;
      templatePath = builtin ? null : value; templateRevision = note.revision;
      $('template-source').value = note.content; preview(); message('');
    } catch (error) { if (request === templateRequest && current()) { templateError = true; $('template-source').value = ''; preview(); message('模板读取失败：' + error.message); } }
    finally { if (request === templateRequest && current()) { templateLoading = false; $('template-source').disabled = false; lock(busy); } }
  }
  async function openTemplate(capture = false) {
    if (busy) { toast('上一项操作尚未结束'); return; }
    if (!shell(capture ? '快速记录' : '模板与新建笔记', `
      <div class="tool-fields"><label>笔记名称<input id="capture-title" maxlength="123" autocomplete="off" /></label><label>存放文件夹<input id="capture-folder" placeholder="留空保存在仓库根目录" spellcheck="false" /></label></div>
      <label class="tool-field">选择模板<select id="template-choice" aria-label="选择模板"></select></label>
      <label class="tool-field">记录内容<textarea id="capture-text" rows="4" placeholder="先记下来，之后再整理…"></textarea></label>
      <details id="template-source-details"><summary>编辑模板</summary><p class="tool-note">支持 {{title}}、{{date}}、{{time}}、{{datetime}}、{{selection}}；模板仅替换文字。</p><label class="tool-field">模板正文<textarea id="template-source" rows="9" spellcheck="false"></textarea></label><div class="tool-actions"><button id="template-save" class="btn-ghost" data-tool-write>另存为模板…</button><button id="template-update" class="btn-ghost" data-tool-write>保存模板修改</button></div></details>
      <details><summary>查看生成内容</summary><textarea id="template-preview" rows="8" readonly aria-label="生成内容预览"></textarea></details>
      <div class="tool-actions"><button id="template-create" class="btn-primary" data-tool-write>创建笔记</button><button id="template-insert" class="btn-ghost" data-tool-write>插入当前笔记</button><button id="capture-discard" class="btn-ghost" hidden>放弃这次记录…</button></div>`)) return;
    mode = capture ? 'capture' : 'template';
    const opened = snapshot;
    $('capture-discard').onclick = async () => {
      if (busy || mode !== 'capture') return;
      const before = snapshot;
      if (!await askConfirm({ title: '放弃这次未保存的记录？', desc: '此设备无法保留草稿，请先复制需要的内容。确认后关闭记录窗口，仓库中已保存的笔记保留。', okText: '放弃记录', danger: true }) || snapshot !== before || overlay.hidden) return;
      try { localStorage.removeItem(draftKey(before.root)); } catch { toast('旧设备草稿未能清除'); }
      mode = ''; close();
    };
    $('capture-title').value = capture ? '记录 ' + localDate(snapshot.now) + ' ' + snapshot.now.toTimeString().slice(0, 8).replaceAll(':', '-') : '未命名笔记';
    $('capture-folder').value = capture ? '收集箱' : '';
    if (capture) try {
      const draft = JSON.parse(localStorage.getItem(draftKey(snapshot.root)) || 'null');
      if (draft && typeof draft.title === 'string' && typeof draft.folder === 'string' && typeof draft.content === 'string') for (const [id, key] of [['capture-title', 'title'], ['capture-folder', 'folder'], ['capture-text', 'content']]) $(id).value = draft[key];
    } catch { message('记录草稿无法读取，请先复制可恢复的内容。'); }
    for (const item of BUILTIN_TEMPLATES) $('template-choice').add(new Option(item.name, item.id));
    for (const path of actions.files().filter(path => /^模板\/.+\.md$/i.test(path)).sort().slice(0, 200)) $('template-choice').add(new Option(path, path));
    const updateTemplateButtons = () => { if ($('template-update')) $('template-update').hidden = !templatePath; };
    $('template-choice').onchange = async () => { await loadTemplate(); updateTemplateButtons(); };
    for (const id of ['capture-title', 'capture-folder', 'capture-text', 'template-source']) $(id).addEventListener('input', preview);
    $('template-create').onclick = async () => {
      if (busy || templateLoading || templateError || !current() || snapshot.accessReadOnly) return;
      lock(true); const root = snapshot.root, title = $('capture-title').value, folder = $('capture-folder').value, wasCapture = mode === 'capture'; let createdPath, cleanupFailed = false;
      try {
        const path = notePath(folder, title); preview(); const content = $('template-preview').value;
        await Api.createNote(path, content, { vaultRoot: root });
        createdPath = path;
        if (wasCapture) try { localStorage.removeItem(draftKey(root)); } catch { cleanupFailed = true; }
        if (!current()) return;
        mode = ''; close(); await actions.created(path, root); toast(cleanupFailed ? '笔记已创建；此设备的记录草稿未能清除' : '笔记已创建');
      } catch (error) { if (createdPath) toast('笔记已创建，列表刷新未完成：' + createdPath); else if (current()) message('创建未完成：' + error.message); }
      finally { lock(false); }
    };
    $('template-insert').onclick = async () => {
      if (busy || templateLoading || templateError || !current() || snapshot.isRead || snapshot.accessReadOnly) return;
      lock(true);
      try { preview(); await actions.insert(snapshot, $('template-preview').value); mode = ''; close(); toast('已插入并保存'); }
      catch (error) { if (current()) message(error.message); }
      finally { lock(false); }
    };
    $('template-save').onclick = async () => {
      if (busy || templateLoading || !current() || snapshot.accessReadOnly) return;
      lock(true);
      try {
        const name = await askText({ title: '保存为模板', desc: '保存为「模板」文件夹里的 Markdown 文件，可在文件树中继续编辑。', value: '我的模板', okText: '保存' });
        if (!name || !current()) return;
        const path = notePath('模板', name); await Api.createNote(path, $('template-source').value, { vaultRoot: snapshot.root });
        if (!current()) return;
        await actions.refresh(); $('template-choice').add(new Option(path, path)); $('template-choice').value = path; await loadTemplate(); updateTemplateButtons(); refreshSelect($('template-choice')); message('模板已保存');
      } catch (error) { if (current()) message(error.message); }
      finally { lock(false); }
    };
    $('template-update').onclick = async () => {
      if (!templatePath || busy || templateLoading || !current() || snapshot.accessReadOnly) return;
      lock(true);
      try { const result = await Api.saveNote(templatePath, $('template-source').value, { expectedRevision: templateRevision, vaultRoot: snapshot.root }); if (current()) { templateRevision = result.revision; message('模板修改已保存'); } }
      catch (error) { if (current()) message('保存未完成，模板编辑内容仍保留：' + error.message); }
      finally { lock(false); }
    };
    upgradeSelects(overlay); enterModal(overlay, $('capture-title')); await loadTemplate();
    if (!current() || snapshot !== opened) return;
    updateTemplateButtons(); lock(false);
    enterModal(overlay, $('capture-title'));
    if (snapshot.accessReadOnly) message('当前会话仅可查看模板与预览。');
  }
  function openProperties() {
    const ctx = context();
    if (!ctx.path || !/\.(md|markdown)$/i.test(ctx.path)) { toast('请先打开 Markdown 笔记'); return; }
    if (busy) { toast('上一项操作尚未结束'); return; }
    const parsed = readProperties(ctx.content);
    if (!shell('笔记属性', `<p class="tool-note" id="properties-path"></p><div class="tool-fields property-fields">
      <label>课程<input id="property-course" maxlength="1000" /></label><label>状态<input id="property-status" maxlength="1000" list="property-statuses" /><datalist id="property-statuses"><option value="待整理"></option><option value="学习中"></option><option value="已掌握"></option></datalist></label>
      <label>掌握程度（0–100）<input id="property-mastery" type="number" min="0" max="100" step="1" /></label><label>复习日期<input id="property-review" type="date" /></label>
      <label class="property-tags">标签<input id="property-tags" placeholder="用逗号分隔，例如：数学, 机器学习/优化" /></label></div>
      <p class="tool-note">属性保存在笔记开头，其他属性和正文会保留。清空字段可移除该属性。</p><div class="tool-actions"><button id="properties-save" class="btn-primary" data-tool-write>保存属性</button></div>`)) return;
    mode = 'properties'; $('properties-path').textContent = ctx.path;
    templateError = false; templateLoading = false;
    const original = {};
    for (const [key, spec] of Object.entries(PROPERTY_FIELDS)) {
      const value = parsed.values[key], input = $('property-' + key), matches = parsed.entries.filter(entry => spec.aliases.includes(entry.key));
      input.value = key === 'tags' ? Array.isArray(value) ? value.join(', ') : typeof value === 'string' ? value : '' : value ?? '';
      original[key] = input.value;
      input.disabled = !!parsed.error || matches.length > 1 || matches.some(entry => !entry.supported) || ctx.accessReadOnly || ctx.isRead;
      input.dataset.editable = String(!input.disabled);
      if (matches.length > 1 || matches.some(entry => !entry.supported)) input.title = '复杂或重复字段，请在源码中编辑；此处保留原样。';
    }
    $('properties-save').disabled = !!parsed.error || ctx.accessReadOnly || ctx.isRead;
    $('properties-save').onclick = async () => {
      if (busy || !current()) return;
      try {
        const patch = {};
        for (const key of Object.keys(PROPERTY_FIELDS)) {
          const input = $('property-' + key); if (input.disabled) continue;
          if (input.value === original[key]) continue;
          if (!input.checkValidity()) { input.reportValidity(); throw Error('请检查属性格式'); }
          const raw = input.value.trim(); patch[key] = !raw ? null : key === 'mastery' ? Number(raw) : key === 'tags' ? raw.split(/[,，]/).map(tag => tag.trim().replace(/^#/, '')).filter(Boolean) : raw;
        }
        const content = writeProperties(snapshot.content, patch); lock(true); await actions.properties(snapshot, content); close(); toast('属性已保存');
      } catch (error) { if (current()) message(error.message); }
      finally { lock(false); }
    };
    if (parsed.error) message(parsed.error);
    else if (ctx.accessReadOnly || ctx.isRead) message(ctx.accessReadOnly ? '当前会话仅可查看属性。' : '切换到编辑模式后可修改属性。');
    enterModal(overlay, overlay.querySelector('.property-fields input:not(:disabled)') || $('note-tools-close'));
  }

  const list = node('section', undefined, 'note-list-sheet'); list.id = 'note-list-view'; list.hidden = true; list.setAttribute('aria-labelledby', 'note-list-title');
  list.innerHTML = `<header class="note-tool-header"><h2 id="note-list-title" tabindex="-1">笔记列表</h2><div class="tool-actions"><button id="note-list-refresh" class="btn-ghost">刷新</button><button id="note-list-close" class="btn-ghost">返回编辑区</button></div></header>
    <div class="note-list-filters"><label>搜索条件<input id="note-list-query" placeholder="关键词、path:目录、tag:标签" /></label><label>课程<input id="note-list-course" placeholder="全部课程" /></label><label>状态<input id="note-list-status" placeholder="精确匹配，留空显示全部" /></label><label>掌握程度至少<input id="note-list-mastery" type="number" min="0" max="100" placeholder="不限" /></label><label>排序<select id="note-list-sort" aria-label="列表排序"><option value="modified">修改时间</option><option value="name">名称</option><option value="course">课程</option><option value="status">状态</option><option value="mastery">掌握程度</option><option value="review">复习日期</option></select></label><label>顺序<select id="note-list-direction" aria-label="排序顺序"><option value="desc">降序</option><option value="asc">升序</option></select></label><label class="tool-check"><input id="note-list-due" type="checkbox" /> 仅看今天及之前待复习</label></div>
    <p class="note-list-summary" id="note-list-summary" role="status" aria-live="polite"></p><div class="note-list-scroll"><table><thead><tr><th>笔记</th><th>课程</th><th>状态</th><th>掌握程度</th><th>复习日期</th><th>操作</th></tr></thead><tbody id="note-list-rows"></tbody></table></div><footer class="note-list-footer"><button id="note-list-prev" class="btn-ghost">上一页</button><span id="note-list-page"></span><button id="note-list-next" class="btn-ghost">下一页</button></footer>`;
  document.querySelector('#editor-area').append(list);
  const l = id => list.querySelector('#' + id); let listRoot, listRequest = 0, offset = 0, returnFocus;
  const closeList = () => { if (list.hidden) return; listRequest++; list.hidden = true; document.querySelector('#editor-area').removeAttribute('data-note-view'); if (returnFocus?.isConnected && returnFocus.getClientRects().length) returnFocus.focus({ preventScroll: true }); };
  async function loadList() {
    if (list.hidden) return;
    const request = ++listRequest, root = context().root;
    l('note-list-summary').textContent = '正在读取笔记列表…'; l('note-list-prev').disabled = true; l('note-list-next').disabled = true;
    try {
      const params = { offset: String(offset), limit: '100' };
      for (const key of ['query', 'course', 'status', 'mastery', 'sort', 'direction']) params[key === 'query' ? 'q' : key] = l('note-list-' + key).value;
      params.due = String(l('note-list-due').checked);
      const result = await Api.notes(params); if (list.hidden || request !== listRequest || root !== context().root || result.root !== root) return;
      if (offset && offset >= result.total) { offset = Math.max(0, Math.floor((result.total - 1) / 100) * 100); await loadList(); return; }
      l('note-list-rows').replaceChildren();
      for (const row of result.rows) {
        const tr = node('tr'), title = node('button', row.name, 'note-list-name'); title.title = row.path;
        title.onclick = async () => { closeList(); await actions.open(row.path); };
        const name = node('td'); name.dataset.label = '笔记'; name.append(title, node('small', row.path)); tr.append(name);
        for (const [key, label] of [['course', '课程'], ['status', '状态'], ['mastery', '掌握程度'], ['review', '复习日期']]) { const value = row.properties[key]; const td = node('td', value === '' || value === null ? '—' : key === 'mastery' ? value + '%' : String(value)); td.dataset.label = label; tr.append(td); }
        const operation = node('td'), edit = node('button', '属性', 'btn-ghost'); operation.dataset.label = '操作';
        edit.setAttribute('aria-label', '查看或编辑 ' + row.name + ' 的属性'); edit.onclick = async () => { await actions.open(row.path); if (context().root === root && context().path === row.path) openProperties(); }; operation.append(edit); tr.append(operation);
        l('note-list-rows').append(tr);
      }
      l('note-list-summary').textContent = result.total ? `共 ${result.total} 篇笔记 · 当前 ${offset + 1}–${offset + result.rows.length} 篇` : '没有符合条件的笔记，可清空筛选条件后重试。';
      l('note-list-page').textContent = `第 ${Math.floor(offset / 100) + 1} 页`;
      l('note-list-prev').disabled = offset === 0; l('note-list-next').disabled = offset + 100 >= result.total;
    } catch (error) { if (request === listRequest && !list.hidden) { l('note-list-summary').textContent = '列表读取失败：' + error.message; l('note-list-rows').replaceChildren(); l('note-list-page').textContent = ''; } }
  }
  const reloadList = debounce(() => { offset = 0; void loadList(); }, 200);
  for (const input of list.querySelectorAll('input, select')) input.addEventListener(input.tagName === 'SELECT' || input.type === 'checkbox' ? 'change' : 'input', reloadList);
  l('note-list-close').onclick = closeList; l('note-list-refresh').onclick = () => { void loadList(); };
  l('note-list-prev').onclick = () => { offset = Math.max(0, offset - 100); void loadList(); }; l('note-list-next').onclick = () => { offset += 100; void loadList(); };
  list.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); closeList(); } });
  async function openList(query = '') {
    const root = context().root; if (!root) return;
    if (!await actions.flush() || root !== context().root) { toast('请先处理未保存的笔记'); return; }
    if (listRoot !== root) { for (const key of ['query', 'course', 'status', 'mastery']) l('note-list-' + key).value = ''; l('note-list-due').checked = false; }
    listRoot = root; l('note-list-query').value = query; offset = 0; returnFocus = document.activeElement;
    actions.showList?.(); list.hidden = false; document.querySelector('#editor-area').dataset.noteView = 'list'; l('note-list-title').focus({ preventScroll: true }); await loadList();
  }
  upgradeSelects(list);
  return { template: () => openTemplate(false), capture: () => openTemplate(true), properties: openProperties, list: openList, closeList, changed: () => {
    if (!overlay.hidden && snapshot.root !== context().root) { for (const button of overlay.querySelectorAll('[data-tool-write]')) button.disabled = true; message('仓库已切换，请关闭此窗口后重新打开笔记工具；这里未提交的内容仍保留供复制。'); }
    if (!list.hidden) { if (context().root !== listRoot) closeList(); else void loadList(); }
  } };
}
