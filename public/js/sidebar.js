/** 侧栏每次显示一种内容；异步关联结果必须核对仓库、路径和请求序号。 */
import { parseCached } from './cm/decorations.js';
import { panelDock } from './pane-docking.js';

const $ = id => document.getElementById(id);
const leaf = path => path.split('/').pop().replace(/\.(md|markdown|txt)$/i, '');
const empty = (box, text) => { const el = document.createElement('div'); el.className = 'panel-empty'; el.textContent = text; box.replaceChildren(el); };

export function initLibraryTabs(options) {
  const dock = panelDock(options);
  dock.onSelect(() => {
    $('btn-collapse-tree').hidden = !dock.isActive('library');
    $('btn-file-sort').hidden = !dock.isActive('library');
  });
  return { select: (name, options = {}) => dock.select(name, { reveal: true, ...options }), get current() { return dock.isActive('library') ? 'library' : null; } };
}

export function createSidebarContext({ state, editor, api, navigate, createMissing, searchTag, history, copy, compact, closeMobile }) {
  let current = '', signature = '', headings = [], linkRequest = 0, linkTimer, raf;
  const folded = new Set();
  const dock = panelDock();
  dock.onSelect(() => { if (dock.isActive('links')) refreshLinks(); });
  const contextTabs = { select: (name, options) => dock.select(name, { ...options, reveal: true }) };

  $('note-info-path').onclick = () => { if (state.currentPath) copy(state.currentPath); };
  $('btn-note-history').onclick = history;

  function setMetadata(path, data) {
    if (path !== state.currentPath) return;
    $('note-info-modified').textContent = Number.isFinite(data.mtimeMs) && data.mtimeMs >= 0
      ? new Date(data.mtimeMs).toLocaleString('zh-CN', { hour12: false }) : '—';
    $('note-info-size').textContent = Number.isFinite(data.size)
      ? (data.size < 1024 ? `${data.size} B` : `${(data.size / 1024).toFixed(1)} KB`) : '—';
  }

  function highlight(line) {
    let active = null;
    for (const h of headings) { if (h.line > line) break; active = h.line; }
    for (const row of $('outline-list').querySelectorAll('.outline-row')) {
      const on = Number(row.dataset.line) === active;
      row.classList.toggle('active', on);
      const button = row.querySelector('.outline-item');
      if (on) button.setAttribute('aria-current', 'location'); else button.removeAttribute('aria-current');
    }
  }
  editor.view.scrollDOM.addEventListener('scroll', () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      if (!state.currentPath || $('panel-outline').hidden) return;
      const v = editor.view;
      const viewport = v.scrollDOM.getBoundingClientRect();
      const cursor = v.coordsAtPos(v.state.selection.main.head);
      // 点击短文末尾标题时整篇仍在视口内，滚动测量不能把刚选中的章节改回第一章。
      if (cursor && cursor.top >= viewport.top && cursor.bottom <= viewport.bottom) {
        highlight(v.state.doc.lineAt(v.state.selection.main.head).number); return;
      }
      const y = Math.max(0, viewport.top - v.documentTop + 1);
      highlight(v.state.doc.lineAt(v.lineBlockAtHeight(y).from).number);
    });
  }, { passive: true });

  function renderOutline() {
    // 复用编辑器已解析的 AST，不为侧栏再解析一遍全文。
    const blocks = state.currentPath ? parseCached(editor.view.state).blocks : [];
    const next = [];
    const walk = bs => { for (const b of bs) { if (b.type === 'heading') next.push({ line: b.line + 1, level: b.level, text: b.text.replace(/[*_`~]/g, '') }); if (b.blocks) walk(b.blocks); } };
    walk(blocks);
    const nextSignature = JSON.stringify(next);
    if (nextSignature === signature) return;
    signature = nextSignature; headings = next;
    $('tab-outline').title = `大纲 · ${headings.length} 个标题`;
    const box = $('outline-list'); box.replaceChildren();
    if (!headings.length) { empty(box, /\.pdf$/i.test(state.currentPath || '') ? '在 PDF 阅读器中查看目录' : state.currentPath ? '当前笔记没有标题' : '打开笔记后显示大纲'); return; }
    const stack = [];
    for (const h of headings) {
      while (stack.length && stack.at(-1).level >= h.level) stack.pop();
      const node = document.createElement('div'); node.className = 'outline-node';
      const row = document.createElement('div'); row.className = 'outline-row'; row.dataset.line = h.line;
      const toggle = document.createElement('button'); toggle.className = 'outline-toggle'; toggle.textContent = '›'; toggle.disabled = true; toggle.setAttribute('aria-label', `折叠或展开 ${h.text}`);
      const item = document.createElement('button'); item.className = `outline-item lv${h.level}`; item.textContent = h.text; item.title = h.text; item.dataset.line = h.line;
      item.onclick = () => { editor.scrollToLine(h.line); highlight(h.line); if (compact()) closeMobile(); };
      const children = document.createElement('div'); children.className = 'outline-children';
      children.id = `outline-children-${h.line}`; children.hidden = folded.has(h.line);
      toggle.setAttribute('aria-controls', children.id); toggle.setAttribute('aria-expanded', String(!children.hidden));
      toggle.onclick = () => { children.hidden = !children.hidden; toggle.setAttribute('aria-expanded', String(!children.hidden)); if (children.hidden) folded.add(h.line); else folded.delete(h.line); };
      row.append(toggle, item); node.append(row, children);
      if (stack.length) { stack.at(-1).children.append(node); stack.at(-1).toggle.disabled = false; } else box.append(node);
      stack.push({ level: h.level, children, toggle });
    }
  }

  function refresh(content) {
    const key = `${state.vault?.root || ''}\0${state.currentPath || ''}`;
    if (key !== current) {
      current = key; signature = ''; folded.clear(); headings = [];
      ++linkRequest; clearTimeout(linkTimer);
      $('note-info-modified').textContent = '—'; $('note-info-size').textContent = '—';
      empty($('backlinks-list'), state.currentPath ? '正在读取关联…' : '打开笔记后显示关联');
      $('tab-links').title = '关联';
    }
    const path = state.currentPath;
    $('note-context-title').textContent = path ? `当前笔记 · ${leaf(path)}` : '当前笔记 · 未打开笔记';
    $('note-context-title').title = path || '';
    $('note-info-path').textContent = path || '未打开笔记'; $('note-info-path').disabled = !path;
    $('btn-note-history').disabled = !path || /\.pdf$/i.test(path);
    const src = path ? String(content || '').replace(/\r\n?/g, '\n') : '';
    renderOutline();
    const tags = new Set();
    // 只扫描非围栏内容，避免示例代码里的 # 被误认为笔记标签。
    let fence = null;
    for (const line of src.split('\n')) {
      const mark = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if (mark) { if (!fence) fence = mark[1]; else if (mark[1][0] === fence[0] && mark[1].length >= fence.length) fence = null; continue; }
      if (fence) continue;
      for (const m of line.matchAll(/(^|[\s(（])#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu)) tags.add(m[2]);
    }
    const tagBox = $('note-tags-list'); tagBox.replaceChildren();
    if (!tags.size) empty(tagBox, path ? '当前笔记没有标签' : '打开笔记后显示标签');
    else {
      const cloud = document.createElement('div'); cloud.className = 'tag-cloud';
      for (const tag of tags) { const b = document.createElement('button'); b.className = 'tag-chip'; b.textContent = `#${tag}`; b.onclick = () => searchTag(tag); cloud.append(b); }
      tagBox.append(cloud);
    }
    highlight(editor.view.state.doc.lineAt(editor.view.state.selection.main.head).number);
    refreshLinks();
  }

  function refreshLinks() {
    const request = ++linkRequest, path = state.currentPath, root = state.vault?.root;
    clearTimeout(linkTimer);
    if (!path) return;
    if (/\.pdf$/i.test(path)) { empty($('backlinks-list'), 'PDF 文件'); return; }
    linkTimer = setTimeout(async () => {
      try {
        const { backlinks = [], outgoing = [], unresolved = [] } = await api.links(path);
        if (request !== linkRequest || path !== state.currentPath || root !== state.vault?.root) return;
        const box = $('backlinks-list'); box.replaceChildren();
        const resolved = outgoing.filter(link => link.resolved);
        $('tab-links').title = `关联 · ${backlinks.length + outgoing.length}`;
        const group = (label, count) => { const h = document.createElement('div'); h.className = 'relation-heading'; h.textContent = `${label} · ${count}`; box.append(h); };
        const linkButton = (name, action, context, parent = box) => {
          const b = document.createElement('button'); b.className = 'backlink-item';
          const title = document.createElement('div'); title.className = 'bl-name'; title.textContent = name; b.append(title);
          if (context) { const c = document.createElement('div'); c.className = 'bl-ctx'; c.textContent = context; b.append(c); }
          b.title = context ? `${name}\n${context}` : name;
          b.onclick = action; parent.append(b);
        };
        if (backlinks.length) {
          group('链接到此笔记', backlinks.length);
          for (const link of backlinks) linkButton(link.name, () => navigate(link.path, null, { newTab: true }), link.contexts.map(c => `L${c.line} · ${c.text}`).join('\n'));
        }
        if (resolved.length) {
          group('本笔记链接到', resolved.length);
          for (const link of resolved) linkButton(leaf(link.resolved), () => navigate(link.resolved, null, { newTab: true }));
        }
        if (unresolved.length) {
          const pending = document.createElement('details'); pending.className = 'relation-unresolved';
          const summary = document.createElement('summary'); summary.textContent = `待创建 · ${unresolved.length}`; pending.append(summary); box.append(pending);
          for (const link of unresolved) linkButton(`[[${link.raw}]]`, () => createMissing(link.raw, true), null, pending);
        }
        if (!backlinks.length && !resolved.length && !unresolved.length) empty(box, '当前笔记还没有关联');
      } catch {
        if (request === linkRequest && path === state.currentPath && root === state.vault?.root) empty($('backlinks-list'), '关联读取失败，重新点击关联可重试');
      }
    }, 150);
  }
  function reveal(name) {
    const view = { outline: 'outline', backlinks: 'links', links: 'links', 'note-tags': 'info', info: 'info' }[name];
    if (view) contextTabs.select(view, { focus: true });
  }
  return { refresh, refreshLinks, setMetadata, highlight, reveal };
}

/** 普通 HTTP 手机页面的复制功能也要可用，不能只依赖安全上下文 Clipboard API。 */
export async function copyLocalText(text) {
  if (navigator.clipboard?.writeText) { try { await navigator.clipboard.writeText(text); return; } catch { /* 退回本机选择复制 */ } }
  const previous = document.activeElement;
  const input = document.createElement('textarea'); input.value = text;
  input.style.cssText = 'position:fixed;top:0;left:0;opacity:0'; document.body.append(input); input.select();
  const ok = document.execCommand('copy'); input.remove(); previous?.focus();
  if (!ok) throw new Error('请长按或选择地址后复制');
}

export function initPhoneAccess({ api, toast, closeMobile }) {
  const panel = $('phone-access-panel'), trigger = $('btn-phone-access');
  let request = 0;
  function close() { panel.hidden = true; ++request; $('app').inert = false; trigger.setAttribute('aria-expanded', 'false'); (trigger.getClientRects().length ? trigger : $('btn-toggle-left')).focus(); }
  async function refresh() {
    const ticket = ++request, box = $('phone-addresses'); empty(box, '正在读取本机地址…');
    try {
      const { addresses, enabled, invitation, sessions } = await api.phoneAccess();
      if (ticket !== request || panel.hidden) return;
      $('btn-phone-stop').disabled = !enabled;
      $('btn-phone-revoke').disabled = !enabled;
      $('phone-access-status').textContent = !enabled ? '手机访问已关闭，本机仍可正常使用。' : invitation
        ? `通行码 ${invitation.code} · ${invitation.mode === 'read' ? '只读' : '读写'} · ${new Date(invitation.expiresAt).toLocaleTimeString()} 前有效 · 已授权 ${sessions} 个会话`
        : `访问已开启 · 已授权 ${sessions} 个会话 · 点击「新通行码」连接其他设备`;
      box.replaceChildren();
      if (!enabled) empty(box, '开启后显示手机访问地址。');
      else if (!addresses.length) empty(box, '没有找到局域网 IPv4 地址，请先连接 Wi-Fi 或有线网络后刷新。');
      let others;
      if (addresses.some(item => item.virtual)) {
        others = document.createElement('details'); others.className = 'phone-other-addresses';
        const summary = document.createElement('summary'); summary.textContent = '虚拟网卡与 VPN 地址'; others.append(summary);
      }
      for (const item of addresses) {
        const row = document.createElement('div'); row.className = 'phone-address';
        const label = document.createElement('label'); label.className = 'phone-address-label'; label.textContent = item.name;
        const controls = document.createElement('div'); controls.className = 'phone-address-controls';
        const input = document.createElement('input'); input.readOnly = true; input.value = item.url; input.setAttribute('aria-label', `${item.name} 的手机访问地址`); input.onclick = () => input.select();
        const button = document.createElement('button'); button.className = 'mini-btn'; button.textContent = '复制';
        button.onclick = async () => { try { await copyLocalText(item.url); toast('访问地址已复制'); } catch (e) { input.focus(); input.select(); toast(e.message); } };
        controls.append(input, button); row.append(label, controls); (item.virtual ? others : box).append(row);
      }
      if (others) box.append(others);
    } catch { if (ticket === request && !panel.hidden) empty(box, '地址读取失败，请检查电脑连接后刷新。'); }
  }
  trigger.onclick = () => { closeMobile(); panel.hidden = false; $('app').inert = true; trigger.setAttribute('aria-expanded', 'true'); $('btn-phone-close').focus(); refresh(); };
  $('btn-phone-close').onclick = close; $('btn-phone-refresh').onclick = refresh;
  for (const [id, action] of [ ['btn-phone-start', () => api.phoneStart($('phone-mode').value)], ['btn-phone-stop', () => api.phoneStop()], ['btn-phone-revoke', () => api.phoneRevoke()] ]) {
    $(id).onclick = async () => { $(id).disabled=true; try {await action();await refresh();} catch(error){toast(error.message);} finally{$(id).disabled=false;} };
  }
  setInterval(() => { if(!panel.hidden) refresh(); },30000);
  panel.onclick = event => { if (event.target === panel) close(); };
  document.addEventListener('keydown', event => {
    if (panel.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); }
    if (event.key === 'Tab') {
      const items = [...panel.querySelectorAll('button,input,select,summary')].filter(el => !el.disabled && el.getClientRects().length);
      const index = items.indexOf(document.activeElement);
      if (event.shiftKey && index <= 0) { event.preventDefault(); items.at(-1)?.focus(); }
      else if (!event.shiftKey && (index < 0 || index === items.length - 1)) { event.preventDefault(); items[0]?.focus(); }
      event.stopImmediatePropagation();
    }
  }, true);
}
