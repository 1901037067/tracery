/**
 * Tracery 主控制器（对应 Obsidian 渲染进程）
 * 负责：仓库/欢迎页、文件树、面板切换、命令面板、快捷键、
 *       编辑器装配、反链/大纲/标签面板、图谱、主题、WebSocket 同步
 */
import { Api, toast, debounce, fuzzyMatch, connectWs } from './api.js';
import { LiveEditor } from './editor.js';
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
import { openDraw } from './draw.js';

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
  currentPath: null,
  tabs: [],                 // 打开的笔记（标签页）
  activeTab: -1,
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

/* ================= 启动 ================= */
async function boot() {
  // 调试/测试钩子
  window.__tracery = { editor, state, Api, openNote, switchPanel, switchRightPanel, exportHtml, exportPdf, togglePin, openTrash };
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
  });
  editor.setAutosave(state.settings?.autosave ?? 900);
  editor.setLineNumbers(getSettings().lineNumbers !== false);
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
  try {
    $('vault-error').hidden = true;
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
  renderTabs();
  const startup = getSettings().startup;
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
  renderTree();
  // 文件树变了 → 装饰里的 `![[图片]]`/`![](路径)` 可能从「找不到」变「找得到」（或反之）。
  // CM 的装饰只在 doc/视口/选区变化时重建，索引变化必须显式通知（块级内核没这方法，忽略）。
  editor?.refreshDecorations?.();
}

const refreshGraph = debounce(async () => {
  const g = await Api.graph();
  state.graph = g;
  state.nameIndex = new Map(g.nodes.map((n) => [n.name.toLowerCase(), n.id]));
  // 双链的「解析得到 / 解析不到」直接取决于这份索引 → 通知装饰重算 unresolved 类
  editor?.refreshDecorations?.();
  if (graphView) {
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
  let byPath = null;
  let byName = null;
  const walk = (node) => {
    for (const f of node.files || []) {
      const p = f.path.replace(/\\/g, '/');
      const lower = p.toLowerCase();
      if (lower === want || lower.endsWith('/' + want)) {
        if (!byPath) byPath = f.path;
      } else if (!byName && f.name.toLowerCase() === leaf) {
        byName = f.path;
      }
    }
    for (const d of node.dirs || []) walk(d);
  };
  walk(state.tree);
  return byPath || byName;
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

function renderTree() {
  const box = $('file-tree');
  box.innerHTML = '';
  if (!state.tree) return;
  if (!state.tree.files.length && !state.tree.dirs.length) {
    box.innerHTML = '<div class="tree-empty">仓库是空的<br>点右上角 ＋ 新建第一篇笔记</div>';
    return;
  }
  renderPinnedSection(box);
  box.appendChild(renderTreeNode(state.tree, 0, true));
  updateCollapseTreeIcon();
}

/** 文件树顶部的星标区（有星标才显示） */
function renderPinnedSection(box) {
  if (!state.pinned.size) return;
  const wrap = document.createElement('div');
  wrap.className = 'pinned-section';
  const head = document.createElement('div');
  head.className = 'pinned-head';
  head.textContent = '星标';
  wrap.appendChild(head);
  for (const p of state.pinned) {
    const item = document.createElement('div');
    item.className = 'tree-item pinned-item';
    item.dataset.path = p;
    const icon = document.createElement('span');
    icon.className = 'tree-icon';
    icon.textContent = '★';
    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = p.split('/').pop().replace(/\.md$/i, '');
    item.append(icon, label);
    item.onclick = () => openNote(p, null, { newTab: false });
    item.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      showFileMenu(e, { path: p, name: p.split('/').pop() });
    };
    wrap.appendChild(item);
  }
  box.appendChild(wrap);
}

/** 星标开关（右键菜单用） */
function togglePin(relPath) {
  if (state.pinned.has(relPath)) state.pinned.delete(relPath);
  else state.pinned.add(relPath);
  localStorage.setItem('tracery.pinned', JSON.stringify([...state.pinned]));
  renderTree();
  toast(state.pinned.has(relPath) ? '已加星标' : '已取消星标');
}

/** 记录最近打开（最多 8 条，去重） */
function pushRecent(relPath) {
  if (!relPath) return;
  state.recent = [relPath, ...state.recent.filter((p) => p !== relPath)].slice(0, 8);
  localStorage.setItem('tracery.recent', JSON.stringify(state.recent));
}

function renderTreeNode(node, depth, isRoot = false) {
  const frag = document.createDocumentFragment();
  const renderDir = (d) => {
    const wrap = document.createElement('div');
    const item = document.createElement('div');
    item.className = 'tree-item';
    const collapsed = state.collapsed.has(d.name);
    const tw = document.createElement('span');
    tw.className = 'tw' + (collapsed ? '' : ' open');
    tw.innerHTML = ICON.chevron;
    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.innerHTML = collapsed ? ICON.folder : ICON.folderOpen;
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = d.name;
    item.append(tw, icon, label);
    item.onclick = (e) => {
      e.stopPropagation();
      if (state.collapsed.has(d.name)) state.collapsed.delete(d.name);
      else state.collapsed.add(d.name);
      localStorage.setItem('tracery.collapsed', JSON.stringify([...state.collapsed]));
      renderTree();
    };
    item.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); showDirMenu(e, d.name); };
    wrap.appendChild(item);
    if (!state.collapsed.has(d.name)) {
      const children = document.createElement('div');
      children.className = 'tree-children';
      for (const sub of d.dirs || []) children.appendChild(renderDir(sub));
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
function closeCtxMenu() { if (ctxMenu) { ctxMenu.remove(); ctxMenu = null; } }
document.addEventListener('click', closeCtxMenu);

/** 字型图标（H1 / B / I / ¶ 这类排版项用文字比画图形更清楚） */
const T = (txt, cls = '') => `<span class="mi-txt ${cls}">${txt}</span>`;

function showMenu(x, y, items) {
  closeCtxMenu();
  ctxMenu = document.createElement('div');
  ctxMenu.className = 'context-menu';
  for (const it of items) {
    if (it === '-') { const s = document.createElement('div'); s.className = 'sep'; ctxMenu.appendChild(s); continue; }
    const btn = document.createElement('button');
    if (it.danger) btn.className = 'danger';
    if (it.disabled) btn.disabled = true;
    btn.innerHTML = `<span class="mi-icon${it.iconOn ? ' on' : ''}">${it.icon || ''}</span>`
      + `<span class="mi-label">${it.label}</span>`
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
  showMenu(e.clientX, e.clientY, items);
}

/** 复制一份笔记（同名后加「副本」，自动避让重名） */
async function duplicateFile(f) {
  try {
    const { content } = await Api.note(f.path);
    const base = f.path.replace(/\.md$/i, '');
    const exists = (p) => !!document.querySelector(`#file-tree .tree-item[data-path="${CSS.escape(p)}"]`);
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

function showDirMenu(e, dirName) {
  showMenu(e.clientX, e.clientY, [
    { label: '在此新建笔记', icon: ICON.doc, action: () => createNoteIn(dirName) },
    { label: '在此新建文件夹', icon: ICON.folder, action: () => createFolderIn(dirName) },
  ]);
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
  const canUndo = editor.canUndo();
  const canRedo = editor.canRedo();
  showMenu(e.clientX, e.clientY, [
    { icon: ICON.undo, label: '撤销', kbd: 'Ctrl Z', disabled: !canUndo, action: withSelection(() => editor.undo()) },
    { icon: ICON.redo, label: '重做', kbd: 'Ctrl ⇧ Z', disabled: !canRedo, action: withSelection(() => editor.redo()) },
    '-',
    item(ICON.link, '新增链接', () => editor.wrapSelection('[[', ']]')),
    item(ICON.globe, '新增外部链接', () => editor.wrapSelection('[', '](https://)')),
    '-',
    item(T('B'), '加粗', () => editor.wrapSelection('**', '**')),
    item(T('I', 'it'), '斜体', () => editor.wrapSelection('*', '*')),
    item(T('S', 'st'), '删除线', () => editor.wrapSelection('~~', '~~')),
    item(ICON.pencil, '高亮', () => editor.wrapSelection('==', '==')),
    item(ICON.code, '行内代码', () => editor.wrapSelection('`', '`')),
    '-',
    item(T('H1'), '标题 1', () => editor.setLinePrefix('# ')),
    item(T('H2'), '标题 2', () => editor.setLinePrefix('## ')),
    item(T('H3'), '标题 3', () => editor.setLinePrefix('### ')),
    item(T('¶'), '正文', () => editor.setLinePrefix('')),
    item(ICON.list, '无序列表', () => editor.setLinePrefix('- ')),
    item(ICON.task, '任务', () => editor.setLinePrefix('- [ ] ')),
    item(ICON.quote, '引用', () => editor.setLinePrefix('> ')),
    '-',
    item(ICON.table, '插入表格', () => editor.insertSnippet('| 列 1 | 列 2 |\n| --- | --- |\n|  |  |')),
    item(ICON.codeBlock, '插入代码块', () => editor.insertSnippet('```\n\n```')),
    item(ICON.rule, '插入分割线', () => editor.insertSnippet('---')),
    '-',
    item(ICON.scissors, '剪切', () => document.execCommand('cut')),
    item(ICON.copy, '复制', () => document.execCommand('copy')),
    item(ICON.clipboard, '粘贴', pasteFromClipboard),
    item(ICON.clipboardText, '以纯文本形式粘贴', pasteFromClipboard),
    item(ICON.selectAll, '全选', () => editor.selectAll()),
  ]);
}

function copyText(text) {
  navigator.clipboard.writeText(text).then(
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
  const parts = rel.replace(/\\/g, '/').split('/');
  parts.pop();
  if (parts.length) {
    for (const name of parts) state.collapsed.delete(name);
    localStorage.setItem('tracery.collapsed', JSON.stringify([...state.collapsed]));
    renderTree();
  }
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
    { icon: ICON.scissors, label: '移除图片', action: () => editor.removeImageAt(img) },
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
    const ti = state.tabs.indexOf(f.path);
    if (ti >= 0) state.tabs[ti] = newPath;
    if (state.currentPath === f.path) {
      state.currentPath = newPath;
      localStorage.setItem('tracery.lastNote', newPath);
      $('note-path').textContent = newPath;
    }
    await refreshTree(); refreshGraph(); refreshTags();
    toast('已重命名');
  } catch (e) { toast(e.message); }
}

async function deleteNote(f) {
  const ok = await askConfirm({
    title: `删除「${f.name}」？`,
    desc: '文件会移入回收站，之后可以恢复（文件面板顶部扫帚图标）。',
    okText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await Api.remove(f.path);
    const ti = state.tabs.indexOf(f.path);
    if (ti >= 0) state.tabs.splice(ti, 1);
    if (state.currentPath === f.path) {
      state.currentPath = null;
      localStorage.removeItem('tracery.lastNote');
      editor.load('', '');
      $('note-path').textContent = '';
      refreshRightPanels(null);
    }
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
    openNote(path, null, { newTab: true });
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
  if (!state.tree) return false;
  let found = false;
  const walk = (n) => {
    if (found) return;
    for (const f of n.files || []) if (f.path === p) { found = true; return; }
    for (const d of n.dirs || []) walk(d);
  };
  walk(state.tree);
  return found;
}

function saveTabsState() {
  try {
    localStorage.setItem(tabsKey(), JSON.stringify({ tabs: state.tabs, active: state.activeTab }));
    if (state.currentPath) localStorage.setItem('tracery.lastNote', state.currentPath);
  } catch { /* 隐私模式下忽略 */ }
}

function loadTabsState() {
  try {
    const raw = JSON.parse(lsGet(tabsKey()) || '{}');
    state.tabs = (Array.isArray(raw.tabs) ? raw.tabs : []).filter((p) => hasNotePath(p));
    state.activeTab = Number.isInteger(raw.active)
      ? Math.min(Math.max(raw.active, 0), state.tabs.length - 1)
      : state.tabs.length - 1;
  } catch {
    state.tabs = [];
    state.activeTab = -1;
  }
}

function renderTabs() {
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
    tab.title = p;
    const name = document.createElement('span');
    name.className = 'tab-name';
    name.textContent = basename(p);
    const close = document.createElement('button');
    close.className = 'tab-close';
    close.title = '关闭 (Ctrl+W)';
    close.innerHTML = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3.2 3.2l5.6 5.6M8.8 3.2l-5.6 5.6"/></svg>';
    close.onclick = (e) => { e.stopPropagation(); closeTab(i); };
    tab.append(name, close);
    tab.onclick = () => activateTab(i);
    tab.onauxclick = (e) => { if (e.button === 1) { e.preventDefault(); closeTab(i); } };
    list.appendChild(tab);
  });
  const active = list.children[state.activeTab];
  active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  updateTabOverflow();
}

/** 标签溢出时给可滚的一侧加渐隐（配合 CSS 的 mask），提示那边还有标签 */
function updateTabOverflow() {
  const list = $('tablist');
  if (!list) return;
  if (list.hidden) { list.removeAttribute('data-overflow'); return; }
  const max = list.scrollWidth - list.clientWidth;
  if (max <= 1) { list.removeAttribute('data-overflow'); return; }
  const atStart = list.scrollLeft <= 1;
  const atEnd = list.scrollLeft >= max - 1;
  list.dataset.overflow = atStart ? 'end' : atEnd ? 'start' : 'both';
}

/** 把某篇笔记加载进当前标签（不改变标签列表） */
async function loadTab(path, heading) {
  try {
    const { content } = await Api.note(path);
    state.currentPath = path;
    $('note-path').textContent = path;
    editor.load(path, content);
    renderTree(); // 高亮
    pushRecent(path);
    refreshRightPanels(content);
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
  if (i < 0 || i >= state.tabs.length) return;
  const path = state.tabs[i];
  if (state.activeTab === i && state.currentPath === path) {
    if (heading) editor.scrollToHeading(heading);
    return;
  }
  await editor.flush();
  state.activeTab = i;
  await loadTab(path, heading);
}

async function closeTab(i) {
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
  if (state.tabs[state.activeTab] !== prevPath) await loadTab(state.tabs[state.activeTab]);
  else saveTabsState();
}

/** 外部删除/同步后清理失效标签 */
function pruneTabs() {
  const before = state.tabs.length;
  const prevPath = state.currentPath;
  state.tabs = state.tabs.filter((p) => hasNotePath(p));
  if (state.tabs.length === before) return;
  if (!state.tabs.length) {
    state.activeTab = -1;
    state.currentPath = null;
    return;
  }
  if (!state.tabs.includes(prevPath)) {
    state.activeTab = Math.min(state.activeTab, state.tabs.length - 1);
    loadTab(state.tabs[state.activeTab]);
  } else {
    state.activeTab = state.tabs.indexOf(prevPath);
  }
  renderTabs();
  saveTabsState();
}

/* ================= 打开笔记 ================= */
/**
 * @param {string} path
 * @param {string} [heading]
 * @param {{newTab?: boolean}} [opts] 默认在当前标签打开；newTab=true 时新开一个
 */
async function openNote(path, heading, opts = {}) {
  if (!path) return;
  const existing = state.tabs.indexOf(path);
  if (existing >= 0) { await activateTab(existing, heading); return; }
  if (state.currentPath === path) {
    if (heading) editor.scrollToHeading(heading);
    return;
  }
  await editor.flush();
  const newTab = opts.newTab === true || state.tabs.length === 0;
  if (newTab) {
    const at = state.activeTab < 0 ? 0 : state.activeTab + 1;
    state.tabs.splice(at, 0, path);
    state.activeTab = at;
  } else {
    state.tabs[state.activeTab] = path;
  }
  await loadTab(path, heading);
}

function refreshRightPanels(content) {
  // Windows 上的笔记可能是 CRLF：JS 正则里 `.` 不匹配 \r，`$` 也不会落在 \r 之前 →
  // 用 `^(#{1,6})\s+(.*)$` 逐行扫会把 CRLF 笔记的标题全部漏掉（大纲变空）。
  // 统一把换行归一化再扫（标签、代码围栏的判断同样受益）。
  const src = String(content || '').replace(/\r\n?/g, '\n');
  // 大纲
  const outline = $('outline-list');
  outline.innerHTML = '';
  const heads = [];
  let inFence = false;
  for (const line of src.split('\n')) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) heads.push({ level: m[1].length, text: m[2].replace(/[*_`~]/g, '') });
  }
  if (!heads.length) {
    outline.innerHTML = '<div class="panel-empty">当前笔记没有标题</div>';
  } else {
    for (const h of heads) {
      const item = document.createElement('span');
      item.className = `outline-item lv${Math.min(4, h.level)}`;
      item.textContent = h.text;
      item.onclick = () => editor.scrollToHeading(h.text);
      outline.appendChild(item);
    }
  }
  // 标签
  const tags = new Set();
  const tagRe = /(^|[\s(（])#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu;
  let inF = false;
  for (const line of src.split('\n')) {
    if (/^\s*```/.test(line)) { inF = !inF; continue; }
    if (inF) continue;
    let m;
    const re = new RegExp(tagRe.source, 'gu');
    while ((m = re.exec(line))) tags.add(m[2]);
  }
  const tagBox = $('note-tags-list');
  tagBox.innerHTML = '';
  if (!tags.size) {
    tagBox.innerHTML = '<div class="panel-empty">当前笔记没有标签</div>';
  } else {
    const cloud = document.createElement('div');
    cloud.className = 'tag-cloud';
    for (const t of tags) {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      chip.textContent = `#${t}`;
      chip.onclick = () => { switchPanel('search'); $('search-input').value = `#${t}`; runSearch(`#${t}`); };
      cloud.appendChild(chip);
    }
    tagBox.appendChild(cloud);
  }
  // 反链
  refreshBacklinks();
}

const refreshBacklinks = debounce(async () => {
  const box = $('backlinks-list');
  if (!state.currentPath) {
    box.innerHTML = '<div class="panel-empty">打开一篇笔记后显示反链</div>';
    return;
  }
  try {
    const { backlinks, unresolved } = await Api.links(state.currentPath);
    box.innerHTML = '';
    $('backlink-count').textContent = String(backlinks.length);
    if (!backlinks.length && !unresolved.length) {
      box.innerHTML = '<div class="panel-empty">还没有笔记链接到当前笔记</div>';
    }
    const name = basename(state.currentPath);
    for (const bl of backlinks) {
      const item = document.createElement('div');
      item.className = 'backlink-item';
      const n = document.createElement('div');
      n.className = 'bl-name';
      n.textContent = bl.name;
      const ctx = document.createElement('div');
      ctx.className = 'bl-ctx';
      ctx.innerHTML = bl.contexts.map((c) =>
        `L${c.line} · ${escapeText(c.text).replace(new RegExp(escapeRe(`[[${name}`), 'gi'), (m) => `<mark>${m}</mark>`)}`
      ).join('<br>');
      item.append(n, ctx);
      item.onclick = () => openNote(bl.path, null, { newTab: true });
      box.appendChild(item);
    }
    if (unresolved.length) {
      const title = document.createElement('div');
      title.className = 'panel-empty';
      title.style.padding = '10px 8px 4px';
      title.textContent = `未创建的链接（${unresolved.length}）`;
      box.appendChild(title);
      for (const u of unresolved) {
        const item = document.createElement('div');
        item.className = 'backlink-item';
        item.innerHTML = `<div class="bl-name" style="color:var(--link-unresolved)">[[${escapeText(u.raw)}]]</div>`;
        item.onclick = async () => {
          const ok = await askConfirm({
            title: `创建「${u.raw}」？`,
            desc: '这篇笔记还不存在，现在创建它。',
            okText: '创建',
          });
          if (!ok) return;
          const path = u.raw.replace(/\.md$/i, '') + '.md';
          try {
            await Api.createNote(path, '');
            await refreshTree(); refreshGraph(); refreshTags();
            openNote(path, null, { newTab: true });
          } catch (e) { toast(e.message); }
        };
        box.appendChild(item);
      }
    }
  } catch { /* ignore */ }
}, 150);

function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/* ================= 面板切换 ================= */
function switchPanel(name) {
  for (const btn of document.querySelectorAll('.ribbon-btn[data-panel]')) {
    btn.classList.toggle('active', btn.dataset.panel === name);
  }
  // 只切左栏的面板！用 .sidebar .panel 会连右侧栏（大纲/反链/标签）一起命中，
  // 切到「文件」时它们因为 id 不匹配被摘掉 active —— 表现就是右侧大纲消失。
  for (const panel of document.querySelectorAll('#sidebar .panel')) {
    panel.classList.toggle('active', panel.id === `panel-${name}`);
  }
  // 切到别的面板就退出图谱全屏
  if (name !== 'graph' && document.body.classList.contains('graph-focus')) toggleGraphFocus(false);
  if (name === 'graph' && graphView && state.graph) {
    graphView.opts.activePath = state.currentPath;
    graphView.setData(state.graph);
  }
  if (name === 'search') {
    setTimeout(() => $('search-input').focus(), 30);
    if (!$('search-input').value.trim()) renderRecentList($('search-results'));
  }
  if (name === 'tags') refreshTags();
}

/** 右侧栏切换（大纲 / 反链 / 标签）：三个按钮 + 一次只显示一个面板 */
function switchRightPanel(name) {
  for (const b of document.querySelectorAll('.rs-tab')) b.classList.toggle('active', b.dataset.rs === name);
  for (const p of document.querySelectorAll('#sidebar-right .panel')) {
    p.classList.toggle('active', p.id === `panel-${name}`);
  }
  localStorage.setItem('tracery.rsTab', name);
}

/** 图谱全屏：把左侧面板撑满窗口（保留功能区图标栏），专注看图 */
function toggleGraphFocus(force) {
  const on = typeof force === 'boolean' ? force : !document.body.classList.contains('graph-focus');
  document.body.classList.toggle('graph-focus', on);
  const btn = $('btn-graph-full');
  if (btn) {
    btn.classList.toggle('active', on);
    btn.title = on ? '退出全屏 (Esc)' : '全屏看图谱';
  }
  if (on) {
    switchPanel('graph');
    // 等布局稳定后让图谱适配新尺寸（力导向还要跑一会儿，二次适配兜底）
    setTimeout(() => graphView?.fit({ reheat: true }), 240);
    setTimeout(() => graphView?.fit(), 900);
  } else {
    setTimeout(() => graphView?.fit({ reheat: true }), 240);
    setTimeout(() => graphView?.fit(), 900);
  }
}

/* ================= 搜索 ================= */
/** 搜索面板空查询时的「最近打开」 */
function renderRecentList(box) {
  box.innerHTML = '';
  const list = state.recent || [];
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
    { icon: '↶', name: '撤销（Ctrl+Z）', sub: '命令', action: () => editor.undo() },
    { icon: '↷', name: '重做（Ctrl+Shift+Z）', sub: '命令', action: () => editor.redo() },
    { icon: '🎨', name: '切换主题皮肤（Apple 风 / Obsidian 风）', sub: '外观', action: cycleThemeSkin },
    { icon: '👁', name: '切换实时预览 / 源码模式', sub: '命令', action: () => editor.toggleMode() },
    { icon: '🕸️', name: '打开图谱视图', sub: '命令', action: () => switchPanel('graph') },
    { icon: '🔍', name: '搜索笔记内容', sub: '命令', action: () => { switchPanel('search'); $('search-input').focus(); } },
    { icon: '📤', name: '导出为 HTML', sub: '命令', action: () => exportHtml() },
    { icon: '📄', name: '导出为 PDF', sub: '命令', action: () => exportPdf() },
    { icon: '🕘', name: '查看历史版本', sub: '命令', action: () => openHistory() },
    { icon: '🏷️', name: '查看所有标签', sub: '命令', action: () => switchPanel('tags') },
    { icon: '📂', name: '切换 / 管理仓库…', sub: '命令', action: openVaultPicker },
    { icon: '✏️', name: '新建绘图并插入笔记', sub: '命令', action: openDrawPanel },
    { icon: '☰', name: '折叠 / 展开左侧栏', sub: '命令', action: () => $('sidebar').classList.toggle('collapsed') },
    { icon: '▤', name: '折叠 / 展开右侧栏', sub: '命令', action: () => $('sidebar-right').classList.toggle('collapsed') },
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
 * 双内核：block（旧块级 contenteditable）/ cm（CodeMirror 6 行级）。
 * 选择顺序：URL `?engine=cm|block` 覆盖 → 设置 `editorEngine` → 默认 block。
 * 两个内核实现同一套方法契约（docs/EDITOR-MIGRATION.md 第 5 节），
 * 所以下面的回调与后文所有 editor.xxx() 调用对二者通用；
 * cm 额外需要 fileUrl / loadNote / saveAsset（块级内核自带这些，忽略即可）。 */
const engineOverride = new URLSearchParams(location.search).get('engine');
const ENGINE = (engineOverride === 'cm' || engineOverride === 'block')
  ? engineOverride
  : (getSettings().editorEngine || 'block');

editor = new (ENGINE === 'cm' ? CmEditor : LiveEditor)({
  liveEl: $('editor-live'),
  sourceEl: $('editor-source'),
  gutterEl: $('source-gutter'),
  sourceWrap: $('source-wrap'),
  resolveLink: (target) => {
    const clean = target.split('#')[0].trim().replace(/\.md$/i, '');
    return state.nameIndex.get(clean.toLowerCase()) || null;
  },
  resolveFile: (name) => resolveVaultFile(name),
  fileUrl: (path) => Api.fileUrl(path),
  // ![[笔记]] 嵌入卡片的内容解析（与 editor.js 的 _renderEmbed 同口径：截 3000 字）
  loadNote: async (name) => {
    const p = resolveVaultFile(name);
    if (!p) return null;
    try { const { content } = await Api.note(p); return (content || '').slice(0, 3000); } catch { return null; }
  },
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
    // 与 editor.js._saveAssetFile 同口径：截图/复制的图默认叫 image.png，一堆 image-2.png
    // 很难认，换成带时间戳的名字（块级内核在同一处做这件事，cm 侧别漏）
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
    try {
      await Api.saveNote(path, content);
      $('status-saved').textContent = `已保存 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
      refreshGraph(); refreshTags();
      refreshBacklinks();
    } catch (e) { toast(`保存失败：${e.message}`); }
  },
  onDirtyChange: (dirty) => {
    $('status-saved').textContent = dirty ? '未保存…' : '';
  },
  onChange: (content) => {
    const words = countWords(content);
    $('status-words').textContent = `${words} 词`;
    refreshRightPanelsThrottled(content);
  },
  onModeChange: (mode) => {
    const label = $('btn-mode-label');
    if (label) label.textContent = mode === 'live' ? '实时预览' : '源码';
    $('btn-mode').classList.toggle('is-source', mode === 'source');
  },
});

// cm 内核的 DOM 收尾：#editor-live 变成 CM 挂载点（CM 自带 contenteditable，
// 外层容器不能再可编辑）；源码 textarea 不再使用，直接隐藏。
if (ENGINE === 'cm') {
  $('editor-live').contentEditable = 'false';
  const sw = $('source-wrap');
  if (sw) sw.hidden = true;
}
// 测试/调试钩子：拿到当前编辑内核实例（test/engine-test.mjs 用 getContent/view 做断言）
window.__editor = editor;

// 表格里：Tab / Shift+Tab 在单元格间跳，回车在当前行下方加一行（仿 Obsidian）
// 用捕获阶段：编辑器自己的 Tab 是「缩进」，必须抢在它前面，并阻止冒泡
$('editor-live').addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' && e.key !== 'Enter') return;
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const anchor = sel.anchorNode;
  const cell = (anchor?.nodeType === 1 ? anchor : anchor?.parentElement)?.closest?.('td, th');
  if (!cell) return;
  const table = cell.closest('table');
  if (!table) return;
  e.stopPropagation();

  if (e.key === 'Tab') {
    e.preventDefault();
    const cells = [...table.querySelectorAll('th, td')];
    const next = cells[cells.indexOf(cell) + (e.shiftKey ? -1 : 1)];
    if (!next) return;
    if (!placeCaretInBlock(next, false)) {
      const r = document.createRange();
      r.setStart(next, 0);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    return;
  }

  // 回车：在表头里不处理；拖到最后一行下面加一行同列数的新行
  const tr = cell.closest('tr');
  const tbody = table.querySelector('tbody');
  if (!tr || !tbody || !tbody.contains(tr)) return;
  e.preventDefault();
  const col = [...tr.children].indexOf(cell);
  const newTr = document.createElement('tr');
  const cols = tr.children.length;
  for (let i = 0; i < cols; i++) {
    const td = document.createElement('td');
    td.appendChild(document.createElement('br'));
    newTr.appendChild(td);
  }
  tr.after(newTr);
  const target = newTr.children[Math.max(0, col)];
  const r = document.createRange();
  r.setStart(target, 0);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
  $('editor-live').focus();
  // 让输入事件走一遍：序列化 + 自动保存
  $('editor-live').dispatchEvent(new InputEvent('input', { bubbles: true }));
}, true);
$('editor-live').addEventListener('contextmenu', onEditorContextMenu);
$('editor-source').addEventListener('contextmenu', onEditorContextMenu);

/**
 * 点击落点（实时预览）。
 * 渲染模型里「源码的一行」必须对应一块可点的区域。空行现在是真的占一行高的
 * placeholder（见 style.css 的 .md-blank），点它就是点那一行，这里显式落光标——
 * 浏览器对「只有 <br> 的空块」默认会把光标塞进附近的文字节点，一点就打错地方。
 * 剩下的空隙只可能是块的外边距（e.target 就是编辑区本身），按距离就近落：
 * 靠上一块 → 上一块末尾，靠下一块 → 下一块开头。
 * 标题例外：绝不接受这种「补字」——点到标题下方的空隙再打字，字补进标题里
 * 是最不容易发现、破坏性最大的操作，直接落到下一块开头。
 */
$('editor-live').addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  const root = e.currentTarget;

  // ① 点空行：光标固定在这一行（等它已经有字了才交给浏览器按字定位）
  const blank = e.target.closest?.('.md-blank');
  if (blank && root.contains(blank)) {
    if (blank.textContent.trim()) return;
    placeCaretAtBlock(blank);
    e.preventDefault();
    root.focus();
    return;
  }

  // ② 点在外边距上：既不在上一块里也不在下一块里
  if (e.target !== root) return;
  const blocks = [...root.children].filter((el) => el.offsetHeight > 0);
  if (!blocks.length) return;
  let prev = null;
  let next = null;
  for (const el of blocks) {
    const r = el.getBoundingClientRect();
    if (r.bottom <= e.clientY) prev = el;
    else if (r.top >= e.clientY && !next) next = el;
  }
  let target = null;
  let atEnd = true;
  if (prev && next) {
    const pr = prev.getBoundingClientRect();
    const nr = next.getBoundingClientRect();
    atEnd = e.clientY - pr.bottom <= nr.top - e.clientY;
    target = atEnd ? prev : next;
  } else if (prev) {
    target = prev;
  } else if (next) {
    target = next;
    atEnd = false;
  }
  // 标题不接收「补字」：改落到下一块开头（没有下一块时才允许落在标题末尾）
  if (target && atEnd && /^H[1-6]$/.test(target.tagName) && next) {
    target = next;
    atEnd = false;
  }
  if (!target || !placeCaretInBlock(target, atEnd)) return;
  e.preventDefault();
  root.focus();
});

/** 把光标放到块的首行（空块 <p><br></p> 也接得住） */
function placeCaretAtBlock(block) {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  const first = walker.nextNode();
  const range = document.createRange();
  if (first) range.setStart(first, 0);
  else range.setStart(block, 0);
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

/** 把光标放到块的末尾（atEnd）或开头 */
function placeCaretInBlock(block, atEnd) {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let first = null;
  let last = null;
  let t;
  while ((t = walker.nextNode())) { if (!first) first = t; last = t; }
  const range = document.createRange();
  if (!first) {
    // 空块：光标直接放进块里，否则浏览器会把它甩到别的块
    range.setStart(block, 0);
  } else {
    const node = atEnd ? last : first;
    range.setStart(node, atEnd ? node.textContent.length : 0);
  }
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
}

// 在已选中的文字上右键时保住选区（否则浏览器先折叠选区，「加粗选中文字」就变成插入空标记）
$('editor-live').addEventListener('mousedown', (e) => {
  if (e.button !== 2) return;
  const sel = window.getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return;
  const inside = [...sel.getRangeAt(0).getClientRects()].some(
    (r) => e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom,
  );
  if (inside) e.preventDefault();
});

const refreshRightPanelsThrottled = debounce((content) => refreshRightPanels(content), 400);

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
    onNodeClick: (path) => openNote(path),
  });
  if (state.graph) graphView.setData(state.graph);
}

/** 打开绘图面板：画完的 PNG 会插入到当前笔记光标处 */
function openDrawPanel() {
  if (!state.currentPath) { toast('先打开一篇笔记，绘图会插入到光标处'); return; }
  openDraw({
    getNotePath: () => state.currentPath,   // 「跟随笔记」模式时决定绘图落点
    onInserted: async (path) => {
      await refreshTree();
      await refreshGraph();
      editor.insertSnippet(`![[${path}|640]]`);
    },
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
  $('btn-toggle-left').onclick = () => $('sidebar').classList.toggle('collapsed');
  $('btn-toggle-right').onclick = () => $('sidebar-right').classList.toggle('collapsed');
  // 折叠状态要看得出来：右栏被折叠时（大纲「消失」了）按钮必须亮起提示，
  // 否则用户会以为面板出 bug 了
  const syncSidebarToggles = () => {
    $('btn-toggle-left').classList.toggle('is-off', $('sidebar').classList.contains('collapsed'));
    $('btn-toggle-right').classList.toggle('is-off', $('sidebar-right').classList.contains('collapsed'));
  };
  new MutationObserver(syncSidebarToggles).observe($('sidebar'), { attributes: true, attributeFilter: ['class'] });
  new MutationObserver(syncSidebarToggles).observe($('sidebar-right'), { attributes: true, attributeFilter: ['class'] });
  syncSidebarToggles();
  $('vault-name').onclick = () => openVaultPicker();

  // 标签条：滚轮横滚 + 溢出渐隐（标签多了不挤压，滚着看）
  const tablist = $('tablist');
  tablist.addEventListener('scroll', updateTabOverflow, { passive: true });
  tablist.addEventListener('wheel', (e) => {
    if (tablist.scrollWidth <= tablist.clientWidth) return;
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;   // 触摸板横滑交给浏览器
    tablist.scrollLeft += e.deltaY;
    e.preventDefault();
  }, { passive: false });
  window.addEventListener('resize', updateTabOverflow);

  // 左侧功能区
  for (const btn of document.querySelectorAll('.ribbon-btn[data-panel]')) {
    btn.onclick = () => switchPanel(btn.dataset.panel);
  }
  // 右侧栏三个切换按钮（记住上次选的）
  for (const btn of document.querySelectorAll('.rs-tab')) {
    btn.onclick = () => switchRightPanel(btn.dataset.rs);
  }
  switchRightPanel(localStorage.getItem('tracery.rsTab') || 'outline');
  $('btn-new-note').onclick = () => createNoteIn('');
  // 右键「+」：新建笔记 / 新建文件夹
  $('btn-new-note').oncontextmenu = (e) => {
    e.preventDefault();
    showMenu(e.clientX, e.clientY, [
      { label: '新建笔记', icon: ICON.doc, action: () => createNoteIn('') },
      { label: '新建文件夹', icon: ICON.folder, action: () => createFolderIn('') },
    ]);
  };
  $('btn-new-note-2').onclick = () => createNoteIn('');
  $('btn-trash').onclick = () => openTrash();
  $('btn-new-folder').onclick = () => createFolderIn('');
  $('btn-collapse-tree').onclick = () => {
    const all = new Set();
    const walk = (node) => { for (const d of node.dirs || []) { all.add(d.name); walk(d); } };
    if (state.tree) walk(state.tree);
    if (state.collapsed.size < all.size) state.collapsed = all;
    else state.collapsed = new Set();
    localStorage.setItem('tracery.collapsed', JSON.stringify([...state.collapsed]));
    renderTree();
  };  $('btn-graph-reheat').onclick = () => graphView?._reheat();
  $('btn-graph-zoom-in').onclick = () => graphView?.zoomIn();
  $('btn-graph-zoom-out').onclick = () => graphView?.zoomOut();
  $('btn-graph-fit').onclick = () => graphView?.fit();
  $('btn-graph-full').onclick = () => toggleGraphFocus();
  initResizers();

  // 绘图
  $('btn-draw').onclick = () => openDrawPanel();
  $('btn-mode').onclick = () => editor.toggleMode();
  $('btn-settings').onclick = () => openSettings();

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

  // 快捷键
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === ',') { e.preventDefault(); openSettings(); return; }
    if (mod && e.key.toLowerCase() === 'p' && !e.shiftKey) { e.preventDefault(); openPalette(); }
    else if (mod && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); switchPanel('search'); $('search-input').focus(); }
    else if (mod && e.shiftKey && e.key.toLowerCase() === 'd') { e.preventDefault(); openDrawPanel(); }
    else if (mod && e.key.toLowerCase() === 'n' && !e.shiftKey) { e.preventDefault(); createNoteIn(''); }
    else if (mod && e.key.toLowerCase() === 'e') { e.preventDefault(); editor.toggleMode(); }
    else if (mod && e.key.toLowerCase() === 'w' && !e.shiftKey) { e.preventDefault(); closeTab(state.activeTab); }
    else if (mod && e.key === 'Tab') {
      e.preventDefault();
      const n = state.tabs.length;
      if (n > 1) activateTab((state.activeTab + (e.shiftKey ? -1 : 1) + n) % n);
    }
    else if (mod && e.key === '\\') { e.preventDefault(); $('sidebar').classList.toggle('collapsed'); }
    else if (mod && e.shiftKey && e.key === '|') { e.preventDefault(); $('sidebar-right').classList.toggle('collapsed'); }
    else if (e.key === 'Escape' && settingsIsOpen()) { e.preventDefault(); closeSettings(); }
    else if (e.key === 'Escape' && !$('palette').hidden) closePalette();
    else if (e.key === 'Escape' && !$('welcome').hidden) closeWelcome();
    else if (e.key === 'Escape' && document.body.classList.contains('graph-focus')) { e.preventDefault(); toggleGraphFocus(false); }
  });

  // 编辑器区域滚动时关闭链接预览（capture：cm 内核的滚动发生在内部 `.cm-scroller`，scroll 不冒泡）
  $('editor-live').addEventListener('scroll', () => {
    const pop = $('link-preview');
    if (pop) pop.hidden = true;
  }, true);

  // 初始化图谱（面板首次显示时）
  const observer = new MutationObserver(() => {
    if ($('panel-graph').classList.contains('active') && !graphView) initGraph();
  });
  observer.observe($('panel-graph'), { attributes: true, attributeFilter: ['class'] });
}

/* ================= WebSocket 同步 ================= */
function onWsMessage(msg) {
  if (msg.type === 'fs-change') {
    const paths = msg.paths || [];
    const affectsCurrent = state.currentPath && paths.some((p) => p === state.currentPath || p === '*' || p === state.currentPath + '.md');
    refreshTree().then(() => pruneTabs());
    refreshGraph();
    refreshTags();
    if (affectsCurrent && !editor.dirty) {
      Api.note(state.currentPath).then(({ content }) => {
        editor.load(state.currentPath, content, { keepMode: true });
        refreshRightPanels(content);
      }).catch(() => {});
    } else if (state.currentPath) {
      refreshBacklinks();
    }
  } else if (msg.type === 'vault-opened') {
    // 其他窗口切换了仓库：同步标题栏与各索引
    Api.state().then(async (s) => {
      if (s.vault) {
        state.vault = s.vault;
        state.currentPath = null;
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

boot();
