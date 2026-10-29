/**
 * Tracery 主控制器（对应 Obsidian 渲染进程）
 * 负责：仓库/欢迎页、文件树、面板切换、命令面板、快捷键、
 *       编辑器装配、反链/大纲/标签面板、图谱、主题、WebSocket 同步
 */
import { Api, toast, debounce, fuzzyMatch, connectWs, setAccess } from './api.js';
import { CmEditor } from './cm/engine.js';
import { ForceGraph } from './graph.js';
import {
  initSettings, receiveSettings, updateSettings, getSettings, openSettings, close as closeSettings,
  isOpen as settingsIsOpen, onApplied, resolveAssetDir, configureWorkspaces, flushPendingSettings,
} from './settings.js';
import { onSyncStatus } from './sync-ui.js';
import { askText, askConfirm } from './dialog.js';
import { renderMarkdown } from './markdown.js';
import { openLightbox } from './lightbox.js';
import { openPdfViewer, configurePdfViewer, showPdfViewer, hidePdfViewer, currentPdf } from './pdf-viewer.js';
import { pdfPage, pdfUrl } from './pdf-reference.js';
import { openDraw, suspendDraw, isDrawOpen } from './draw.js';
import { initMobile, isCompact, toggleMobilePanel, closeMobilePanels } from './mobile.js';
import { initPwa } from './pwa.js';
import { rememberDraft, clearSavedDraft, recoverDraft, archiveDraft, showRecovery } from './recovery.js';
import { VirtualTree, flattenTree } from './virtual-tree.js';
import { FILE_SORTS, validSort, sortTree } from './file-sort.js';
import { noteIndex, resolveNote, missingNotePath, normalizeNotePath, wikiParts, isAttachmentTarget } from './wiki-path.js';
import { noteAnchors, selectNoteContent } from './note-embed.js';
import { createSidebarContext, initLibraryTabs, initPhoneAccess, copyLocalText } from './sidebar.js';
import { HOTKEY_COMMANDS, bindingFor, shortcutFromEvent, shortcutLabel } from './hotkeys.js';
import { toggleBold, toggleItalic, toggleStrike, insertWikilink } from './cm/editing.js';
import { GROUP_COLORS, isBlankTab, newBlankKey, groupForTab, tidyTabGroups, moveTabToGroup, renameTabKeys } from './tab-workspace.js';
import { configureFullBackup } from './full-backup.js';
import { captureBrowserState, applyBrowserState } from './workspace-backup.js';
import { initChromeLayout } from './chrome-layout.js';
import { createSavedGroups } from './saved-groups.js';
import { DEFAULT_LAYOUT, LAYOUT_FIELDS } from './layout-settings.js';
import { createTabDrag } from './tab-drag.js';
import { uiIcon } from './ui-icons.js';
import { sidebarForSide, applyWorkspaceLayout } from './workspace-layout.js';
import { panelDock } from './pane-docking.js';
import { setWorkspaceRoot, readPresets, writePresets, normalizeSession } from './layout-presets.js';
import { initTooltips } from './tooltip.js';
import { createNoteTools } from './note-tools.js';
import { initSavedSearches } from './saved-searches.js';
import { parseSearch } from './search-query.js';
import { createStudyUI } from './study-tools-ui.js';

initTooltips();
configurePdfViewer({ open: (path, page) => openPdfAt(path, page), close: () => closeTab(state.activeTab), root: () => state.vault?.root, readOnly: () => editor.accessReadOnly, cite: () => studyTools.cite() });

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
  readingPositions: {},
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
setWorkspaceRoot(() => state.vault?.root || '');
configureWorkspaces({ capture: captureWorkspaceSession, apply: item => navigate(() => applyWorkspaceNow(item)) });
let backupNavigation = false, explicitRestoreAtBoot = sessionStorage.getItem('tracery.restoreSession');
configureFullBackup({
  async prepare() {
    if (!suspendDraw() || !await editor.flush()) return null;
    await flushPendingSettings();
    rememberReadingPosition(); saveTabsState();
    return { vaultRoot: state.vault.root, clientState: captureBrowserState(state.vault.root) };
  },
  async open(result, restoreSettings) {
    return navigate(async () => {
      if (!result?.verified || !suspendDraw() || !await editor.flush()) return;
      await flushPendingSettings();
      const oldRoot = state.vault.root, previousSettings = getSettings(), host = $('editor-live'); let rollback = () => {}, switched = false, settingsChanged = false;
      backupNavigation = true; host.inert = true;
      try {
        await Api.openVault(result.path); switched = true;
        if (restoreSettings) {
          settingsChanged = true;
          const response = await Api.saveSettings(result.settings); receiveSettings(response.settings);
          rollback = applyBrowserState(result.path, result.clientState);
          sessionStorage.setItem('tracery.restoreSession', result.path);
        }
        location.reload();
      } catch (error) {
        rollback(); sessionStorage.removeItem('tracery.restoreSession');
        if (settingsChanged) await Api.saveSettings(previousSettings).then(response => receiveSettings(response.settings)).catch(() => {});
        if (switched) await Api.openVault(oldRoot).catch(() => {});
        backupNavigation = false; host.inert = false; throw error;
      }
    });
  },
});
const savedGroups = createSavedGroups({ state, openNote,
  prepare: async () => suspendDraw() && await editor.flush(), activate: activateTab,
  changed: () => { renderTabs(); saveTabsState(); },
});

/* ================= 启动 ================= */
async function boot() {
  // 调试/测试钩子
  window.__tracery = { editor, state, Api, openNote, switchPanel, switchRightPanel, exportHtml, exportPdf, togglePin, openTrash, revealInTree, prepareClose, openRecoveryCenter };
  const st = await Api.state();
  state.access = st.access || {local:true,mode:'write'};
  if (st.storageWarnings?.length) toast(st.storageWarnings.join('；'), 12000);
  setAccess(state.access);
  if (!state.access.local) {
    document.body.dataset.client = 'mobile';
    document.body.dataset.access = state.access.mode;
    editor.accessReadOnly = state.access.mode === 'read';
    if (editor.accessReadOnly) editor.setMode('read');
    const status = document.createElement('div'); status.className = 'mobile-access-status'; status.setAttribute('role','status');
    const label = document.createElement('span'); label.textContent = editor.accessReadOnly ? '手机访问 · 只读' : '手机访问 · 读写';
    const logout = document.createElement('button'); logout.className='mini-btn'; logout.textContent='断开';
    logout.onclick = async () => { if (!await editor.flush()) return; try { await fetch('/api/access/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}); } finally {location.replace('/mobile-login.html');} };
    status.append(label,logout);document.body.append(status);
  }
  state.settings = st.settings || null;
  initSettings(st.settings || {});
  state.settings = getSettings();
  state.themeName = getSettings().themeName;
  onApplied((s) => {
    state.settings = s;
    state.theme = document.documentElement.dataset.theme;
    state.themeName = s.themeName;
    if (editor.autosaveMs !== s.autosave) editor.setAutosave(s.autosave);
    if (editor.showLineNumbers !== (s.lineNumbers !== false)) editor.setLineNumbers(s.lineNumbers !== false);
    editor.view.requestMeasure();
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
  initChromeLayout();
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
  noteTools.closeList();
  studyTools.closeTasks();
  state.vault = vault;
  searchTools.refresh();
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
  const explicit = explicitRestoreAtBoot === state.vault?.root;
  if (explicit) { explicitRestoreAtBoot = null; sessionStorage.removeItem('tracery.restoreSession'); }
  const startup = explicit ? 'last' : getSettings().startup;
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
  if (/\.(md|markdown|txt)$/i.test(name)) return '';
  if (/\.(png|jpe?g|gif|svg|webp|avif)$/i.test(name)) return ICON.image;
  if (/\.pdf$/i.test(name)) return ICON.pdf;
  return ICON.paperclip;
}

function appendFileLabel(item, file, className = 'label') {
  const pdf = PDF_FILE_RE.test(file.path);
  const image = /\.(png|jpe?g|gif|svg|webp|avif|bmp)$/i.test(file.path);
  const kind = pdf ? 'PDF' : image ? '图片' : '';
  const iconMarkup = kind ? '' : iconForFile(file.name);
  if (iconMarkup) { const icon = document.createElement('span'); icon.className = 'icon'; icon.innerHTML = iconMarkup; item.append(icon); }
  const label = document.createElement('span'); label.className = className;
  label.textContent = file.name.replace(/\.(md|markdown|txt|pdf)$/i, ''); item.append(label);
  if (kind) { const badge = document.createElement('span'); badge.className = 'file-kind'; badge.textContent = kind; badge.setAttribute('aria-label', `${kind}文件`); item.append(badge); }
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
  let g; try { g = await Api.graph(); } catch { return; } // 连接状态由 API 层提示，保留已有图谱。
  state.graph = g;
  // 双链的「解析得到 / 解析不到」直接取决于这份索引 → 通知装饰重算 unresolved 类
  editor?.refreshDecorations?.();
  if (graphView && document.body.classList.contains('graph-focus')) {
    graphView.opts.activePath = state.currentPath;
    graphView.setData(g);
  }
}, 150);

const refreshTags = debounce(async () => {
  let response; try { response = await Api.tags(); } catch { return; }
  const { tags } = response;
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
  if (name.startsWith('/') && /\.pdf$/i.test(name)) {
    let target; try { target = decodeURIComponent(name.slice(1)); } catch { return null; }
    return state.files.has(target) ? target : null;
  }
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
    if (file && PDF_FILE_RE.test(file)) openPdfViewer(pdfUrl(Api.fileUrl(file), pdfPage(wikiParts(raw).heading)));
    else if (file && IMG_FILE_RE.test(file)) openLightbox(Api.fileUrl(file), state.files.get(file)?.name || file);
    else if (file) window.open(Api.fileUrl(file), '_blank', 'noopener');
    else toast('找不到引用的笔记或附件');
  }
}
async function openPdfAt(path, page) {
  const root = state.vault?.root;
  const result = await openNote(path, null, { newTab: true });
  if (result === false || root !== state.vault?.root || state.currentPath !== path) return;
  showPdfViewer(pdfUrl(Api.fileUrl(path), page), state.files.get(path)?.name || path, vaultAbs(path));
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
  savedGroups.load();
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
  savedGroups.render();
  for (const [id, paths, kind] of [['pinned-list', [...state.pinned], 'pinned'], ['recent-notes', state.recent, 'recent']]) {
    const box = $(id); box.replaceChildren();
    const available = paths.filter(p => state.files.has(p));
    const tab = $(`tab-${kind}`), label = kind === 'pinned' ? '收藏' : '最近打开';
    tab.title = `${label} · ${available.length}`; tab.setAttribute('aria-label', `${label}，${available.length} 项`);
    for (const p of available) {
      const item = document.createElement('button'); item.className = `tree-item ${kind}-item${p === state.currentPath ? ' active' : ''}`; item.dataset.path = p; item.title = p;
      appendFileLabel(item, state.files.get(p), 'label tree-label');
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
  let warning = false;
  try { savedGroups.rename(map); } catch { warning = true; }
  state.pinned = new Set([...state.pinned].map(map)); state.recent = state.recent.map(map);
  try { saveShortcuts(); } catch { warning = true; }
  const items = readPresets().map(item => {
    if (!item.session) return item;
    const session = item.session;
    return { ...item, session: { ...session, tabs: session.tabs.map(map), active: session.active && map(session.active),
      groups: session.groups.map(group => ({ ...group, tabs: group.tabs.map(map) })),
      positions: Object.fromEntries(Object.entries(session.positions).map(([key, value]) => [map(key), value])) } };
  });
  try { if (items.length) writePresets(items); } catch { warning = true; }
  return warning;
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
  appendFileLabel(item, f);
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
let contextReturnFocus = null;
let vaultMenuRequest = 0;
function closeCtxMenu(restoreFocus = false) {
  vaultMenuRequest++;
  $('vault-name')?.setAttribute('aria-expanded', 'false');
  $('btn-tab-more')?.setAttribute('aria-expanded', 'false');
  if (ctxMenu) { ctxMenu.remove(); ctxMenu = null; }
  contextTarget?.classList.remove('context-target'); contextTarget = null;
  if (restoreFocus && contextReturnFocus?.isConnected) contextReturnFocus.focus({ preventScroll: true });
  contextReturnFocus = null;
  $('btn-file-sort')?.setAttribute('aria-expanded', 'false');
}
document.addEventListener('click', () => closeCtxMenu());
window.addEventListener('resize', () => closeCtxMenu());

/** 字型图标（H1 / B / I / ¶ 这类排版项用文字比画图形更清楚） */
const T = (txt, cls = '') => `<span class="mi-txt ${cls}">${txt}</span>`;

function showMenu(x, y, items, target = null) {
  closeCtxMenu();
  contextReturnFocus = document.activeElement;
  if (target) { contextTarget = target; target.classList.add('context-target'); }
  ctxMenu = document.createElement('div');
  ctxMenu.className = 'context-menu';
  ctxMenu.setAttribute('role', 'menu'); ctxMenu.setAttribute('aria-label', '操作菜单');
  for (const it of items) {
    if (it === '-') { const s = document.createElement('div'); s.className = 'sep'; s.setAttribute('role', 'separator'); ctxMenu.appendChild(s); continue; }
    const btn = document.createElement('button');
    btn.setAttribute('role', 'checked' in it ? 'menuitemcheckbox' : 'menuitem'); btn.tabIndex = -1;
    if ('checked' in it) btn.setAttribute('aria-checked', String(!!it.checked));
    if (it.danger) btn.className = 'danger';
    if (it.disabled) btn.disabled = true;
    if (it.title) btn.title = it.title;
    btn.innerHTML = `<span class="mi-icon${it.iconOn ? ' on' : ''}">${it.icon || ''}</span>`
      + `<span class="mi-label">${it.label}</span>`
      + (it.checked ? '<span class="mi-check">✓</span>' : '')
      + (it.kbd ? `<span class="mi-kbd">${it.kbd}</span>` : '');
    btn.onclick = (e) => { e.stopPropagation(); closeCtxMenu(true); it.action?.(); };
    ctxMenu.appendChild(btn);
  }
  document.body.appendChild(ctxMenu);
  const rect = ctxMenu.getBoundingClientRect();
  ctxMenu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  ctxMenu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
  const itemsEnabled = [...ctxMenu.querySelectorAll('button:not(:disabled)')];
  itemsEnabled[0]?.focus({ preventScroll: true });
  ctxMenu.onkeydown = event => {
    if (event.key === 'Tab') { closeCtxMenu(true); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const index = itemsEnabled.indexOf(document.activeElement);
    itemsEnabled[event.key === 'Home' ? 0 : event.key === 'End' ? itemsEnabled.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + itemsEnabled.length) % itemsEnabled.length]?.focus();
  };
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
  items.push({ label: '移动到…', icon: ICON.folder, action: () => moveEntry(f.path) });
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
  items.push({ label: '移动到…', icon: ICON.folder, action: () => moveEntry(rel) });
  items.push({ label: '删除', icon: ICON.trash, danger: true, action: () => deleteFolder(rel) });
  showMenu(e.clientX, e.clientY, items, e.currentTarget);
}

/** 移动和改名使用相同的引用事务及会话映射。 */
async function relocateEntry(rel, next) {
  return navigate(async () => {
    if (!suspendDraw() || !await editor.flush()) return;
    const root = state.vault.root, host = $('editor-live'), wasInert = host.inert;
    host.inert = true;
    try {
      const result = await Api.rename(rel, next, { vaultRoot: root });
      const map = value => value === rel || value.startsWith(rel + '/') ? next + value.slice(rel.length) : value;
      const storageWarning = renameShortcuts(rel, next); renameTabKeys(state, map);
      if (state.currentPath) { state.currentPath = map(state.currentPath); editor.path = map(editor.path); }
      await refreshTree(); refreshGraph(); refreshTags();
      if (state.currentPath && !PDF_FILE_RE.test(state.currentPath) && !editor.dirty) {
        const loaded = await Api.note(state.currentPath);
        editor.load(state.currentPath, loaded.content, { keepMode: true, revision: loaded.revision, vaultRoot: root });
        refreshRightPanels(loaded.content);
      } else if (PDF_FILE_RE.test(state.currentPath || '')) {
        hidePdfViewer(); showPdfViewer(Api.fileUrl(state.currentPath), state.files.get(state.currentPath)?.name, vaultAbs(state.currentPath));
      }
      renderTabs(); saveTabsState();
      toast(`已移动或重命名，更新 ${result.references || 0} 处引用${storageWarning ? '；工作区记录存储失败，请检查本机存储空间' : ''}`);
    } catch (error) { await refreshTree(); toast(error.message); }
    finally { host.inert = wasInert; updateEmptyNote(); }
  });
}
async function moveEntry(rel) {
  const directory = await askText({ title: '移动到文件夹', desc: '输入仓库内的目标目录，输入 / 表示根目录。相关引用会同步更新。', value: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '/',
    suggestions: ['/', ...new Set([...state.files.keys()].filter(file => file.includes('/')).map(file => file.slice(0, file.lastIndexOf('/'))))], okText: '移动' });
  if (!directory) return;
  const clean = directory.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const next = [clean, rel.split('/').pop()].filter(Boolean).join('/');
  if (next !== rel) await relocateEntry(rel, next);
}
async function renameFolder(rel) {
  const oldName = rel.split('/').pop();
  const input = await askText({ title: '重命名文件夹', desc: '目录路径及相关笔记、附件引用会同步更新。', value: oldName, okText: '重命名' });
  if (!input) return;
  const clean = input.replace(/[\\/:*?"<>|]/g, '-').replace(/^\.+$/, '');
  if (!clean || clean === oldName) return;
  await relocateEntry(rel, (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : '') + clean);
}

/** 删除文件夹（连同里面的内容一起移入回收站，可整体恢复） */
async function deleteFolder(rel) {
  const prefix = rel + '/';
  const under = (p) => p === rel || p.startsWith(prefix);
  try {
    if (state.currentPath && under(state.currentPath) && !await editor.flush()) return;
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
  if (PDF_FILE_RE.test(state.currentPath || '')) { toast('PDF 请使用阅读器中的下载或打印功能'); return; }
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
  if (PDF_FILE_RE.test(state.currentPath || '')) { toast('PDF 请使用阅读器中的下载或打印功能'); return; }
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
    const path = state.currentPath, root = state.vault?.root;
    const before = editor.getContent(), generation = editor._generation, previousRevision = editor.revision;
    const { content, revision } = await Api.note(path);
    if (editor.dirty || root !== state.vault?.root || path !== state.currentPath || before !== editor.getContent() || generation !== editor._generation || previousRevision !== editor.revision) return;
    editor.load(path, content, { revision, vaultRoot: root });
  } catch { /* 文件可能已不在 */ }
}

async function openHistory() {
  if (!state.currentPath || PDF_FILE_RE.test(state.currentPath)) { toast('先打开一篇 Markdown 笔记'); return; }
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
    meta.textContent = `${fmtSize(it.size || 0)} · ${it.sourceUncertain ? '旧版历史 · 来源未验证，仅供预览' : '点击看内容'}`;
    main.append(name, meta);
    const actions = document.createElement('div');
    actions.className = 'trash-item-actions';
    const restore = document.createElement('button');
    restore.className = 'mini-btn';
    restore.textContent = '恢复';
    restore.disabled = it.restorable === false || state.access?.mode === 'read';
    restore.onclick = async (e) => {
      e.stopPropagation();
      const ok = await askConfirm({
        title: '恢复到这一版？',
        desc: '当前内容会先存一份新快照，随时可以再回来。',
        okText: '恢复',
      });
      if (!ok) return;
      try {
        if (!await editor.flush()) return;
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
    meta.textContent = `${it.path}${it.originalPathUnknown ? '（原路径未知，将恢复到仓库根目录）' : ''} · ${when} · ${fmtSize(it.size || 0)}`;
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
  try {
    await Api.remove(rel);
    await refreshTree();
    refreshGraph();
    toast('已删除图片文件');
  } catch (err) { toast(`删除失败：${err.message}`); }
}

async function renameNote(f) {
  const ext = (f.name.match(/\.[^.]+$/) || [])[0] || '';
  const oldName = f.name.slice(0, f.name.length - ext.length);
  const input = await askText({ title: /\.md$/i.test(f.name) ? '重命名笔记' : '重命名文件', desc: '指向此文件的笔记和附件引用会同步更新。', value: oldName, okText: '重命名' });
  if (!input || input === oldName) return;
  const bare = (ext && input.toLowerCase().endsWith(ext.toLowerCase()) ? input.slice(0, -ext.length) : input).replace(/[\\/:*?"<>|]/g, '-');
  const directory = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : '';
  await relocateEntry(f.path, directory + bare + ext);
}

async function deleteNote(f) {
  try {
    if (state.currentPath === f.path && !await editor.flush()) return;
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
    state.readingPositions = Object.fromEntries(state.tabs.filter(p => state.readingPositions[p]).map(p => [p, state.readingPositions[p]]));
    localStorage.setItem(tabsKey(), JSON.stringify({ tabs: state.tabs, active: state.activeTab, groups: state.tabGroups, positions: state.readingPositions }));
    if (state.currentPath) localStorage.setItem('tracery.lastNote', state.currentPath);
  } catch { /* 隐私模式下忽略 */ }
}

function loadTabsState() {
  try {
    const raw = JSON.parse(lsGet(tabsKey()) || '{}');
    state.tabs = [...new Set((Array.isArray(raw.tabs) ? raw.tabs : []).filter(p => typeof p === 'string' && (isBlankTab(p) || hasNotePath(p))))];
    state.tabGroups = Array.isArray(raw.groups) ? raw.groups : [];
    state.readingPositions = normalizeSession({ tabs: state.tabs, positions: raw.positions })?.positions || {};
    state.activeTab = Number.isInteger(raw.active)
      ? Math.min(Math.max(raw.active, 0), state.tabs.length - 1)
      : state.tabs.length - 1;
    tidyTabGroups(state);
  } catch {
    state.tabs = [];
    state.tabGroups = [];
    state.readingPositions = {};
    state.activeTab = -1;
  }
}

/* ---------- 标签拖拽换序 ----------
 * 用 pointer 事件而不是 HTML5 drag&drop：标题栏整体是 `-webkit-app-region: drag`，
 * HTML5 拖放在 Electron 里时灵时不灵；pointer 还能被 puppeteer 的鼠标事件直接驱动（可测）。
 * 约定：移动超过 5px 才算拖拽（否则当点击）；落点按「指针在中线左/右」决定插前还是插后。 */
let suppressTabClick = false;
const tabDragUI = createTabDrag({ state, label: tabLabel, color: groupColor, commit(plan) {
  suppressTabClick = true; setTimeout(() => { suppressTabClick = false; }, 0);
  if (!plan) return;
  state.tabs = plan.tabs; state.activeTab = plan.activeTab; state.tabGroups = plan.tabGroups;
  renderTabs(); saveTabsState();
} });

function updateEmptyNote() {
  const empty = !state.currentPath;
  const pdf = PDF_FILE_RE.test(state.currentPath || '');
  $('empty-note').hidden = !empty;
  $('editor-live').hidden = empty || pdf;
  $('editor-live').inert = empty || pdf;
  $('editor-area').classList.toggle('is-empty', empty);
  $('editor-area').classList.toggle('is-pdf', pdf);
  $('btn-mode').disabled = empty || pdf;
  $('document-header').hidden = empty || pdf;
  $('note-path').textContent = state.currentPath || '';
  $('note-path').title = state.currentPath || '';
  if (!pdf) hidePdfViewer();
}

function tabLabel(key) { return isBlankTab(key) ? '新标签页' : basename(key); }

async function openBlankTabNow() {
  if (!suspendDraw() || !await editor.flush()) return;
  if (document.body.classList.contains('graph-focus')) toggleGraphFocus(false);
  const key = newBlankKey();
  state.tabs.push(key);
  state.activeTab = state.tabs.length - 1;
  if (await loadTab(key) === false) return false;
  $('empty-open-note').focus();
}

const tabAnimations = new Set();
let tabGhostLayer;
function cancelTabMotion() {
  for (const animation of tabAnimations) animation.cancel();
  tabAnimations.clear();
  tabGhostLayer?.remove();
  tabGhostLayer = null;
}
function toggleTabGroup(group) {
  cancelTabMotion();
  const list = $('tablist');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const key = node => node.classList.contains('tab') ? `tab:${node.dataset.index}` : `${node.classList.contains('tab-group-rail') ? 'rail' : 'group'}:${node.dataset.group}`;
  const before = new Map([...list.querySelectorAll('.tab:not([hidden]), .tab-group-header, .tab-group-rail')]
    .map(node => [key(node), { rect: node.getBoundingClientRect(), node }]));
  const focused = document.activeElement?.classList.contains('tab-group-header');
  group.collapsed = !group.collapsed;
  renderTabs(); saveTabsState();
  const header = [...list.querySelectorAll('.tab-group-header')].find(node => node.dataset.group === group.id);
  if (focused) header?.focus({ preventScroll: true });
  if (reduced || !header) return;
  const anchor = header.getBoundingClientRect();
  const animate = (node, frames, ghost = false) => {
    const animation = node.animate(frames, { duration: 200, easing: 'cubic-bezier(.22,.7,.25,1)' });
    tabAnimations.add(animation);
    const clean = () => { tabAnimations.delete(animation); if (ghost) node.remove(); };
    animation.finished.then(() => { clean(); if (!tabAnimations.size) layoutTabs(); }, clean);
  };
  for (const node of list.querySelectorAll('.tab:not([hidden]), .tab-group-header, .tab-group-rail')) {
    const rect = node.getBoundingClientRect(), old = before.get(key(node));
    if (!rect.width) continue;
    animate(node, old ? [
      { translate: `${old.rect.left - rect.left}px ${old.rect.top - rect.top}px`, scale: `${old.rect.width / rect.width} 1` },
      { translate: '0 0', scale: '1 1' },
    ] : [
      { translate: `${anchor.right - rect.left}px 0`, scale: '.2 1', opacity: 0 },
      { translate: '0 0', scale: '1 1', opacity: 1 },
    ]);
    before.delete(key(node));
  }
  if (!before.size) return;
  const layer = document.createElement('div'); layer.className = `${list.className} tab-motion-overlay`;
  layer.inert = true; layer.setAttribute('aria-hidden', 'true'); document.body.append(layer); tabGhostLayer = layer;
  for (const { node, rect } of before.values()) {
    const ghost = node.cloneNode(true); ghost.hidden = false;
    Object.assign(ghost.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    layer.append(ghost);
    animate(ghost, [{ translate: '0 0', scale: '1 1', opacity: 1 },
      { translate: `${anchor.right - rect.left}px 0`, scale: '.2 1', opacity: 0 }], true);
  }
  const pending = [...tabAnimations].map(animation => animation.finished);
  Promise.allSettled(pending).then(() => { layer.remove(); if (tabGhostLayer === layer) tabGhostLayer = null; });
}

function renderTabs() {
  cancelTabMotion();
  tidyTabGroups(state);
  updateEmptyNote();
  tabDragUI.cancel();
  // 标签栏已并入标题栏：标题栏永远可见（拖拽区 + 窗口按钮），
  // 无标签时只隐藏标签列表本身，不能再隐藏整个 bar
  const list = $('tablist');
  if (!list) return;
  if (!state.tabs.length) { list.hidden = true; list.innerHTML = ''; layoutTabs(); return; }
  list.hidden = false;
  list.innerHTML = '';
  state.tabs.forEach((p, i) => {
    const tab = document.createElement('div');
    tab.className = `tab${i === state.activeTab ? ' active' : ''}`;
    tab.title = isBlankTab(p) ? tabLabel(p) : p;
    tab.dataset.index = String(i);
    const group = groupForTab(state, p);
    const nextGroup = groupForTab(state, state.tabs[i + 1]);
    if (group || nextGroup) tab.style.setProperty('--tab-divider-color', groupColor(group || nextGroup));
    if (group) {
      tab.dataset.group = group.id;
      tab.style.setProperty('--group-color', groupColor(group));
      tab.classList.toggle('group-end', nextGroup?.id !== group.id);
      if (group.tabs[0] === p) list.appendChild(makeGroupHeader(group));
      tab.hidden = group.collapsed;
    }
    const name = document.createElement('span');
    name.className = 'tab-name';
    name.textContent = tabLabel(p);
    if (PDF_FILE_RE.test(p)) { tab.dataset.fileKind = 'pdf'; tab.setAttribute('aria-label', `${tabLabel(p)}，PDF 文件`); }
    const close = document.createElement('button');
    close.className = 'tab-close';
    close.title = commandLabel('closeTab');
    close.innerHTML = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3.2 3.2l5.6 5.6M8.8 3.2l-5.6 5.6"/></svg>';
    close.onclick = (e) => { e.stopPropagation(); closeTab(i); };

    tabDragUI.bind(tab, { kind: 'tab', key: p });

    tab.append(name, close);
    tab.onclick = () => { if (suppressTabClick) return; activateTab(i); };
    tab.onauxclick = (e) => { if (e.button === 1) { e.preventDefault(); closeTab(i); } };
    tab.oncontextmenu = e => { e.preventDefault(); showTabContextMenu(e, p); };
    list.appendChild(tab);
  });
  for (const group of state.tabGroups.filter(group => !group.collapsed)) {
    const rail = document.createElement('span'); rail.className = 'tab-group-rail'; rail.dataset.group = group.id;
    rail.setAttribute('aria-hidden', 'true'); rail.style.setProperty('--group-color', groupColor(group)); list.append(rail);
  }
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
  items.push('-', { label: '打开设置', icon: uiIcon('general'), action: () => { if (isCompact()) closeMobilePanels(); openSettings(); } });
  const workspaces = readPresets();
  if (workspaces.length) items.push('-');
  for (const item of workspaces) items.push({ label: `工作区：${item.name}`, icon: uiIcon('layout'), action: () => navigate(() => applyWorkspaceNow(item)) });
  showMenu(r.left, r.bottom + 6, items);
}

/** 关闭全部标签页（与逐一点 × 同口径：先 flush 再清空） */
async function closeAllTabsNow() {
  if (!suspendDraw()) return;
  if (!state.tabs.length) return;
  if (!await editor.flush()) return false;
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
  cancelTabMotion();
  const list = $('tablist');
  if (!list) return;
  list.removeAttribute('data-overflow');
  const tabs = [...list.querySelectorAll('.tab:not([hidden])')];
  const count = tabs.length;
  const headers = [...list.querySelectorAll('.tab-group-header')];
  const measure = document.createElement('canvas').getContext('2d');
  const preferred = headers.map(header => {
    measure.font = getComputedStyle(header).font;
    return Math.min(180, Math.ceil(measure.measureText(header.querySelector('.tab-group-label').textContent).width) + 34);
  });
  const groups = preferred.reduce((sum, width) => sum + width, 0);
  const widths = tabs.map(tab => {
    measure.font = getComputedStyle(tab.querySelector('.tab-name')).font;
    const width = Math.min(168, Math.max(80, Math.ceil(measure.measureText(tab.querySelector('.tab-name').textContent).width) + 52));
    tab.style.flexBasis = `${width}px`;
    tab.style.maxWidth = `${width}px`;
    return width;
  });
  const desired = 35 + widths.reduce((sum, width) => sum + width, 0) + groups + Math.max(0, count + headers.length - 1) * 4;
  $('tab-strip').style.flexBasis = `${desired}px`;
  const average = list.clientWidth / Math.max(1, count + state.tabGroups.length);
  const available = Math.max(0, list.clientWidth - (count ? 56 + (count - 1) * 8 : 0));
  const scale = groups ? Math.min(1, available / groups) : 1;
  headers.forEach((header, index) => { header.style.width = `${preferred[index] * scale}px`; });
  const squeezed = list.clientWidth + 1 < desired - 35;
  list.classList.toggle('is-compact', squeezed && average < 86);
  list.classList.toggle('is-micro', squeezed && average < 28);
  list.style.gap = `${Math.min(4, average / 8)}px`;
  const origin = list.getBoundingClientRect();
  for (const rail of list.querySelectorAll('.tab-group-rail')) {
    const header = headers.find(node => node.dataset.group === rail.dataset.group);
    const members = [...list.querySelectorAll('.tab:not([hidden])')].filter(node => node.dataset.group === rail.dataset.group);
    if (!header || !members.length) continue;
    const start = header.getBoundingClientRect().left - origin.left + 8;
    rail.style.left = `${start}px`;
    rail.style.width = `${Math.max(0, members.at(-1).getBoundingClientRect().right - origin.left - start)}px`;
  }
}

function groupColor(group) { return GROUP_COLORS.find(([key]) => key === group.color)?.[2] || GROUP_COLORS[0][2]; }

function makeGroupHeader(group) {
  const header = document.createElement('button');
  header.className = 'tab-group-header';
  header.dataset.group = group.id;
  header.style.setProperty('--group-color', groupColor(group));
  header.setAttribute('aria-expanded', String(!group.collapsed));
  header.title = `${group.name} · ${group.tabs.length} 个标签（点击${group.collapsed ? '展开' : '折叠'}，右键编辑）`;
  header.classList.toggle('is-current', group.collapsed && group.tabs.includes(state.tabs[state.activeTab]));
  const label = document.createElement('span'); label.className = 'tab-group-label'; label.textContent = group.name;
  header.setAttribute('aria-label', `${group.name}，${group.tabs.length} 个标签`);
  header.append(label);
  header.onclick = () => { if (!suppressTabClick) toggleTabGroup(group); };
  header.oncontextmenu = e => { e.preventDefault(); showGroupEditor(group, e.clientX, e.clientY); };
  tabDragUI.bind(header, { kind: 'group', groupId: group.id });
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
  action(savedGroups.has(group.id) ? '更新保存的分组' : '保存分组', () => savedGroups.save(group));
  action('取消分组', () => { state.tabGroups = state.tabGroups.filter(item => item !== group); renderTabs(); saveTabsState(); });
  action('关闭分组', () => closeTabGroup(group));
  document.body.append(menu);
  const box = menu.getBoundingClientRect(); menu.style.left = `${Math.max(8, Math.min(x, innerWidth - box.width - 8))}px`; menu.style.top = `${Math.max(8, Math.min(y, innerHeight - box.height - 8))}px`;
  requestAnimationFrame(() => { input.focus(); input.select(); });
}

async function closeTabGroupNow(group) {
  if (!suspendDraw() || !await editor.flush()) return;
  const active = state.tabs[state.activeTab], index = state.activeTab;
  state.tabs = state.tabs.filter(key => !group.tabs.includes(key));
  state.activeTab = state.tabs.includes(active) ? state.tabs.indexOf(active) : Math.min(index, state.tabs.length - 1);
  if (state.activeTab >= 0) return await loadTab(state.tabs[state.activeTab]);
  else { state.currentPath = null; localStorage.removeItem('tracery.lastNote'); editor.load('', ''); refreshRightPanels(null); renderTree(); renderTabs(); saveTabsState(); }
}

let navigationTail = Promise.resolve(), noteLoadToken = 0;
let restoringReading = false;
const persistReadingPosition = debounce(() => { rememberReadingPosition(); saveTabsState(); }, 200);
function rememberReadingPosition() {
  if (restoringReading || !state.currentPath || editor.path !== state.currentPath) return;
  const main = editor.view.state.selection.main, scroller = editor.view.scrollDOM;
  state.readingPositions[state.currentPath] = { top: scroller.scrollTop, left: scroller.scrollLeft, anchor: main.anchor, head: main.head, mode: editor.mode };
}
function captureWorkspaceSession() {
  rememberReadingPosition();
  return normalizeSession({ tabs: state.tabs, active: state.tabs[state.activeTab], groups: state.tabGroups, positions: state.readingPositions, dock: panelDock().snapshot() });
}
async function restoreReadingPosition(position, valid) {
  if (!position) return;
  restoringReading = true;
  try {
    editor.setMode(position.mode);
    const end = editor.view.state.doc.length;
    editor.view.dispatch({ selection: { anchor: Math.min(end, position.anchor), head: Math.min(end, position.head) } });
    // 装饰、字体及侧栏宽度会触发重新测量；待布局完成再恢复滚动，避免光标定位覆盖阅读位置。
    for (const delay of [0, 60]) {
      await new Promise(resolve => delay ? setTimeout(resolve, delay) : requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (!valid()) return;
      editor.view.scrollDOM.scrollTop = position.top; editor.view.scrollDOM.scrollLeft = position.left;
    }
  } finally { restoringReading = false; }
}
async function applyWorkspaceNow(item) {
  if (!state.vault || !suspendDraw() || !await editor.flush()) { toast('笔记尚未保存，暂未切换工作区'); return false; }
  const root = state.vault.root, session = normalizeSession(item.session);
  if (!session) { updateSettings({ layout: item.layout }); toast(`已切换仅布局工作区：${item.name}`); return true; }
  rememberReadingPosition();
  const missing = session.tabs.filter(p => !isBlankTab(p) && !hasNotePath(p));
  const tabs = session.tabs.filter(p => isBlankTab(p) || hasNotePath(p));
  const active = tabs.includes(session.active) ? session.active : tabs[0];
  // 先验证活动笔记可读且草稿已处理，成功后再替换标签与布局。
  if (active && await loadTab(active, null, { restore: false }) === false) return false;
  if (root !== state.vault?.root) return false;
  state.tabs = tabs; state.activeTab = tabs.indexOf(active); state.tabGroups = session.groups;
  state.readingPositions = session.positions;
  tidyTabGroups(state);
  updateSettings({ layout: item.layout });
  if (!active) {
    state.currentPath = null; editor.load('', ''); $('note-path').textContent = ''; localStorage.removeItem('tracery.lastNote'); refreshRightPanels(null);
  }
  if (document.body.classList.contains('graph-focus')) toggleGraphFocus(false);
  switchPanel('files', { mobileOpen: false }); panelDock().restore(session.dock); if (isCompact()) closeMobilePanels();
  renderTree(); renderTabs(); saveTabsState();
  if (active && !PDF_FILE_RE.test(active)) await restoreReadingPosition(session.positions[active], () => root === state.vault?.root && state.currentPath === active);
  toast(`已切换工作区：${item.name}${missing.length ? `（跳过 ${missing.length} 篇缺失笔记）` : ''}`);
  return true;
}
function navigate(job) {
  const run = navigationTail.then(async () => {
    const root = state.vault?.root;
    const before = { tabs: [...state.tabs], activeTab: state.activeTab, groups: JSON.parse(JSON.stringify(state.tabGroups)) };
    const ok = await job();
    if (ok === false && root === state.vault?.root) {
      state.tabs = before.tabs; state.activeTab = before.activeTab; state.tabGroups = before.groups;
      renderTabs(); saveTabsState();
    }
    return ok;
  });
  navigationTail = run.catch(() => {}); return run;
}
function openNote(...args) { return navigate(() => openNoteNow(...args)); }
function activateTab(i, heading) { const key = state.tabs[i]; return navigate(() => activateTabNow(state.tabs.indexOf(key), heading)); }
function closeTab(i) { const key = state.tabs[i]; return navigate(() => closeTabNow(state.tabs.indexOf(key))); }
function closeAllTabs() { return navigate(closeAllTabsNow); }
function openBlankTab() { return navigate(openBlankTabNow); }
function closeTabGroup(group) { return navigate(() => closeTabGroupNow(group)); }

/** 把某篇笔记加载进当前标签（不改变标签列表） */
async function loadTab(path, heading, { restore = true } = {}) {
  rememberReadingPosition();
  const keepReadMode = editor.isRead;
  const ticket = ++noteLoadToken, root = state.vault?.root;
  const current = () => ticket === noteLoadToken && root === state.vault?.root;
  if (isBlankTab(path)) {
    state.currentPath = null;
    editor.load('', '');
    $('note-path').textContent = '';
    refreshRightPanels(null);
    renderTree(); renderTabs(); saveTabsState();
    return;
  }
  if (PDF_FILE_RE.test(path)) {
    const file = state.files.get(path);
    if (!file) { toast('PDF 文件不存在'); return false; }
    if (!await editor.flush() || !current()) return false;
    editor.load('', '');
    state.currentPath = path; $('note-path').textContent = path; $('save-notice').hidden = true;
    showPdfViewer(Api.fileUrl(path), file.name, vaultAbs(path));
    pushRecent(path); refreshRightPanels(null); sidebars.setMetadata(path, file);
    renderTree(); renderTabs(); saveTabsState();
    return true;
  }
  try {
    const { content, ...metadata } = await Api.note(path);
    if (!current() || !await editor.flush() || !current()) return false;
    // 只读授权只展示磁盘正文；本设备的待恢复草稿保留，等重新获准读写后处理。
    const recovered = state.access?.mode === 'read' ? null : await recoverDraft(root, path, content);
    if (!current() || recovered === false) return false;
    // 等待恢复确认时旧笔记也可能继续输入，切换前再次确认已落盘。
    if (!await editor.flush() || !current()) return false;
    state.currentPath = path;
    $('note-path').textContent = path;
    // 阅读模式要跨笔记保持：在阅读视图里点双链跳到别的笔记，仍应停在阅读模式
    // （live / source 保持老行为：换笔记回到实时预览）
    editor.load(path, content, { keepMode: editor.isRead, revision: metadata.revision, vaultRoot: root });
    $('save-notice').hidden = true;
    if (recovered !== null) editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: recovered } });
    renderTree(); // 高亮
    pushRecent(path);
    refreshRightPanels(editor.getContent());
    sidebars.setMetadata(path, metadata);
    if (graphView) graphView.opts.activePath = path;
    if (heading) setTimeout(() => editor.scrollToHeading(heading), 60);
    renderTabs();
    saveTabsState();
    if (restore && !heading && state.readingPositions[path]) await restoreReadingPosition({ ...state.readingPositions[path], mode: keepReadMode ? 'read' : state.readingPositions[path].mode }, current);
    return true;
  } catch (e) {
    toast(e.message);
    return false;
  }
}

async function activateTabNow(i, heading) {
  if (!suspendDraw()) return;
  if (i < 0 || i >= state.tabs.length) return;
  if (isCompact()) closeMobilePanels();
  if (document.body.classList.contains('graph-focus')) toggleGraphFocus(false);
  const path = state.tabs[i];
  const group = groupForTab(state, path);
  if (group) group.collapsed = false;
  if (state.activeTab === i && state.currentPath === path) {
    if (heading && !PDF_FILE_RE.test(path)) editor.scrollToHeading(heading);
    renderTabs(); saveTabsState();
    return;
  }
  if (!await editor.flush()) return false;
  state.activeTab = i;
  return await loadTab(path, heading);
}

async function closeTabNow(i) {
  if (!suspendDraw()) return;
  if (i < 0 || i >= state.tabs.length) return;
  const prevPath = state.currentPath;
  const wasActive = i === state.activeTab;
  if (wasActive && !await editor.flush()) return false;
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
  if (state.activeTab >= 0 && state.tabs[state.activeTab] !== prevPath) return await loadTab(state.tabs[state.activeTab]);
  else saveTabsState();
}

/** 外部删除/同步后清理失效标签 */
function pruneTabs() {
  const before = state.tabs.length;
  const prevPath = state.tabs[state.activeTab];
  state.tabs = state.tabs.filter((p) => isBlankTab(p) || hasNotePath(p) || (editor.dirty && p === editor.path));
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
async function relinkMissingAttachment(raw) {
  if (state.access?.mode === 'read' || !state.currentPath) return;
  const source = state.currentPath, root = state.vault.root, missing = String(raw).split('|')[0].trim();
  const images = IMG_FILE_RE.test(wikiParts(missing).target);
  const options = [...state.files.keys()].filter(file => images ? IMG_FILE_RE.test(file) : isAttachmentTarget(file));
  const target = await askText({ title: '重新关联附件', desc: `为 ${missing} 选择仓库内的文件。当前笔记中的该引用会更新，别名与图片宽度保留。`, suggestions: options, placeholder: '输入或选择仓库内的相对路径', okText: '关联' });
  if (!target) return;
  if (!options.includes(target)) { toast('请选择列表中仓库内的文件'); return; }
  await navigate(async () => {
    if (source !== state.currentPath || root !== state.vault.root || !await editor.flush()) return;
    const host = $('editor-live'); host.inert = true;
    try {
      const result = await Api.relink({ path: source, raw: missing, target, expectedRevision: editor.revision, vaultRoot: root });
      const data = await Api.note(source); editor.load(source, data.content, { keepMode: true, revision: data.revision, vaultRoot: root });
      refreshRightPanels(data.content); toast(`已重新关联 ${result.references} 处引用`);
    } catch (error) { toast(error.message); }
    finally { host.inert = false; updateEmptyNote(); }
  });
}

async function createMissingNote(raw, newTab = false) {
  if (isAttachmentTarget(raw)) { openEmbeddedLink(raw); return; }
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
async function openNoteNow(path, heading, opts = {}) {
  noteTools.closeList();
  studyTools.closeTasks();
  if (!suspendDraw()) return;
  if (!path) return;
  if (isCompact()) closeMobilePanels();
  const existing = state.tabs.indexOf(path);
  if (existing >= 0) return await activateTabNow(existing, heading);
  if (state.currentPath === path) {
    if (heading) editor.scrollToHeading(heading);
    return;
  }
  if (!await editor.flush()) return false;
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
  return await loadTab(path, heading);
}

function refreshRightPanels(content) {
  updateEmptyNote();
  if (!state.currentPath) {
    editor?.load('', '');
    $('note-path').textContent = '';
  }
  sidebars?.refresh(state.currentPath ? content : null);
}

async function saveRecoveryCopy(item) {
  const root = state.vault?.root;
  if (!root || item.root !== root) return false;
  const stem = item.path.replace(/\.[^/.]+$/, '');
  const path = `${stem}（恢复副本 ${Date.now()}-${Math.random().toString(36).slice(2, 6)}）.md`;
  try {
    await Api.createNote(path, item.content, { vaultRoot: root });
    await refreshTree();
    toast(`已保存副本：${path}`, 4500);
    return true;
  } catch (error) { toast(`另存失败：${error.message}`); return false; }
}
function openRecoveryCenter() { showRecovery(state.vault?.root, saveRecoveryCopy); }
async function viewDiskVersion() {
  if (!editor.path) return;
  const root = state.vault?.root, path = editor.path;
  if (editor.dirty && !await askConfirm({ title: '查看磁盘版本？', desc: '当前编辑内容会保留在恢复中心，然后显示磁盘上的内容。', okText: '保留草稿并查看' })) return;
  try {
    if (editor._saving) await editor._saving;
    const disk = await Api.note(path);
    if (root !== state.vault?.root || path !== editor.path) return;
    if (editor.dirty && !archiveDraft(root, path, editor.getContent())) return;
    clearSavedDraft(root, path, editor.getContent());
    editor.load(path, disk.content, { keepMode: true, revision: disk.revision, vaultRoot: root, discardChanges: true });
    $('save-notice').hidden = true; refreshRightPanels(disk.content);
  } catch (error) { toast(error.message); }
}
async function prepareClose() {
  document.activeElement?.blur();
  await navigationTail;
  if (!suspendDraw()) return false;
  if (editor.dirty) rememberDraft(editor.vaultRoot || state.vault?.root, editor.path, editor.getContent());
  return await editor.flush();
}

function refreshBacklinks() { sidebars?.refreshLinks(); }

function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ================= 面板切换 ================= */
let graphReturnPanel = 'files';
let graphFitTimers = [];
function switchPanel(name, { mobileOpen = true, pane = 'library' } = {}) {
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
  // 图谱临时占用导航区域，不能被用户保存的收起状态挡住。
  applyWorkspaceLayout(getSettings().layout);
  if (!isCompact() && name !== 'graph' && mobileOpen && !getSettings().layout.navigationVisible) updateSettings({ layout: { navigationVisible: true } });
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
  if (name === 'files') panelDock().select(pane, { reveal: mobileOpen });
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

let searchRequest = 0;
const fetchSearch = debounce(async (q, request, root) => {
  const box = $('search-results');
  const repRow = $('search-replace');
  if (root !== state.vault?.root || request !== searchRequest) return;
  let parsed;
  try { parsed = parseSearch(q); } catch (error) { if (repRow) repRow.hidden = true; box.textContent = error.message; return; }
  if (repRow) repRow.hidden = !q.trim() || parsed.literal === null;
  if (!q.trim()) { renderRecentList(box); return; }
  let results = [];
  try { results = (await Api.search(q)).results; } catch (error) { if (root === state.vault?.root && request === searchRequest) box.textContent = '搜索失败：' + error.message; return; }
  if (root !== state.vault?.root || request !== searchRequest) return;
  box.innerHTML = '';
  if (!results.length) {
    box.innerHTML = '<div class="search-empty">没有匹配的笔记</div>';
    return;
  }
  const needle = parsed.highlights[0] || '';
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
      if (needle && idx >= 0) {
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
function runSearch(q) { fetchSearch(q, ++searchRequest, state.vault?.root); }

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
    { icon: uiIcon('editor'), name: '摘录当前 PDF 到笔记', sub: '阅读', action: () => studyTools.cite() },
    { icon: uiIcon('layout'), name: '全库任务汇总', sub: '笔记工具', action: () => studyTools.tasks() },
    { icon: uiIcon('editor'), name: '从模板新建笔记', sub: '笔记工具', action: () => noteTools.template() },
    { icon: uiIcon('editor'), name: '快速记录', sub: '笔记工具', action: () => noteTools.capture() },
    { icon: uiIcon('general'), name: '编辑当前笔记属性', sub: '笔记工具', action: () => noteTools.properties() },
    { icon: uiIcon('layout'), name: '打开笔记列表', sub: '笔记工具', action: () => noteTools.list() },
    { icon: '📄', name: '新建笔记', sub: '命令', action: () => createNoteIn('') },
    { icon: '🌗', name: '切换亮色 / 暗色主题', sub: '外观', action: toggleTheme },
    { icon: '⚙️', name: '打开设置', sub: '设置', action: () => openSettings() },
    { icon: '☷', name: '布局设置', sub: '外观', action: () => openSettings('layout') },
    { icon: '↶', name: commandLabel('undo'), sub: '命令', action: () => editor.undo() },
    { icon: '↷', name: commandLabel('redo'), sub: '命令', action: () => editor.redo() },
    { icon: '🎨', name: '切换主题皮肤（Apple 风 / Obsidian 风）', sub: '外观', action: cycleThemeSkin },
    { icon: '👁', name: '切换编辑模式（实时预览 / 源码 / 阅读）', sub: '命令', action: () => editor.toggleMode() },
    { icon: '🕸️', name: '打开图谱视图', sub: '命令', action: () => switchPanel('graph') },
    { icon: '🔍', name: '搜索笔记内容', sub: '命令', action: () => { switchPanel('search'); $('search-input').focus(); } },
    { icon: '📤', name: '导出为 HTML', sub: '命令', action: () => exportHtml() },
    { icon: '📄', name: '导出为 PDF', sub: '命令', action: () => exportPdf() },
    { icon: '🕘', name: '查看历史版本', sub: '命令', action: () => openHistory() },
    { icon: '↩', name: '打开恢复中心（未保存草稿）', sub: '命令', action: openRecoveryCenter },
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
  saveAsset: async (file, context) => {
    const root = context.vaultRoot || state.vault?.root, notePath = context.path;
    const directory = resolveAssetDir(getSettings(), notePath);
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
      const res = await Api.saveAsset({ data: dataUrl, name, dir: directory, vaultRoot: root });
      if (!res?.ok) toast(res?.error || '附件保存失败');
      return res || { ok: false };
    } catch (e) { toast(`附件保存失败：${e.message}`); return { ok: false }; }
  },
  onImageClick: (src, alt) => openLightbox(src, alt),
  onAssetSaved: () => { refreshTree().catch(() => {}); },   // 断线时保留旧树，连接提示由 API 层处理。
  onAssetDeferred: path => toast(`附件已保存：${path}；笔记已切换，请从文档库插入。`, 4500),
  confirmCreate: (name) => askConfirm({
    title: `创建「${name}」？`,
    desc: '这个链接指向的笔记还不存在，现在创建它。',
    okText: '创建',
  }),
  onNavigate: (path, heading) => openNote(path, heading),
  onFileClick: name => openEmbeddedLink(name),
  onRelinkAttachment: raw => relinkMissingAttachment(raw),
  onCreateNote: (name) => {
    const path = name.replace(/\.md$/i, '') + '.md';
    Api.createNote(path, '').then(async () => {
      await refreshTree(); refreshGraph(); refreshTags();
      openNote(path, null, { newTab: true });
    }).catch((e) => toast(e.message));
  },
  onTagClick: (tag) => { switchPanel('search'); $('search-input').value = `#${tag}`; runSearch(`#${tag}`); },
  onSave: async (path, content, context) => {
    const root = context.vaultRoot ?? state.vault?.root;
    try {
      const metadata = await Api.saveNote(path, content, { ...context, vaultRoot: root });
      if (root === state.vault?.root) sidebars?.setMetadata(path, metadata);
      clearSavedDraft(root, path, content);
      refreshGraph(); refreshTags();
      refreshBacklinks();
      if (root === state.vault?.root && path === editor.path) $('save-notice').hidden = true;
      return metadata;
    } catch (e) {
      const kept = rememberDraft(root, path, content);
      if (root === state.vault?.root && path === editor.path) {
        $('save-notice').hidden = false;
        $('save-notice-text').textContent = `${e.status === 409 ? '版本冲突，已停止覆盖磁盘。' : '保存失败。'}${kept ? '此设备已保留草稿。' : '设备草稿也未能保存，请立即复制或另存。'} ${e.message}`;
      }
      toast(`保存未完成：${e.message}`); return false;
    }
  },
  onDirtyChange: (dirty) => {
    $('status-saved').textContent = dirty ? '未保存…' : `已保存 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
  },
  onSaveState: value => { $('status-saved').textContent = ({ saving: '保存中…', dirty: '未保存…', error: '保存失败，点击重试' })[value] || $('status-saved').textContent; },
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

const noteTools = createNoteTools({
  showList: () => { studyTools.closeTasks(); if (isCompact()) closeMobilePanels(); },
  context: () => {
    const selection = editor.view.state.selection.main, current = editor.path === state.currentPath;
    return { root: state.vault?.root, path: state.currentPath, content: current ? editor.getContent() : '', generation: editor._generation,
      selection: current ? editor.view.state.sliceDoc(selection.from, selection.to) : '', range: { anchor: selection.anchor, head: selection.head },
      accessReadOnly: editor.accessReadOnly, isRead: editor.isRead };
  },
  files: () => [...state.files.keys()],
  refresh: () => refreshTree(),
  flush: () => editor.flush(),
  open: path => openNote(path, null, { newTab: true }),
  created: async (path, root) => { if (root !== state.vault?.root) return; await refreshTree(); refreshGraph(); refreshTags(); if (root === state.vault?.root) await openNote(path, null, { newTab: true }); },
  insert: async (before, text) => {
    if (before.root !== state.vault?.root || before.path !== editor.path || before.content !== editor.getContent() || before.generation !== editor._generation) throw Error('笔记已变化，请重新打开模板以确认插入位置');
    if (editor.isRead || editor.accessReadOnly) throw Error('当前笔记仅可查看');
    editor.view.dispatch({ selection: before.range }); editor.insertText(text);
    if (!await editor.flush()) throw Error('插入内容已留在编辑区草稿中，保存未完成，请处理保存提示后重试保存');
  },
  properties: async (before, content) => {
    const unchanged = () => before.root === state.vault?.root && before.path === editor.path && before.content === editor.getContent() && before.generation === editor._generation;
    if (editor.isRead || editor.accessReadOnly) throw Error('当前笔记仅可查看');
    if (!unchanged() || !await editor.flush() || !unchanged()) throw Error('笔记已变化或保存未完成，请重新打开属性');
    const result = await Api.saveNote(before.path, content, { expectedRevision: editor.revision, vaultRoot: before.root });
    if (before.root === state.vault?.root && before.path === editor.path && (unchanged() || editor.getContent() === content)) {
      const scroll = editor.view.scrollDOM.scrollTop;
      editor.load(before.path, content, { keepMode: true, revision: result.revision, vaultRoot: before.root });
      editor.view.scrollDOM.scrollTop = scroll; refreshRightPanels(content); sidebars.setMetadata(before.path, result);
    }
    refreshGraph(); refreshTags();
  },
});
const searchTools = initSavedSearches({ root: () => state.vault?.root, run: runSearch });
const studyTools = createStudyUI({
  context: () => ({ root: state.vault?.root, readOnly: editor.accessReadOnly }), pdf: currentPdf,
  notes: () => [...state.files.keys()].filter(path => /\.(md|markdown)$/i.test(path)),
  flush: () => editor.flush(),
  refresh: () => refreshTree(),
  showTasks: () => { noteTools.closeList(); if (isCompact()) closeMobilePanels(); },
  open: async (path, line) => { const root = state.vault?.root; const result = await openNote(path, null, { newTab: true }); if (result !== false && root === state.vault?.root && state.currentPath === path && line) editor.scrollToLine(line); },
});

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
  if (!state.currentPath || PDF_FILE_RE.test(state.currentPath)) { toast('先打开一篇笔记，绘图会插入到光标处'); return; }
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
  const bind = (handle, panel, key) => {
    const { min: MIN, max: MAX } = LAYOUT_FIELDS[key];
    if (!handle || !panel) return;
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = panel.getBoundingClientRect().width;
      const sign = panel.getBoundingClientRect().left < $('editor-area').getBoundingClientRect().left ? 1 : -1;
      handle.classList.add('dragging');
      document.body.classList.add('resizing');
      const move = (ev) => {
        const w = Math.min(MAX, Math.max(MIN, startW + (ev.clientX - startX) * sign));
        updateSettings({ layout: { [key]: Math.round(w) } });
      };
      const up = () => {
        handle.classList.remove('dragging');
        document.body.classList.remove('resizing');
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
    handle.addEventListener('dblclick', () => {
      updateSettings({ layout: { [key]: DEFAULT_LAYOUT[key] } });
    });
  };
  bind($('resizer-left'), left, 'leftWidth');
  bind($('resizer-right'), right, 'rightWidth');
}

/* 快捷键的动作与标题使用同一份配置；不接管输入框、弹窗或画板自己的编辑按键。 */
const hotkeyActions = {
  palette: openPalette, settings: openSettings,
  search: () => { switchPanel('search'); $('search-input').focus(); },
  newNote: () => createNoteIn(''), draw: openDrawPanel, mode: () => { if (!PDF_FILE_RE.test(state.currentPath || '')) editor.toggleMode(); },
  quickCapture: () => noteTools.capture(), template: () => noteTools.template(), noteProperties: () => noteTools.properties(), noteList: () => noteTools.list(),
  tasks: () => studyTools.tasks(), pdfCitation: () => studyTools.cite(),
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
  for (const [element, command] of Object.entries({ 'btn-command': 'palette', 'btn-settings': 'settings', 'btn-new-note-2': 'newNote', 'btn-draw': 'draw', 'btn-toggle-left': 'leftSidebar', 'btn-toggle-right': 'rightSidebar' })) $(element).title = commandLabel(command);
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
  // 收放本身会改变标签条宽度，不能让观察器在首帧取消动画；结束时再校正排版。
  const tabResize = new ResizeObserver(() => { if (!tabAnimations.size) layoutTabs(); });
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
    { label: '从模板新建…', icon: ICON.doc, action: () => noteTools.template() },
    { label: '快速记录…', icon: ICON.pencil, action: () => noteTools.capture() },
    { label: '笔记列表…', icon: ICON.list, action: () => noteTools.list() },
    { label: '全库任务…', icon: ICON.task, action: () => studyTools.tasks() },
    { label: '新建文件夹', icon: ICON.folder, action: () => createFolderIn('') },
    '-',
    { label: '在文件树定位当前笔记', icon: ICON.tree, disabled: !state.currentPath, action: () => revealInTree(state.currentPath) },
    { label: '回收站', icon: ICON.trash, action: () => openTrash() },
  ];
  $('section-library').oncontextmenu = e => {
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
  $('btn-command').onclick = openPalette;
  $('btn-mode').onclick = () => editor.toggleMode();
  $('btn-settings').onclick = () => { if (isCompact()) closeMobilePanels(); openSettings(); };

  // 搜索
  $('btn-note-properties').onclick = () => noteTools.properties();
  $('btn-note-list').onclick = () => noteTools.list();
  $('btn-task-list').onclick = () => studyTools.tasks();
  $('search-note-list').onclick = () => noteTools.list($('search-input').value);
  $('search-input').addEventListener('input', (e) => runSearch(e.target.value));
  // 全部替换（替换前服务端会自动留版本快照，可回滚）
  $('btn-replace-all').onclick = async () => {
    const search = $('search-input').value;
    let q;
    try { q = parseSearch(search).literal; } catch (error) { toast(error.message); return; }
    if (q === null) { toast('组合搜索只筛选结果；全文替换请使用单个关键词或引号短语'); return; }
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
    if (document.querySelector('.note-tools-overlay:not([hidden])')) return;
    if (document.querySelector('.dialog-backdrop:not([hidden])')) return;
    if (settingsIsOpen()) {
      if (e.key === 'Escape' && !e.target.closest('.hotkey-binding[aria-pressed="true"]')) { e.preventDefault(); closeSettings(); }
      return;
    }
    if (document.querySelector('.dialog-backdrop:not([hidden]), .draw-overlay:not([hidden]), .lightbox:not([hidden]), .history-viewer:not([hidden]), .trash-viewer:not([hidden])')) return;
    if (e.key === 'Escape') {
      if (ctxMenu) { e.preventDefault(); closeCtxMenu(true); }
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
    rememberReadingPosition();
    persistReadingPosition();
    const pop = $('link-preview');
    if (pop) pop.hidden = true;
  }, true);

}

/* ================= WebSocket 同步 ================= */
function onWsMessage(msg) {
  if (backupNavigation && ['vault-opened', 'fs-change'].includes(msg.type)) return;
  if (msg.type === 'connection-ready') {
    const root = state.vault?.root;
    Api.state().then(snapshot => {
      if (root !== state.vault?.root) return;
      // 先核对仓库身份，不能把断线期间切换的仓库当成原仓库刷新。
      if (snapshot.vault?.root !== root) onWsMessage({ type: 'vault-opened' });
      else onWsMessage({ type: 'fs-change', paths: ['*'], treeChanged: true });
    }).catch(() => {});
  } else if (msg.type === 'fs-change') {
    studyTools.changed();
    noteTools.changed();
    editor.refreshDecorations();
    const paths = msg.paths || [];
    const affectsCurrent = state.currentPath && paths.some((p) => p === state.currentPath || p === '*' || p === state.currentPath + '.md');
    const refreshed = msg.treeChanged !== false || !fileSort.startsWith('name') ? refreshTree().then(() => pruneTabs()) : Promise.resolve();
    refreshed.catch(() => {});
    refreshGraph();
    refreshTags();
    if (affectsCurrent && PDF_FILE_RE.test(state.currentPath || '')) {
      const path = state.currentPath, root = state.vault?.root;
      refreshed.then(() => {
        if (state.currentPath !== path || state.vault?.root !== root || !state.files.has(path)) return;
        hidePdfViewer(); showPdfViewer(Api.fileUrl(path), state.files.get(path).name, vaultAbs(path));
        sidebars.setMetadata(path, state.files.get(path));
      }).catch(() => {});
    } else if (affectsCurrent && !editor.dirty) {
      const path = state.currentPath, root = state.vault?.root;
      const generation = editor._generation, before = editor.getContent(), revision = editor.revision;
      Api.note(path).then(({ content, ...metadata }) => {
        if (path !== state.currentPath || root !== state.vault?.root || editor.dirty || generation !== editor._generation || before !== editor.getContent() || revision !== editor.revision) return;
        if (editor.getContent() === content) { editor.revision = metadata.revision; return; }
        editor.load(path, content, { keepMode: true, revision: metadata.revision, vaultRoot: root });
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
        if (changed && editor.dirty) rememberDraft(editor.vaultRoot || state.vault?.root, editor.path, editor.getContent());
        ++noteLoadToken;
        state.vault = s.vault;
        searchRequest++; searchTools.refresh(); noteTools.changed(); studyTools.changed();
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
    }).catch(() => { refreshTree().catch(() => {}); refreshGraph(); refreshTags(); });
  } else if (msg.type === 'settings' && msg.settings) {
    // 其他窗口改了设置：同步应用（幂等）
    const cur = getSettings();
    if (JSON.stringify(cur) !== JSON.stringify(msg.settings)) receiveSettings(msg.settings);
  } else if (msg.type === 'sync-status' && msg.status) {
    onSyncStatus(msg.status);
  }
}

function toggleSidebar(side) {
  if (isCompact()) {
    if (side === 'left' && document.body.classList.contains('graph-focus')) toggleGraphFocus(false);
    toggleMobilePanel(side);
  } else {
    const layout = getSettings().layout, region = sidebarForSide(side, layout);
    if (region.id === 'sidebar' && document.body.classList.contains('graph-focus')) { toggleGraphFocus(false); return; }
    updateSettings({ layout: { [region.key]: !layout[region.key] } });
  }
}
libraryTabs = initLibraryTabs({
  onChange: patch => updateSettings({ layout: patch }),
  onReveal(host, pane) {
    if (host === 'navigation' && !$('panel-files').classList.contains('active')) switchPanel('files', { mobileOpen: false, pane });
    if (isCompact()) {
      const side = host === 'navigation' ? 'left' : 'right';
      if (!document.body.classList.contains(`mobile-${side}-open`)) toggleMobilePanel(side);
    } else {
      const key = host === 'navigation' ? 'navigationVisible' : 'contextVisible';
      if (!getSettings().layout[key]) updateSettings({ layout: { [key]: true } });
    }
  },
});
sidebars = createSidebarContext({ state, editor, api: Api, navigate: openNote, createMissing: createMissingNote,
  searchTag: tag => { switchPanel('search'); $('search-input').value = `#${tag}`; runSearch(`#${tag}`); },
  history: openHistory, copy: copyText, compact: isCompact, closeMobile: closeMobilePanels });
sidebars.refresh(null);
initPhoneAccess({ api: Api, toast, closeMobile: closeMobilePanels });
initMobile();
initPwa({ beforeReload: async () => { await editor.flush(); return !editor.dirty; } });
$('save-retry').onclick = () => editor.flush();
$('status-saved').onclick = () => editor.dirty ? editor.flush() : openRecoveryCenter();
$('save-disk').onclick = viewDiskVersion;
$('save-copy').onclick = () => saveRecoveryCopy({ root: editor.vaultRoot || state.vault?.root, path: editor.path, content: editor.getContent() });
$('save-recovery').onclick = openRecoveryCenter;
const checkpointDraft = () => { if (editor.dirty) rememberDraft(editor.vaultRoot || state.vault?.root, editor.path, editor.getContent()); };
window.addEventListener('pagehide', checkpointDraft);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { checkpointDraft(); editor.flush(); } });
window.addEventListener('beforeunload', (event) => {
  if (!editor.dirty) return;
  checkpointDraft();
  event.preventDefault(); event.returnValue = '';
});
boot().catch(() => { $('app').hidden = true; $('boot-error').hidden = false; });
