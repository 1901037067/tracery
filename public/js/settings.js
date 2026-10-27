/**
 * Tracery 设置面板 + 外观设置引擎
 * 设计：macOS 系统设置风格（左侧导航 + 右侧分组行），所有改动即时预览。
 * 外观 = CSS 变量，所以「改设置」不需要重载页面，也不碰布局代码。
 */
import { Api, toast, debounce } from './api.js';
import { initSyncPane } from './sync-ui.js';
import { HOTKEY_COMMANDS, bindingFor, shortcutFromEvent, shortcutLabel, validateShortcut, sanitizeHotkeys } from './hotkeys.js';
import { DEFAULT_LAYOUT, LAYOUT_FIELDS, normalizeLayout } from './layout-settings.js';
import { applyWorkspaceLayout } from './workspace-layout.js';
import { PANE_NAMES, movePane } from './pane-layout.js';
import { readPresets, writePresets, encodePreset, decodePreset } from './layout-presets.js';
import { askText } from './dialog.js';
import { uiIcon } from './ui-icons.js';
import { upgradeSelects, refreshSelect, closeSelect } from './select-control.js';
import { initHistoryBackup } from './history-backup.js';
import { initFullBackup, fullBackupMarkup } from './full-backup.js';

export const DEFAULT_SETTINGS = {
  themeName: 'apple',
  themeMode: 'dark',
  accent: 'blue',
  radius: 'default',
  fontSize: 16,
  editorWidth: 720,
  layout: DEFAULT_LAYOUT,
  autosave: 900,
  lineNumbers: true,   // 行号：源码模式与实时预览共用同一个开关
  startup: 'last',
  hotkeys: {},
  // 附件管理：新图片/文件（粘贴、拖入、绘图）的落点
  attachment: {
    mode: 'folder',    // folder=指定文件夹 | note=跟随笔记所在目录 | root=仓库根目录
    folder: '附件',
  },
};

/**
 * 计算新附件的落点（相对仓库根目录的目录，'' = 根目录）。
 * 三种模式对应 Obsidian 的「新附件默认位置」：
 *   folder — 指定文件夹（默认 附件/，也支持 附件/图片 这类子目录）
 *   note   — 跟随笔记所在目录（ Obsidian 默认行为）
 *   root   — 仓库根目录
 * 放在 settings.js 是因为它由设置形状决定，editor/draw 都需要同一份逻辑。
 */
export function resolveAssetDir(settings, noteRel) {
  const a = settings?.attachment || DEFAULT_SETTINGS.attachment;
  if (a.mode === 'note') return noteRel ? noteRel.replace(/\/[^/]*$/, '') : '';
  if (a.mode === 'root') return '';
  return a.folder || '附件';
}

/** 强调色预设（亮/暗各一档，暗色更亮以保对比度） */
export const ACCENTS = {
  blue: { label: '系统蓝', light: '#0071e3', dark: '#0a84ff' },
  purple: { label: '紫罗兰', light: '#7c5cff', dark: '#9b7cff' },
  green: { label: '松绿', light: '#0f9d58', dark: '#34c759' },
  orange: { label: '琥珀', light: '#d9730d', dark: '#ff9f0a' },
  pink: { label: '玫红', light: '#e0245e', dark: '#ff4d7d' },
  graphite: { label: '石墨', light: '#4b4b50', dark: '#a0a0a6' },
};

/** 圆角预设：[xs, sm, md, lg, xl] */
const RADII = {
  compact: [4, 8, 10, 14, 18],
  default: [6, 10, 14, 20, 26],
  large: [8, 12, 18, 26, 34],
};


let settings = { ...DEFAULT_SETTINGS };
let mediaQuery = null;
let onSettingsApplied = null;
let workspaceActions = {};
export function configureWorkspaces(actions) { workspaceActions = actions; }

/** HTML 属性/文本转义（设置面板模板里插用户可改的值，如附件文件夹名） */
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

export const getSettings = () => ({ ...settings });

/* ---------------- 应用设置到界面 ---------------- */
function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function effectiveMode() {
  if (settings.themeMode === 'auto') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return settings.themeMode;
}

export function applySettings() {
  const root = document.documentElement;
  const mode = effectiveMode();

  // 亮暗
  root.dataset.theme = mode;

  // 皮肤
  const safeTheme = /^[a-z0-9_-]+$/i.test(settings.themeName || '') ? settings.themeName : 'apple';
  const link = document.getElementById('theme-css');
  const href = `/themes/${safeTheme}.css`;
  if (link && link.getAttribute('href') !== href) link.href = href;

  // 强调色（内联变量优先级高于主题文件）
  const acc = ACCENTS[settings.accent] || ACCENTS.blue;
  const color = mode === 'dark' ? acc.dark : acc.light;
  root.style.setProperty('--accent', color);
  root.style.setProperty('--accent-hover', color);
  root.style.setProperty('--accent-soft', hexToRgba(color, mode === 'dark' ? 0.20 : 0.12));
  root.style.setProperty('--link', mode === 'dark' ? acc.dark : acc.light);

  // 圆角
  const [xs, sm, md, lg, xl] = RADII[settings.radius] || RADII.default;
  root.style.setProperty('--r-xs', `${xs}px`);
  root.style.setProperty('--r-sm', `${sm}px`);
  root.style.setProperty('--r-md', `${md}px`);
  root.style.setProperty('--r-lg', `${lg}px`);
  root.style.setProperty('--r-xl', `${xl}px`);

  // 编辑器排版
  root.style.setProperty('--editor-font-size', `${settings.fontSize}px`);
  root.style.setProperty('--editor-width', `${settings.editorWidth}px`);
  root.style.setProperty('--sidebar-left-width', `${settings.layout.leftWidth}px`);
  root.style.setProperty('--sidebar-right-width', `${settings.layout.rightWidth}px`);
  root.style.setProperty('--editor-line-height', settings.layout.lineHeight);
  root.style.setProperty('--editor-content-padding', `${settings.layout.contentPadding}px`);
  applyWorkspaceLayout(settings.layout);

  // 系统主题联动
  if (mediaQuery) { mediaQuery.onchange = null; mediaQuery = null; }
  if (settings.themeMode === 'auto') {
    mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    mediaQuery.onchange = () => applySettings();
  }

  onSettingsApplied?.(getSettings());
}

const PENDING_LAYOUT_KEY = 'tracery.pendingLayout';
export function initSettings(initial, { recoverPending = true } = {}) {
  settings = { ...DEFAULT_SETTINGS, ...(initial || {}) };
  // 仅在尚未保存新布局时迁移旧的拖动宽度；之后以设置为准。
  const legacy = {};
  if (!initial?.layout) {
    for (const [field, key] of [['leftWidth', 'sidebarW'], ['rightWidth', 'rightW']]) {
      const raw = localStorage.getItem(`tracery.ui.${key}`) ?? localStorage.getItem(`evnote.ui.${key}`);
      if (raw !== null && Number.isFinite(Number(raw))) legacy[field] = Number(raw);
    }
  }
  settings.layout = normalizeLayout(initial?.layout || legacy);
  if (Object.keys(legacy).length) persist({ layout: settings.layout });
  if (recoverPending) {
    try {
      const journal = JSON.parse(localStorage.getItem(PENDING_LAYOUT_KEY) || 'null');
      if (journal && typeof journal === 'object' && !Array.isArray(journal)) {
        settings.layout = normalizeLayout(journal, settings.layout);
        persist({ layout: settings.layout });
      }
    } catch { localStorage.removeItem(PENDING_LAYOUT_KEY); }
  }
  settings.hotkeys = sanitizeHotkeys(settings.hotkeys);
  applySettings();
  renderActiveControls();
}

/** 积攒多次改动，防抖后一次性落盘（避免连点时中间改动被丢弃） */
let pendingPatch = {};
let savingPatch = null;
function mergePatch(base, patch) {
  const result = { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    result[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? { ...result[key], ...value } : value;
  }
  return result;
}
/** 服务端广播可先于请求响应到达；保留尚在提交/防抖队列中的本机修改。 */
export function receiveSettings(initial) {
  initSettings(mergePatch(mergePatch(initial, savingPatch), pendingPatch), { recoverPending: false });
}
const flushSettings = debounce(async () => {
  if (savingPatch) return;
  const patch = pendingPatch;
  pendingPatch = {};
  if (!Object.keys(patch).length) return;
  savingPatch = patch;
  try {
    const res = await Api.saveSettings(patch);
    if (res?.settings) settings = mergePatch({ ...settings, ...res.settings }, pendingPatch);
    if (patch.layout && !pendingPatch.layout) localStorage.removeItem(PENDING_LAYOUT_KEY);
  } catch { toast('设置保存失败'); }
  finally { savingPatch = null; if (Object.keys(pendingPatch).length) flushSettings(); }
}, 400);

function persist(patch) {
  for (const [key, value] of Object.entries(patch)) {
    pendingPatch[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? { ...pendingPatch[key], ...value } : value;
  }
  flushSettings();
}

/** 点分键（如 attachment.folder）→ 嵌套补丁对象 */
function patchByPath(key, value) {
  if (!key.includes('.')) return { [key]: value };
  const i = key.indexOf('.');
  return { [key.slice(0, i)]: patchByPath(key.slice(i + 1), value) };
}
/** 按点分键读设置值 */
function getByPath(key) {
  return key.split('.').reduce((o, k) => (o == null ? o : o[k]), settings);
}

/** 修改设置：立即生效 + 防抖落盘（嵌套对象一层深合并，避免丢同组其他字段） */
export function updateSettings(patch) {
  if (patch.layout) patch = { ...patch, layout: normalizeLayout(patch.layout, settings.layout) };
  // 宽度拖动结束后立刻刷新也能恢复；服务端确认后清掉这份待提交记录。
  if (patch.layout) localStorage.setItem(PENDING_LAYOUT_KEY, JSON.stringify(patch.layout));
  const next = { ...settings };
  for (const [k, v] of Object.entries(patch)) {
    next[k] = (v && typeof v === 'object' && !Array.isArray(v) && settings[k] && typeof settings[k] === 'object')
      ? { ...settings[k], ...v }
      : v;
  }
  settings = next;
  applySettings();
  persist(patch);
  renderActiveControls();
  return getSettings();
}

/** 备份前确认最新界面设置落盘；不把仍在防抖队列中的旧值当作备份。 */
export async function flushPendingSettings() {
  const started = Date.now();
  while (savingPatch) { if (Date.now() - started > 30000) throw Error('设置仍在保存，请稍后重试备份'); await new Promise(resolve => setTimeout(resolve, 20)); }
  pendingPatch = {};
  const result = await Api.saveSettings(settings);
  if (result?.settings) { settings = mergePatch(result.settings, pendingPatch); applySettings(); }
  return settings;
}

export function onApplied(fn) { onSettingsApplied = fn; }

/* ---------------- 面板 UI ---------------- */
let modalEl = null;
let open = false;

const SEG = (key, options, current) => `
  <div class="seg" data-key="${key}">
    ${options.map(([v, label]) => `<button data-value="${v}" class="${String(current) === String(v) ? 'active' : ''}">${label}</button>`).join('')}
  </div>`;

const ROW = (title, desc, control) => `
  <div class="set-row">
    <div class="set-label"><span>${title}</span>${desc ? `<small>${desc}</small>` : ''}</div>
    <div class="set-control">${control}</div>
  </div>`;

const TOGGLE = (key, on) => `
  <button class="switch ${on ? 'on' : ''}" role="switch" aria-checked="${on ? 'true' : 'false'}"
          data-toggle="${key}" aria-label="开关"><span></span></button>`;

function build() {
  const el = document.createElement('div');
  el.id = 'settings';
  el.className = 'modal settings-modal';
  el.hidden = true;
  el.innerHTML = `
    <div class="settings-box" role="dialog" aria-label="设置">
      <aside class="settings-nav">
        <div class="settings-nav-title">设置</div>
        <button data-pane="appearance" class="active">${uiIcon('appearance')}<span>外观</span></button>
        <button data-pane="editor">${uiIcon('editor')}<span>编辑器</span></button>
        <button data-pane="layout">${uiIcon('layout')}<span>布局</span></button>
        <button data-pane="hotkeys">${uiIcon('hotkeys')}<span>快捷键</span></button>
        <button data-pane="attachment">${uiIcon('attachment')}<span>附件</span></button>
        <button data-pane="sync">${uiIcon('sync')}<span>同步</span></button>
        <button data-pane="general">${uiIcon('general')}<span>通用</span></button>
        <button data-pane="about">${uiIcon('about')}<span>关于</span></button>
      </aside>
      <section class="settings-body">
        <div class="settings-pane active" data-pane="appearance">
          <h2>外观</h2>
          ${ROW('主题皮肤', '整体配色风格，对应 themes/*.css', SEG('themeName', [['apple', 'Apple 风'], ['obsidian', 'Obsidian 风']], settings.themeName))}
          ${ROW('亮暗', '跟随系统会随系统外观自动切换', SEG('themeMode', [['light', '浅色'], ['dark', '深色'], ['auto', '跟随系统']], settings.themeMode))}
          ${ROW('强调色', '按钮、链接、选中态的主色',
            `<div class="swatches" data-key="accent">
              ${Object.entries(ACCENTS).map(([k, v]) => `<button data-value="${k}" class="${settings.accent === k ? 'active' : ''}" title="${v.label}" style="--sw:${v.light}"></button>`).join('')}
            </div>`)}
          ${ROW('圆角', '影响卡片、按钮、输入框的圆润程度', SEG('radius', [['compact', '紧凑'], ['default', '标准'], ['large', '圆润']], settings.radius))}
        </div>

        <div class="settings-pane" data-pane="editor">
          <h2>编辑器</h2>
          ${ROW('正文字号', `${settings.fontSize} px`,
            `<input type="range" class="rng" data-key="fontSize" min="12" max="20" step="1" value="${settings.fontSize}" />`)}
          ${ROW('正文宽度', `${settings.editorWidth} px`,
            `<input type="range" class="rng" data-key="editorWidth" min="560" max="1000" step="20" value="${settings.editorWidth}" />`)}
          ${ROW('自动保存', '停止输入后多久落盘', SEG('autosave', [[300, '0.3 秒'], [600, '0.6 秒'], [900, '0.9 秒'], [1500, '1.5 秒']], settings.autosave))}
          ${ROW('行号', '在正文左侧显示行号（源码模式与实时预览共用）', TOGGLE('lineNumbers', settings.lineNumbers !== false))}
        </div>

        <div class="settings-pane" data-pane="layout">
          <h2>布局</h2>
          <p class="set-note">修改即时预览并自动保存。拖动侧栏图标可换栏或排序，也可右键移动。Alt + 左右键排序，Alt + Shift + 左右键换栏。可从设置或命令面板进入布局设置。</p>
          <div class="set-section-title">工作区</div>
          <p class="set-note">保存当前打开的笔记、标签分组与颜色、侧栏布局和阅读位置。按笔记库保存在此设备；顶部标签菜单可一键切换。旧布局预设保留为仅布局工作区。</p>
          <div class="layout-preset-toolbar"><select id="layout-preset-select" class="txt" aria-label="工作区"></select><button id="layout-preset-apply" class="btn-ghost">切换</button><button id="layout-preset-save" class="btn-ghost">保存当前工作区</button></div>
          <p id="workspace-summary" class="set-note" role="status"></p>
          <div class="set-actions"><button id="layout-preset-import" class="btn-ghost">导入</button><button id="layout-preset-export" class="btn-ghost">导出</button><button id="layout-preset-remove" class="btn-ghost">移除工作区</button></div>
          <input id="layout-preset-file" type="file" accept=".json,application/json" hidden />
          <div class="set-section-title">区域与位置</div>
          ${ROW('主侧栏位置', '交换完整侧栏；各个图标的位置可在下方单独调整', SEG('layout.navigationSide', [['left', '主栏在左'], ['right', '主栏在右']], settings.layout.navigationSide))}
          ${ROW('主侧栏', '记住桌面的展开状态，也可通过标题栏按钮切换', TOGGLE('layout.navigationVisible', settings.layout.navigationVisible))}
          ${ROW('辅助侧栏', '每侧可放置任意侧栏页签，记住桌面的展开状态', TOGGLE('layout.contextVisible', settings.layout.contextVisible))}
          ${ROW('左侧功能栏', '桌面的文件、搜索、绘图和命令等图标入口', TOGGLE('layout.ribbonVisible', settings.layout.ribbonVisible))}
          ${ROW('底部状态栏', '字数、保存状态和编辑模式入口', TOGGLE('layout.statusBarVisible', settings.layout.statusBarVisible))}
          <div class="set-section-title">页签位置与顺序</div>
          <div id="layout-pane-controls">${Object.entries(PANE_NAMES).map(([id, label]) => ROW(label, '', `<div class="pane-placement-controls" data-pane-control="${id}"><select class="txt" data-pane-place="${id}" aria-label="${label}所在侧栏"><option value="navigation">主侧栏</option><option value="context">辅助侧栏</option></select><small class="pane-order"></small><button class="mini-btn" data-pane-step="-1" aria-label="${label}向前移动">${uiIcon('up')}</button><button class="mini-btn" data-pane-step="1" aria-label="${label}向后移动">${uiIcon('down')}</button></div>`)).join('')}</div>
          <div class="set-section-title">尺寸与排版</div>
          ${Object.entries(LAYOUT_FIELDS).map(([key, rule]) => ROW(rule.label, `${settings.layout[key]} ${rule.unit}`,
            `<input type="range" class="rng" data-key="layout.${key}" aria-label="${rule.label}" min="${rule.min}" max="${rule.max}" step="${rule.step}" value="${settings.layout[key]}" />`)).join('')}
          <div class="set-actions"><button id="set-reset-layout" class="btn-ghost">恢复默认布局</button></div>
          <p class="set-note">正文字号与正文宽度可在「编辑器」中调整。</p>
        </div>

        <div class="settings-pane" data-pane="hotkeys">
          <h2>快捷键</h2>
          <p class="set-note">点击按键录制新组合，Esc 取消；支持 Ctrl / Cmd、Alt 组合键和功能键。修改立即生效并保存在本机。</p>
          <div class="hotkey-toolbar"><input type="search" id="hotkey-search" class="search-input" placeholder="搜索命令或快捷键…" aria-label="搜索快捷键"><button id="hotkey-reset-all" class="btn-ghost">恢复全部默认</button></div>
          <p id="hotkey-message" class="hotkey-message" role="status" aria-live="polite"></p>
          <div id="hotkey-list"></div>
          <p class="set-note">编辑命令仅在笔记编辑区生效；输入框中保留普通输入与撤销。方向键、Enter、Tab 等基础编辑操作，以及绘图画布内的工具按键保持原有行为。</p>
        </div>

        <div class="settings-pane" data-pane="attachment">
          <h2>附件</h2>
          ${ROW('新附件位置', '粘贴、拖入的图片和绘图保存到哪里',
            SEG('attachment.mode', [['folder', '指定文件夹'], ['note', '跟随笔记'], ['root', '仓库根目录']], settings.attachment.mode))}
          ${ROW('附件文件夹', '可写子目录，如 附件/图片',
            `<input type="text" class="txt" data-key="attachment.folder" spellcheck="false"
                    value="${escHtml(settings.attachment.folder)}" placeholder="附件" />`)}
          <p class="set-note">
            粘贴图片（Ctrl+V）、拖入文件、内置绘图都按此规则落盘，并在光标处插入 <code>![[路径]]</code> 双链。
            已有附件不会被移动；换设置只影响之后新增的文件。
          </p>
        </div>

        <div class="settings-pane" data-pane="sync">
          <h2>同步</h2>
          <div id="sync-body"></div>
        </div>

        <div class="settings-pane" data-pane="general">
          <h2>通用</h2>
          ${ROW('启动时', '打开应用时自动打开的笔记', SEG('startup', [['last', '上次的笔记'], ['empty', '不自动打开']], settings.startup))}
          ${fullBackupMarkup}
          <div class="set-section-title">历史备份</div>
          <p class="set-note">历史默认保存在本机用户数据目录。导出包含旧正文，请妥善保存；它不替代笔记和附件的仓库备份。支持 32 MiB 以内的备份，更大的历史请关闭应用后复制用户数据目录中的 history-v2 和 history 文件夹。</p>
          <div class="set-actions"><button id="history-backup-export" data-history-backup class="btn-ghost">导出当前仓库历史</button><button id="history-backup-import" data-history-backup class="btn-ghost">导入历史备份</button></div>
          <input id="history-backup-file" type="file" accept="application/json,.json" hidden />
          <p id="history-backup-result" class="set-note" role="status" style="white-space:pre-wrap;overflow-wrap:anywhere"></p>
          <div class="set-section-title">主题文件</div>
          <p class="set-note">
            当前皮肤 <code>public/themes/${settings.themeName}.css</code>。所有颜色、圆角、字体都是变量，
            改文件或用 AI 改都行，改坏了 <code>git checkout</code> 就能还原。
          </p>
          <div class="set-actions">
            <button id="set-copy-css" class="btn-ghost">复制当前外观 CSS</button>
            <button id="set-open-theme-doc" class="btn-ghost">变量速查表</button>
          </div>
        </div>

        <div class="settings-pane" data-pane="about">
          <h2>关于</h2>
          <div class="about-hero">
            <img src="/icon.png" alt="Tracery" />
            <div>
              <div class="about-name">Tracery</div>
              <div class="about-ver">MIT 开源</div>
            </div>
          </div>
          <p class="set-note">
            开源的本地 Markdown 笔记软件，笔记和附件保存在自己的电脑里。
            无需云账户，可在同一可信局域网内通过手机浏览器访问电脑上的笔记。
          </p>
          <div class="set-actions">
            <a class="btn-ghost" href="https://github.com/1901037067/tracery" target="_blank" rel="noopener">GitHub</a>
            <a class="btn-ghost" href="https://github.com/1901037067/tracery#readme" target="_blank" rel="noopener">使用说明</a>
          </div>
        </div>

        <footer class="settings-footer">
          <button id="set-reset" class="link-btn">恢复默认</button>
          <button id="set-done" class="btn-primary">完成</button>
        </footer>
      </section>
    </div>`;
  document.body.appendChild(el);
  for (const toggle of el.querySelectorAll('[data-toggle]')) {
    toggle.setAttribute('aria-label', toggle.closest('.set-row').querySelector('.set-label > span').textContent);
  }
  bind(el);
  initHistoryBackup(el);
  initFullBackup(el);
  initSyncPane();
  return el;
}

function bind(el) {
  upgradeSelects(el);
  bindHotkeys(el);
  bindLayoutPresets(el);
  for (const control of el.querySelectorAll('[data-pane-control]')) {
    const id = control.dataset.paneControl;
    control.querySelector('select').onchange = event => updateSettings({ layout: { panels: movePane(settings.layout.panels, id, event.target.value, settings.layout.panels[event.target.value].length) } });
    for (const button of control.querySelectorAll('[data-pane-step]')) button.onclick = () => {
      const panels = settings.layout.panels, host = panels.navigation.includes(id) ? 'navigation' : 'context';
      updateSettings({ layout: { panels: movePane(panels, id, host, panels[host].indexOf(id) + Number(button.dataset.paneStep)) } });
    };
  }
  // 左侧导航
  for (const btn of el.querySelectorAll('.settings-nav button')) {
    btn.onclick = () => {
      cancelHotkeyRecording(); closeSelect();
      for (const b of el.querySelectorAll('.settings-nav button')) b.classList.toggle('active', b === btn);
      for (const p of el.querySelectorAll('.settings-pane')) p.classList.toggle('active', p.dataset.pane === btn.dataset.pane);
      if (btn.dataset.pane === 'sync') initSyncPane();   // 每次进来都取一次最新状态
    };
  }
  // 分段控件（支持 attachment.mode 这类点分键）
  for (const seg of el.querySelectorAll('.seg')) {
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-value]');
      if (!b) return;
      const key = seg.dataset.key;
      const raw = b.dataset.value;
      const value = /^\d+$/.test(raw) ? Number(raw) : raw;
      updateSettings(patchByPath(key, value));
    });
  }
  // 文本输入（附件文件夹等）
  for (const txt of el.querySelectorAll('input.txt[data-key]')) {
    txt.addEventListener('change', () => {
      updateSettings(patchByPath(txt.dataset.key, txt.value.trim()));
    });
  }
  // 色板
  for (const sw of el.querySelectorAll('.swatches')) {
    sw.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-value]');
      if (!b) return;
      updateSettings({ accent: b.dataset.value });
    });
  }
  // 开关（布尔项）
  for (const tg of el.querySelectorAll('.switch[data-toggle]')) {
    tg.addEventListener('click', () => {
      const key = tg.dataset.toggle;
      const next = !(getByPath(key) !== false);
      updateSettings(patchByPath(key, next));
      tg.classList.toggle('on', next);
      tg.setAttribute('aria-checked', String(next));
    });
  }
  // 滑块
  for (const rng of el.querySelectorAll('.rng')) {
    rng.addEventListener('input', () => {
      const key = rng.dataset.key;
      const value = Number(rng.value);
      updateSettings(patchByPath(key, value));
    });
  }
  // 底部按钮
  el.querySelector('#set-done').onclick = () => close();
  el.querySelector('#set-reset-layout').onclick = () => {
    updateSettings({ layout: { ...DEFAULT_LAYOUT } });
    toast('已恢复默认布局');
  };
  el.querySelector('#set-reset').onclick = () => {
    const hotkeys = settings.hotkeys;
    updateSettings({ ...DEFAULT_SETTINGS, hotkeys });
    toast('已恢复默认外观');
  };
  el.querySelector('#set-copy-css').onclick = async () => {
    const css = exportCurrentTheme();
    try {
      await navigator.clipboard.writeText(css);
      toast('已复制到剪贴板，可粘贴成 public/themes/我的主题.css');
    } catch {
      toast('复制失败，请检查浏览器剪贴板权限');
    }
  };
  el.querySelector('#set-open-theme-doc').onclick = () => {
    toast('见项目内 public/themes/README.md');
  };
  // 点击遮罩关闭
  el.addEventListener('click', (e) => { if (e.target === el) close(); });
}

function bindLayoutPresets(el) {
  const select = el.querySelector('#layout-preset-select'), file = el.querySelector('#layout-preset-file');
  const selected = () => readPresets().find(item => item.id === select.value);
  const refresh = id => {
    select.replaceChildren(); const custom = document.createElement('option'); custom.value = ''; custom.textContent = '选择工作区'; select.append(custom);
    for (const item of readPresets()) { const option = document.createElement('option'); option.value = item.id; option.textContent = item.name; select.append(option); }
    select.value = id || ''; refreshSelect(select);
    select.onchange();
  };
  select.onchange = () => { const item = selected(); el.querySelector('#layout-preset-apply').disabled = !item; el.querySelector('#layout-preset-remove').disabled = !item;
    el.querySelector('#workspace-summary').textContent = !item ? '保存同名工作区可更新快照；切换不会修改笔记正文。' : item.session ? `${item.session.tabs.filter(p => !p.startsWith('tracery:blank:')).length} 篇笔记 · ${item.session.groups.length} 个分组 · 含阅读位置` : '仅布局 · 再次保存同名工作区可加入当前笔记与阅读位置'; };
  el.querySelector('#layout-preset-save').onclick = async () => {
    const name = await askText({ title: '保存工作区', value: selected()?.name || '', placeholder: '例如：上课、复习、写作、项目', okText: '保存' });
    if (!name?.trim()) return;
    try {
      const items = readPresets(), label = name.trim().slice(0, 40), existing = items.find(item => item.name === label);
      const item = { id: existing?.id || crypto.randomUUID(), name: label, layout: normalizeLayout(settings.layout), session: workspaceActions.capture?.() || null };
      if (existing) items[items.indexOf(existing)] = item; else items.push(item);
      writePresets(items); refresh(item.id); toast('工作区已保存到此设备的当前笔记库');
    } catch { toast('工作区保存失败'); }
  };
  el.querySelector('#layout-preset-apply').onclick = async () => { const item = selected(); if (!item) return; if (workspaceActions.apply) await workspaceActions.apply(item); else updateSettings({ layout: item.layout }); };
  el.querySelector('#layout-preset-remove').onclick = () => { try { writePresets(readPresets().filter(item => item.id !== select.value)); refresh(); toast('已移除工作区，当前笔记和布局保持不变'); } catch { toast('工作区移除失败'); } };
  el.querySelector('#layout-preset-export').onclick = () => {
    const item = selected() || { name: '当前工作区', layout: settings.layout, session: workspaceActions.capture?.() || null };
    const url = URL.createObjectURL(new Blob([encodePreset(item)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'Tracery-workspace.json'; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  el.querySelector('#layout-preset-import').onclick = () => file.click();
  file.onchange = async () => {
    const input = file.files[0]; file.value = ''; if (!input) return;
    try {
      if (input.size > 2 * 1024 * 1024) throw Error('工作区文件过大');
      const item = decodePreset(await input.text()), items = readPresets(), baseName = item.name;
      let suffix = 2; while (items.some(old => old.name === item.name)) item.name = `${baseName.slice(0, 32)} (${suffix++})`;
      items.push(item); writePresets(items); refresh(item.id); toast('已导入工作区，点击「切换」查看');
    } catch (error) { toast(error.message || '工作区文件无法读取'); }
  };
  el.refreshWorkspaces = () => refresh(select.value);
  refresh();
}

let recordingHotkey = null;
const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform);
function cancelHotkeyRecording() { recordingHotkey = null; renderHotkeyControls(); }
function hotkeyMessage(text, error = false) {
  const el = document.getElementById('hotkey-message');
  if (el) { el.textContent = text; el.classList.toggle('error', error); }
}
function saveHotkey(command, shortcut) {
  const error = validateShortcut(command.id, shortcut, settings.hotkeys);
  if (error) { hotkeyMessage(error, true); return; }
  recordingHotkey = null;
  updateSettings({ hotkeys: { [command.id]: shortcut } });
  hotkeyMessage(`${command.label}：${shortcutLabel(shortcut, isMac())}`);
}
function bindHotkeys(el) {
  const list = el.querySelector('#hotkey-list');
  for (const group of [...new Set(HOTKEY_COMMANDS.map(command => command.group))]) {
    const section = document.createElement('section'); section.className = 'hotkey-group';
    const title = document.createElement('h3'); title.textContent = group; section.append(title);
    for (const command of HOTKEY_COMMANDS.filter(command => command.group === group)) {
      const row = document.createElement('div'); row.className = 'hotkey-row'; row.dataset.hotkey = command.id;
      const label = document.createElement('span'); label.className = 'hotkey-name'; label.textContent = command.label;
      const controls = document.createElement('div'); controls.className = 'hotkey-controls';
      const record = document.createElement('button'); record.className = 'hotkey-binding'; record.dataset.command = command.id;
      record.setAttribute('aria-label', `修改${command.label}快捷键`);
      record.onclick = () => { recordingHotkey = command.id; renderHotkeyControls(); hotkeyMessage('请按新组合键；Esc 取消，Backspace 清除。'); };
      record.onkeydown = event => {
        if (recordingHotkey !== command.id) return;
        if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) { cancelHotkeyRecording(); return; }
        event.preventDefault(); event.stopPropagation();
        if (event.key === 'Escape') { cancelHotkeyRecording(); hotkeyMessage('已取消修改'); return; }
        if (event.key === 'Backspace' && !event.ctrlKey && !event.metaKey && !event.altKey) { saveHotkey(command, null); return; }
        if (['Control', 'Meta', 'Alt', 'Shift', 'AltGraph'].includes(event.key) || event.isComposing) return;
        const shortcut = shortcutFromEvent(event);
        if (!shortcut) { hotkeyMessage('请使用 Ctrl / Cmd、Alt 组合键，或功能键。', true); return; }
        saveHotkey(command, shortcut);
      };
      record.onblur = () => { if (recordingHotkey === command.id) cancelHotkeyRecording(); };
      const clear = document.createElement('button'); clear.className = 'mini-btn hotkey-clear'; clear.textContent = '清除'; clear.setAttribute('aria-label', `清除${command.label}快捷键`);
      clear.onclick = () => saveHotkey(command, null);
      const reset = document.createElement('button'); reset.className = 'mini-btn hotkey-reset'; reset.textContent = '还原'; reset.title = `默认：${shortcutLabel(command.defaultKey, isMac())}`; reset.setAttribute('aria-label', `还原${command.label}默认快捷键`);
      reset.onclick = () => saveHotkey(command, command.defaultKey);
      controls.append(record, clear, reset); row.append(label, controls); section.append(row);
    }
    list.append(section);
  }
  el.querySelector('#hotkey-search').oninput = () => renderHotkeyControls();
  el.querySelector('#hotkey-reset-all').onclick = () => {
    recordingHotkey = null;
    updateSettings({ hotkeys: Object.fromEntries(HOTKEY_COMMANDS.map(command => [command.id, command.defaultKey])) });
    hotkeyMessage('已恢复全部默认快捷键');
  };
  renderHotkeyControls(el);
}
function renderHotkeyControls(root = modalEl) {
  if (!root) return;
  const query = root.querySelector('#hotkey-search')?.value.trim().toLowerCase() || '';
  for (const command of HOTKEY_COMMANDS) {
    const row = root.querySelector(`.hotkey-row[data-hotkey="${command.id}"]`); if (!row) continue;
    const shortcut = bindingFor(command, settings.hotkeys), label = shortcutLabel(shortcut, isMac());
    const button = row.querySelector('.hotkey-binding'), active = recordingHotkey === command.id;
    button.textContent = active ? '请按快捷键…' : label;
    button.setAttribute('aria-pressed', String(active)); button.title = `${command.label}：${label}，点击修改`;
    row.querySelector('.hotkey-clear').disabled = shortcut === null;
    row.querySelector('.hotkey-reset').disabled = shortcut === command.defaultKey;
    row.hidden = !!query && !`${command.label} ${command.group} ${label}`.toLowerCase().includes(query);
  }
  for (const group of root.querySelectorAll('.hotkey-group')) group.hidden = !group.querySelector('.hotkey-row:not([hidden])');
}

/** 把当前外观导出成一份可直接使用的主题 CSS */
export function exportCurrentTheme() {
  const acc = ACCENTS[settings.accent] || ACCENTS.blue;
  const [xs, sm, md, lg, xl] = RADII[settings.radius] || RADII.default;
  return `/* Tracery 自定义主题（由设置面板导出） */
:root {
  --accent: ${acc.light};
  --accent-hover: ${acc.light};
  --accent-soft: ${hexToRgba(acc.light, 0.12)};
  --link: ${acc.light};

  --r-xs: ${xs}px;
  --r-sm: ${sm}px;
  --r-md: ${md}px;
  --r-lg: ${lg}px;
  --r-xl: ${xl}px;
}

[data-theme="dark"] {
  --accent: ${acc.dark};
  --accent-hover: ${acc.dark};
  --accent-soft: ${hexToRgba(acc.dark, 0.20)};
  --link: ${acc.dark};
}
`;
}

/** 刷新控件选中态（不重建 DOM） */
function renderActiveControls() {
  if (!modalEl) return;
  for (const control of modalEl.querySelectorAll('[data-pane-control]')) {
    const id = control.dataset.paneControl, panels = settings.layout.panels, host = panels.navigation.includes(id) ? 'navigation' : 'context';
    const select = control.querySelector('select'), index = panels[host].indexOf(id);
    select.value = host;
    for (const option of select.options) option.textContent = `${option.value === 'navigation' ? '主侧栏' : '辅助侧栏'}（${(option.value === 'navigation') === (settings.layout.navigationSide === 'left') ? '左' : '右'}）`;
    refreshSelect(select);
    control.querySelector('.pane-order').textContent = `${index + 1} / ${panels[host].length}`;
    control.querySelector('[data-pane-step="-1"]').disabled = index === 0;
    control.querySelector('[data-pane-step="1"]').disabled = index === panels[host].length - 1;
  }
  for (const seg of modalEl.querySelectorAll('.seg')) {
    const current = getByPath(seg.dataset.key);
    for (const b of seg.querySelectorAll('button[data-value]')) {
      b.classList.toggle('active', String(current) === b.dataset.value);
    }
  }
  for (const sw of modalEl.querySelectorAll('.swatches')) {
    for (const b of sw.querySelectorAll('button[data-value]')) {
      b.classList.toggle('active', settings.accent === b.dataset.value);
    }
  }
  for (const rng of modalEl.querySelectorAll('.rng')) {
    const key = rng.dataset.key;
    const value = getByPath(key);
    if (rng.value !== String(value)) rng.value = String(value);
    const label = rng.closest('.set-row')?.querySelector('.set-label small');
    if (label) label.textContent = `${value} ${LAYOUT_FIELDS[key.split('.')[1]]?.unit || 'px'}`;
  }
  for (const tg of modalEl.querySelectorAll('.switch[data-toggle]')) {
    const on = getByPath(tg.dataset.toggle) !== false;
    tg.classList.toggle('on', on);
    tg.setAttribute('aria-checked', String(on));
  }
  // 皮肤文件名提示
  const note = modalEl.querySelector('[data-pane="general"] .set-note code');
  if (note) note.textContent = `public/themes/${settings.themeName}.css`;
  renderHotkeyControls();
}

export function openSettings(pane) {
  if (!modalEl) modalEl = build();
  modalEl.refreshWorkspaces?.();
  modalEl.hidden = false;
  open = true;
  renderActiveControls();
  if (typeof pane === 'string') modalEl.querySelector(`.settings-nav button[data-pane="${pane}"]`)?.click();
  const first = modalEl.querySelector('.settings-nav button.active');
  first?.focus();
}

export function close() {
  if (!modalEl) return;
  closeSelect();
  modalEl.hidden = true;
  cancelHotkeyRecording();
  open = false;
}

export const isOpen = () => open;

export function toggleSettings() {
  if (open) close();
  else openSettings();
}
