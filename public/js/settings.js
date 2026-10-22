/**
 * Tracery 设置面板 + 外观设置引擎
 * 设计：macOS 系统设置风格（左侧导航 + 右侧分组行），所有改动即时预览。
 * 外观 = CSS 变量，所以「改设置」不需要重载页面，也不碰布局代码。
 */
import { Api, toast, debounce } from './api.js';
import { initSyncPane } from './sync-ui.js';
import { HOTKEY_COMMANDS, bindingFor, shortcutFromEvent, shortcutLabel, validateShortcut, sanitizeHotkeys } from './hotkeys.js';

export const DEFAULT_SETTINGS = {
  themeName: 'apple',
  themeMode: 'dark',
  accent: 'blue',
  radius: 'default',
  fontSize: 16,
  editorWidth: 720,
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

const THEME_LABEL = { apple: 'Apple 风', obsidian: 'Obsidian 风' };

let settings = { ...DEFAULT_SETTINGS };
let mediaQuery = null;
let onSettingsApplied = null;

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

  // 系统主题联动
  if (mediaQuery) { mediaQuery.onchange = null; mediaQuery = null; }
  if (settings.themeMode === 'auto') {
    mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    mediaQuery.onchange = () => applySettings();
  }

  onSettingsApplied?.(getSettings());
}

export function initSettings(initial) {
  settings = { ...DEFAULT_SETTINGS, ...(initial || {}) };
  settings.hotkeys = sanitizeHotkeys(settings.hotkeys);
  applySettings();
  renderActiveControls();
}

/** 积攒多次改动，防抖后一次性落盘（避免连点时中间改动被丢弃） */
let pendingPatch = {};
const flushSettings = debounce(async () => {
  const patch = pendingPatch;
  pendingPatch = {};
  if (!Object.keys(patch).length) return;
  try {
    const res = await Api.saveSettings(patch);
    // 期间若又有新改动，别覆盖本地
    if (res?.settings && !Object.keys(pendingPatch).length) settings = { ...settings, ...res.settings };
  } catch { toast('设置保存失败'); }
}, 400);

function persist(patch) {
  pendingPatch = { ...pendingPatch, ...patch };
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
        <button data-pane="appearance" class="active">外观</button>
        <button data-pane="editor">编辑器</button>
        <button data-pane="hotkeys">快捷键</button>
        <button data-pane="attachment">附件</button>
        <button data-pane="sync">同步</button>
        <button data-pane="general">通用</button>
        <button data-pane="about">关于</button>
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
              <div class="about-ver">v1.1.1 · MIT 开源</div>
            </div>
          </div>
          <p class="set-note">
            开源的仓库型 Markdown 笔记软件，Obsidian 兼容备选。
            架构通过 REA 逆向分析 Obsidian 后复刻，见 <code>docs/OBSIDIAN_ANALYSIS.md</code>。
          </p>
          <div class="set-actions">
            <a class="btn-ghost" href="https://github.com/" target="_blank" rel="noopener">GitHub</a>
            <button id="set-open-roadmap" class="btn-ghost">路线图</button>
          </div>
        </div>

        <footer class="settings-footer">
          <button id="set-reset" class="link-btn">恢复默认</button>
          <button id="set-done" class="btn-primary">完成</button>
        </footer>
      </section>
    </div>`;
  document.body.appendChild(el);
  bind(el);
  initSyncPane();
  return el;
}

function bind(el) {
  bindHotkeys(el);
  // 左侧导航
  for (const btn of el.querySelectorAll('.settings-nav button')) {
    btn.onclick = () => {
      cancelHotkeyRecording();
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
      const label = rng.closest('.set-row')?.querySelector('.set-label small');
      if (label) label.textContent = `${value} px`;
      updateSettings({ [key]: value });
    });
  }
  // 底部按钮
  el.querySelector('#set-done').onclick = () => close();
  el.querySelector('#set-reset').onclick = () => {
    const hotkeys = settings.hotkeys;
    settings = { ...DEFAULT_SETTINGS, hotkeys };
    applySettings();
    Api.saveSettings(settings).catch(() => {});
    renderActiveControls();
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
  el.querySelector('#set-open-roadmap').onclick = () => {
    toast('见项目内 docs/ROADMAP.md');
  };
  // 点击遮罩关闭
  el.addEventListener('click', (e) => { if (e.target === el) close(); });
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
    if (rng.value !== String(settings[key])) rng.value = String(settings[key]);
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

export function openSettings() {
  if (!modalEl) modalEl = build();
  modalEl.hidden = false;
  open = true;
  renderActiveControls();
  const first = modalEl.querySelector('.settings-nav button.active');
  first?.focus();
}

export function close() {
  if (!modalEl) return;
  modalEl.hidden = true;
  cancelHotkeyRecording();
  open = false;
}

export const isOpen = () => open;

export function toggleSettings() {
  if (open) close();
  else openSettings();
}
