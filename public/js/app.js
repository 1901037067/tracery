/**
 * Tracery 主控制器（对应 Obsidian 渲染进程）
 * 负责：仓库/欢迎页、文件树、面板切换、命令面板、快捷键、
 *       编辑器装配、反链/大纲/标签面板、图谱、主题、WebSocket 同步
 */
import { Api, toast, debounce, fuzzyMatch, connectWs } from './api.js';
import { CmEditor } from './cm/engine.js';
import { ForceGraph } from './graph.js';
import {
  initSettings, updateSettings, getSettings, openSettings, close as closeSettings,
  isOpen as settingsIsOpen, onApplied, ACCENTS, resolveAssetDir,
} from './settings.js';
import { onSyncStatus } from './sync-ui.js';
import { askText, askConfirm } from './dialog.js';
import { renderMarkdown } from './markdown.js';
import { openLightbox } from './lightbox.js';
import { openPdfViewer } from './pdf-viewer.js';
import { openDraw, suspendDraw, isDrawOpen } from './draw.js';
import { initMobile, isCompact, toggleMobilePanel, closeMobilePanels } from './mobile.js';
import { initPwa } from './pwa.js';
import { rememberDraft, clearSavedDraft, recoverDraft } from './recovery.js';
import { VirtualTree, flattenTree } from './virtual-tree.js';
import { FILE_SORTS, validSort, sortTree } from './file-sort.js';
import { noteIndex, resolveNote, missingNotePath, normalizeNotePath, wikiParts } from './wiki-path.js';
import { noteAnchors, selectNoteContent } from './note-embed.js';
import { createSidebarContext, initLibraryTabs, initPhoneAccess, copyLocalText } from './sidebar.js';
import { HOTKEY_COMMANDS, bindingFor, shortcutFromEvent, shortcutLabel } from './hotkeys.js';
import { toggleBold, toggleItalic, toggleStrike, insertWikilink } from './cm/editing.js';
import { GROUP_COLORS, isBlankTab, newBlankKey, groupForTab, tidyTabGroups, moveTabToGroup, renameTabKeys } from './tab-workspace.js';

const $ = (id) => document.getElementById(id);

/** 图片类文件：文件树点击时用灯箱查看，而不是尝试当笔记打开 */
const IMG_FILE_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
/** PDF：应用内阅读器打开 */
const PDF_FILE_RE = /\.pdf$/i;

/** 仓库相对路径 → 绝对路径（桌面能力用） */
function vaultAbs(rel) {
  const root = state.vault?.root;
  if (!root || !rel) return '';
  return `${root.replace(/[\\/]+$/, '')}\\${rel.replace(/[\\/]/g, '\\')}`;
}

/**
 * 读 localStorage：优先新键（tracery.*），回退旧键（evnote.*）。
 * 2026-10 产品从 EVNote 改名 Tracery 时加的保护——
 * 老用户的界面状态（折叠目录 / 栏宽 / 上次打开的笔记 / 标签页）不能因为改名归零。
 */
function lsGet(key) {
  const v = localStorage.getItem(key);
  if (v !== null) return v;
  const legacy = key.replace(/^tracery\./, 'evnote.');
  return legacy === key ? null : localStorage.getItem(legacy);
}

const state = {
  vault: null,
  tree: null,
  files: new Map(),
  fileLookup: new Map(),
  currentPath: null,
  tabs: [],                 // 打开的笔记（标签页）
  activeTab: -1,
  tabGroups: [],
  nameIndex: new Map(),      // 笔记名(小写) -> path，供 resolveLink 用
  collapsed: new Set(JSON.parse(lsGet('tracery.collapsed') || '[]')),
  pinned: new Set(JSON.parse(lsGet('tracery.pinned') || '[]')),   // 星标笔记（仓库相对路径）
  recent: JSON.parse(lsGet('tracery.recent') || '[]'),            // 最近打开（最多 8 条）
  graph: null,
  theme: 'dark',
  themeName: 'apple',
  settings: null,
};

/** 编辑器实例（boot 之后才创建；定义在这里是为了让 refreshTree / refreshGraph
 *  这类「先声明后调用」的辅助函数能安全地通知它重建装饰）。 */
let editor = null;
let sidebars = null;
let libraryTabs = null;

/* ================= 启动 ================= */
async function boot() {
  // 调试/测试钩子
  window.__tracery = { editor, state, Api, openNote, switchPanel, switchRightPanel, exportHtml, exportPdf, togglePin, openTrash, revealInTree };
  const st = await Api.state();
  state.settings = st.settings || null;
  initSettings(st.settings || {});
  state.themeName = getSettings().themeName;
  onApplied((s) => {
    state.settings = s;
    state.theme = document.documentElement.dataset.theme;
    state.themeName = s.themeName;
    editor.setAutosave(s.autosave);
    editor.setLineNumbers(s.lineNumbers !== false);
    refreshShortcutHints();
  });
  editor.setAutosave(state.settings?.autosave ?? 900);
  editor.setLineNumbers(getSettings().lineNumbers !== false);
  refreshShortcutHints();
  if (st.vault) {
    $('welcome').hidden = true;
    $('app').hidden = false;
    await enterApp(st.vault);
  } else {
    showWelcome(st.recentVaults || []);
  }
  bindGlobalEvents();
  connectWs(onWsMessage);
}

/* ================= 欢迎页 / 仓库管理 ================= */
function showWelcome(recents) {
  $('welcome').hidden = false;
  // 已有仓库时是「浮层」：应用留在背后，随时可以关掉返回
  if (!state.vault) $('app').hidden = true;
  $('btn-welcome-close').hidden = !state.vault;
  $('vault-error').hidden = true;
  // 提示文案随场景变化：首次启动 vs 切换仓库
  $('welcome-tip').innerHTML = state.vault
    ? '按 <code>Esc</code> 或点右上角关闭，返回当前仓库'
    : '提示：首次启动会自动打开内置 <code>demo-vault</code> 演示仓库';
  renderRecentVaults(recents || []);
}

/** 关闭仓库选择浮层（仅在已有仓库时可关） */
function closeWelcome() {
  if (!state.vault) return;
  $('welcome').hidden = true;
}

/** 打开仓库选择浮层（标题栏仓库名 / 文件夹按钮 / 命令面板） */
function openVaultPicker() {
  if (!suspendDraw()) return;
  if (isCompact()) closeMobilePanels();
  $('vault-path').value = state.vault?.root || '';
  Api.state()
    .then((s) => showWelcome(s.recentVaults || []))
    .catch(() => showWelcome([]));
}

function renderRecentVaults(recents) {
  const list = $('recent-list');
  list.innerHTML = '';
  $('recent-empty').hidden = recents.length > 0;
  for (const v of recents) {
    const li = document.createElement('li');
    const isCurrent = !!state.vault && v === state.vault.root;
    li.className = 'recent-item' + (isCurrent ? ' current' : '');

    const open = document.createElement('button');
    open.className = 'recent-open';
    open.title = `打开 ${v}`;
    const name = document.createElement('span');
    name.className = 'recent-name';
    name.textContent = v.replace(/\\/g, '/').split('/').filter(Boolean).slice(-1)[0] || v;
    if (isCurrent) {
      const badge = document.createElement('span');
      badge.className = 'recent-badge';
      badge.textContent = '当前';
      name.appendChild(badge);
    }
    const p = document.createElement('span');
    p.className = 'recent-path';
    p.textContent = v;
    open.append(name, p);
    open.onclick = () => openVault(v);

    const rm = document.createElement('button');
    rm.className = 'recent-remove';
    rm.title = '从列表移除（不会删除磁盘文件）';
    rm.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="width:12px;height:12px"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
    rm.onclick = async (e) => {
      e.stopPropagation();
      try {
        const res = await Api.forgetVault(v);
        renderRecentVaults(res.recentVaults || []);
      } catch { toast('移除失败'); }
    };

    li.append(open, rm);
    list.appendChild(li);
  }
}

async function browseVault() {
  const picked = await window.electronAPI?.pickVault?.();
  if (!picked) return;
  $('vault-path').value = picked;
  openVault(picked);
}

async function openVault(path) {
  if (!suspendDraw()) return;
  try {
    $('vault-error').hidden = true;
    if (!await editor.flush()) { toast('笔记尚未保存，请保存后再切换仓库'); return; }
    const res = await Api.openVault(path);
    $('welcome').hidden = true;
    $('app').hidden = false;
    await enterApp(res.vault);
    toast(`已打开仓库：${res.vault.name}`);
  } catch (e) {
    $('vault-error').textContent = e.message;
    $('vault-error').hidden = false;
  }
}

async function enterApp(vault) {
  state.vault = vault;
  state.currentPath = null;
  loadShortcuts();
  refreshRightPanels(null);
  $('vault-name').textContent = vault.name;
  $('vault-name').title = `${vault.root}\n点击切换 / 管理仓库`;
  document.title = `${vault.name} — Tracery`;
  await refreshTree();
  await refreshGraph();
  await refreshTags();
  await restoreTabsAfterVaultSwitch();
}

/**
 * 切仓库后：恢复该仓库的标签页，并按启动设置开一篇。
 * enterApp 与 WS vault-opened 共用——两边漏任何一边，
 * 旧仓库的标签就会带进新仓库（标签是按仓库根目录存 localStorage 的）。
 */
async function restoreTabsAfterVaultSwitch() {
  loadTabsState();
  const startup = getSettings().startup;
  if (startup === 'empty') state.activeTab = -1;
  renderTabs();
  if (startup === 'empty') return;
  if (state.tabs.length) {
    state.activeTab = Math.min(state.activeTab < 0 ? 0 : state.activeTab, state.tabs.length - 1);
    await loadTab(state.tabs[state.activeTab]);
  } else {
    const last = lsGet('tracery.lastNote');
    const target = last && hasNotePath(last) ? last : firstNotePath();
    if (target) await openNote(target, null, { newTab: true });
  }
}

/* ================= 图标（统一线条风格） ================= */
const S = (body) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICON = {
  chevron: S('<path d="M6 3.5L10.5 8 6 12.5"/>'),
  folder: S('<path d="M1.8 4.6A1.6 1.6 0 0 1 3.4 3h3l1.4 1.8h4.8a1.6 1.6 0 0 1 1.6 1.6v5a1.6 1.6 0 0 1-1.6 1.6H3.4a1.6 1.6 0 0 1-1.6-1.6z"/>'),
  folderOpen: S('<path d="M1.8 11.4V4.6A1.6 1.6 0 0 1 3.4 3h3l1.4 1.8h4.4A1.6 1.6 0 0 1 13.8 6.4v1"/><path d="M1.8 11.4l1.5-3.1a1.6 1.6 0 0 1 1.45-.9h8.9a.8.8 0 0 1 .74 1.1l-1.3 3.4a1.6 1.6 0 0 1-1.5 1H3.4a1.6 1.6 0 0 1-1.6-1.5z"/>'),
  doc: S('<path d="M4 1.8h5l3.2 3.2v9H4z"/><path d="M9 1.8V5h3.2"/><path d="M6 8.4h4M6 10.6h4"/>'),
  image: S('<rect x="2" y="3" width="12" height="10" rx="1.8"/><circle cx="5.6" cy="6.4" r="1"/><path d="M2.6 11.6l3.2-3 2.5 2.3 2.2-2 2.9 2.7"/>'),
  pdf: S('<path d="M4 1.8h5l3.2 3.2v9H4z"/><path d="M9 1.8V5h3.2"/><path d="M6 9.2h4"/><path d="M6 11.2h2.6"/>'),
  paperclip: S('<path d="M10.8 4.6l-4.6 4.6a2 2 0 0 0 2.8 2.8l4.6-4.6a3.2 3.2 0 0 0-4.5-4.5L3.6 7.4a4.4 4.4 0 0 0 6.2 6.2l3.4-3.4"/>'),
  // 右键菜单图标（统一 16 格线性，别再用 emoji：跨平台字形不一致、还发虚）
  eye: S('<path d="M1.8 8S4.1 4.6 8 4.6 14.2 8 14.2 8 11.9 11.4 8 11.4 1.8 8 1.8 8z"/><circle cx="8" cy="8" r="1.6"/>'),
  copy: S('<rect x="5.6" y="5.6" width="7.4" height="7.4" rx="1.4"/><path d="M10.4 5.6V4A1.2 1.2 0 0 0 9.2 2.8H4A1.2 1.2 0 0 0 2.8 4v5.2A1.2 1.2 0 0 0 4 10.4h1.6"/>'),
  star: S('<path d="M8 2.6l1.7 3.4 3.7.55-2.7 2.6.64 3.7L8 11.1l-3.34 1.75L5.3 9.15 2.6 6.55l3.7-.55z"/>'),
  link: S('<path d="M6.7 9.3a2.5 2.5 0 0 0 3.5 0l2-2a2.5 2.5 0 0 0-3.5-3.5l-.9.9"/><path d="M9.3 6.7a2.5 2.5 0 0 0-3.5 0l-2 2a2.5 2.5 0 0 0 3.5 3.5l.9-.9"/>'),
  globe: S('<circle cx="8" cy="8" r="5.4"/><path d="M2.6 8h10.8"/><path d="M8 2.6c1.6 1.5 2.4 3.3 2.4 5.4S9.6 12 8 13.4C6.4 11.9 5.6 10.1 5.6 8S6.4 4.1 8 2.6z"/>'),
  compass: S('<circle cx="8" cy="8" r="5.4"/><path d="M10.1 5.9L9.2 9.2 5.9 10.1l.9-3.3z"/>'),
  external: S('<path d="M9.4 3.4h3.2v3.2"/><path d="M12.6 3.4L7.4 8.6"/><path d="M11.4 9.6v2a1.2 1.2 0 0 1-1.2 1.2H4a1.2 1.2 0 0 1-1.2-1.2V5.2A1.2 1.2 0 0 1 4 4h2"/>'),
  pencil: S('<path d="M10.9 2.7l2.4 2.4-7.1 7.1-3.1.7.7-3.1z"/>'),
  check: S('<path d="M3.2 8.4l3 3 6.6-6.6"/>'),
  trash: S('<path d="M2.8 4.6h10.4"/><path d="M6.2 4.6V3.2h3.6v1.4"/><path d="M4.1 4.6l.6 8.1h6.6l.6-8.1"/>'),
  zoom: S('<circle cx="7.1" cy="7.1" r="3.6"/><path d="M9.8 9.8l3.2 3.2"/>'),
  tree: S('<path d="M3.3 4.6h.01M6.4 4.6h6.4M6.4 8h6.4M6.4 11.4h6.4"/><path d="M3.6 4.6v6.8"/><path d="M3.6 8h2.2"/>'),
  scissors: S('<circle cx="4.4" cy="11.5" r="1.5"/><circle cx="11.6" cy="11.5" r="1.5"/><path d="M5.5 10.4L11.9 3M10.5 10.4L4.1 3"/>'),
  clipboard: S('<rect x="4.2" y="3.4" width="7.6" height="10" rx="1.3"/><path d="M6.2 3.4v-.8h3.6v.8"/>'),
  clipboardText: S('<rect x="4.2" y="3.4" width="7.6" height="10" rx="1.3"/><path d="M6.2 3.4v-.8h3.6v.8"/><path d="M6.2 7h3.6M6.2 9.4h2.4"/>'),
  code: S('<path d="M6.1 5.3L3.2 8l2.9 2.7"/><path d="M9.9 5.3L12.8 8l-2.9 2.7"/>'),
  codeBlock: S('<rect x="2.4" y="3.4" width="11.2" height="9.2" rx="1.4"/><path d="M6.2 6.9L4.7 8.3l1.5 1.4"/><path d="M9.8 6.9l1.5 1.4-1.5 1.4"/>'),
  table: S('<rect x="2.4" y="3.4" width="11.2" height="9.2" rx="1.2"/><path d="M2.4 6.6h11.2M2.4 9.5h11.2M6.2 3.4v9.2"/>'),
  rule: S('<path d="M2.4 8h11.2"/>'),
  list: S('<path d="M3.3 4.4h.01M3.3 8h.01M3.3 11.6h.01"/><path d="M6.4 4.4h6.4M6.4 8h6.4M6.4 11.6h6.4"/>'),
  task: S('<rect x="2.3" y="2.9" width="4.1" height="4.1" rx="1"/><path d="M3.2 4.9l.8.8 1.4-1.7"/><rect x="2.3" y="9" width="4.1" height="4.1" rx="1"/><path d="M8.9 4.9h4.6M8.9 11h4.6"/>'),
  quote: S('<path d="M3 3.4v9.2"/><path d="M6.4 5h6.6M6.4 8h6.6M6.4 11h4.2"/>'),
  selectAll: S('<rect x="2.6" y="2.6" width="10.8" height="10.8" rx="1.4" stroke-dasharray="2.6 2"/><path d="M6.2 6.6l4 1.6-1.6.8-.8 1.6z"/>'),
  undo: S('<path d="M6 4.6L3.2 7.4 6 10.2"/><path d="M3.2 7.4h6.1a3.1 3.1 0 0 1 0 6.2H7.1"/>'),
  redo: S('<path d="M10 4.6l2.8 2.8L10 10.2"/><path d="M12.8 7.4H6.7a3.1 3.1 0 0 0 0 6.2h2.2"/>'),
  close: S('<path d="M4 4l8 8M12 4l-8 8"/>'),
  book: S('<path d="M2.6 4.2A1.4 1.4 0 0 1 4 2.8h9.4v9.4H4.6A1.4 1.4 0 0 0 3.2 13.6z"/><path d="M2.6 12.2V4.2"/><path d="M13.4 12.2H4.6"/><path d="M6.2 5.6h4.6M6.2 7.8h3.2"/>'),
};

function iconForFile(name) {
  if (/\.md$/i.test(name)) return ICON.doc;
  if (/\.(png|jpe?g|gif|svg|webp|avif)$/i.test(name)) return ICON.image;
  if (/\.pdf$/i.test(name)) return ICON.pdf;
  return ICON.paperclip;
}

/* ================= 数据刷新 ================= */
async function refreshTree() {
  state.tree = await Api.tree();
  state.files = new Map();
  state.fileLookup = new Map();
  const walk = (node) => { for (const f of node.files || []) state.files.set(f.path, f); for (const d of node.dirs || []) walk(d); };
  walk(state.tree);
  for (const f of state.files.values()) {
    const parts = f.path.toLowerCase().split('/');
    for (let i = 0; i < parts.length; i++) {
      const suffix = parts.slice(i).join('/');
      if (!state.fileLookup.has(suffix)) state.fileLookup.set(suffix, f.path);
    }
  }
  state.nameIndex = new Map();
  for (const f of state.files.values()) if (/\.(md|markdown|txt)$/i.test(f.name)) state.nameIndex.set(f.name.replace(/\.(md|markdown|txt)$/i, '').toLowerCase(), f.path);
  state.noteIndex = noteIndex(state.files.keys());
  renderTree(true);
  // 文件树变了 → 装饰里的 `![[图片]]`/`![](路径)` 可能从「找不到」变「找得到」（或反之）。
  // CM 的装饰只在 doc/视口/选区变化时重建，索引变化必须显式通知（块级内核没这方法，忽略）。
  editor?.refreshDecorations?.();
}

const refreshGraph = debounce(async () => {
  // 双链名称索引来自文件清单；隐藏图谱不传输全仓节点，也不在后台重启力导向计算。
  if (!document.body.classList.contains('graph-focus')) { state.graph = null; return; }
  const g = await Api.graph();
  state.graph = g;
  // 双链的「解析得到 / 解析不到」直接取决于这份索引 → 通知装饰重算 unresolved 类
  editor?.refreshDecorations?.();
  if (graphView && document.body.classList.contains('graph-focus')) {
    graphView.opts.activePath = state.currentPath;
    graphView.setData(g);
  }
}, 150);

const refreshTags = debounce(async () => {
  const { tags } = await Api.tags();
  const box = $('tag-list');
  box.innerHTML = '';
  if (!tags.length) {
    box.innerHTML = '<div class="panel-empty">还没有标签</div>';
    return;
  }
  const cloud = document.createElement('div');
  cloud.className = 'tag-cloud';
  for (const { tag, count } of tags) {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.innerHTML = `#${escapeText(tag)}<span class="count">${count}</span>`;
    chip.onclick = () => { switchPanel('search'); $('search-input').value = `#${tag}`; runSearch(`#${tag}`); };
    cloud.appendChild(chip);
  }
  box.appendChild(cloud);
}, 150);

function basename(p) { return p.replace(/\\/g, '/').split('/').slice(-1)[0].replace(/\.md$/i, ''); }

function firstNotePath() {
  const walk = (node) => {
    for (const f of node.files || []) if (/\.md$/i.test(f.name)) return f.path;
    for (const d of node.dirs || []) { const r = walk(d); if (r) return r; }
    return null;
  };
  return state.tree ? walk(state.tree) : null;
}

/**
 * 在仓库里找附件（图片/PDF 等）。
 * 支持三种写法：`图.png`（裸文件名）、`z_图片/图.png`（相对路径）、`./图.png`。
 * 优先整路径匹配，其次按文件名唯一匹配。
 */
function resolveVaultFile(name) {
  if (!state.tree || !name) return null;
  const want = name.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  const leaf = want.split('/').pop();
  return state.fileLookup.get(want) || state.fileLookup.get(leaf) || null;
}

function resolveEmbeddedFile(name, from) {
  const folder = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
  const raw = name.replace(/\\/g, '/');
  const candidate = normalizeNotePath(`${folder}/${raw}`);
  if (candidate && state.files.has(candidate)) return candidate;
  if (/^\.{1,2}\//.test(raw)) return null;
  return resolveVaultFile(raw);
}

async function loadEmbeddedNote(raw) {
  const from = editor?.path || state.currentPath || '';
  const path = state.noteIndex && resolveNote(raw, from, state.noteIndex);
  if (!path) return { error: '找不到这篇笔记，请检查引用路径或是否有同名笔记' };
  try {
    const content = path === editor.path ? editor.getContent() : (await Api.note(path)).content;
    return { path, ...selectNoteContent(content, wikiParts(raw).heading) };
  } catch { return { path, error: '笔记读取失败，请检查文件后刷新重试' }; }
}

async function completeWiki(query) {
  const hash = query.indexOf('#'), caret = query.indexOf('^');
  const anchorAt = hash >= 0 ? hash : caret;
  if (anchorAt >= 0) {
    const target = query.slice(0, anchorAt), part = query.slice(anchorAt + 1);
    const path = state.noteIndex && resolveNote(target || '#', editor.path || '', state.noteIndex);
    if (!path) return [];
    try {
      const content = path === editor.path ? editor.getContent() : (await Api.note(path)).content;
      const needle = (hash < 0 ? '^' : '') + part;
      return noteAnchors(content).filter(item => (needle.startsWith('^') === item.anchor.startsWith('^')) && (item.anchor + item.label).toLowerCase().includes(needle.toLowerCase()))
        .slice(0, 60).map(item => ({ label: item.anchor, target: `${target}#${item.anchor}`, detail: item.anchor.startsWith('^') ? item.label : '标题', type: 'text' }));
    } catch { return []; }
  }
  return [...state.files.keys()].filter(path => path.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => Number(!state.noteIndex?.exact.has(a)) - Number(!state.noteIndex?.exact.has(b)) || a.localeCompare(b, 'zh-CN', { numeric: true }))
    .slice(0, 80).map(path => ({ label: path.replace(/\.(md|markdown|txt)$/i, ''), detail: state.noteIndex?.exact.has(path) ? '笔记' : '附件', type: 'text' }));
}

function openEmbeddedLink(raw, from = editor.path) {
  const path = state.noteIndex && resolveNote(raw, from, state.noteIndex);
  if (path) openNote(path, wikiParts(raw).heading, { newTab: true });
  else {
    const file = resolveEmbeddedFile(wikiParts(raw).target, from);
    if (file) window.open(Api.fileUrl(file), '_blank', 'noopener');
    else toast('找不到引用的笔记或附件');
  }
}

/* ================= 文件树 ================= */
/* 折叠/展开全部的两种图标（参考 Obsidian：⤡ 折叠 / ⤢ 展开，状态可辨） */
const ICON_COLLAPSE_ALL = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2.5v4H2.5M10 2.5v4h3.5M6 13.5v-4H2.5M10 13.5v-4h3.5"/></svg>';
const ICON_EXPAND_ALL = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6V2.5h4M13.5 6V2.5h-4M2.5 10v3.5h4M13.5 10v3.5h-4"/></svg>';

/** 按当前折叠状态刷新按钮图标：全折叠 → 显示「展开」，否则 → 显示「折叠」 */
function updateCollapseTreeIcon() {
  const btn = $('btn-collapse-tree');
  if (!btn) return;
  const all = new Set();
  const walk = (node) => { for (const d of node.dirs || []) { all.add(d.name); walk(d); } };
  if (state.tree) walk(state.tree);
  const allCollapsed = all.size > 0 && state.collapsed.size >= all.size;
  btn.innerHTML = allCollapsed ? ICON_EXPAND_ALL : ICON_COLLAPSE_ALL;
  btn.title = allCollapsed ? '展开全部文件夹' : '折叠全部文件夹';
}

let virtualTree = null;
let renderedTree = null;
let fileSort = 'name-asc', sortedTree = null, sortedSource = null, sortedMode = null;
function orderedTree() {
  if (!state.tree) return null;
  if (sortedSource !== state.tree || sortedMode !== fileSort || !sortedTree) {
    sortedSource = state.tree; sortedMode = fileSort; sortedTree = sortTree(state.tree, fileSort);
  }
  return sortedTree;
}
function renderTree(rebuild = false) {
  const box = $('file-tree');
  const ordered = orderedTree();
  $('btn-file-sort').title = `排序：${FILE_SORTS.find(([key]) => key === fileSort)[1]}；文件夹优先`;
  renderShortcuts();
  if (state.tree && state.files.size > 400) {
    if (!virtualTree) virtualTree = new VirtualTree(box, (row) => {
      if (row.kind === 'dir') return renderDirItem(row.node, row.rel);
      if (row.kind === 'heading') { const el = document.createElement('div'); el.className = 'pinned-head'; el.textContent = '星标'; return el; }
      const el = renderFile(row.file);
      if (row.kind === 'pinned') el.classList.add('pinned-item');
      return el;
    });
    if (rebuild || renderedTree !== ordered) virtualTree.setRows(flattenTree(ordered, state.collapsed, new Set()));
    virtualTree.select(state.currentPath); renderedTree = ordered; updateCollapseTreeIcon(); return;
  }
  if (virtualTree) { virtualTree.destroy(); virtualTree = null; }
  renderedTree = null;
  box.innerHTML = '';
  if (!state.tree) return;
  if (!state.tree.files.length && !state.tree.dirs.length) {
    box.innerHTML = '<div class="tree-empty">仓库是空的<br>点右上角 ＋ 新建第一篇笔记</div>';
    return;
  }
  box.appendChild(renderTreeNode(ordered, 0, true));
  updateCollapseTreeIcon();
}

// 收藏与最近打开按仓库隔离；旧全局数据只迁移到第一次接续使用的仓库。
function shortcutsKey() { return `tracery.shortcuts:${state.vault?.root || ''}`; }
function loadShortcuts() {
  fileSort = validSort(localStorage.getItem(`tracery.fileSort:${state.vault.root}`)); sortedTree = null;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(shortcutsKey()) || 'null'); } catch { /* 损坏时使用空列表 */ }
  if (!saved && !localStorage.getItem('tracery.shortcutsMigrated')) {
    saved = { pinned: [...state.pinned], recent: state.recent };
    localStorage.setItem('tracery.shortcutsMigrated', state.vault.root);
  }
  state.pinned = new Set(Array.isArray(saved?.pinned) ? saved.pinned.filter(p => typeof p === 'string') : []);
  state.recent = Array.isArray(saved?.recent) ? saved.recent.filter(p => typeof p === 'string').slice(0, 8) : [];
  saveShortcuts();
}
function saveShortcuts() { localStorage.setItem(shortcutsKey(), JSON.stringify({ pinned: [...state.pinned], recent: state.recent })); }
function renderShortcuts() {
  for (const [id, paths, kind] of [['pinned-list', [...state.pinned], 'pinned'], ['recent-notes', state.recent, 'recent']]) {
    const box = $(id); box.replaceChildren();
    const available = paths.filter(p => state.files.has(p));
    const tab = $(`tab-${kind}`), label = kind === 'pinned' ? '收藏' : '最近打开';
    tab.title = `${label} · ${available.length}`; tab.setAttribute('aria-label', `${label}，${available.length} 项`);
    for (const p of available) {
      const item = document.createElement('button'); item.className = `tree-item ${kind}-item${p === state.currentPath ? ' active' : ''}`; item.dataset.path = p; item.title = p;
      const icon = document.createElement('span'); icon.className = 'icon'; icon.innerHTML = kind === 'pinned' ? ICON.star : ICON.doc;
      const label = document.createElement('span'); label.className = 'label tree-label'; label.textContent = basename(p); item.append(icon, label);
      item.onclick = () => {
        if (IMG_FILE_RE.test(p)) openLightbox(Api.fileUrl(p), state.files.get(p).name);
        else if (PDF_FILE_RE.test(p)) openPdfViewer(Api.fileUrl(p), state.files.get(p).name, vaultAbs(p));
        else openNote(p);
      };
      item.oncontextmenu = e => { e.preventDefault(); e.stopPropagation(); showFileMenu(e, state.files.get(p)); };
      box.append(item);
    }
    if (!available.length) { const el = document.createElement('div'); el.className = 'panel-empty'; el.textContent = kind === 'pinned' ? '右键笔记可加入收藏' : '打开的笔记会出现在这里'; box.append(el); }
  }
}

/** 星标开关（右键菜单用） */
function togglePin(relPath) {
  if (state.pinned.has(relPath)) state.pinned.delete(relPath);
  else state.pinned.add(relPath);
  saveShortcuts();
  renderTree(true);
  toast(state.pinned.has(relPath) ? '已加星标' : '已取消星标');
}

/** 记录最近打开（最多 8 条，去重） */
function pushRecent(relPath) {
  if (!relPath) return;
  state.recent = [relPath, ...state.recent.filter((p) => p !== relPath)].slice(0, 8);
  saveShortcuts();
  renderShortcuts();
}

function renameShortcuts(oldPath, newPath) {
  const map = p => p === oldPath ? newPath : p.startsWith(`${oldPath}/`) ? `${newPath}${p.slice(oldPath.length)}` : p;
  state.pinned = new Set([...state.pinned].map(map)); state.recent = state.recent.map(map); saveShortcuts();
}

function renderDirItem(d, rel) {
  const item = document.createElement('div');
  item.className = 'tree-item'; item.dataset.dir = rel;
  const collapsed = state.collapsed.has(d.name);
  item.innerHTML = `<span class="tw${collapsed ? '' : ' open'}">${ICON.chevron}</span><span class="icon">${collapsed ? ICON.folder : ICON.folderOpen}</span>`;
  const label = document.createElement('span'); label.className = 'label'; label.textContent = d.name; item.appendChild(label);
  item.onclick = (e) => {
    e.stopPropagation();
    if (state.collapsed.has(d.name)) state.collapsed.delete(d.name); else state.collapsed.add(d.name);
    localStorage.setItem('tracery.collapsed', JSON.stringify([...state.collapsed])); renderTree(true);
  };
  item.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); showDirMenu(e, rel); };
  return item;
}

function renderTreeNode(node, depth, isRoot = false) {
  const frag = document.createDocumentFragment();
  // parentRel：树节点只带 basename（服务端 tree() 是按层级拼出来的），
  // 但右键菜单/删除/重命名需要**完整相对路径**——所以在递归时把父级路径拼进来。
  const renderDir = (d, parentRel = '') => {
    const rel = parentRel ? `${parentRel}/${d.name}` : d.name;
    const wrap = document.createElement('div');
    const item = renderDirItem(d, rel);
    wrap.appendChild(item);
    if (!state.collapsed.has(d.name)) {
      const children = document.createElement('div');
      children.className = 'tree-children';
      for (const sub of d.dirs || []) children.appendChild(renderDir(sub, rel));
      for (const f of d.files || []) children.appendChild(renderFile(f));
      wrap.appendChild(children);
    }
    return wrap;
  };
  if (isRoot) {
    for (const d of node.dirs || []) frag.appendChild(renderDir(d));
    for (const f of node.files || []) frag.appendChild(renderFile(f));
  }
  return frag;
}

function renderFile(f) {
  const item = document.createElement('div');
  item.className = 'tree-item' + (f.path === state.currentPath ? ' active' : '');
  item.dataset.path = f.path;
  const icon = document.createElement('span');
  icon.className = 'icon';
  icon.innerHTML = iconForFile(f.name);
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = f.name.replace(/\.md$/i, '');
  item.append(icon, label);
  item.onclick = (e) => {
    // 图片 → 灯箱；PDF → 应用内阅读器（以前都走 openNote → 报「笔记不存在」）
    if (IMG_FILE_RE.test(f.path)) { openLightbox(Api.fileUrl(f.path), f.name); return; }
    if (PDF_FILE_RE.test(f.path)) { openPdfViewer(Api.fileUrl(f.path), f.name, vaultAbs(f.path)); return; }
    openNote(f.path, null, { newTab: !(e.ctrlKey || e.metaKey) });
  };
  item.onauxclick = (e) => {
    if (e.button === 1) {
      e.preventDefault();
      if (IMG_FILE_RE.test(f.path)) { openLightbox(Api.fileUrl(f.path), f.name); return; }
      if (PDF_FILE_RE.test(f.path)) { openPdfViewer(Api.fileUrl(f.path), f.name, vaultAbs(f.path)); return; }
      openNote(f.path, null, { newTab: true });
    }
  };
  item.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); showFileMenu(e, f); };
  return item;
}

/* ================= 右键菜单 ================= */
let ctxMenu = null;
let contextTarget = null;
let vaultMenuRequest = 0;
function closeCtxMenu() {
  vaultMenuRequest++;
  $('vault-name')?.setAttribute('aria-expanded', 'false');
  $('btn-tab-more')?.setAttribute('aria-expanded', 'false');
  if (ctxMenu) { ctxMenu.remove(); ctxMenu = null; }
  contextTarget?.classList.remove('context-target'); contextTarget = null;
  $('btn-file-sort')?.setAttribute('aria-expanded', 'false');
}
document.addEventListener('click', closeCtxMenu);

/** 字型图标（H1 / B / I / ¶ 这类排版项用文字比画图形更清楚） */
const T = (txt, cls = '') => `<span class="mi-txt ${cls}">${txt}</span>`;

function showMenu(x, y, items, target = null) {
  closeCtxMenu();
  if (target) { contextTarget = target; target.classList.add('context-target'); }
  ctxMenu = document.createElement('div');
  ctxMenu.className = 'context-menu';
  for (const it of items) {
    if (it === '-') { const s = document.createElement('div'); s.className = 'sep'; ctxMenu.appendChild(s); continue; }
    const btn = document.createElement('button');
    if (it.danger) btn.className = 'danger';
    if (it.disabled) btn.disabled = true;
    if (it.title) btn.title = it.title;
    btn.innerHTML = `<span class="mi-icon${it.iconOn ? ' on' : ''}">${it.icon || ''}</span>`
      + `<span class="mi-label">${it.label}</span>`
      + (it.checked ? '<span class="mi-check">✓</span>' : '')
      + (it.kbd ? `<span class="mi-kbd">${it.kbd}</span>` : '');
    btn.onclick = (e) => { e.stopPropagation(); closeCtxMenu(); it.action?.(); };
    ctxMenu.appendChild(btn);
  }
  document.body.appendChild(ctxMenu);
  const rect = ctxMenu.getBoundingClientRect();
  ctxMenu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
  ctxMenu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
}

function showFileMenu(e, f) {
  const isMd = /\.md$/i.test(f.path);
  const isImg = IMG_FILE_RE.test(f.path);
  const isPdf = PDF_FILE_RE.test(f.path);
  const abs = vaultAbs(f.path);
  const inElectron = !!window.electronAPI;
  const openIn = () => {
    if (isImg) { openLightbox(Api.fileUrl(f.path), f.name); return; }
    if (isPdf) { openPdfViewer(Api.fileUrl(f.path), f.name, abs); return; }
    openNote(f.path, null, { newTab: true });
  };
  const items = [
    { label: isMd ? '在新标签页中打开' : '查看', icon: isMd ? ICON.doc : ICON.eye, action: openIn },
  ];
  if (isMd) items.push({ label: '创建副本', icon: ICON.copy, action: () => duplicateFile(f) });
  const pinned = state.pinned.has(f.path);
  items.push({
    label: pinned ? '取消星标' : '星标',
    icon: ICON.star,
    iconOn: pinned,
    action: () => togglePin(f.path),
  });
  items.push('-');
  items.push({ label: '复制路径', icon: ICON.link, action: () => copyText(abs) });
  items.push({ label: '复制相对路径', icon: ICON.compass, action: () => copyText(f.path) });
  items.push('-');
  if (inElectron) {
    items.push({ label: '使用默认应用打开', icon: ICON.external, action: () => window.electronAPI.openPath(abs) });
    items.push({ label: '在系统资源管理器中显示', icon: ICON.folder, action: () => window.electronAPI.reveal(abs) });
    items.push('-');
  }
  items.push({ label: '重命名', icon: ICON.pencil, action: () => renameNote(f) });
  items.push({ label: '删除', icon: ICON.trash, danger: true, action: () => deleteNote(f) });
  showMenu(e.clientX, e.clientY, items, e.currentTarget);
}

/** 复制一份笔记（同名后加「副本」，自动避让重名） */
async function duplicateFile(f) {
  try {
    const { content } = await Api.note(f.path);
    const base = f.path.replace(/\.md$/i, '');
    const exists = (p) => state.files.has(p);
    let target = `${base} 副本.md`;
    let n = 1;
    while (exists(target)) { n += 1; target = `${base} 副本 ${n}.md`; }
    await Api.createNote(target, content);
    await refreshTree();
    refreshGraph();
    refreshTags();
    toast(`已创建副本：${target}`);
  } catch (err) { toast(`创建副本失败：${err.message}`); }
}

/** 文件夹右键菜单（对齐文件菜单的口径） */
function showDirMenu(e, rel) {
  const abs = vaultAbs(rel);
  const inElectron = !!window.electronAPI;
  const items = [
    { label: '在此新建笔记', icon: ICON.doc, action: () => createNoteIn(rel) },
    { label: '在此新建文件夹', icon: ICON.folder, action: () => createFolderIn(rel) },
    '-',
    { label: '复制相对路径', icon: ICON.compass, action: () => copyText(rel) },
  ];
  if (inElectron) {
    items.push({ label: '在系统资源管理器中显示', icon: ICON.folder, action: () => window.electronAPI.reveal(abs) });
  }
  items.push('-');
  items.push({ label: '重命名', icon: ICON.pencil, action: () => renameFolder(rel) });
  items.push({ label: '删除', icon: ICON.trash, danger: true, action: () => deleteFolder(rel) });
  showMenu(e.clientX, e.clientY, items, e.currentTarget);
}

/** 重命名文件夹：目录里的笔记路径整体前缀替换，打开中的标签/当前笔记跟着改 */
async function renameFolder(rel) {
  const oldName = rel.split('/').pop();
  const input = await askText({
    title: '重命名文件夹',
    desc: '文件夹里笔记的路径会跟着变；指向它们的 [[双链]] 不会自动更新。',
    value: oldName,
    okText: '重命名',
  });
  if (!input) return;
  // Windows 文件名不允许这些字符，直接替换成 -（与冲突副本/绘图文件同口径）
  const clean = input.replace(/[\\/:*?"<>|]/g, '-').replace(/^\.+$/, '');
  if (!clean || clean === oldName) return;
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : '';
  const newRel = dir + clean;
  try {
    await Api.rename(rel, newRel);
    renameShortcuts(rel, newRel);
    const prefix = rel + '/';
    const under = (p) => p === rel || p.startsWith(prefix);
    const mapped = (p) => (p === rel ? newRel : `${newRel}/${p.slice(prefix.length)}`);
    renameTabKeys(state, p => under(p) ? mapped(p) : p);
    if (state.currentPath && under(state.currentPath)) {
      const np = mapped(state.currentPath);
      state.currentPath = np;
      localStorage.setItem('tracery.lastNote', np);
      $('note-path').textContent = np;
    }
    await refreshTree(); refreshGraph(); refreshTags();
    saveTabsState();
    renderTabs();
    toast('已重命名文件夹');
  } catch (e) { toast(e.message); }
}

/** 删除文件夹（连同里面的内容一起移入回收站，可整体恢复） */
async function deleteFolder(rel) {
  const name = rel.split('/').pop();
  const ok = await askConfirm({
    title: `删除文件夹「${name}」？`,
    desc: '文件夹里的所有内容会一起移入回收站，之后可从文件面板的“更多”菜单整体恢复。',
    okText: '删除',
    danger: true,
  });
  if (!ok) return;
  const prefix = rel + '/';
  const under = (p) => p === rel || p.startsWith(prefix);
  try {
    if (state.currentPath && under(state.currentPath)) await editor.flush();
    await Api.remove(rel);
    // 关掉该文件夹下打开的所有标签（含子目录）
    const prevActive = state.tabs[state.activeTab] || '';   // activeTab=-1 时别拿到 undefined
    const remain = state.tabs.filter((p) => !under(p));
    state.tabs = remain;
    if (!remain.length) state.activeTab = -1;
    else if (under(prevActive)) state.activeTab = Math.min(state.activeTab, remain.length - 1);
    else state.activeTab = Math.max(0, remain.indexOf(prevActive));
    if (state.currentPath && under(state.currentPath)) {
      state.currentPath = null;
      localStorage.removeItem('tracery.lastNote');
      editor.load('', '');
      $('note-path').textContent = '';
      refreshRightPanels(null);
    }
    await refreshTree(); refreshGraph(); refreshTags();
    saveTabsState();
    renderTabs();
    if (state.activeTab >= 0 && remain[state.activeTab] !== state.currentPath) {
      await loadTab(remain[state.activeTab]);
    }
    toast('文件夹已移入回收站');
  } catch (e) { toast(e.message); }
}

/* ================= 导出（HTML / PDF） ================= */
/** 生成自包含的导出 HTML：内联样式 + 图片转 data URL，发给别人也能直接看 */
async function buildExportHtml() {
  const md = editor.getContent();
  const root = renderMarkdown(md, { tagOffsets: false });
  // 图片转 data URL（导出文件不依赖本机服务）
  for (const img of root.querySelectorAll('img')) {
    const src = img.getAttribute('src') || '';
    if (!src || src.startsWith('data:')) continue;
    try {
      const blob = await (await fetch(src)).blob();
      const dataUrl = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.onerror = rej;
        fr.readAsDataURL(blob);
      });
      img.setAttribute('src', dataUrl);
    } catch { /* 拿不到就保留原地址 */ }
  }
  let css = '';
  try { css = await (await fetch('/css/style.css')).text(); } catch { /* 忽略 */ }
  const title = (state.currentPath || '笔记').split('/').pop().replace(/\.md$/i, '');
  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeText(title)}</title>
<style>${css}</style>
<style>
  html, body { background: #fff; }
  body { margin: 0; padding: 48px 56px; }
  .export-body { max-width: 780px; margin: 0 auto; }
  .export-body pre { overflow-x: auto; }
</style>
</head>
<body><div class="markdown-body export-body">${root.innerHTML}</div></body>
</html>`;
}

async function exportHtml() {
  try {
    const html = await buildExportHtml();
    const name = (state.currentPath || '笔记').split('/').pop().replace(/\.md$/i, '');
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name}.html`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('已导出 HTML');
  } catch (e) { toast(`导出失败：${e.message}`); }
}

async function exportPdf() {
  if (!window.electronAPI?.exportPdf) { toast('PDF 导出仅桌面版支持，浏览器里可以用 HTML 导出后打印'); return; }
  try {
    const html = await buildExportHtml();
    const name = (state.currentPath || '笔记').split('/').pop().replace(/\.md$/i, '');
    const saved = await window.electronAPI.exportPdf(html, `${name}.pdf`);
    if (saved) toast('PDF 已保存');
  } catch (e) { toast(`导出失败：${e.message}`); }
}

/* ================= 版本历史 ================= */
let historyKeyHandler = null;

function closeHistory() {
  const box = document.getElementById('history-viewer');
  if (box) box.hidden = true;
  if (historyKeyHandler) {
    document.removeEventListener('keydown', historyKeyHandler, true);
    historyKeyHandler = null;
  }
}

/** 重新载入当前笔记（恢复历史 / 批量替换后用） */
async function reloadCurrentNote() {
  if (!state.currentPath) return;
  try {
    const { content } = await Api.note(state.currentPath);
    editor.load(state.currentPath, content);
  } catch { /* 文件可能已不在 */ }
}

async function openHistory() {
  if (!state.currentPath) { toast('先打开一篇笔记'); return; }
  const notePath = state.currentPath;
  let box = document.getElementById('history-viewer');
  if (!box) {
    box = document.createElement('div');
    box.className = 'trash-viewer';
    box.id = 'history-viewer';
    box.innerHTML = `
      <div class="trash-panel" role="dialog" aria-label="版本历史">
        <header class="trash-head">
          <span class="trash-title">版本历史</span>
          <span class="trash-sub"></span>
          <span class="trash-actions"><button class="mini-btn hist-close" title="关闭 (Esc)">✕</button></span>
        </header>
        <div class="trash-list"></div>
      </div>`;
    document.body.appendChild(box);
    box.querySelector('.hist-close').onclick = closeHistory;
    box.addEventListener('mousedown', (e) => { if (e.target === box) closeHistory(); });
  }
  box.hidden = false;
  historyKeyHandler = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); closeHistory(); }
  };
  document.addEventListener('keydown', historyKeyHandler, true);

  const list = box.querySelector('.trash-list');
  const sub = box.querySelector('.trash-sub');
  sub.textContent = notePath;
  list.textContent = '加载中…';
  let items = [];
  try { ({ items } = await Api.history(notePath)); } catch (e) { list.textContent = `读取失败：${e.message}`; return; }
  if (!items.length) {
    list.innerHTML = '<div class="panel-empty">还没有历史版本（每次保存前会自动留一份，最多 20 个）</div>';
    return;
  }
  list.innerHTML = '';
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'trash-item hist-item';
    const main = document.createElement('div');
    main.className = 'trash-main';
    const name = document.createElement('div');
    name.className = 'trash-name';
    name.textContent = new Date(it.time).toLocaleString('zh-CN', { hour12: false });
    const meta = document.createElement('div');
    meta.className = 'trash-meta';
    meta.textContent = `${fmtSize(it.size || 0)} · 点击看内容`;
    main.append(name, meta);
    const actions = document.createElement('div');
    actions.className = 'trash-item-actions';
    const restore = document.createElement('button');
    restore.className = 'mini-btn';
    restore.textContent = '恢复';
    restore.onclick = async (e) => {
      e.stopPropagation();
      const ok = await askConfirm({
        title: '恢复到这一版？',
        desc: '当前内容会先存一份新快照，随时可以再回来。',
        okText: '恢复',
      });
      if (!ok) return;
      try {
        await Api.historyRestore(notePath, it.id);
        await reloadCurrentNote();
        await refreshTree();
        toast('已恢复到这个版本');
        closeHistory();
      } catch (err) { toast(`恢复失败：${err.message}`); }
    };
    actions.appendChild(restore);
    row.append(main, actions);
    // 点行展开内容预览
    row.onclick = async () => {
      let pre = row.querySelector('.hist-preview');
      if (pre) { pre.remove(); return; }
      try {
        const { content } = await Api.historyContent(notePath, it.id);
        pre = document.createElement('pre');
        pre.className = 'hist-preview';
        pre.textContent = content;
        row.appendChild(pre);
      } catch (err) { toast(`读取失败：${err.message}`); }
    };
    list.appendChild(row);
  }
}

/* ================= 回收站 ================= */
let trashKeyHandler = null;

function closeTrash() {
  const box = document.getElementById('trash-viewer');
  if (box) box.hidden = true;
  if (trashKeyHandler) {
    document.removeEventListener('keydown', trashKeyHandler, true);
    trashKeyHandler = null;
  }
}

function openTrash() {
  let box = document.getElementById('trash-viewer');
  if (!box) {
    box = document.createElement('div');
    box.className = 'trash-viewer';
    box.id = 'trash-viewer';
    box.innerHTML = `
      <div class="trash-panel" role="dialog" aria-label="回收站">
        <header class="trash-head">
          <span class="trash-title">回收站</span>
          <span class="trash-sub"></span>
          <span class="trash-actions">
            <button class="mini-btn trash-empty" title="彻底删除全部">清空</button>
            <button class="mini-btn trash-close" title="关闭 (Esc)">✕</button>
          </span>
        </header>
        <div class="trash-list"></div>
      </div>`;
    document.body.appendChild(box);
    box.querySelector('.trash-close').onclick = closeTrash;
    box.addEventListener('mousedown', (e) => { if (e.target === box) closeTrash(); });
    box.querySelector('.trash-empty').onclick = async () => {
      const ok = await askConfirm({
        title: '清空回收站？',
        desc: '里面的文件会被彻底删除，无法恢复。',
        okText: '清空',
        danger: true,
      });
      if (!ok) return;
      try { await Api.trashEmpty(); renderTrashList(); } catch (e) { toast(e.message); }
    };
  }
  box.hidden = false;
  trashKeyHandler = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); closeTrash(); }
  };
  document.addEventListener('keydown', trashKeyHandler, true);
  renderTrashList();
}

const fmtSize = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

async function renderTrashList() {
  const box = document.getElementById('trash-viewer');
  if (!box) return;
  const list = box.querySelector('.trash-list');
  const sub = box.querySelector('.trash-sub');
  list.textContent = '加载中…';
  let items = [];
  try { ({ items } = await Api.trash()); } catch (e) { list.textContent = `读取失败：${e.message}`; return; }
  sub.textContent = items.length ? `${items.length} 项` : '';
  if (!items.length) {
    list.innerHTML = '<div class="panel-empty">回收站是空的（删除的笔记和附件会先放到这里）</div>';
    return;
  }
  list.innerHTML = '';
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'trash-item';
    const main = document.createElement('div');
    main.className = 'trash-main';
    const name = document.createElement('div');
    name.className = 'trash-name';
    name.textContent = it.name;
    const meta = document.createElement('div');
    meta.className = 'trash-meta';
    const when = new Date(it.deletedAt).toLocaleString('zh-CN', { hour12: false });
    meta.textContent = `${it.path} · ${when} · ${fmtSize(it.size || 0)}`;
    main.append(name, meta);
    const restore = document.createElement('button');
    restore.className = 'mini-btn';
    restore.textContent = '恢复';
    restore.onclick = async () => {
      try {
        const r = await Api.trashRestore(it.id);
        await refreshTree(); refreshGraph(); refreshTags();
        toast(`已恢复：${r.path}`);
        if (/\.md$/i.test(r.path)) openNote(r.path, null, { newTab: true });
        renderTrashList();
      } catch (e) { toast(`恢复失败：${e.message}`); }
    };
    const purge = document.createElement('button');
    purge.className = 'mini-btn trash-purge';
    purge.textContent = '彻底删除';
    purge.onclick = async () => {
      const ok = await askConfirm({ title: `彻底删除「${it.name}」？`, desc: '这一步不可恢复。', okText: '彻底删除', danger: true });
      if (!ok) return;
      try { await Api.trashPurge(it.id); renderTrashList(); } catch (e) { toast(e.message); }
    };
    const actions = document.createElement('div');
    actions.className = 'trash-item-actions';
    actions.append(restore, purge);
    row.append(main, actions);
    list.appendChild(row);
  }
}

/* ================= 编辑区右键菜单（仿 Obsidian） ================= */
// 点菜单项会让 contenteditable 失焦、选区丢失 —— 右键时先存一份，动作前还原，
// 否则「标题/加粗」这类要靠光标位置的动作全部落空
let editorSavedRange = null;

function restoreEditorSelection() {
  if (!editorSavedRange) return;
  try {
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(editorSavedRange);
  } catch { /* 选区所在节点已被重渲染替换，忽略 */ }
}

/** 包装菜单动作：先还原选区再执行 */
function withSelection(fn) {
  return () => { restoreEditorSelection(); fn(); };
}

function onEditorContextMenu(e) {
  const sel = window.getSelection();
  editorSavedRange = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
  const fig = e.target.closest?.('.embed-image');
  const img = e.target.closest?.('img');
  if (fig || img) { e.preventDefault(); showImageMenu(e, fig || img); return; }
  e.preventDefault();
  showTextMenu(e);
}

async function pasteFromClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    if (text) editor.insertText(text);
  } catch (err) { toast(`读不到剪贴板：${err.message}`); }
}

function showTextMenu(e) {
  // 所有动作都先还原右键时的选区（点菜单会把选区清掉）
  const item = (ic, label, fn) => ({ icon: ic, label, action: withSelection(fn) });
  // 阅读模式是只读的：改内容的那批项直接置灰（否则点了没反应，用户以为菜单坏了）
  const ro = editor.isRead;
  const editItem = (ic, label, fn) => ({ icon: ic, label, disabled: ro, action: withSelection(fn) });
  const canUndo = editor.canUndo();
  const canRedo = editor.canRedo();
  showMenu(e.clientX, e.clientY, [
    { icon: ICON.undo, label: '撤销', kbd: commandKeyLabel('undo'), disabled: ro || !canUndo, action: withSelection(() => editor.undo()) },
    { icon: ICON.redo, label: '重做', kbd: commandKeyLabel('redo'), disabled: ro || !canRedo, action: withSelection(() => editor.redo()) },
    '-',
    editItem(ICON.link, '新增链接', () => editor.wrapSelection('[[', ']]')),
    editItem(ICON.globe, '新增外部链接', () => editor.wrapSelection('[', '](https://)')),
    '-',
    editItem(T('B'), '加粗', () => editor.wrapSelection('**', '**')),
    editItem(T('I', 'it'), '斜体', () => editor.wrapSelection('*', '*')),
    editItem(T('S', 'st'), '删除线', () => editor.wrapSelection('~~', '~~')),
    editItem(ICON.pencil, '高亮', () => editor.wrapSelection('==', '==')),
    editItem(ICON.code, '行内代码', () => editor.wrapSelection('`', '`')),
    '-',
    editItem(T('H1'), '标题 1', () => editor.setLinePrefix('# ')),
    editItem(T('H2'), '标题 2', () => editor.setLinePrefix('## ')),
    editItem(T('H3'), '标题 3', () => editor.setLinePrefix('### ')),
    editItem(T('¶'), '正文', () => editor.setLinePrefix('')),
    editItem(ICON.list, '无序列表', () => editor.setLinePrefix('- ')),
    editItem(ICON.task, '任务', () => editor.setLinePrefix('- [ ] ')),
    editItem(ICON.quote, '引用', () => editor.setLinePrefix('> ')),
    '-',
    editItem(ICON.table, '插入表格', () => editor.insertSnippet('| 列 1 | 列 2 |\n| --- | --- |\n|  |  |')),
    editItem(ICON.codeBlock, '插入代码块', () => editor.insertSnippet('```\n\n```')),
    editItem(ICON.rule, '插入分割线', () => editor.insertSnippet('---')),
    '-',
    { ...item(ICON.scissors, '剪切', () => document.execCommand('cut')), disabled: ro },
    item(ICON.copy, '复制', () => document.execCommand('copy')),
    { ...item(ICON.clipboard, '粘贴', pasteFromClipboard), disabled: ro },
    { ...item(ICON.clipboardText, '以纯文本形式粘贴', pasteFromClipboard), disabled: ro },
    item(ICON.selectAll, '全选', () => editor.selectAll()),
  ]);
}

function copyText(text) {
  copyLocalText(text).then(
    () => toast('已复制'),
    (err) => toast(`复制失败：${err.message}`),
  );
}

/** 复制图片本身到剪贴板（统一转 PNG，方便粘贴到其它软件） */
async function copyImageToClipboard(src) {
  try {
    const blob = await (await fetch(src)).blob();
    const bmp = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    canvas.getContext('2d').drawImage(bmp, 0, 0);
    const png = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    toast('图片已复制');
  } catch (err) { toast(`复制图片失败：${err.message}`); }
}

/** 在文件树里定位并高亮某个文件（展开祖先目录） */
function revealInTree(rel) {
  if (!rel) return;
  switchPanel('files');
  libraryTabs?.select('library');
  const parts = rel.replace(/\\/g, '/').split('/');
  parts.pop();
  if (parts.length) {
    for (const name of parts) state.collapsed.delete(name);
    localStorage.setItem('tracery.collapsed', JSON.stringify([...state.collapsed]));
    renderTree(true);
  }
  virtualTree?.reveal(rel);
  const el = document.querySelector(`#file-tree .tree-item[data-path="${CSS.escape(rel)}"]`);
  if (!el) { toast('文件树里没找到这个文件'); return; }
  el.scrollIntoView({ block: 'center' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 900);
}

function showImageMenu(e, target) {
  const fig = target.classList?.contains('embed-image') ? target : target.closest?.('.embed-image');
  const img = fig ? fig.querySelector('img') : target;
  const rel = fig
    ? (fig.dataset.target || '').split('|')[0].split('#')[0].trim()
    : (img?.dataset?.mdSrc || '');
  const resolved = rel ? (resolveVaultFile(rel) || rel) : '';
  const abs = resolved && state.vault?.root
    ? `${state.vault.root.replace(/[\\/]+$/, '')}\\${resolved.replace(/[\\/]/g, '\\')}`
    : '';
  const src = img?.getAttribute('src') || '';
  const inElectron = !!window.electronAPI;
  showMenu(e.clientX, e.clientY, [
    { icon: ICON.copy, label: '复制图片', action: () => copyImageToClipboard(src) },
    { icon: ICON.zoom, label: '查看大图', action: () => openLightbox(src, img?.alt || '') },
    { icon: ICON.link, label: '复制路径', action: () => copyText(resolved) },
    '-',
    { icon: ICON.folder, label: '在资源管理器中显示', action: () => (inElectron ? window.electronAPI.reveal(abs) : toast('仅桌面版支持')) },
    { icon: ICON.external, label: '使用默认应用打开', action: () => (inElectron ? window.electronAPI.openPath(abs) : toast('仅桌面版支持')) },
    { icon: ICON.tree, label: '在文件列表中显示', action: () => revealInTree(resolved) },
    '-',
    // 只有图片才可能带场景（pdf/附件跳过）
    ...(/[.](png|jpe?g|webp|gif)$/i.test(resolved || '')
      ? [{ icon: ICON.pencil, label: '编辑绘图', action: () => editDrawing(resolved) }, '-']
      : []),
    { icon: ICON.scissors, label: '移除图片', disabled: editor.isRead, action: () => editor.removeImageAt(img) },
    { icon: ICON.trash, label: '删除图片文件', danger: true, action: () => deleteAssetFile(resolved) },
  ]);
}

async function deleteAssetFile(rel) {
  if (!rel) return;
  const ok = await askConfirm({
    title: '删除这个图片文件？',
    desc: `${rel}\n\n会从仓库里删除文件本身，文档里引用它的地方会变成坏链。`,
    okText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await Api.remove(rel);
    await refreshTree();
    refreshGraph();
    toast('已删除图片文件');
  } catch (err) { toast(`删除失败：${err.message}`); }
}

async function renameNote(f) {
  const isMd = /\.md$/i.test(f.name);
  const ext = (f.name.match(/\.[^.]+$/) || [])[0] || '';
  const oldName = isMd ? f.name.replace(/\.md$/i, '') : f.name.replace(/\.[^.]+$/, '');
  const input = await askText({
    title: isMd ? '重命名笔记' : '重命名文件',
    desc: isMd ? '指向这篇笔记的 [[双链]] 会自动更新' : '文档里引用这个文件的地方可能不会自动更新',
    value: oldName,
    okText: '重命名',
  });
  if (!input || input === oldName) return;
  const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : '';
  const bare = input.replace(/\.[^.]+$/, '');
  const newPath = dir + bare + ext;
  try {
    await Api.rename(f.path, newPath);
    renameShortcuts(f.path, newPath);
    renameTabKeys(state, p => p === f.path ? newPath : p);
    if (state.currentPath === f.path) {
      state.currentPath = newPath;
      localStorage.setItem('tracery.lastNote', newPath);
      $('note-path').textContent = newPath;
    }
    await refreshTree(); refreshGraph(); refreshTags();
    renderTabs(); saveTabsState();
    toast('已重命名');
  } catch (e) { toast(e.message); }
}

async function deleteNote(f) {
  const ok = await askConfirm({
    title: `删除「${f.name}」？`,
    desc: '文件会移入回收站，之后可从文件面板的“更多”菜单恢复。',
    okText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    if (state.currentPath === f.path) await editor.flush();
    await Api.remove(f.path);
    const ti = state.tabs.indexOf(f.path);
    if (ti >= 0) await closeTab(ti);
    await refreshTree(); refreshGraph(); refreshTags();
    toast('已删除');
  } catch (e) { toast(e.message); }
}

async function createNoteIn(dir) {
  const name = await askText({
    title: '新建笔记',
    desc: dir ? `将会创建在 ${dir}/ 下` : '名称末尾不用加 .md',
    value: '未命名笔记',
    okText: '创建',
  });
  if (!name) return;
  const path = (dir ? dir + '/' : '') + name.replace(/\.md$/i, '') + '.md';
  try {
    await Api.createNote(path, '');
    await refreshTree(); refreshGraph(); refreshTags();
    openNote(path, null, { newTab: !isBlankTab(state.tabs[state.activeTab]) });
    toast(`已创建「${name.replace(/\.md$/i, '')}」`);
  } catch (e) { toast(e.message); }
}

async function createFolderIn(dir) {
  const name = await askText({
    title: '新建文件夹',
    desc: dir ? `将会创建在 ${dir}/ 下` : '',
    value: '新建文件夹',
    okText: '创建',
  });
  if (!name) return;
  try {
    await Api.createNote((dir ? dir + '/' : '') + name + '/.keep', '');
    await refreshTree();
    toast('已创建文件夹');
  } catch (e) { toast(e.message); }
}

/* ================= 标签页（多开） ================= */
function tabsKey() { return `tracery.tabs.${state.vault?.root || 'default'}`; }

function hasNotePath(p) {
  return state.files.has(p);
}

function saveTabsState() {
  try {
    tidyTabGroups(state);
    localStorage.setItem(tabsKey(), JSON.stringify({ tabs: state.tabs, active: state.activeTab, groups: state.tabGroups }));
    if (state.currentPath) localStorage.setItem('tracery.lastNote', state.currentPath);
  } catch { /* 隐私模式下忽略 */ }
}

function loadTabsState() {
  try {
    const raw = JSON.parse(lsGet(tabsKey()) || '{}');
    state.tabs = [...new Set((Array.isArray(raw.tabs) ? raw.tabs : []).filter(p => typeof p === 'string' && (isBlankTab(p) || hasNotePath(p))))];
    state.tabGroups = Array.isArray(raw.groups) ? raw.groups : [];
    state.activeTab = Number.isInteger(raw.active)
      ? Math.min(Math.max(raw.active, 0), state.tabs.length - 1)
      : state.tabs.length - 1;
    tidyTabGroups(state);
  } catch {
    state.tabs = [];
    state.tabGroups = [];
    state.activeTab = -1;
  }
}

/* ---------- 标签拖拽换序 ----------
 * 用 pointer 事件而不是 HTML5 drag&drop：标题栏整体是 `-webkit-app-region: drag`，
 * HTML5 拖放在 Electron 里时灵时不灵；pointer 还能被 puppeteer 的鼠标事件直接驱动（可测）。
 * 约定：移动超过 5px 才算拖拽（否则当点击）；落点按「指针在中线左/右」决定插前还是插后。 */
let tabDrag = null;            // { from, startX, moved }
let suppressTabClick = false;  // 拖完会补一个 click，别把它当成切标签
let tabDragPreview = null;

function clearTabDragPreview() {
  tabDragPreview?.remove();
  tabDragPreview = null;
}
window.addEventListener('blur', () => {
  tabDrag = null;
  clearTabDragPreview();
  clearTabDropMarks();
  document.querySelectorAll('#tablist .dragging').forEach((el) => el.classList.remove('dragging'));
});

function moveTabDragPreview(e, path) {
  if (!tabDragPreview) {
    tabDragPreview = document.createElement('div');
    tabDragPreview.className = 'tab-drag-preview';
    tabDragPreview.textContent = tabLabel(path);
    document.body.appendChild(tabDragPreview);
  }
  const box = tabDragPreview.getBoundingClientRect();
  const x = e.clientX + box.width + 16 < innerWidth ? e.clientX + 14 : e.clientX - box.width - 14;
  tabDragPreview.style.left = `${Math.max(4, x)}px`;
  tabDragPreview.style.top = `${Math.max(4, Math.min(e.clientY + 12, innerHeight - box.height - 4))}px`;
}

function clearTabDropMarks() {
  document.querySelectorAll('#tablist .drop-before, #tablist .drop-after, #tablist .drop-target')
    .forEach((el) => el.classList.remove('drop-before', 'drop-after', 'drop-target'));
}

/** 把 from 位置的标签挪到插入位 to（to 是「原数组里的插入下标」） */
function reorderTabs(from, to, groupId) {
  if (from < 0 || from >= state.tabs.length || to < 0) return;
  const activePath = state.tabs[state.activeTab];
  const [item] = state.tabs.splice(from, 1);
  const insert = Math.max(0, Math.min(from < to ? to - 1 : to, state.tabs.length));
  state.tabs.splice(insert, 0, item);
  if (groupId !== undefined) {
    for (const group of state.tabGroups) group.tabs = group.tabs.filter(key => key !== item);
    state.tabGroups.find(group => group.id === groupId)?.tabs.push(item);
  }
  // 活跃标签跟着「那篇笔记」走，不能跟着下标走
  state.activeTab = state.tabs.indexOf(activePath);
  renderTabs();
  saveTabsState();
}

function updateEmptyNote() {
  const empty = !state.currentPath;
  $('empty-note').hidden = !empty;
  $('editor-live').hidden = empty;
  $('editor-live').inert = empty;
  $('editor-area').classList.toggle('is-empty', empty);
  $('btn-mode').disabled = empty;
}

function tabLabel(key) { return isBlankTab(key) ? '新标签页' : basename(key); }

async function openBlankTab() {
  if (!suspendDraw() || !await editor.flush()) return;
  if (document.body.classList.contains('graph-focus')) toggleGraphFocus(false);
  const key = newBlankKey();
  state.tabs.push(key);
  state.activeTab = state.tabs.length - 1;
  await loadTab(key);
  $('empty-open-note').focus();
}

function renderTabs() {
  tidyTabGroups(state);
  updateEmptyNote();
  clearTabDragPreview();
  // 标签栏已并入标题栏：标题栏永远可见（拖拽区 + 窗口按钮），
  // 无标签时只隐藏标签列表本身，不能再隐藏整个 bar
  const list = $('tablist');
  if (!list) return;
  if (!state.tabs.length) { list.hidden = true; list.innerHTML = ''; return; }
  list.hidden = false;
  list.innerHTML = '';
  state.tabs.forEach((p, i) => {
    const tab = document.createElement('div');
    tab.className = `tab${i === state.activeTab ? ' active' : ''}`;
    tab.title = isBlankTab(p) ? tabLabel(p) : p;
    tab.dataset.index = String(i);
    const group = groupForTab(state, p);
    if (group) {
      tab.dataset.group = group.id;
      tab.style.setProperty('--group-color', groupColor(group));
      if (group.tabs[0] === p) list.appendChild(makeGroupHeader(group));
      tab.hidden = group.collapsed;
    }
    const name = document.createElement('span');
    name.className = 'tab-name';
    name.textContent = tabLabel(p);
    const close = document.createElement('button');
    close.className = 'tab-close';
    close.title = commandLabel('closeTab');
    close.innerHTML = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3.2 3.2l5.6 5.6M8.8 3.2l-5.6 5.6"/></svg>';
    close.onclick = (e) => { e.stopPropagation(); closeTab(i); };

    // 拖拽换序（pointer 实现，见上）
    tab.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('.tab-close')) return;
      tabDrag = { from: i, startX: e.clientX, startY: e.clientY, moved: false };
      try { tab.setPointerCapture(e.pointerId); } catch { /* 老内核忽略 */ }
    });
    tab.addEventListener('pointermove', (e) => {
      if (!tabDrag || tabDrag.from !== i) return;
      if (!tabDrag.moved) {
        if (Math.hypot(e.clientX - tabDrag.startX, e.clientY - tabDrag.startY) < 5) return;
        tabDrag.moved = true;
        tab.classList.add('dragging');
      }
      moveTabDragPreview(e, p);
      const over = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.tab, .tab-group-header');
      clearTabDropMarks();
      if (!over || over === tab) return;
      if (over.classList.contains('tab-group-header')) { over.classList.add('drop-target'); return; }
      const r = over.getBoundingClientRect();
      over.classList.add(e.clientX > r.left + r.width / 2 ? 'drop-after' : 'drop-before');
    });
    const endDrag = (e, commit) => {
      if (!tabDrag || tabDrag.from !== i) return;
      const { moved } = tabDrag;
      const over = moved ? document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.tab, .tab-group-header') : null;
      tabDrag = null;
      clearTabDragPreview();
      tab.classList.remove('dragging');
      clearTabDropMarks();
      if (!moved || !commit || !over) return;
      suppressTabClick = true;
      setTimeout(() => { suppressTabClick = false; }, 0);
      if (over.classList.contains('tab-group-header')) {
        moveTabToGroup(state, p, over.dataset.group); renderTabs(); saveTabsState(); return;
      }
      const target = Number(over.dataset.index);
      if (!Number.isFinite(target) || target === i) return;
      const r = over.getBoundingClientRect();
      reorderTabs(i, target + (e.clientX > r.left + r.width / 2 ? 1 : 0), groupForTab(state, state.tabs[target])?.id || null);
    };
    tab.addEventListener('pointerup', (e) => endDrag(e, true));
    tab.addEventListener('pointercancel', (e) => endDrag(e, false));
    tab.addEventListener('lostpointercapture', (e) => endDrag(e, false));

    tab.append(name, close);
    tab.onclick = () => { if (suppressTabClick) return; activateTab(i); };
    tab.onauxclick = (e) => { if (e.button === 1) { e.preventDefault(); closeTab(i); } };
    tab.oncontextmenu = e => { e.preventDefault(); showTabContextMenu(e, p); };
    list.appendChild(tab);
  });
  layoutTabs();
}

/** 标签条最右侧的下拉菜单（2026-10-19 用户需求）：
 *  ① 列出当前打开了哪些标签页（当前那个带 ✓，点一项即切过去）；② 关闭所有标签页；③ 收藏所有标签页。 */
function showTabMenu(btn) {
  const r = btn.getBoundingClientRect();
  const noteCount = state.tabs.filter(key => !isBlankTab(key)).length;
  const items = [];
  if (state.tabs.length) {
    state.tabs.forEach((p, i) => {
      items.push({
        icon: ICON.doc,
        label: tabLabel(p),
        title: groupForTab(state, p)?.name || (isBlankTab(p) ? '新标签页' : p),
        checked: i === state.activeTab,
        action: () => activateTab(i),
      });
    });
  } else {
    items.push({ label: '当前没有打开的标签页', icon: ICON.doc, disabled: true });
  }
  items.push('-');
  items.push({
    label: '关闭所有标签页',
    icon: ICON.close,
    disabled: !state.tabs.length,
    action: () => closeAllTabs(),
  });
  items.push({
    label: noteCount ? `收藏所有标签页（${noteCount}）` : '收藏所有标签页',
    icon: ICON.star,
    disabled: !noteCount,
    action: () => pinAllTabs(),
  });
  showMenu(r.left, r.bottom + 6, items);
}

/** 关闭全部标签页（与逐一点 × 同口径：先 flush 再清空） */
async function closeAllTabs() {
  if (!suspendDraw()) return;
  if (!state.tabs.length) return;
  await editor.flush();
  state.tabs = [];
  state.activeTab = -1;
  state.currentPath = null;
  localStorage.removeItem('tracery.lastNote');
  editor.load('', '');
  $('note-path').textContent = '';
  refreshRightPanels(null);
  renderTree();
  renderTabs();
  saveTabsState();
  toast('已关闭全部标签页');
}

/** 把当前打开的所有标签页都加进「星标」（文件树顶部星标区），已加过的跳过 */
function pinAllTabs() {
  if (!state.tabs.length) { toast('当前没有打开的标签页'); return; }
  let added = 0;
  for (const p of state.tabs) {
    if (isBlankTab(p)) continue;
    if (!state.pinned.has(p)) { state.pinned.add(p); added += 1; }
  }
  saveShortcuts();
  renderTree();
  toast(added ? `已收藏 ${added} 个标签页` : '这些标签页都已经收藏过了');
}

/** 按可用宽度压缩标签，保留末尾加号和独立拖窗区。 */
function layoutTabs() {
  const list = $('tablist');
  if (!list) return;
  list.removeAttribute('data-overflow');
  const count = list.querySelectorAll('.tab:not([hidden])').length;
  const groups = state.tabGroups.reduce((sum, group) => sum + Math.min(120, 24 + group.name.length * 13), 0);
  const desired = 35 + count * 168 + groups + Math.max(0, count + state.tabGroups.length - 1) * 4;
  $('tab-strip').style.flexBasis = `${desired}px`;
  const average = list.clientWidth / Math.max(1, count + state.tabGroups.length);
  const groupCap = Math.min(120, Math.max(4, list.clientWidth / (state.tabGroups.length + 1) * .65));
  for (const header of list.querySelectorAll('.tab-group-header')) header.style.maxWidth = `${groupCap}px`;
  list.classList.toggle('is-compact', average < 86);
  list.classList.toggle('is-micro', average < 28);
  list.style.gap = `${Math.min(4, average / 8)}px`;
}

function groupColor(group) { return GROUP_COLORS.find(([key]) => key === group.color)?.[2] || GROUP_COLORS[0][2]; }

function bindGroupDrag(header, group) {
  let gesture = null;
  header.onpointerdown = event => {
    if (event.button !== 0) return;
    gesture = { x: event.clientX, y: event.clientY, moved: false };
    header.setPointerCapture(event.pointerId);
  };
  header.onpointermove = event => {
    if (!gesture) return;
    if (!gesture.moved && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 5) return;
    gesture.moved = true; header.classList.add('dragging');
    moveTabDragPreview(event, group.name);
    clearTabDropMarks();
    const over = document.elementFromPoint(event.clientX, event.clientY)?.closest('.tab, .tab-group-header');
    if (over && over.dataset.group !== group.id) over.classList.add('drop-target');
  };
  const end = (event, commit) => {
    if (!gesture) return;
    const moved = gesture.moved; gesture = null; clearTabDragPreview(); clearTabDropMarks(); header.classList.remove('dragging');
    if (!moved) return;
    suppressTabClick = true; setTimeout(() => { suppressTabClick = false; }, 0);
    if (!commit) return;
    const over = document.elementFromPoint(event.clientX, event.clientY)?.closest('.tab, .tab-group-header');
    if (!over || over.dataset.group === group.id) return;
    const active = state.tabs[state.activeTab], box = over.getBoundingClientRect(), after = event.clientX > box.left + box.width / 2;
    const targetGroup = state.tabGroups.find(item => item.id === over.dataset.group);
    const targetKey = targetGroup ? (after ? targetGroup.tabs.at(-1) : targetGroup.tabs[0]) : state.tabs[Number(over.dataset.index)];
    state.tabs = state.tabs.filter(key => !group.tabs.includes(key));
    state.tabs.splice(state.tabs.indexOf(targetKey) + (after ? 1 : 0), 0, ...group.tabs);
    state.activeTab = state.tabs.indexOf(active); renderTabs(); saveTabsState();
  };
  header.onpointerup = event => end(event, true);
  header.onpointercancel = header.onlostpointercapture = event => end(event, false);
}

function makeGroupHeader(group) {
  const header = document.createElement('button');
  header.className = 'tab-group-header';
  header.dataset.group = group.id;
  header.style.setProperty('--group-color', groupColor(group));
  header.setAttribute('aria-expanded', String(!group.collapsed));
  header.title = `${group.name} · ${group.tabs.length} 个标签（点击${group.collapsed ? '展开' : '折叠'}，右键编辑）`;
  header.classList.toggle('is-current', group.collapsed && group.tabs.includes(state.tabs[state.activeTab]));
  const label = document.createElement('span'); label.className = 'tab-group-label'; label.textContent = group.name;
  const count = document.createElement('span'); count.className = 'tab-group-count'; count.textContent = group.tabs.length;
  header.append(label, count);
  header.onclick = () => { if (suppressTabClick) return; group.collapsed = !group.collapsed; renderTabs(); saveTabsState(); };
  header.oncontextmenu = e => { e.preventDefault(); showGroupEditor(group, e.clientX, e.clientY); };
  bindGroupDrag(header, group);
  return header;
}

function showTabContextMenu(event, key) {
  const group = groupForTab(state, key);
  const refresh = () => { renderTabs(); saveTabsState(); };
  const items = [{ label: '添加到新分组', icon: ICON.folder, action: () => {
    const created = { id: crypto.randomUUID(), name: '新分组', color: GROUP_COLORS[state.tabGroups.length % GROUP_COLORS.length][0], collapsed: false, tabs: [] };
    state.tabGroups.push(created); moveTabToGroup(state, key, created.id); refresh();
    showGroupEditor(created, event.clientX, event.clientY);
  } }];
  for (const target of state.tabGroups) {
    if (target === group) continue;
    items.push({ label: `移入「${escapeText(target.name)}」`, icon: ICON.folder, action: () => { moveTabToGroup(state, key, target.id); refresh(); } });
  }
  if (group) items.push({ label: '移出分组', icon: ICON.doc, action: () => {
    // 移到组后方，避免同组连续化再次把标签包在组里。
    const active = state.tabs[state.activeTab], last = group.tabs.at(-1);
    if (last !== key) { state.tabs.splice(state.tabs.indexOf(key), 1); state.tabs.splice(state.tabs.indexOf(last) + 1, 0, key); }
    state.activeTab = state.tabs.indexOf(active);
    moveTabToGroup(state, key, null); refresh();
  } });
  items.push('-', { label: '关闭标签页', icon: ICON.close, action: () => closeTab(state.tabs.indexOf(key)) });
  showMenu(event.clientX, event.clientY, items);
}

function showGroupEditor(group, x, y) {
  closeCtxMenu();
  const menu = document.createElement('div'); menu.className = 'context-menu tab-group-editor';
  ctxMenu = menu;
  menu.onclick = e => e.stopPropagation();
  const label = document.createElement('label'); label.textContent = '分组名称';
  const input = document.createElement('input'); input.value = group.name; input.maxLength = 40; input.setAttribute('aria-label', '分组名称');
  input.oninput = () => { group.name = input.value.trim() || '未命名分组'; renderTabs(); saveTabsState(); };
  input.onkeydown = e => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); closeCtxMenu(); } };
  label.append(input); menu.append(label);
  const colors = document.createElement('div'); colors.className = 'tab-group-colors'; colors.setAttribute('role', 'radiogroup'); colors.setAttribute('aria-label', '分组颜色');
  for (const [key, name, value] of GROUP_COLORS) {
    const color = document.createElement('button'); color.className = 'tab-group-color'; color.title = name; color.setAttribute('aria-label', name); color.setAttribute('role', 'radio'); color.setAttribute('aria-checked', String(group.color === key)); color.dataset.color = key;
    color.style.setProperty('--group-color', value);
    color.onclick = () => { group.color = key; for (const swatch of colors.children) swatch.setAttribute('aria-checked', String(swatch === color)); renderTabs(); saveTabsState(); };
    colors.append(color);
  }
  menu.append(colors);
  const action = (text, callback) => { const button = document.createElement('button'); button.textContent = text; button.onclick = () => { closeCtxMenu(); callback(); }; menu.append(button); };
  action('在分组中新建标签页', async () => { await openBlankTab(); const key = state.tabs[state.activeTab]; if (isBlankTab(key)) { moveTabToGroup(state, key, group.id); renderTabs(); saveTabsState(); } });
  action('取消分组', () => { state.tabGroups = state.tabGroups.filter(item => item !== group); renderTabs(); saveTabsState(); });
  action('关闭分组', () => closeTabGroup(group));
  document.body.append(menu);
  const box = menu.getBoundingClientRect(); menu.style.left = `${Math.max(8, Math.min(x, innerWidth - box.width - 8))}px`; menu.style.top = `${Math.max(8, Math.min(y, innerHeight - box.height - 8))}px`;
  requestAnimationFrame(() => { input.focus(); input.select(); });
}

async function closeTabGroup(group) {
  if (!suspendDraw() || !await editor.flush()) return;
  const active = state.tabs[state.activeTab], index = state.activeTab;
  state.tabs = state.tabs.filter(key => !group.tabs.includes(key));
  state.activeTab = state.tabs.includes(active) ? state.tabs.indexOf(active) : Math.min(index, state.tabs.length - 1);
  if (state.activeTab >= 0) await loadTab(state.tabs[state.activeTab]);
  else { state.currentPath = null; localStorage.removeItem('tracery.lastNote'); editor.load('', ''); refreshRightPanels(null); renderTree(); renderTabs(); saveTabsState(); }
}

/** 把某篇笔记加载进当前标签（不改变标签列表） */
async function loadTab(path, heading) {
  if (isBlankTab(path)) {
    state.currentPath = null;
    editor.load('', '');
    $('note-path').textContent = '';
    refreshRightPanels(null);
    renderTree(); renderTabs(); saveTabsState();
    return;
  }
  try {
    const { content, ...metadata } = await Api.note(path);
    const recovered = await recoverDraft(state.vault?.root, path, content);
    state.currentPath = path;
    $('note-path').textContent = path;
    // 阅读模式要跨笔记保持：在阅读视图里点双链跳到别的笔记，仍应停在阅读模式
    // （live / source 保持老行为：换笔记回到实时预览）
    editor.load(path, content, { keepMode: editor.isRead });
    if (recovered !== null) editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: recovered } });
    renderTree(); // 高亮
    pushRecent(path);
    refreshRightPanels(editor.getContent());
    sidebars.setMetadata(path, metadata);
    if (graphView) graphView.opts.activePath = path;
    if (heading) setTimeout(() => editor.scrollToHeading(heading), 60);
    renderTabs();
    saveTabsState();
  } catch (e) {
    toast(e.message);
    await closeTab(state.activeTab);
  }
}

async function activateTab(i, heading) {
  if (!suspendDraw()) return;
  if (i < 0 || i >= state.tabs.length) return;
  if (isCompact()) closeMobilePanels();
  if (document.body.classList.contains('graph-focus')) toggleGraphFocus(false);
  const path = state.tabs[i];
  const group = groupForTab(state, path);
  if (group) group.collapsed = false;
  if (state.activeTab === i && state.currentPath === path) {
    if (heading) editor.scrollToHeading(heading);
    renderTabs(); saveTabsState();
    return;
  }
  await editor.flush();
  state.activeTab = i;
  await loadTab(path, heading);
}

async function closeTab(i) {
  if (!suspendDraw()) return;
  if (i < 0 || i >= state.tabs.length) return;
  const prevPath = state.currentPath;
  const wasActive = i === state.activeTab;
  if (wasActive) await editor.flush();
  state.tabs.splice(i, 1);

  if (!state.tabs.length) {
    state.activeTab = -1;
    state.currentPath = null;
    localStorage.removeItem('tracery.lastNote');
    editor.load('', '');
    $('note-path').textContent = '';
    refreshRightPanels(null);
    renderTree();
    renderTabs();
    saveTabsState();
    return;
  }
  if (i < state.activeTab) state.activeTab -= 1;
  else if (wasActive) state.activeTab = Math.min(i, state.tabs.length - 1);

  renderTabs();
  if (state.activeTab >= 0 && state.tabs[state.activeTab] !== prevPath) await loadTab(state.tabs[state.activeTab]);
  else saveTabsState();
}

/** 外部删除/同步后清理失效标签 */
function pruneTabs() {
  const before = state.tabs.length;
  const prevPath = state.tabs[state.activeTab];
  state.tabs = state.tabs.filter((p) => isBlankTab(p) || hasNotePath(p));
  if (state.tabs.length === before) return;
  if (!state.tabs.length) {
    state.activeTab = -1;
    state.currentPath = null;
    editor.load('', '');
    $('note-path').textContent = '';
    localStorage.removeItem('tracery.lastNote');
    refreshRightPanels(null);
    renderTabs();
    saveTabsState();
    return;
  }
  if (!state.tabs.includes(prevPath)) {
    if (!prevPath) { state.activeTab = -1; renderTabs(); saveTabsState(); return; }
    state.activeTab = Math.min(state.activeTab, state.tabs.length - 1);
    loadTab(state.tabs[state.activeTab]);
  } else {
    state.activeTab = state.tabs.indexOf(prevPath);
  }
  renderTabs();
  saveTabsState();
}

/* ================= 打开笔记 ================= */

/** 双链取词口径：`[[目标|别名]]` / `[[目标#标题]]` / `[[目标.md]]` 都要还原成「目标」。
 *  统一放一处——「解析能不能命中」和「点未解析链接该创建哪篇」两处口径必须一致，
 *  否则带别名的链接（[[目标|别名]]）会解析不到、点了还会去建一篇叫「目标|别名」的笔记。 */
function wikilinkTarget(raw) {
  return String(raw || '').split('|')[0].split('#')[0].trim().replace(/\.md$/i, '');
}

/** 点「还不存在的笔记」的双链 → 问一句就当场创建并打开。
 *  为什么要有：demo-vault/双链与反链.md 把这条写成入口功能（「链接先行」工作流：先织网再填内容），
 *  反链面板的「未创建的链接」本来就是这套动作——两处共用这里，提示语和行为不会走偏。 */
async function createMissingNote(raw, newTab = false) {
  const name = wikilinkTarget(raw);
  if (!name) return;
  const ok = await askConfirm({
    title: `创建「${name}」？`,
    desc: '这篇笔记还不存在，现在创建它。',
    okText: '创建',
  });
  if (!ok) return;
  const path = missingNotePath(raw, state.currentPath || '');
  if (!path) { toast('链接路径超出笔记库，请检查路径'); return; }
  try {
    await Api.createNote(path, '');
    await refreshTree(); refreshGraph(); refreshTags();
    openNote(path, null, { newTab });
  } catch (e) { toast(e.message); }
}

/**
 * 打开（已在标签里就切过去）笔记
 * @param {string} path
 * @param {string} [heading]
 * @param {{newTab?: boolean}} [opts] 默认在当前标签打开；newTab=true 时新开一个
 */
async function openNote(path, heading, opts = {}) {
  if (!suspendDraw()) return;
  if (!path) return;
  if (isCompact()) closeMobilePanels();
  const existing = state.tabs.indexOf(path);
  if (existing >= 0) { await activateTab(existing, heading); return; }
  if (state.currentPath === path) {
    if (heading) editor.scrollToHeading(heading);
    return;
  }
  await editor.flush();
  const newTab = (opts.newTab === true && !isBlankTab(state.tabs[state.activeTab])) || state.activeTab < 0 || state.tabs.length === 0;
  if (newTab) {
    const at = state.activeTab < 0 ? 0 : state.activeTab + 1;
    state.tabs.splice(at, 0, path);
    state.activeTab = at;
  } else {
    const previous = state.tabs[state.activeTab];
    for (const group of state.tabGroups) group.tabs = group.tabs.map(key => key === previous ? path : key);
    state.tabs[state.activeTab] = path;
  }
  await loadTab(path, heading);
}

function refreshRightPanels(content) {
  updateEmptyNote();
  if (!state.currentPath) {
    editor?.load('', '');
    $('note-path').textContent = '';
  }
  sidebars?.refresh(state.currentPath ? content : null);
}

function refreshBacklinks() { sidebars?.refreshLinks(); }

function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/* ================= 面板切换 ================= */
let graphReturnPanel = 'files';
let graphFitTimers = [];
function switchPanel(name, { mobileOpen = true } = {}) {
  if (!suspendDraw()) return;
  if (isCompact()) {
    if (name === 'graph') closeMobilePanels();
    else if (mobileOpen && !document.body.classList.contains('mobile-left-open')) toggleMobilePanel('left');
  }
  const wasGraph = document.body.classList.contains('graph-focus');
  if (name === 'graph' && !wasGraph) {
    graphReturnPanel = document.querySelector('.ribbon-btn[data-panel].active')?.dataset.panel || 'files';
  }
  document.body.classList.toggle('graph-focus', name === 'graph');
  if (name !== 'graph') graphView?.pause();
  for (const timer of graphFitTimers) clearTimeout(timer);
  graphFitTimers = [];
  for (const btn of document.querySelectorAll('.ribbon-btn[data-panel]')) {
    btn.classList.toggle('active', btn.dataset.panel === name);
  }
  // 只切左栏的面板！用 .sidebar .panel 会连右侧栏（大纲/反链/标签）一起命中，
  // 切到「文件」时它们因为 id 不匹配被摘掉 active —— 表现就是右侧大纲消失。
  for (const panel of document.querySelectorAll('#sidebar .panel')) {
    panel.classList.toggle('active', panel.id === `panel-${name}`);
  }
  if (name === 'graph') {
    // 入口统一进入大画布；保留侧栏原有折叠状态，退出时直接还原。
    if (!graphView) initGraph();
    refreshGraph();
    if (state.graph) {
      graphView.opts.activePath = state.currentPath;
      graphView.setData(state.graph);
    }
    graphFitTimers = [
      setTimeout(() => graphView?.fit({ auto: true }), 240),
      setTimeout(() => graphView?.fit({ auto: true }), 900),
    ];
  }
  if (name === 'search') {
    setTimeout(() => $('search-input').focus(), 30);
    if (!$('search-input').value.trim()) renderRecentList($('search-results'));
  }
  if (name === 'tags') refreshTags();
}

/** 命令入口切换当前笔记上下文。 */
function switchRightPanel(name) {
  sidebars?.reveal(name);
}

/** 退出后回到打开图谱前的面板，不再退成左侧栏中的小图谱。 */
function toggleGraphFocus(force) {
  const on = typeof force === 'boolean' ? force : !document.body.classList.contains('graph-focus');
  switchPanel(on ? 'graph' : graphReturnPanel, { mobileOpen: false });
}

/* ================= 搜索 ================= */
/** 搜索面板空查询时的「最近打开」 */
function renderRecentList(box) {
  box.innerHTML = '';
  const list = (state.recent || []).filter(p => state.files.has(p));
  if (!list.length) {
    box.innerHTML = '<div class="search-empty">输入关键词搜索全文<br>打开过的笔记会出现在这里</div>';
    return;
  }
  const head = document.createElement('div');
  head.className = 'search-section';
  head.textContent = '最近打开';
  box.appendChild(head);
  for (const p of list) {
    const item = document.createElement('div');
    item.className = 'search-result';
    const n = document.createElement('div');
    n.className = 'sr-name';
    n.textContent = p.split('/').pop().replace(/\.md$/i, '');
    const path = document.createElement('div');
    path.className = 'sr-line';
    path.textContent = p;
    item.append(n, path);
    item.onclick = () => openNote(p, null, { newTab: false });
    box.appendChild(item);
  }
}

const runSearch = debounce(async (q) => {
  const box = $('search-results');
  const repRow = $('search-replace');
  if (repRow) repRow.hidden = !q.trim();
  if (!q.trim()) { renderRecentList(box); return; }
  let results = [];
  try { results = (await Api.search(q)).results; } catch { /* ignore */ }
  box.innerHTML = '';
  if (!results.length) {
    box.innerHTML = '<div class="search-empty">没有匹配的笔记</div>';
    return;
  }
  const needle = q.toLowerCase();
  for (const r of results) {
    const item = document.createElement('div');
    item.className = 'search-result';
    const n = document.createElement('div');
    n.className = 'sr-name';
    n.textContent = r.name;
    const lines = r.matches.map((m) => {
      const div = document.createElement('div');
      div.className = 'sr-line';
      const idx = m.text.toLowerCase().indexOf(needle);
      if (idx >= 0) {
        div.innerHTML = `${escapeText(m.text.slice(0, idx))}<mark>${escapeText(m.text.slice(idx, idx + needle.length))}</mark>${escapeText(m.text.slice(idx + needle.length))}`;
      } else {
        div.textContent = m.text;
      }
      return div;
    });
    item.append(n, ...lines);
    item.onclick = () => openNote(r.path, null, { newTab: true });
    box.appendChild(item);
  }
}, 200);

/* ================= 命令面板 ================= */
const paletteItems = [];
let paletteIndex = 0;

function openPalette() {
  if (isCompact()) closeMobilePanels();
  $('palette').hidden = false;
  $('palette-input').value = '';
  renderPalette('');
  setTimeout(() => $('palette-input').focus(), 30);
}
function closePalette() { $('palette').hidden = true; }

function renderPalette(q) {
  const list = $('palette-list');
  list.innerHTML = '';
  paletteItems.length = 0;
  paletteIndex = 0;

  const commands = [
    { icon: '📄', name: '新建笔记', sub: '命令', action: () => createNoteIn('') },
    { icon: '🌗', name: '切换亮色 / 暗色主题', sub: '外观', action: toggleTheme },
    { icon: '⚙️', name: '打开设置', sub: '设置', action: () => openSettings() },
    { icon: '↶', name: commandLabel('undo'), sub: '命令', action: () => editor.undo() },
    { icon: '↷', name: commandLabel('redo'), sub: '命令', action: () => editor.redo() },
    { icon: '🎨', name: '切换主题皮肤（Apple 风 / Obsidian 风）', sub: '外观', action: cycleThemeSkin },
    { icon: '👁', name: '切换编辑模式（实时预览 / 源码 / 阅读）', sub: '命令', action: () => editor.toggleMode() },
    { icon: '🕸️', name: '打开图谱视图', sub: '命令', action: () => switchPanel('graph') },
    { icon: '🔍', name: '搜索笔记内容', sub: '命令', action: () => { switchPanel('search'); $('search-input').focus(); } },
    { icon: '📤', name: '导出为 HTML', sub: '命令', action: () => exportHtml() },
    { icon: '📄', name: '导出为 PDF', sub: '命令', action: () => exportPdf() },
    { icon: '🕘', name: '查看历史版本', sub: '命令', action: () => openHistory() },
    { icon: '🏷️', name: '查看所有标签', sub: '命令', action: () => switchPanel('tags') },
    { icon: '📂', name: '切换 / 管理仓库…', sub: '命令', action: openVaultPicker },
    { icon: '✏️', name: '新建绘图并插入笔记', sub: '命令', action: openDrawPanel },
    { icon: '☰', name: '折叠 / 展开左侧栏', sub: '命令', action: () => toggleSidebar('left') },
    { icon: '▤', name: '折叠 / 展开右侧栏', sub: '命令', action: () => toggleSidebar('right') },
  ];
  for (const c of commands) {
    if (!q || fuzzyMatch(q, c.name) >= 0) paletteItems.push(c);
  }
  // 笔记快速跳转（Obsidian Ctrl+P 核心行为）
  const notes = [];
  const walk = (node, prefix) => {
    for (const f of node.files || []) {
      if (/\.md$/i.test(f.name)) notes.push({ path: f.path, name: f.name.replace(/\.md$/i, ''), dir: prefix });
    }
    for (const d of node.dirs || []) walk(d, prefix ? `${prefix}/${d.name}` : d.name);
  };
  if (state.tree) walk(state.tree, '');
  for (const n of notes) {
    const score = q ? fuzzyMatch(q, n.name) : 0;
    if (q && score < 0) continue;
    paletteItems.push({
      icon: '📄', name: n.name, sub: n.dir || '仓库根目录',
      score,
      action: () => openNote(n.path),
    });
  }
  if (q) paletteItems.sort((a, b) => (b.score || 0) - (a.score || 0));

  for (const item of paletteItems.slice(0, 60)) {
    const li = document.createElement('li');
    const icon = document.createElement('span');
    icon.className = 'pi-icon';
    icon.textContent = item.icon;
    const name = document.createElement('span');
    name.className = 'pi-name';
    name.textContent = item.name;
    const sub = document.createElement('span');
    sub.className = 'pi-sub';
    sub.textContent = item.sub;
    li.append(icon, name, sub);
    li.onclick = () => { closePalette(); item.action?.(); };
    list.appendChild(li);
  }
  highlightPalette(0);
}

function highlightPalette(i) {
  const items = $('palette-list').children;
  if (!items.length) return;
  paletteIndex = (i + items.length) % items.length;
  for (let k = 0; k < items.length; k++) items[k].classList.toggle('selected', k === paletteIndex);
  items[paletteIndex].scrollIntoView({ block: 'nearest' });
}

/* ================= 编辑器装配 =================
 * 内核：CodeMirror 6（行级真实文本 + 装饰）。 */
editor = new CmEditor({
  liveEl: $('editor-live'),
  resolveLink: (target, from) => {
    return state.noteIndex ? resolveNote(target, from ?? editor?.path ?? state.currentPath ?? '', state.noteIndex) : null;
  },
  // 点未解析的双链 → 问一句就当场创建并打开（见 createMissingNote）
  onCreateWikilink: (raw) => createMissingNote(raw),
  resolveFile: (name, from) => from ? resolveEmbeddedFile(name, from) : resolveVaultFile(name),
  fileUrl: (path) => Api.fileUrl(path),
  loadNote: loadEmbeddedNote,
  completeWiki,
  openEmbedLink: openEmbeddedLink,
  openEmbedNote: (raw, result) => result?.path ? openNote(result.path, wikiParts(raw).heading, { newTab: true }) : openEmbeddedLink(raw),
  // 附件落盘（与 editor.js 的 _saveAssetFile 同口径；CM 内核把 File 递出来，这里存好后回插）
  saveAsset: async (file) => {
    if (file.size > 30 * 1024 * 1024) { toast('文件超过 30MB，无法作为附件存入'); return { ok: false }; }
    let dataUrl;
    try {
      dataUrl = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.onerror = () => rej(new Error('读取文件失败'));
        r.readAsDataURL(file);
      });
    } catch (e) { toast(e.message); return { ok: false }; }
    // 截图/复制的图默认叫 image.png，一堆 image-2.png 很难认，换成带时间戳的名字
    let name = file.name || '';
    if (!name || /^image\.(png|jpe?g|gif|webp)$/i.test(name)) {
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
      name = `粘贴的图片 ${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${ext}`;
    }
    try {
      const res = await Api.saveAsset({ data: dataUrl, name, dir: resolveAssetDir(getSettings(), editor.path) });
      if (!res?.ok) toast(res?.error || '附件保存失败');
      return res || { ok: false };
    } catch (e) { toast(`附件保存失败：${e.message}`); return { ok: false }; }
  },
  onImageClick: (src, alt) => openLightbox(src, alt),
  onAssetSaved: () => { refreshTree(); },   // 粘贴/拖入的附件立即出现在文件树
  confirmCreate: (name) => askConfirm({
    title: `创建「${name}」？`,
    desc: '这个链接指向的笔记还不存在，现在创建它。',
    okText: '创建',
  }),
  onNavigate: (path, heading) => openNote(path, heading),
  onCreateNote: (name) => {
    const path = name.replace(/\.md$/i, '') + '.md';
    Api.createNote(path, '').then(async () => {
      await refreshTree(); refreshGraph(); refreshTags();
      openNote(path, null, { newTab: true });
    }).catch((e) => toast(e.message));
  },
  onTagClick: (tag) => { switchPanel('search'); $('search-input').value = `#${tag}`; runSearch(`#${tag}`); },
  onSave: async (path, content) => {
    const root = state.vault?.root;
    try {
      const metadata = await Api.saveNote(path, content);
      if (root === state.vault?.root) sidebars?.setMetadata(path, metadata);
      clearSavedDraft(root, path, content);
      refreshGraph(); refreshTags();
      refreshBacklinks();
      return true;
    } catch (e) { toast(`保存失败，内容已保留在此设备：${e.message}`); return false; }
  },
  onDirtyChange: (dirty) => {
    $('status-saved').textContent = dirty ? '未保存…' : `已保存 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
  },
  onChange: (content) => {
    if (editor?.dirty) rememberDraft(state.vault?.root, editor.path, content);
    const words = countWords(content);
    $('status-words').textContent = `${words} 词`;
    refreshRightPanelsThrottled(content);
  },
  onSelectionChange: line => sidebars?.highlight(line),
  onModeChange: (mode) => {
    const label = $('btn-mode-label');
    if (label) label.textContent = mode === 'live' ? '实时预览' : mode === 'source' ? '源码' : '阅读';
    $('btn-mode').classList.toggle('is-source', mode === 'source');
    $('btn-mode').classList.toggle('is-read', mode === 'read');
    // 阅读模式：藏光标 / 图片拖宽手柄（见 style.css 的 #editor-live.is-read 规则）
    $('editor-live').classList.toggle('is-read', mode === 'read');
  },
});

// DOM 收尾：#editor-live 是 CM 挂载点（CM 自带 contenteditable，外层容器不能再可编辑）
$('editor-live').contentEditable = 'false';
// 测试/调试钩子：拿到当前编辑内核实例（test/engine-test.mjs 用 getContent/view 做断言）
window.__editor = editor;

$('editor-live').addEventListener('contextmenu', onEditorContextMenu);

const refreshRightPanelsThrottled = debounce(() => refreshRightPanels(editor.getContent()), 200);

function countWords(text) {
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff]/g) || []).length;
  const en = (text.replace(/[\u4e00-\u9fff\u3040-\u30ff]/g, ' ').match(/[A-Za-z0-9_'-]+/g) || []).length;
  return cjk + en;
}

/* ================= 图谱 ================= */
let graphView = null;
function initGraph() {
  graphView = new ForceGraph($('graph-canvas'), {
    activePath: state.currentPath,
    onInteraction: () => { for (const timer of graphFitTimers) clearTimeout(timer); graphFitTimers = []; },
    onNodeClick: (path) => {
      toggleGraphFocus(false);
      openNote(path);
    },
  });
  if (state.graph) graphView.setData(state.graph);
}

/** 打开绘图面板：画完的 PNG 会插入到当前笔记光标处 */
function drawingOptions() {
  return {
    vaultRoot: state.vault?.root || '',
    getNotePath: () => state.currentPath,
    onInserted: async (path) => {
      await refreshTree();
      await refreshGraph();
      editor.insertSnippet(`![[${path}|640]]`);
      await editor.flush();
    },
    onUpdated: async (path) => {
      await refreshTree();
      reloadImagesFor(path);
      editor.refreshDecorations?.();
    },
  };
}

async function openDrawPanel() {
  if (isDrawOpen()) return;
  if (!state.currentPath) { toast('先打开一篇笔记，绘图会插入到光标处'); return; }
  // 阅读模式是只读的，插不进去：先切回实时预览，避免「画完点了插入却什么也没发生」
  if (editor.isRead) editor.setMode('live');
  await editor.flush();
  if (isCompact()) closeMobilePanels();
  openDraw(drawingOptions());
}

/** 覆盖写之后，正文里指向这张图的 <img> 必须重新取一次（src 没变，浏览器会拿旧图） */
function reloadImagesFor(rel) {
  const leaf = decodeURIComponent(String(rel || '')).split('/').pop();
  if (!leaf) return;
  document.querySelectorAll('#editor-live img').forEach((img) => {
    const src = img.getAttribute('src') || '';
    if (!src || !decodeURIComponent(src).includes(leaf)) return;
    try {
      const u = new URL(src, location.origin);
      u.searchParams.set('v', String(Date.now()));
      img.src = u.toString();
    } catch { /* 相对地址异常就跳过 */ }
  });
}

/** 右键图片 → 编辑绘图：读同名 .draw.json 的场景，回填进白板；保存时覆盖原 PNG */
async function editDrawing(rel) {
  const norm = String(rel || '').replace(/\\/g, '/');
  if (!norm) return;
  const jsonRel = norm.replace(/\.(png|jpe?g|webp|gif)$/i, '.draw.json');
  let scene = null;
  try {
    const res = await fetch(Api.fileUrl(jsonRel), { cache: 'no-store' });
    if (res.ok) scene = JSON.parse(await res.text());
  } catch { /* 没 JSON / JSON 坏了，都按「不可编辑」处理 */ }
  if (!Array.isArray(scene?.elements) || !scene.elements.length) {
    toast('这张图没有可编辑的绘图数据（旧版本保存的图片只能重新画）');
    return;
  }
  openDraw({
    ...drawingOptions(),
    elements: scene.elements,
    boardBackground: scene.appState?.boardBackground,
    editingPath: norm,
  });
}

/* ================= 可拖拽栏宽（Obsidian 式） ================= */
function initResizers() {
  const left = $('sidebar');
  const right = $('sidebar-right');
  const MIN = 190;
  const MAX = 640;

  const apply = (el, key) => {
    if (!el) return;
    const v = Number(lsGet(key));
    if (v >= MIN && v <= MAX) el.style.width = `${v}px`;
  };
  apply(left, 'tracery.ui.sidebarW');
  apply(right, 'tracery.ui.rightW');

  const bind = (handle, panel, key, def) => {
    if (!handle || !panel) return;
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = panel.getBoundingClientRect().width;
      const sign = panel === right ? -1 : 1;
      handle.classList.add('dragging');
      document.body.classList.add('resizing');
      const move = (ev) => {
        const w = Math.min(MAX, Math.max(MIN, startW + (ev.clientX - startX) * sign));
        panel.style.width = `${Math.round(w)}px`;
      };
      const up = () => {
        handle.classList.remove('dragging');
        document.body.classList.remove('resizing');
        localStorage.setItem(key, String(Math.round(panel.getBoundingClientRect().width)));
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    handle.addEventListener('dblclick', () => {
      panel.style.width = `${def}px`;
      localStorage.removeItem(key);
    });
  };
  bind($('resizer-left'), left, 'tracery.ui.sidebarW', 272);
  bind($('resizer-right'), right, 'tracery.ui.rightW', 296);
}

/* 快捷键的动作与标题使用同一份配置；不接管输入框、弹窗或画板自己的编辑按键。 */
const hotkeyActions = {
  palette: openPalette, settings: openSettings,
  search: () => { switchPanel('search'); $('search-input').focus(); },
  newNote: () => createNoteIn(''), draw: openDrawPanel, mode: () => editor.toggleMode(),
  save: () => editor.flush(), theme: toggleTheme, graph: () => switchPanel('graph'), tags: () => switchPanel('tags'),
  history: openHistory, vault: openVaultPicker, phone: () => $('btn-phone-access').click(), exportHtml, exportPdf,
  closeTab: () => closeTab(state.activeTab),
  nextTab: () => { if (state.tabs.length > 1) activateTab((state.activeTab + 1) % state.tabs.length); },
  previousTab: () => { if (state.tabs.length > 1) activateTab((state.activeTab - 1 + state.tabs.length) % state.tabs.length); },
  leftSidebar: () => toggleSidebar('left'), rightSidebar: () => toggleSidebar('right'),
  undo: () => editor.undo(), redo: () => editor.redo(), redoAlt: () => editor.redo(),
  bold: () => toggleBold(editor.view), italic: () => toggleItalic(editor.view), strike: () => toggleStrike(editor.view), wikilink: () => insertWikilink(editor.view),
};
function commandLabel(id) {
  const command = HOTKEY_COMMANDS.find(c => c.id === id), key = commandKeyLabel(id);
  return command.label + (key ? ` (${key})` : '');
}
function commandKeyLabel(id) {
  const command = HOTKEY_COMMANDS.find(c => c.id === id), key = bindingFor(command, getSettings().hotkeys);
  return key ? shortcutLabel(key, /Mac/.test(navigator.platform)) : '';
}
function refreshShortcutHints() {
  for (const hint of document.querySelectorAll('[data-empty-shortcut]')) {
    hint.textContent = commandKeyLabel(hint.dataset.emptyShortcut);
    hint.hidden = !hint.textContent;
  }
  for (const [element, command] of Object.entries({ 'btn-settings': 'settings', 'btn-new-note-2': 'newNote', 'btn-draw': 'draw', 'btn-toggle-left': 'leftSidebar', 'btn-toggle-right': 'rightSidebar' })) $(element).title = commandLabel(command);
  document.querySelector('.ribbon-btn[data-panel="search"]').title = commandLabel('search');
  for (const close of document.querySelectorAll('#tablist .tab-close')) close.title = commandLabel('closeTab');
}

/* ================= 主题（由设置模块统一管理） ================= */
async function toggleTheme() {
  const current = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  updateSettings({ themeMode: next });
}

/** 在 apple / obsidian 两套皮肤间切换 */
async function cycleThemeSkin() {
  const order = ['apple', 'obsidian'];
  const idx = order.indexOf(getSettings().themeName);
  const next = order[(idx + 1) % order.length];
  updateSettings({ themeName: next });
  toast(`主题皮肤：${next === 'apple' ? 'Apple 风' : 'Obsidian 风'}`);
}

/* ================= 全局事件 ================= */
function bindGlobalEvents() {
  // Electron 窗口控制按钮
  if (window.electronAPI?.isElectron) {
    document.body.classList.add('electron');
    $('win-min').onclick = () => window.electronAPI.minimize();
    $('win-max').onclick = () => window.electronAPI.maximize();
    $('win-close').onclick = () => window.electronAPI.close();
  }

  // 欢迎页 / 仓库管理
  $('btn-open-vault').onclick = () => {
    const p = $('vault-path').value.trim();
    if (!p) { $('vault-error').textContent = '请输入仓库文件夹路径'; $('vault-error').hidden = false; return; }
    $('vault-error').hidden = true;
    openVault(p);
  };
  $('vault-path').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-open-vault').click(); });
  $('btn-browse-vault').onclick = () => browseVault();
  $('btn-welcome-close').onclick = () => closeWelcome();
  $('welcome').addEventListener('click', (e) => {
    // 点遮罩空白处退出（有仓库时）
    if (e.target === $('welcome')) closeWelcome();
  });

  // 标题栏
  $('btn-theme').onclick = toggleTheme;
  $('btn-toggle-left').onclick = () => toggleSidebar('left');
  $('btn-toggle-right').onclick = () => toggleSidebar('right');
  // 标签条最右侧的下拉：标签页列表 / 关闭全部 / 收藏全部
  $('btn-tab-more').onclick = (e) => {
    e.stopPropagation();
    if (e.currentTarget.getAttribute('aria-expanded') === 'true') { closeCtxMenu(); return; }
    showTabMenu(e.currentTarget);
    e.currentTarget.setAttribute('aria-expanded', 'true');
  };
  // 折叠状态要看得出来：右栏被折叠时（大纲「消失」了）按钮必须亮起提示，
  // 否则用户会以为面板出 bug 了
  const syncSidebarToggles = () => {
    $('btn-toggle-left').classList.toggle('is-off', $('sidebar').classList.contains('collapsed'));
    $('btn-toggle-right').classList.toggle('is-off', $('sidebar-right').classList.contains('collapsed'));
  };
  new MutationObserver(syncSidebarToggles).observe($('sidebar'), { attributes: true, attributeFilter: ['class'] });
  new MutationObserver(syncSidebarToggles).observe($('sidebar-right'), { attributes: true, attributeFilter: ['class'] });
  syncSidebarToggles();
  $('vault-name').onclick = async (e) => {
    e.stopPropagation();
    const anchor = e.currentTarget;
    // 第二下点击也能取消尚未完成的请求，快速双击不会被迟到的响应重新展开。
    if (anchor.getAttribute('aria-expanded') === 'true') { closeCtxMenu(); return; }
    closeCtxMenu();
    anchor.setAttribute('aria-expanded', 'true');
    const request = vaultMenuRequest;
    let recents = [];
    try { const s = await Api.state(); recents = s.recentVaults || []; } catch { recents = []; }
    if (request !== vaultMenuRequest || anchor.getAttribute('aria-expanded') !== 'true') return;
    const current = state.vault?.root || '';
    const items = recents.slice(0, 8).map((v) => ({
      icon: v === current ? ICON.check : ICON.folder,
      label: v.replace(/\\/g, '/').split('/').filter(Boolean).slice(-1)[0] || v,
      title: v,
      action: () => { if (v !== current) openVault(v); },
    }));
    if (!items.length) items.push({ icon: ICON.folder, label: '还没有最近仓库', disabled: true });
    items.push('-');
    items.push({ icon: ICON.folderOpen, label: '管理仓库…', action: () => openVaultPicker() });
    const r = anchor.getBoundingClientRect();
    showMenu(r.left, r.bottom + 6, items);
    anchor.setAttribute('aria-expanded', 'true');
  };

  $('btn-tab-new').onclick = openBlankTab;
  const tabResize = new ResizeObserver(layoutTabs);
  tabResize.observe($('tab-strip'));
  window.addEventListener('resize', layoutTabs);

  // 左侧功能区
  for (const btn of document.querySelectorAll('.ribbon-btn[data-panel]')) {
    btn.onclick = () => switchPanel(btn.dataset.panel);
  }
  $('btn-new-note-2').onclick = () => createNoteIn('');
  $('empty-new-note').onclick = () => createNoteIn('');
  $('empty-open-note').onclick = openPalette;
  // 给整个笔记库背景提供根目录操作；行级事件仍由文件/文件夹自己的菜单接管。
  const rootFileActions = () => [
    { label: '新建笔记', icon: ICON.doc, action: () => createNoteIn('') },
    { label: '新建文件夹', icon: ICON.folder, action: () => createFolderIn('') },
    '-',
    { label: '在文件树定位当前笔记', icon: ICON.tree, disabled: !state.currentPath, action: () => revealInTree(state.currentPath) },
    { label: '回收站', icon: ICON.trash, action: () => openTrash() },
  ];
  $('panel-files').oncontextmenu = e => {
    if (!state.vault || libraryTabs.current !== 'library' || e.target.closest('.tree-item, button, input, textarea, [role="tablist"]')) return;
    e.preventDefault(); e.stopPropagation(); showMenu(e.clientX, e.clientY, rootFileActions());
  };
  $('btn-file-more').onclick = e => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    showMenu(r.left, r.bottom + 5, rootFileActions());
  };
  $('btn-file-sort').onclick = e => {
    e.stopPropagation();
    if (e.currentTarget.getAttribute('aria-expanded') === 'true') { closeCtxMenu(); return; }
    const r = e.currentTarget.getBoundingClientRect();
    const items = [];
    FILE_SORTS.forEach(([mode, label], i) => {
      if (i === 2 || i === 4) items.push('-');
      items.push({ label, checked: fileSort === mode, action: () => {
        fileSort = mode; localStorage.setItem(`tracery.fileSort:${state.vault.root}`, mode); renderTree(true);
      } });
    });
    showMenu(r.left, r.bottom + 5, items); e.currentTarget.setAttribute('aria-expanded', 'true');
  };
  $('btn-collapse-tree').onclick = () => {
    const all = new Set();
    const walk = (node) => { for (const d of node.dirs || []) { all.add(d.name); walk(d); } };
    if (state.tree) walk(state.tree);
    if (state.collapsed.size < all.size) state.collapsed = all;
    else state.collapsed = new Set();
    localStorage.setItem('tracery.collapsed', JSON.stringify([...state.collapsed]));
    renderTree(true);
  };  $('btn-graph-reheat').onclick = () => graphView?._reheat();
  $('btn-graph-zoom-in').onclick = () => graphView?.zoomIn();
  $('btn-graph-zoom-out').onclick = () => graphView?.zoomOut();
  $('btn-graph-fit').onclick = () => graphView?.fit();
  $('btn-graph-full').onclick = () => toggleGraphFocus();
  initResizers();

  // 绘图
  $('btn-draw').onclick = () => openDrawPanel();
  $('btn-mode').onclick = () => editor.toggleMode();
  $('btn-settings').onclick = () => { if (isCompact()) closeMobilePanels(); openSettings(); };

  // 搜索
  $('search-input').addEventListener('input', (e) => runSearch(e.target.value));
  // 全部替换（替换前服务端会自动留版本快照，可回滚）
  $('btn-replace-all').onclick = async () => {
    const q = $('search-input').value;
    if (!q.trim()) { toast('先输入要查找的内容'); return; }
    const rep = $('replace-input').value;
    const ok = await askConfirm({
      title: '在全部笔记里替换？',
      desc: `把「${q}」替换成「${rep}」——会改所有匹配的笔记，替换前每篇都会自动留一份版本快照。`,
      okText: '全部替换',
    });
    if (!ok) return;
    try {
      const r = await Api.replace(q, rep);
      await refreshTree();
      refreshGraph();
      refreshTags();
      if (r.files.includes(state.currentPath)) await reloadCurrentNote();
      toast(`已替换 ${r.count} 处，涉及 ${r.files.length} 篇`);
      runSearch(q);
    } catch (e) { toast(`替换失败：${e.message}`); }
  };
  $('search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = $('search-results').querySelector('.search-result');
      if (first) first.click();
    }
  });

  // 命令面板
  $('palette-input').addEventListener('input', (e) => renderPalette(e.target.value));
  $('palette-input').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); highlightPalette(paletteIndex + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlightPalette(paletteIndex - 1); }
    else if (e.key === 'Enter') {
      const item = paletteItems[paletteIndex];
      if (item) { closePalette(); item.action?.(); }
    } else if (e.key === 'Escape') closePalette();
  });
  $('palette').addEventListener('click', (e) => { if (e.target === $('palette')) closePalette(); });

  // 统一在捕获阶段分派，优先于 CM 的默认键位；取消绑定后旧键也不能继续偷偷生效。
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.isComposing || e.keyCode === 229 || e.getModifierState('AltGraph')) return;
    if (!$('phone-access-panel').hidden) return;
    if (settingsIsOpen()) {
      if (e.key === 'Escape' && !e.target.closest('.hotkey-binding[aria-pressed="true"]')) { e.preventDefault(); closeSettings(); }
      return;
    }
    if (document.querySelector('.dialog-backdrop:not([hidden]), .draw-overlay:not([hidden]), .lightbox:not([hidden]), .pdf-viewer:not([hidden]), .history-viewer:not([hidden]), .trash-viewer:not([hidden])')) return;
    if (e.key === 'Escape') {
      if (ctxMenu) { e.preventDefault(); closeCtxMenu(); }
      else if (!$('palette').hidden) closePalette();
      else if (!$('welcome').hidden) closeWelcome();
      else if (document.body.classList.contains('graph-focus')) { e.preventDefault(); toggleGraphFocus(false); }
      return;
    }
    if (!$('palette').hidden || !$('welcome').hidden) return;
    const key = shortcutFromEvent(e); if (!key) return;
    const editing = editor.view.dom.contains(e.target) || editor.view.hasFocus;
    const command = HOTKEY_COMMANDS.find(c => bindingFor(c, getSettings().hotkeys) === key && (!c.editorOnly || editing));
    if (command) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (command.editorOnly && (!state.currentPath || editor.isRead)) return;
      if (e.repeat && !command.editorOnly) return;
      Promise.resolve(hotkeyActions[command.id]?.()).catch(error => toast(error.message));
    } else if (editing && HOTKEY_COMMANDS.some(c => c.defaultKey === key)) {
      e.preventDefault(); e.stopImmediatePropagation();
    }
  }, true);

  // 编辑器区域滚动时关闭链接预览（capture：cm 内核的滚动发生在内部 `.cm-scroller`，scroll 不冒泡）
  $('editor-live').addEventListener('scroll', () => {
    const pop = $('link-preview');
    if (pop) pop.hidden = true;
  }, true);

}

/* ================= WebSocket 同步 ================= */
function onWsMessage(msg) {
  if (msg.type === 'fs-change') {
    editor.refreshDecorations();
    const paths = msg.paths || [];
    const affectsCurrent = state.currentPath && paths.some((p) => p === state.currentPath || p === '*' || p === state.currentPath + '.md');
    if (msg.treeChanged !== false || !fileSort.startsWith('name')) refreshTree().then(() => pruneTabs());
    refreshGraph();
    refreshTags();
    if (affectsCurrent && !editor.dirty) {
      const path = state.currentPath, root = state.vault?.root;
      Api.note(path).then(({ content, ...metadata }) => {
        if (path !== state.currentPath || root !== state.vault?.root || editor.dirty) return;
        editor.load(path, content, { keepMode: true });
        refreshRightPanels(content);
        sidebars.setMetadata(path, metadata);
      }).catch(() => {});
    } else if (state.currentPath) {
      refreshBacklinks();
    }
  } else if (msg.type === 'vault-opened') {
    // 其他窗口切换了仓库：同步标题栏与各索引
    Api.state().then(async (s) => {
      if (s.vault) {
        const changed = state.vault?.root !== s.vault.root;
        state.vault = s.vault;
        state.currentPath = null;
        if (changed) loadShortcuts();
        refreshRightPanels(null);
        $('vault-name').textContent = s.vault.name;
        $('vault-name').title = `${s.vault.root}\n点击切换 / 管理仓库`;
        document.title = `${s.vault.name} — Tracery`;
        $('welcome').hidden = true;
        $('app').hidden = false;
      }
      // 先等树刷新再恢复标签：loadTabsState 靠 hasNotePath 过滤，
      // 用旧树过滤会把上一个仓库的标签带进来
      await refreshTree();
      refreshGraph(); refreshTags();
      await restoreTabsAfterVaultSwitch();
    }).catch(() => { refreshTree(); refreshGraph(); refreshTags(); });
  } else if (msg.type === 'settings' && msg.settings) {
    // 其他窗口改了设置：同步应用（幂等）
    const cur = getSettings();
    if (JSON.stringify(cur) !== JSON.stringify(msg.settings)) initSettings(msg.settings);
  } else if (msg.type === 'sync-status' && msg.status) {
    onSyncStatus(msg.status);
  }
}

function toggleSidebar(side) {
  if (isCompact()) {
    if (side === 'left' && document.body.classList.contains('graph-focus')) toggleGraphFocus(false);
    toggleMobilePanel(side);
  } else $(side === 'left' ? 'sidebar' : 'sidebar-right').classList.toggle('collapsed');
}
libraryTabs = initLibraryTabs();
sidebars = createSidebarContext({ state, editor, api: Api, navigate: openNote, createMissing: createMissingNote,
  searchTag: tag => { switchPanel('search'); $('search-input').value = `#${tag}`; runSearch(`#${tag}`); },
  history: openHistory, copy: copyText, compact: isCompact, closeMobile: closeMobilePanels });
sidebars.refresh(null);
initPhoneAccess({ api: Api, toast, closeMobile: closeMobilePanels });
initMobile();
initPwa({ beforeReload: async () => { await editor.flush(); return !editor.dirty; } });
window.addEventListener('beforeunload', (event) => {
  if (!editor.dirty) return;
  event.preventDefault(); event.returnValue = '';
});
boot().catch(() => { $('app').hidden = true; $('boot-error').hidden = false; });
