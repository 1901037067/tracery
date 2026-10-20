/* 安装与更新都是用户操作；有未保存内容时绝不自动刷新页面。 */
import { askConfirm } from './dialog.js';
import { toast } from './api.js';
export function initPwa({ beforeReload }) {
  const syncThemeColor = () => {
    const color = getComputedStyle(document.documentElement).getPropertyValue('--bg-window').trim();
    if (color) document.querySelector('meta[name="theme-color"]').content = color;
  };
  new MutationObserver(syncThemeColor).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });
  document.getElementById('theme-css').addEventListener('load', syncThemeColor);
  syncThemeColor();
  const byId = (id) => document.getElementById(id);
  const install = byId('btn-pwa-install');
  const standalone = matchMedia('(display-mode: standalone)');
  let promptEvent = null;
  let registration = null;
  let updating = false;
  const syncInstall = () => { install.hidden = !!window.electronAPI || standalone.matches || navigator.standalone === true; };
  syncInstall(); standalone.addEventListener('change', syncInstall);
  window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); promptEvent = event; syncInstall(); });
  window.addEventListener('appinstalled', () => { install.hidden = true; promptEvent = null; });
  install.onclick = async () => {
    if (promptEvent) {
      await promptEvent.prompt(); await promptEvent.userChoice; promptEvent = null;
    } else {
      await askConfirm({ title: '安装 Tracery', desc: !isSecureContext
        ? '添加到主屏幕需要 HTTPS。当前地址仍可正常使用移动网页版；请通过 HTTPS 访问仓库服务后再安装。'
        : '在浏览器菜单选择「安装应用」或「添加到主屏幕」。iPhone / iPad 可在 Safari 的分享菜单中添加。', okText: '知道了' });
    }
  };
  const connection = (online) => { byId('connection-banner').hidden = online && navigator.onLine; };
  window.addEventListener('offline', () => connection(false));
  window.addEventListener('tracery:connection', (event) => connection(event.detail.connected));
  if (!navigator.onLine) connection(false);
  byId('btn-retry-connection').onclick = async () => {
    if (await beforeReload()) location.reload();
    else toast('仍有未保存内容，请确认连接后重试');
  };
  byId('btn-pwa-update').onclick = async () => {
    if (!await beforeReload()) { toast('请先保存当前内容，再更新应用'); return; }
    updating = true;
    registration?.waiting?.postMessage({ type: 'ACTIVATE_UPDATE' });
  };
  if (window.electronAPI || !isSecureContext || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (updating) location.reload(); });
  navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).then((reg) => {
    registration = reg;
    const showUpdate = () => { byId('pwa-update').hidden = !reg.waiting; };
    showUpdate();
    reg.addEventListener('updatefound', () => reg.installing?.addEventListener('statechange', () => setTimeout(showUpdate, 0)));
  }).catch(() => { install.title = '安装到设备（离线资源暂未准备好）'; });
}
