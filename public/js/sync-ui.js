/**
 * 「设置 → 同步」面板（客户端）
 * 只做三件事：填地址+配对码、展示状态、触发同步。
 * 真正的文件传输在 Node 服务端（server/sync.js），浏览器不碰文件系统、也拿不到 token 之外的东西。
 */
import { Api, toast } from './api.js';
import { askText, askConfirm } from './dialog.js';

let status = null;
let mount = null;
let mode = null;          // 'form' | 'connected'
let busy = false;
let lanCode = null;   // 本机作为主机时生成的 6 位通行码

/* ---------------- 对外 ---------------- */
export async function initSyncPane() {
  mount = document.getElementById('sync-body');
  if (!mount) return;
  try {
    status = await Api.syncStatus();
  } catch {
    status = { configured: false };
  }
  render(true);
}

/** WS 广播 / 手动刷新后更新界面 */
export function onSyncStatus(next, { force = false } = {}) {
  if (!next) return;
  status = next;
  if (!mount) return;
  if (force) { mode = null; render(true); return; }
  render();
}

export function getSyncStatus() { return status; }

/* ---------------- 渲染 ---------------- */
function render(force = false) {
  if (!mount) return;
  const want = status?.configured ? 'connected' : 'form';
  if (!force && mode === want) {
    updateLive();
    return;
  }
  mode = want;
  mount.innerHTML = want === 'connected' ? connectedHtml() : formHtml();
  if (want === 'form') bindForm();
  else bindConnected();
}

function formHtml() {
  return `
    <div class="sync-intro">
      <div class="sync-intro-title">把笔记同步到你自己的服务器</div>
      <div class="sync-intro-desc">
        在 NAS / 树莓派 / 任意一台机器上运行 <code>npx evnote-sync</code>，
        它会打印一个配对码。填到下面即可，数据不经过任何第三方。
      </div>
    </div>
    <div class="sync-field">
      <label for="sync-url">服务端地址</label>
      <input id="sync-url" type="text" placeholder="http://192.168.1.10:9600" spellcheck="false" autocomplete="off" />
    </div>
    <div class="sync-field">
      <label for="sync-code">配对码</label>
      <input id="sync-code" type="text" placeholder="ABCD-EFGH" spellcheck="false" autocomplete="off" />
    </div>
    <div class="sync-field">
      <label for="sync-device">设备名称</label>
      <input id="sync-device" type="text" placeholder="家里的台式机" spellcheck="false" autocomplete="off" />
    </div>
    <div id="sync-form-error" class="sync-error" hidden></div>
    <div class="set-actions">
      <button id="sync-connect" class="btn-primary">连接并同步</button>
      <button id="sync-help" class="btn-ghost">怎么部署？</button>
    </div>
    <div id="sync-help-box" class="sync-help" hidden>
      <ol>
        <li>找一台<b>常开</b>的机器（NAS、旧笔记本、树莓派都行），装 Node 20+。</li>
        <li>在这台机器上运行下面这条命令，它会打印「地址」和「配对码」。</li>
        <li>把地址和配对码填到上面，点「连接并同步」；其他设备重复这一步即可。</li>
      </ol>
      <div class="sync-cmd">
        <code>npx evnote-sync --data ./evnote-sync --name 我的同步盘</code>
        <button id="sync-copy-cmd" class="btn-ghost">复制</button>
      </div>
      <p class="set-note">
        同一局域网直接填 <code>http://192.168.x.x:9600</code>；
        公网使用请套一层 HTTPS 反向代理，或走 Tailscale / WireGuard。
        数据只存在这台机器上，服务端可以随时整目录备份。
      </p>
    </div>
    <div class="lan-block">
      <div class="lan-title">局域网直连</div>
      <div class="lan-desc">同一个 Wi-Fi 下免部署：一台设备当主机，其他设备输 6 位通行码即可互相同步。</div>
      <div class="lan-host">
        <button id="lan-start" class="btn-ghost">本机当主机，生成通行码</button>
        <span id="lan-code" class="lan-code" hidden></span>
        <span id="lan-code-hint" class="lan-sub" hidden>其他设备在下面输入这串数字</span>
      </div>
      <div class="lan-join">
        <input id="lan-code-input" class="lan-input" type="text" maxlength="6" inputmode="numeric"
               placeholder="输入对方 6 位通行码" autocomplete="off" />
        <button id="lan-find" class="btn-primary">查找并连接</button>
      </div>
      <div id="lan-error" class="sync-error" hidden style="margin-top:10px"></div>
    </div>
    <p class="set-note" style="margin-top:14px">
      首次连接会把两边合并：只在一边存在的文件直接同步；两边都改过的文件，
      改的是不同段落会自动合并，同一段冲突才生成「冲突副本」，不会覆盖你的内容。
    </p>`;
}

function connectedHtml() {
  const s = status;
  const conflicts = s.lastResult?.conflicts || [];
  const hosting = lanCode && (s.serverUrl || '').includes('127.0.0.1');
  return `
    <div class="sync-card">
      <span class="sync-dot ${s.lastError ? 'err' : 'ok'}"></span>
      <div class="sync-card-main">
        <div class="sync-title">已连接${s.serverName ? ` · ${escapeHtml(s.serverName)}` : ''}</div>
        <div class="sync-sub">${escapeHtml(s.serverUrl || '')}</div>
      </div>
      <button id="sync-now" class="btn-primary sync-now-btn">立即同步</button>
    </div>
    ${hosting ? `
    <div class="lan-banner">
      本机共享中 · 通行码 <b class="lan-code">${escapeHtml(lanCode)}</b> · 其他设备连上后即可互相同步
      <button id="lan-stop" class="btn-ghost">停止共享</button>
    </div>` : ''}
    <div class="set-row">
      <div class="set-label"><span>状态</span><small id="sync-state-text">${escapeHtml(stateText(s))}</small></div>
      <div class="set-control"><span class="sync-meta" id="sync-meta">${escapeHtml(metaText(s))}</span></div>
    </div>
    <div class="set-row">
      <div class="set-label"><span>自动同步</span><small>本地改动后自动推送到服务器</small></div>
      <div class="set-control">
        <div class="seg" data-sync-key="autoSync">
          <button data-value="1" class="${s.autoSync ? 'active' : ''}">开</button>
          <button data-value="0" class="${s.autoSync ? '' : 'active'}">关</button>
        </div>
      </div>
    </div>
    <div class="set-row">
      <div class="set-label"><span>自动合并</span><small>两边改的不是同一段时直接合并，不生成副本</small></div>
      <div class="set-control">
        <div class="seg" data-sync-key="autoMerge">
          <button data-value="1" class="active">开</button>
          <button data-value="0" class="">关</button>
        </div>
      </div>
    </div>
    <div class="set-row">
      <div class="set-label"><span>检查间隔</span><small>拉取远端变更的频率</small></div>
      <div class="set-control">
        <div class="seg" data-sync-key="interval">
          ${[[30, '30 秒'], [60, '1 分钟'], [300, '5 分钟']].map(([v, l]) => `<button data-value="${v}" class="${Number(s.interval) === v ? 'active' : ''}">${l}</button>`).join('')}
        </div>
      </div>
    </div>
    ${conflicts.length ? `
    <div class="sync-conflicts">
      <div class="sync-conflicts-title">本次同步产生 ${conflicts.length} 个冲突副本</div>
      <ul>${conflicts.map((c) => `<li><code>${escapeHtml(c.copy)}</code></li>`).join('')}</ul>
      <div class="sync-hint">原文件保留了你本地版本；上面这些是远端版本，确认后可自行合并删除。</div>
    </div>` : ''}
    <div class="set-actions" style="margin-top:18px">
      <button id="sync-disconnect" class="btn-ghost sync-danger">断开连接</button>
      <button id="sync-device-rename" class="btn-ghost">设备名称：${escapeHtml(s.deviceName || '未命名')}</button>
    </div>
    <p class="set-note" style="margin-top:12px">
      同步状态保存在仓库的 <code>.evnote/sync-state.json</code>；远端删除的文件会进
      <code>.evnote/trash/</code>，不会直接销毁。
    </p>`;
}

function bindForm() {
  const inputEnterBind = (input, btn) => {
    input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); btn?.click(); } });
  };
  const btn = mount.querySelector('#sync-connect');
  const dev = mount.querySelector('#sync-device');
  if (dev && !dev.value) dev.value = guessDevice();
  const submit = async () => {
    if (busy) return;
    const serverUrl = mount.querySelector('#sync-url').value.trim();
    const code = mount.querySelector('#sync-code').value.trim();
    const deviceName = mount.querySelector('#sync-device').value.trim();
    const errEl = mount.querySelector('#sync-form-error');
    if (!serverUrl || !code) {
      errEl.textContent = '请填写服务端地址和配对码';
      errEl.hidden = false;
      return;
    }
    busy = true;
    btn.disabled = true;
    btn.textContent = '连接中…';
    try {
      const res = await Api.syncPair({ serverUrl, code, deviceName });
      const st = res.status || res;
      onSyncStatus(st);
      const r = st.firstResult;
      if (r) toast(`已连接，同步完成：↑${r.uploaded} ↓${r.downloaded}`);
      else toast('已连接同步服务端');
    } catch (e) {
      errEl.textContent = e.message;
      errEl.hidden = false;
    } finally {
      busy = false;
      if (btn) { btn.disabled = false; btn.textContent = '连接并同步'; }
    }
  };
  btn.onclick = submit;
  for (const id of ['#sync-url', '#sync-code', '#sync-device']) {
    mount.querySelector(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  }
  const helpBox = mount.querySelector('#sync-help-box');
  mount.querySelector('#sync-help').onclick = () => {
    helpBox.hidden = !helpBox.hidden;
    if (!helpBox.hidden) setTimeout(() => helpBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 60);
  };
  mount.querySelector('#sync-copy-cmd').onclick = async () => {
    const cmd = mount.querySelector('.sync-cmd code').textContent;
    try {
      await navigator.clipboard.writeText(cmd);
      toast('命令已复制');
    } catch {
      toast('复制失败，请手动选择文本');
    }
  };

  /* ---- 局域网直连 ---- */
  const lanErr = mount.querySelector('#lan-error');
  const showLanError = (msg) => {
    lanErr.textContent = msg;
    lanErr.hidden = false;
  };

  mount.querySelector('#lan-start').onclick = async () => {
    const btn = mount.querySelector('#lan-start');
    if (busy) return;
    busy = true;
    btn.disabled = true;
    btn.textContent = '开启中…';
    lanErr.hidden = true;
    try {
      const r = await Api.lanStart();
      lanCode = r.lan.code;
      onSyncStatus(r.sync, { force: true });
      toast(`本机共享已开启，通行码 ${r.lan.code}`);
    } catch (e) {
      showLanError(e.message);
    } finally {
      busy = false;
      btn.disabled = false;
      btn.textContent = '本机当主机，生成通行码';
    }
  };

  mount.querySelector('#lan-find').onclick = async () => {
    const btn = mount.querySelector('#lan-find');
    const input = mount.querySelector('#lan-code-input');
    if (busy) return;
    const code = input.value.trim();
    if (!/^\d{6}$/.test(code)) { showLanError('请输入 6 位数字通行码'); return; }
    busy = true;
    btn.disabled = true;
    const prevText = btn.textContent;
    btn.textContent = '查找中…';
    lanErr.hidden = true;
    try {
      const hit = await Api.lanFind(code);
      const pr = await Api.syncPair({ serverUrl: hit.url, code });
      onSyncStatus(pr.status || pr);
      toast(`已连接 ${hit.name}`);
    } catch (e) {
      showLanError(e.message);
    } finally {
      busy = false;
      btn.disabled = false;
      btn.textContent = prevText;
    }
  };
  inputEnterBind(mount.querySelector('#lan-code-input'), mount.querySelector('#lan-find'));
}

function bindConnected() {
  mount.querySelector('#sync-now').onclick = async () => {
    if (busy) return;
    busy = true;
    const btn = mount.querySelector('#sync-now');
    btn.disabled = true;
    btn.textContent = '同步中…';
    try {
      const res = await Api.syncNow();
      if (res.status) onSyncStatus(res.status);
      const r = res.result;
      if (r) {
        const conflictTxt = r.conflicts?.length ? `，${r.conflicts.length} 个冲突副本` : '';
        const mergedTxt = r.merged?.length ? `，自动合并 ${r.merged.length} 篇` : '';
        toast(`同步完成：↑${r.uploaded} ↓${r.downloaded}${mergedTxt}${conflictTxt}`);
      }
    } catch (e) {
      toast(`同步失败：${e.message}`);
    } finally {
      busy = false;
      const b = mount.querySelector('#sync-now');
      if (b) { b.disabled = false; b.textContent = '立即同步'; }
    }
  };

  for (const seg of mount.querySelectorAll('.seg[data-sync-key]')) {
    seg.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-value]');
      if (!b) return;
      const key = seg.dataset.syncKey;
      const patch = key === 'autoSync' ? { autoSync: b.dataset.value === '1' }
        : key === 'autoMerge' ? { autoMerge: b.dataset.value === '1' }
        : { interval: Number(b.dataset.value) };
      try {
        const res = await Api.syncOptions(patch);
        if (res.status) onSyncStatus(res.status, { force: true });
      } catch { toast('设置保存失败'); }
    });
  }

  mount.querySelector('#sync-disconnect').onclick = async () => {
    const ok = await askConfirm({
      title: '断开同步？',
      desc: '本地文件不会被删除，只是不再与服务器同步。',
      okText: '断开',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await Api.syncDisconnect();
      lanCode = null;
      onSyncStatus(res.status || { configured: false });
      toast('已断开同步');
    } catch { toast('断开失败'); }
  };

  mount.querySelector('#sync-device-rename').onclick = async () => {
    const name = await askText({
      title: '设备名称',
      desc: '冲突副本的文件名里会用到它',
      value: status.deviceName || guessDevice(),
      okText: '保存',
    });
    if (!name) return;
    // 设备名只影响之后的文件名，不需要重新配对
    Api.syncOptions({ deviceName: name }).then((res) => {
      if (res.status) onSyncStatus(res.status, { force: true });
      toast(`设备名称已改为：${name}`);
    }).catch(() => toast('修改失败'));
  };

  // 主机：停止局域网共享
  mount.querySelector('#lan-stop')?.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    try {
      const res = await Api.lanStop();
      lanCode = null;
      onSyncStatus(res.sync || { configured: false }, { force: true });
      toast('已停止本机共享');
    } catch (e) {
      toast(`停止失败：${e.message}`);
    } finally {
      busy = false;
    }
  });
}

/** 已连接状态下，只更新文字，避免整块重绘把焦点弄丢 */
function updateLive() {
  if (mode !== 'connected') return;
  const stateEl = mount.querySelector('#sync-state-text');
  const metaEl = mount.querySelector('#sync-meta');
  const dot = mount.querySelector('.sync-dot');
  if (stateEl) stateEl.textContent = stateText(status);
  if (metaEl) metaEl.textContent = metaText(status);
  if (dot) dot.className = `sync-dot ${status.lastError ? 'err' : 'ok'}`;
  const btn = mount.querySelector('#sync-now');
  if (btn && !busy) btn.textContent = status.syncing ? '同步中…' : '立即同步';
}

/* ---------------- 文案 ---------------- */
function stateText(s) {
  if (s.syncing) return s.progress ? `${s.progress.phase === 'upload' ? '上传' : '下载'} ${s.progress.done}/${s.progress.total}` : '同步中…';
  if (s.lastError) return `出错：${s.lastError}`;
  if (!s.lastSyncAt) return '尚未同步';
  const r = s.lastResult;
  if (r && (r.uploaded || r.downloaded || r.deleted || r.merged?.length)) {
    const mergedTxt = r.merged?.length ? ` · 合并 ${r.merged.length}` : '';
    return `上次：↑${r.uploaded} ↓${r.downloaded}${r.deleted ? ` · 删除 ${r.deleted}` : ''}${mergedTxt}`;
  }
  return '已是最新';
}

function metaText(s) {
  if (!s.lastSyncAt) return '';
  return `上次同步 ${relTime(s.lastSyncAt)}`;
}

function relTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff)) return '';
  if (diff < 60e3) return '刚刚';
  if (diff < 3600e3) return `${Math.floor(diff / 60e3)} 分钟前`;
  if (diff < 86400e3) return `${Math.floor(diff / 3600e3)} 小时前`;
  return `${Math.floor(diff / 86400e3)} 天前`;
}

function guessDevice() {
  const p = navigator.platform || '';
  if (/Win/i.test(p)) return 'Windows 电脑';
  if (/Mac/i.test(p)) return 'Mac';
  if (/Linux/i.test(p)) return 'Linux';
  return '我的设备';
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
