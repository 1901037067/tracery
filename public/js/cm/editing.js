/**
 * public/js/cm/editing.js — CM6 行内编辑内核（P2）
 * ------------------------------------------------------------------
 * EDITOR-MIGRATION.md 第 4 节 P2：Enter 续列表/任务列表、Tab 缩进、
 * Ctrl+B/I/S/K、粘贴/拖入附件拦截。行首 Backspace 合并由 CM 原生的
 * deleteMarkupBackward 负责（这里只是把它钉进同一份 keymap，验证即可）。
 *
 * 设计边界（与 P1 的 cm/decorations.js 互补，互不依赖）：
 *   - keymap 只放「编辑动作」，不放装饰；装饰在 ViewPlugin / StateField 里。
 *   - 粘贴/拖入附件必须走 EditorView.domEventHandlers：CM6 对 contenteditable
 *     的 paste/drop 没有内建处理器，浏览器默认行为会把图片塞成 data:/blob: URL
 *     （刷新即丢）、拖入文件直接导航打开。返回 true = 拦下默认并阻止 CM 后续处理。
 *   - 本模块不落盘、不碰服务端：把 File 交给调用方（P4 接 editor.js 的
 *     _saveAssetFile → Api.saveAsset → 回插 ![[path]]），保持内核与业务解耦。
 *
 * 与块级模型的口径对齐（editor.js 的 _handleEnter / Tab / _wrapSelection）：
 *   - 任务项续行固定续「未勾选」的 `- [ ] `；空任务项再回车 = 退出列表（交 CM 内置）。
 *   - Tab = 2 空格缩进（列表行插在行首、普通行插在光标处）；Shift+Tab = 去掉行首 1~2 空格。
 *   - Ctrl+B/I/S/K 与 editor.js 完全一致：**粗** / *斜* / ~~删~~ / [[双链]]。
 */
import { EditorSelection, Prec } from '@codemirror/state';
import { keymap, EditorView } from '@codemirror/view';
import { insertNewlineContinueMarkup, deleteMarkupBackward } from '@codemirror/lang-markdown';
import { parseCached } from './decorations.js';

const INDENT = '  ';
/** 任务项标记：缩进 + 项目符号 + 空格 + [ ]/[x] + 空格 */
const TASK_ITEM_RE = /^(\s*)([-*+]\s+)\[([ xX])\]\s?/;

/* ================= Enter：续任务列表（CM 内置不续 [ ]，这里补） =================
 * @codemirror/lang-markdown 的 insertNewlineContinueMarkup 会续 `- `、`1. `、`> `
 * 并把有序列表自增、空项去标记，但它不认识 GFM 任务项的 `[ ]`——续出来的新行是
 * `- ` 而不是 `- [ ] `（迁移文档第 4 节点名的「要自己补」）。 */
export const continueMarkupOrTask = ({ state, dispatch }) => {
  const r = state.selection.main;
  if (state.selection.ranges.length === 1 && r.empty) {
    const line = state.doc.lineAt(r.from);
    // 空列表项 / 空引用回车 = 退出（对齐 editor.js._handleEnter 的既定行为）：
    // CM 内置的 insertNewlineContinueMarkup 只在「列表首项」或「前一行是空行」时才去标记，
    // 像 `- 甲` 下面续出来的空 `- ` 项它会插一条空行、把列表变成 loose list，并不退出。
    if (/^\s*(?:[-*+]|\d+\.)\s*$/.test(line.text) || /^\s*>\s*$/.test(line.text)) {
      dispatch(state.update({
        changes: { from: line.from, to: line.to },
        selection: EditorSelection.cursor(line.from),
        scrollIntoView: true, userEvent: 'delete',
      }));
      return true;
    }
    const m = TASK_ITEM_RE.exec(line.text);
    if (m) {
      const markupEnd = line.from + m[0].length;
      const rest = line.text.slice(m[0].length);
      if (r.from >= markupEnd && rest.trim() !== '') {
        // 光标在标记之后、且本项还有内容 → 续一个未勾选的任务项
        const insert = state.lineBreak + m[1] + m[2] + '[ ] ';
        dispatch(state.update({
          changes: { from: r.from, insert },
          selection: EditorSelection.cursor(r.from + insert.length),
          scrollIntoView: true, userEvent: 'input',
        }));
        return true;
      }
      if (r.from >= markupEnd) {
        // 空任务项再回车 = 退出任务列表：去掉整行标记、留在原行（与 editor.js 一致）
        dispatch(state.update({
          changes: { from: line.from, to: line.to },
          selection: EditorSelection.cursor(line.from),
          scrollIntoView: true, userEvent: 'delete',
        }));
        return true;
      }
    }
  }
  // 其余（有序/无序/引用/空任务项去标记/普通换行）全部交给 CM 内置命令。
  // 返回 false 时由 defaultKeymap 的 insertNewlineAndIndent 兜底（非 markdown 上下文，
  // 例如代码块内），所以不需要自己再兜一层。
  return insertNewlineContinueMarkup({ state, dispatch });
};

/* ================= Tab：2 空格缩进 / Shift+Tab 反缩进 =================
 * 与 editor.js 一致：列表行缩进落在行首，普通行落在光标处。跨行选区逐行缩进。 */
export const indentMore = ({ state, dispatch }) => {
  const changes = state.changeByRange((range) => {
    if (range.empty) {
      const line = state.doc.lineAt(range.head);
      const listLine = /^\s*(?:[-*+]|\d+\.)\s/.test(line.text);
      const at = listLine ? line.from : range.head;
      return {
        changes: { from: at, insert: INDENT },
        range: EditorSelection.cursor(range.head + INDENT.length),
      };
    }
    const first = state.doc.lineAt(range.from);
    const last = state.doc.lineAt(range.to);
    const specs = [];
    for (let n = first.number; n <= last.number; n++) specs.push({ from: state.doc.line(n).from, insert: INDENT });
    return {
      changes: specs,
      range: EditorSelection.range(range.from + INDENT.length, range.to + INDENT.length * (last.number - first.number + 1)),
    };
  });
  dispatch(state.update(changes, { scrollIntoView: true, userEvent: 'input' }));
  return true;
};

export const indentLess = ({ state, dispatch }) => {
  const changes = state.changeByRange((range) => {
    const first = state.doc.lineAt(range.from);
    const last = state.doc.lineAt(range.to);
    const specs = [];
    let fromCut = 0, toCut = 0;
    for (let n = first.number; n <= last.number; n++) {
      const line = state.doc.line(n);
      const lead = (/^ */.exec(line.text))[0].length;
      const cut = Math.min(INDENT.length, lead);
      if (cut > 0) specs.push({ from: line.from, to: line.from + cut });
      if (n === first.number) fromCut = Math.min(cut, range.from - line.from);
      toCut += cut;
    }
    if (!specs.length) return { range };
    return { changes: specs, range: EditorSelection.range(range.from - fromCut, range.to - toCut) };
  });
  dispatch(state.update(changes, { scrollIntoView: true, userEvent: 'delete' }));
  return true;
};

/* ================= 表格：Tab 跳格 / Enter 加行（cm 的「单元格编辑」） =================
 * 和块级内核的 <table> 不同，cm 里表格仍是真实文本行（widgets.js 只藏了管道字符、
 * 给单元格挂了 padding/边线），所以「编辑单元格」= 把光移进那一格 + 直接打字，天然可编辑。
 * 这里只补两件块级有、cm 缺的事：
 *   ① Tab / Shift+Tab 在单元格之间跳（不再是把整行缩进 2 空格）；末行末格再 Tab = 加一行；
 *   ② Enter 在当前行下面加一行同样列数的空行（表头行则插在分隔行之后）。
 * 判定一律走 parseMarkdown 的 table 块（不靠文本猜），代码块/普通段落里的 | 不会被误判。 */
/** 一行里所有未转义管道的字符下标 */
function tablePipes(text) {
  const pipes = [];
  for (let k = 0; k < text.length; k++) {
    if (text[k] === '|' && text[k - 1] !== '\\') pipes.push(k);
  }
  return pipes;
}

/** 当前行属于哪个 table 块（AST 行号 0-based，CM 行号 1-based） */
function tableAt(state, lineNo1) {
  let blocks;
  try { ({ blocks } = parseCached(state)); } catch { return null; }
  const idx = lineNo1 - 1;
  let hit = null;
  const walk = (bs) => {
    for (const b of bs) {
      if (b.type === 'table') {
        const last = b.rows.length ? b.rows[b.rows.length - 1].line : b.header.line + 1;
        if (idx >= b.header.line && idx <= last) hit = b;
      }
      if (b.blocks) walk(b.blocks);
    }
  };
  walk(blocks);
  return hit;
}

/** 第 k 个单元格的内容起点（跳过「| 」里那个空格） */
function cellStart(line, k) {
  const pipes = tablePipes(line.text);
  const p = pipes[k];
  if (p == null) return null;
  let pos = p + 1;
  while (pos < line.text.length && line.text[pos] === ' ') pos++;
  return line.from + Math.min(pos, line.text.length);
}

/** 光标（相对行首的偏移）落在第几个单元格 */
function cellIndexAt(line, rel) {
  const pipes = tablePipes(line.text);
  if (pipes.length < 2) return 0;
  let n = 0;
  while (n < pipes.length && pipes[n] < rel) n++;
  return Math.max(0, Math.min(n - 1, pipes.length - 2));
}

/** 在当前行下方插一行同列数的空表格行，光标放进第一格 */
function insertTableRow(state, dispatch, afterLine, cols) {
  const row = '|' + '  |'.repeat(Math.max(1, cols));
  const pos = afterLine.to;
  dispatch(state.update({
    changes: { from: pos, insert: state.lineBreak + row },
    selection: EditorSelection.cursor(pos + 2),   // 跳过换行符和开头那个 |，落在第一格
    scrollIntoView: true, userEvent: 'input',
  }));
  return true;
}

function moveTableCell(ctx, dir) {
  const { state, dispatch } = ctx;
  const r = state.selection.main;
  if (!r.empty || state.selection.ranges.length !== 1) return false;
  const line = state.doc.lineAt(r.head);
  const tbl = tableAt(state, line.number);
  if (!tbl) return false;
  // 视觉顺序里的行序（分隔行不在里面：它被整行收起，光标也跳不到）
  const seq = [tbl.header.line, ...tbl.rows.map((x) => x.line)];
  let rowIdx = seq.indexOf(line.number - 1);
  if (rowIdx < 0) return false;
  let cellIdx = cellIndexAt(line, r.head - line.from);
  const cols = Math.max(1, tablePipes(line.text).length - 1);

  if (dir > 0) {
    if (cellIdx + 1 < cols) cellIdx += 1;
    else if (rowIdx + 1 < seq.length) { rowIdx += 1; cellIdx = 0; }
    else {
      // 末行末格再按 Tab = 加一行（Obsidian 的手感），光标直接进新行第一格
      return insertTableRow(state, dispatch, line, cols);
    }
  } else {
    if (cellIdx > 0) cellIdx -= 1;
    else if (rowIdx > 0) { rowIdx -= 1; cellIdx = -1; }   // 上一行的最后一格
    else return false;                                    // 表头第一格再往前 → 交回默认（缩进）
  }

  const target = state.doc.line(seq[rowIdx] + 1);
  const targetCols = Math.max(1, tablePipes(target.text).length - 1);
  if (cellIdx < 0 || cellIdx >= targetCols) cellIdx = targetCols - 1;
  const pos = cellStart(target, cellIdx);
  if (pos == null) return false;
  dispatch(state.update({
    selection: EditorSelection.cursor(pos),
    scrollIntoView: true, userEvent: 'select',
  }));
  return true;
}

export const tableTabNext = (ctx) => moveTableCell(ctx, 1);
export const tableTabPrev = (ctx) => moveTableCell(ctx, -1);

/** Enter：表格里回车 = 加一行（而不是把一行拆成两行、把表拆坏） */
export const tableEnter = ({ state, dispatch }) => {
  const r = state.selection.main;
  if (!r.empty || state.selection.ranges.length !== 1) return false;
  const line = state.doc.lineAt(r.head);
  const tbl = tableAt(state, line.number);
  if (!tbl) return false;
  const cols = Math.max(1, tablePipes(line.text).length - 1);
  const idx0 = line.number - 1;
  // 表头 / 分隔行上回车：新行要落在分隔行之后，否则会把表头和分隔行拆开
  const after = (idx0 === tbl.header.line || idx0 === tbl.header.line + 1)
    ? state.doc.line(Math.min(tbl.header.line + 2, state.doc.lines))
    : line;
  return insertTableRow(state, dispatch, after, cols);
};

/* ================= Ctrl+B/I/S/K：包裹 / 插入（对齐 editor.js） ================= */
function toggleWrap(open, close) {
  return ({ state, dispatch }) => {
    const changes = state.changeByRange((range) => {
      if (range.empty) {
        return {
          changes: { from: range.head, insert: open + close },
          range: EditorSelection.cursor(range.head + open.length),
        };
      }
      const text = state.sliceDoc(range.from, range.to);
      return {
        changes: { from: range.from, to: range.to, insert: open + text + close },
        range: EditorSelection.range(range.from + open.length, range.from + open.length + text.length),
      };
    });
    dispatch(state.update(changes, { scrollIntoView: true, userEvent: 'input' }));
    return true;
  };
}

export const toggleBold = toggleWrap('**', '**');
export const toggleItalic = toggleWrap('*', '*');
export const toggleStrike = toggleWrap('~~', '~~');

/** Ctrl+K：插入双链（有选区用选区文字，无选区用占位「链接文字」并选中它） */
export const insertWikilink = ({ state, dispatch }) => {
  const changes = state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to) || '链接文字';
    const insert = `[[${text}]]`;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.range(range.from + 2, range.from + 2 + text.length),
    };
  });
  dispatch(state.update(changes, { scrollIntoView: true, userEvent: 'input' }));
  return true;
};

/* ================= 附件粘贴 / 拖入拦截（domEventHandlers） =================
 * 不拦的后果：浏览器把图片塞进 contenteditable（data:/blob:，刷新即丢）、
 * 拖入文件直接导航打开。返回 true → CM preventDefault 且不再走后续处理器。
 * 这里只「拦 + 递文件」，落盘与回插由调用方负责（P4 = editor.js 的 _saveAssetFile）。 */
export function assetEventHandlers({ onAssetFile } = {}) {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const file = [...(event.clipboardData?.items || [])]
        .filter((it) => it.kind === 'file').map((it) => it.getAsFile()).find(Boolean);
      if (!file) return false;               // 纯文本粘贴：放行给 CM 的默认处理
      onAssetFile?.(file, view, event);
      return true;                           // 拦掉默认插入
    },
    drop(event, view) {
      const files = [...(event.dataTransfer?.files || [])];
      if (!files.length) return false;
      for (const f of files) onAssetFile?.(f, view, event);
      return true;
    },
    dragover(event) {
      // 有文件在拖 → 必须 preventDefault，否则 drop 事件不会触发
      return [...(event.dataTransfer?.types || [])].includes('Files');
    },
  });
}

/* ================= 装配 ================= */

/** P2 编辑动作 keymap。Prec.high 保证压在 defaultKeymap 之前；
 *  Enter/Backspace 只在 markdown 上下文命中，未命中会继续落到 defaultKeymap。 */
export const editingKeymap = [
  // 表格优先：Tab/Enter 在表格里是「跳格/加行」，其余情况再走列表与缩进
  { key: 'Enter', run: tableEnter },
  { key: 'Tab', run: tableTabNext },
  { key: 'Shift-Tab', run: tableTabPrev },
  { key: 'Enter', run: continueMarkupOrTask },
  { key: 'Backspace', run: deleteMarkupBackward },
  { key: 'Tab', run: indentMore },
  { key: 'Shift-Tab', run: indentLess },
  { key: 'Mod-b', run: toggleBold },
  { key: 'Mod-i', run: toggleItalic },
  { key: 'Mod-s', run: toggleStrike },
  { key: 'Mod-k', run: insertWikilink },
];

/**
 * P2 编辑扩展集合。用法：
 *   EditorState.create({ doc, extensions: [
 *     markdown({ base: markdownLanguage, addKeymap: false }), // 交出自己的 keymap
 *     ...editingExtensions({ onAssetFile }),
 *   ]})
 * 注意要与 `markdown({ addKeymap: false })` 搭配：否则内置 markdownKeymap
 * （Prec.high）会和本 keymap 抢 Enter/Backspace 的绑定顺序。
 */
export function editingExtensions({ onAssetFile } = {}) {
  return [
    Prec.high(keymap.of(editingKeymap)),
    assetEventHandlers({ onAssetFile }),
  ];
}
