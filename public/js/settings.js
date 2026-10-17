/**
 * Tracery 设置面板 + 外观设置引擎
 * 设计：macOS 系统设置风格（左侧导航 + 右侧分组行），所有改动即时预览。
 * 外观 = CSS 变量，所以「改设置」不需要重载页面，也不碰布局代码。
 */
import { Api, toast, debounce } from './api.js';
import { initSyncPane } from './sync-ui.js';

export const DEFAULT_SETTINGS = {
  themeName: 'apple',
  themeMode: 'dark',
  accent: 'blue',
  radius: 'default',
  fontSize: 16,
  editorWidth: 720,
  autosave: 900,
  startup: 'last',
};

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
    mediaQuery.onchange = () => { applySettings(); onSettingsApplied?.(); };
  }

  onSettingsApplied?.(getSettings());
}

export function initSettings(initial) {
  settings = { ...DEFAULT_SETTINGS, ...(initial || {}) };
  applySettings();
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

/** 修改设置：立即生效 + 防抖落盘 */
export function updateSettings(patch) {
  settings = { ...settings, ...patch };
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
              <div class="about-ver">v1.0.0 · MIT 开源</div>
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
  // 左侧导航
  for (const btn of el.querySelectorAll('.settings-nav button')) {
    btn.onclick = () => {
      for (const b of el.querySelectorAll('.settings-nav button')) b.classList.toggle('active', b === btn);
      for (const p of el.querySelectorAll('.settings-pane')) p.classList.toggle('active', p.dataset.pane === btn.dataset.pane);
      if (btn.dataset.pane === 'sync') initSyncPane();   // 每次进来都取一次最新状态
    };
  }
  // 分段控件
  for (const seg of el.querySelectorAll('.seg')) {
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-value]');
      if (!b) return;
      const key = seg.dataset.key;
      const raw = b.dataset.value;
      const value = /^\d+$/.test(raw) ? Number(raw) : raw;
      updateSettings({ [key]: value });
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
    settings = { ...DEFAULT_SETTINGS };
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
    const key = seg.dataset.key;
    for (const b of seg.querySelectorAll('button[data-value]')) {
      b.classList.toggle('active', String(settings[key]) === b.dataset.value);
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
  // 皮肤文件名提示
  const note = modalEl.querySelector('[data-pane="general"] .set-note code');
  if (note) note.textContent = `public/themes/${settings.themeName}.css`;
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
  open = false;
}

export const isOpen = () => open;

export function toggleSettings() {
  if (open) close();
  else openSettings();
}
