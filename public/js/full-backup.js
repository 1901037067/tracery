import { askConfirm } from './dialog.js';
let actions = {}, view, active, lastResult, starting = false;
export function configureFullBackup(value) { actions = value; }
const request = async (url, body) => {
  const response = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await response.json(); if (!response.ok) throw Error(data.error || '完整备份操作失败'); return data;
};
function busy(value) {
  if (!view) return;
  for (const control of view.querySelectorAll('[data-full-backup], [data-backup-picker], .backup-path')) control.disabled = value;
  const cancel = view.querySelector('#full-backup-cancel');
  if (!active && document.activeElement === cancel) view.querySelector('.backup-status').focus({ preventScroll: true });
  cancel.hidden = !active; cancel.disabled = !active; cancel.textContent = '取消任务';
  for (const id of ['open', 'reveal']) view.querySelector('#full-backup-' + id).disabled = value;
}
function message(text, state = 'working') {
  const output = view.querySelector('#full-backup-result');
  output.textContent = text;
  view.querySelector('.backup-status').dataset.state = state;
}
function progress(state) {
  const bar = view.querySelector('#full-backup-progress');
  bar.hidden = !state?.total;
  if (state?.total) { bar.max = state.total; bar.value = state.completed; }
}
async function follow(id) {
  active = id; busy(true); sessionStorage.setItem('tracery.fullBackupJob', id);
  try {
    while (active === id) {
      const state = await request('/api/backup/status?id=' + encodeURIComponent(id));
      message(`${state.phase}${state.total ? ` · ${state.completed}/${state.total} 个文件 · ${(state.bytes / 1048576).toFixed(1)} MiB` : ''}`);
      progress(state);
      if (state.status === 'complete') {
        lastResult = { ...state.result, kind: state.kind };
        message(state.kind === 'verify' ? `校验通过：${state.result.files} 个文件完整。` : `${state.kind === 'create' ? '备份完成，已回读校验' : '恢复完成，已逐文件校验'}${state.result.sourceName ? ' · ' + state.result.sourceName : ''}：\n${state.result.path}`, 'complete');
        progress(null);
        view.querySelector('#full-backup-open').hidden = state.kind !== 'restore';
        view.querySelector('#full-backup-reveal').hidden = !state.result.path || !window.electronAPI?.openPath;
        sessionStorage.removeItem('tracery.fullBackupJob'); break;
      }
      if (['failed', 'cancelled'].includes(state.status)) {
        message(`${state.phase}${state.error ? '：' + state.error : ''}${state.incomplete ? '\n未完成目录保留在：' + state.incomplete : ''}`, state.status === 'failed' ? 'error' : 'idle');
        progress(null);
        sessionStorage.removeItem('tracery.fullBackupJob'); break;
      }
      await new Promise(resolve => setTimeout(resolve, 400));
    }
  } catch (error) { if (error.message.includes('任务不存在')) sessionStorage.removeItem('tracery.fullBackupJob'); message(error.message + '。重新打开设置可继续查看任务。', 'error'); progress(null); }
  finally { active = null; busy(false); }
}
export function initFullBackup(panel) {
  view = panel;
  for (const button of panel.querySelectorAll('[data-backup-picker]')) {
    button.hidden = !window.electronAPI?.pickBackupDirectory;
    button.onclick = async () => { const value = await window.electronAPI.pickBackupDirectory(button.dataset.backupPicker); if (value) panel.querySelector('#' + button.dataset.target).value = value; };
  }
  const start = async kind => {
    if (active || starting) return;
    starting = true;
    try {
      const parent = panel.querySelector(kind === 'create' ? '#full-backup-destination' : '#full-backup-restore-parent').value.trim();
      const source = panel.querySelector('#full-backup-source').value.trim();
      for (const input of panel.querySelectorAll('.backup-path')) input.removeAttribute('aria-invalid');
      const missing = kind !== 'create' && !source ? '#full-backup-source' : kind !== 'verify' && !parent ? kind === 'create' ? '#full-backup-destination' : '#full-backup-restore-parent' : null;
      if (missing) {
        const input = panel.querySelector(missing); input.setAttribute('aria-invalid', 'true'); input.focus();
        throw Error(kind !== 'create' && !source ? '请先选择已有的完整备份文件夹。' : kind === 'create' ? '请选择当前仓库之外的备份存放文件夹。' : '请选择恢复仓库的存放位置。');
      }
      busy(true);
      message('正在保存当前笔记并准备任务…'); progress(null);
      panel.querySelector('.backup-status').scrollIntoView({ block: 'nearest' });
      panel.querySelector('.backup-status').focus({ preventScroll: true });
      const context = await actions.prepare?.(); if (!context) { message('任务尚未开始。处理完未保存的内容后可重试。', 'idle'); return; }
      if (kind === 'restore' && !await askConfirm({ title: '恢复到新仓库？', desc: '先逐文件校验备份，再在所选位置新建仓库。原仓库和备份均保留，完成后可选择打开恢复的仓库。', okText: '校验并恢复' })) return;
      panel.querySelector('#full-backup-open').hidden = true; panel.querySelector('#full-backup-reveal').hidden = true;
      const { id } = await request('/api/backup/' + kind, { ...context, parent, source });
      starting = false;
      await follow(id);
    } catch (error) { message(error.message, 'error'); progress(null); }
    finally { starting = false; busy(!!active); if (!active && panel.querySelector('#full-backup-result').textContent === '正在保存当前笔记并准备任务…') message('任务尚未开始。', 'idle'); }
  };
  panel.querySelector('#full-backup-create').onclick = () => start('create');
  panel.querySelector('#full-backup-verify').onclick = () => start('verify');
  panel.querySelector('#full-backup-restore').onclick = () => start('restore');
  panel.querySelector('#full-backup-cancel').onclick = async event => {
    if (!active) return;
    event.currentTarget.disabled = true; event.currentTarget.textContent = '正在取消…';
    try { await request('/api/backup/cancel', { id: active }); }
    catch (error) { message(error.message, 'error'); busy(!!active); }
  };
  panel.querySelector('#full-backup-open').onclick = async () => { try { await actions.open?.(lastResult, panel.querySelector('#full-backup-settings').checked); } catch (error) { message(error.message, 'error'); } };
  panel.querySelector('#full-backup-reveal').onclick = () => { if (lastResult?.path) window.electronAPI?.openPath(lastResult.path); };
  if (!active) { const id = sessionStorage.getItem('tracery.fullBackupJob'); if (id) void follow(id); }
  busy(!!active);
  for (const input of panel.querySelectorAll('.backup-path')) input.addEventListener('input', () => input.removeAttribute('aria-invalid'));
}
export const fullBackupMarkup = `
  <section class="full-backup" aria-labelledby="full-backup-heading">
    <h3 class="set-section-title" id="full-backup-heading">完整本地备份与恢复</h3>
    <p class="set-note">备份当前正文、附件、绘图、历史、回收站及工作区。恢复时新建仓库，保留原仓库。</p>
    <details class="backup-details"><summary>备份范围与注意事项</summary>
      <p class="set-note">备份为可复制到移动硬盘的文件夹，创建后逐文件回读校验。不包含同步凭据、索引和未保存草稿。</p>
      <p class="set-note">备份期间建议暂停编辑和其他设备写入；文件发生变化时任务会停止并提示重试。支持最多 20 万文件和 20 万目录；附件可超过 32 MiB，校验清单上限为 32 MiB。</p>
    </details>
    <section class="backup-step" aria-labelledby="backup-create-heading">
      <h4 id="backup-create-heading">创建备份</h4>
      <label class="backup-path-label" for="full-backup-destination">备份存放文件夹</label>
      <div class="backup-path-row"><input id="full-backup-destination" class="backup-path" aria-describedby="full-backup-result" placeholder="当前仓库之外的文件夹" spellcheck="false" /><button class="btn-ghost" data-backup-picker="destination" data-target="full-backup-destination">选择位置…</button></div>
      <div class="set-actions"><button id="full-backup-create" data-full-backup class="btn-primary">创建完整备份</button></div>
    </section>
    <section class="backup-step" aria-labelledby="backup-restore-heading">
      <h4 id="backup-restore-heading">校验与恢复</h4>
      <label class="backup-path-label" for="full-backup-source">已有完整备份</label>
      <div class="backup-path-row"><input id="full-backup-source" class="backup-path" aria-describedby="full-backup-result" placeholder="已完成的 Tracery 备份文件夹" spellcheck="false" /><button class="btn-ghost" data-backup-picker="source" data-target="full-backup-source">选择备份…</button></div>
      <div class="set-actions"><button id="full-backup-verify" data-full-backup class="btn-ghost">校验完整性</button></div>
      <label class="backup-path-label" for="full-backup-restore-parent">恢复仓库存放文件夹</label>
      <div class="backup-path-row"><input id="full-backup-restore-parent" class="backup-path" aria-describedby="full-backup-result backup-restore-note" placeholder="将在此处自动新建仓库" spellcheck="false" /><button class="btn-ghost" data-backup-picker="restore" data-target="full-backup-restore-parent">选择位置…</button></div>
      <label class="backup-preference"><input id="full-backup-settings" type="checkbox" checked /> 打开恢复仓库时应用备份的界面设置与工作区</label>
      <div class="set-actions"><button id="full-backup-restore" data-full-backup class="btn-ghost">恢复到新仓库</button></div>
      <p class="set-note" id="backup-restore-note">恢复前自动校验，完成后可选择打开新仓库。</p>
    </section>
    <div class="backup-status" data-state="idle" role="region" aria-label="备份任务状态" tabindex="-1">
      <p id="full-backup-result" class="set-note backup-result" role="status" aria-live="polite" aria-atomic="true">尚未开始备份任务。</p>
      <progress id="full-backup-progress" aria-label="当前任务文件进度" hidden></progress>
      <div class="set-actions"><button id="full-backup-cancel" class="btn-ghost" hidden>取消任务</button><button id="full-backup-open" class="btn-primary" hidden>打开恢复的仓库</button><button id="full-backup-reveal" class="btn-ghost" hidden>打开结果文件夹</button></div>
    </div>
  </section>`;
