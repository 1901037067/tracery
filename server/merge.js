/**
 * 文本三方合并（diff3）
 * ------------------------------------------------------------------
 * 场景：同一篇笔记在两台设备上都改了。只要改的不是同一段，就没有理由让用户手工合。
 *
 * 规则：
 *   - 只有文本笔记（.md/.markdown/.txt）参与合并；二进制一律走冲突副本
 *   - 两边改了同一段 → 返回 conflicts > 0，调用方继续用「冲突副本」策略，不写半成品
 *   - 两边改了不同段 / 同一处改成同样内容 → 自动合并（node-diff3 的 false conflict 排除）
 *   - 行尾风格跟随 base（CRLF 文件不会被悄悄改成 LF）
 */
import { diff3Merge } from 'node-diff3';

const MERGEABLE = /\.(md|markdown|txt)$/i;

export function isMergeablePath(p) {
  return MERGEABLE.test(String(p || ''));
}

/**
 * @param {string} base   上一次同步成功时的内容
 * @param {string} ours   本地当前内容
 * @param {string} theirs 远端当前内容
 * @returns {{ text: string, conflicts: number }}
 */
export function mergeText(base, ours, theirs) {
  const eol = base.includes('\r\n') ? '\r\n' : '\n';
  const norm = (s) => String(s ?? '').replace(/\r\n/g, '\n');
  const split = (s) => norm(s).split('\n');

  const a = split(ours);     // 本地
  const o = split(base);     // 基准
  const b = split(theirs);   // 远端

  let regions;
  try {
    regions = diff3Merge(a, o, b, { excludeFalseConflicts: true });
  } catch {
    // 合并库异常时不要猜测：直接报告冲突，让上层走副本策略
    return { text: norm(ours), conflicts: 1 };
  }

  const lines = [];
  let conflicts = 0;
  for (const r of regions) {
    if (r.ok) {
      lines.push(...r.ok);
    } else if (r.conflict) {
      conflicts++;
      lines.push('<<<<<<< 本地（保留）', ...r.conflict.a, '=======', ...r.conflict.b, '>>>>>>> 远端（另一台设备）');
    }
  }

  let text = lines.join('\n');
  if (eol === '\r\n') text = text.replace(/\n/g, '\r\n');
  return { text, conflicts };
}
