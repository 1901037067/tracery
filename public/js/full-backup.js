import { askConfirm } from './dialog.js';
let actions = {}, view, active, lastResult;
export function configureFullBackup(value) { actions = value; }
const request = async (url, body) => {
  const response = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await response.json(); if (!response.ok) throw Error(data.error || '完整备份操作失败'); return data;
};
function busy(value) { if (view) for (const button of view.querySelectorAll('[data-full-backup]')) button.disabled = value; }
async function follow(id) {
  active = id; busy(true); sessionStorage.setItem('tracery.fullBackupJob', id);
  try {
    while (active === id) {
      const state = await request('/api/backup/status?id=' + encodeURIComponent(id));
      view.querySelector('#full-backup-result').textContent = `${state.phase}${state.total ? ` · ${state.completed}/${state.total} 个文件 · ${(state.bytes / 1048576).toFixed(1)} MiB` : ''}`;
      if (state.status === 'complete') {
        lastResult = { ...state.result, kind: state.kind };
        view.querySelector('#full-backup-result').textContent = state.kind === 'verify' ? `校验通过：${state.result.files} 个文件完整。` : `${state.kind === 'create' ? '备份完成，已回读校验' : '恢复完成，已逐文件校验'}${state.result.sourceName ? ' · ' + state.result.sourceName : ''}：\n${state.result.path}`;
        view.querySelector('#full-backup-open').hidden = state.kind !== 'restore';
        view.querySelector('#full-backup-reveal').hidden = !state.result.path || !window.electronAPI?.openPath;
        sessionStorage.removeItem('tracery.fullBackupJob'); break;
      }
      if (['failed', 'cancelled'].includes(state.status)) {
        view.querySelector('#full-backup-result').textContent = `${state.phase}：${state.error || ''}${state.incomplete ? '\n未完成目录保留在：' + state.incomplete : ''}`;
        sessionStorage.removeItem('tracery.fullBackupJob'); break;
      }
      await new Promise(resolve => setTimeout(resolve, 400));
    }
  } catch (error) { if (error.message.includes('任务不存在')) sessionStorage.removeItem('tracery.fullBackupJob'); view.querySelector('#full-backup-result').textContent = error.message + '。重新打开设置可继续查看任务。'; }
  finally { active = null; busy(false); }
}
export function initFullBackup(panel) {
  view = panel;
  for (const button of panel.querySelectorAll('[data-backup-picker]')) {
    button.hidden = !window.electronAPI?.pickBackupDirectory;
    button.onclick = async () => { const value = await window.electronAPI.pickBackupDirectory(button.dataset.backupPicker); if (value) panel.querySelector('#' + button.dataset.target).value = value; };
  }
  const start = async kind => {
    if (active) return;
    const output = panel.querySelector('#full-backup-result');
    try {
      const parent = panel.querySelector(kind === 'create' ? '#full-backup-destination' : '#full-backup-restore-parent').value.trim();
      const source = panel.querySelector('#full-backup-source').value.trim();
      if ((kind !== 'verify' && !parent) || (kind !== 'create' && !source)) throw Error('请先选择需要的文件夹');
      const context = await actions.prepare?.(); if (!context) return;
      if (kind === 'restore' && !await askConfirm({ title: '恢复到新仓库？', desc: '先逐文件校验备份，再在所选位置新建仓库。原仓库和备份均保留，完成后可选择打开恢复的仓库。', okText: '校验并恢复' })) return;
      panel.querySelector('#full-backup-open').hidden = true; panel.querySelector('#full-backup-reveal').hidden = true;
      const { id } = await request('/api/backup/' + kind, { ...context, parent, source });
      await follow(id);
    } catch (error) { output.textContent = error.message; }
  };
  panel.querySelector('#full-backup-create').onclick = () => start('create');
  panel.querySelector('#full-backup-verify').onclick = () => start('verify');
  panel.querySelector('#full-backup-restore').onclick = () => start('restore');
  panel.querySelector('#full-backup-cancel').onclick = async () => { if (active) { try { await request('/api/backup/cancel', { id: active }); } catch (error) { panel.querySelector('#full-backup-result').textContent = error.message; } } };
  panel.querySelector('#full-backup-open').onclick = async () => { try { await actions.open?.(lastResult, panel.querySelector('#full-backup-settings').checked); } catch (error) { panel.querySelector('#full-backup-result').textContent = error.message; } };
  panel.querySelector('#full-backup-reveal').onclick = () => { if (lastResult?.path) window.electronAPI?.openPath(lastResult.path); };
  if (!active) { const id = sessionStorage.getItem('tracery.fullBackupJob'); if (id) void follow(id); }
  busy(!!active);
}
export const fullBackupMarkup = `
  <div class="set-section-title">完整本地备份与恢复</div>
  <p class="set-note">包含当前仓库的笔记、全部附件、绘图、历史、回收站及工作区设置；不包含同步凭据、索引和未保存草稿。备份是可复制到移动硬盘的文件夹，创建后逐文件回读校验。支持最多 20 万文件和 20 万目录；附件可超过 32 MiB，校验清单上限为 32 MiB。</p>
  <p class="set-note">备份期间仍可保存；若文件发生变化，本次备份会停止并提示重试。建议备份时暂时停止编辑和其他设备写入。</p>
  <label class="backup-path-label">备份存放文件夹<input id="full-backup-destination" class="backup-path" placeholder="选择当前仓库之外的文件夹" /></label>
  <div class="set-actions"><button class="btn-ghost" data-backup-picker="destination" data-target="full-backup-destination">选择位置…</button><button id="full-backup-create" data-full-backup class="btn-ghost">创建完整备份</button></div>
  <label class="backup-path-label">已有完整备份<input id="full-backup-source" class="backup-path" placeholder="选择已完成的 Tracery 备份文件夹" /></label>
  <div class="set-actions"><button class="btn-ghost" data-backup-picker="source" data-target="full-backup-source">选择备份…</button><button id="full-backup-verify" data-full-backup class="btn-ghost">校验完整性</button></div>
  <label class="backup-path-label">恢复仓库存放文件夹<input id="full-backup-restore-parent" class="backup-path" placeholder="将在此处自动新建仓库" /></label>
  <div class="set-actions"><button class="btn-ghost" data-backup-picker="restore" data-target="full-backup-restore-parent">选择恢复位置…</button><button id="full-backup-restore" data-full-backup class="btn-ghost">恢复到新仓库</button><button id="full-backup-cancel" class="btn-ghost">取消任务</button></div>
  <p id="full-backup-result" class="set-note backup-result" role="status" aria-live="polite"></p>
  <label class="set-note"><input id="full-backup-settings" type="checkbox" checked /> 打开恢复仓库时应用备份的界面设置与工作区</label>
  <div class="set-actions"><button id="full-backup-open" class="btn-ghost" hidden>打开恢复的仓库</button><button id="full-backup-reveal" class="btn-ghost" hidden>打开结果文件夹</button></div>`;
