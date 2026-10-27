import { askConfirm } from './dialog.js';
export function initHistoryBackup(panel) {
  const output = panel.querySelector('#history-backup-result'), input = panel.querySelector('#history-backup-file');
  let busy = false;
  const buttons = [...panel.querySelectorAll('[data-history-backup]')];
  const request = async (url, options) => {
    const response = await fetch(url, options), data = await response.json();
    if (!response.ok) throw new Error(data.error || '历史备份操作失败');
    return data;
  };
  const run = async job => {
    if (busy) return;
    busy = true; for (const button of buttons) button.disabled = true;
    output.textContent = '正在处理…';
    try { await job(); } catch (error) { output.textContent = error.message; }
    finally { busy = false; for (const button of buttons) button.disabled = false; }
  };
  panel.querySelector('#history-backup-export').onclick = () => run(async () => {
    const archive = await request('/api/history/backup');
    const blob = new Blob([JSON.stringify(archive)], { type: 'application/json' }), url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = `Tracery-history-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    output.textContent = `已导出 ${archive.notes.length} 篇笔记和 ${archive.legacy.length} 组旧版历史。备份不包含当前笔记和附件，请另外备份仓库文件夹。`;
  });
  panel.querySelector('#history-backup-import').onclick = () => { input.value = ''; input.click(); };
  input.onchange = () => run(async () => {
    const file = input.files[0]; if (!file) { output.textContent = ''; return; }
    if (file.size > 32 * 1024 * 1024 - 4096) throw new Error('备份过大，请使用用户数据目录备份（history-v2 和 history 文件夹）');
    const archive = JSON.parse(await file.text()), state = await request('/api/state'), root = state.vault?.root;
    if (!root || state.access?.local === false) throw new Error('请在电脑本机打开目标仓库后导入');
    const rebind = archive.sourceRoot !== root;
    if (!await askConfirm({ title: rebind ? '将其他位置的历史导入当前仓库？' : '导入历史备份？',
      desc: `${rebind ? '仓库位置不同，将按当前仓库重新关联历史。\n' : ''}只关联相对路径和当前正文均匹配的笔记；不修改笔记正文、不覆盖现有历史。旧版来源不明的历史仍只能预览。仅导入你信任的备份。`, okText: '导入历史' })) { output.textContent = '已取消导入'; return; }
    const result = await request('/api/history/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archive, vaultRoot: root, allowRebind: rebind }) });
    output.textContent = `已补充 ${result.added} 个版本；跳过 ${result.skipped.length} 篇正文缺失或已变化的笔记。${result.legacyUnverified ? '旧版历史继续标记为来源未验证。' : ''}${result.skipped.length ? '\n未关联：' + result.skipped.map(row => row.path).join('、') : ''}`;
  });
}
