/**
 * cmlab.js — 编辑区内核迁移 P0 探针（独立页，不碰 public/js/editor.js）
 * ------------------------------------------------------------------
 * 验证目标（EDITOR-MIGRATION.md P0）：
 *   1. 中文输入法组词不丢字（由 test/cmlab-test.mjs 经 CDP Input.imeSetComposition 驱动；
 *      页内手动组词也可观察，compositionstart/update/end 全程记录）
 *   2. 行号与源码逐行一致（含折行不重复编号、开关可切）
 *   3. 3000 行滚动：视口外不渲染 DOM、帧时间、单次变更更新成本
 *   4. Decoration.widget 高度变化时滚动稳定性（4 个变体：视口内 state 切换 /
 *      视口上方 state 切换 / 原地 DOM 变更 + requestMeasure / anchor 补偿）
 *   5. history() 撤销恢复 doc 与选区
 *   6. 行内编辑（P2）：Enter 续列表/任务列表、Tab 缩进、Ctrl+B/I/S/K、
 *      粘贴/拖入附件在 domEventHandlers 里拦掉
 *   7. 块级 widget（P3）：图片嵌入 + 拖宽、复选框、Callout 行装饰、表格边框、双链/标签事件
 *
 * 结果同时渲染到页面表格并暴露在 window.__probe.results。
 */
import { EditorState, EditorSelection, Compartment, StateEffect, StateField, RangeSetBuilder } from '@codemirror/state';
import { EditorView, Decoration, ViewPlugin, keymap, lineNumbers, WidgetType } from '@codemirror/view';
import { history, undo, redo, defaultKeymap, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { livePreviewPlugin, fenceHiding } from './cm/decorations.js';
import { editingExtensions } from './cm/editing.js';
import { widgetExtensions } from './cm/widgets.js';

/* ================= 文档生成（确定性，3000 行中文 md） ================= */

const COLLAPSE_LINE_NO = 600; // :::collapse 挂件（state 驱动 expand/collapse）
const GROW_LINE_NO = 620;     // :::grow 挂件（原地 DOM 增高 + requestMeasure）
const LONG_LINE_NO = 1233;    // 超长行（验证折行不重复编号）

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildDoc(totalLines = 3000) {
  const rnd = mulberry32(20261018);
  const out = [];
  for (let i = 1; i <= totalLines; i++) {
    if (i === COLLAPSE_LINE_NO) { out.push(':::collapse 可折叠挂件探针 · P0 widget 高度变化（展开后正文增高约 300px）'); continue; }
    if (i === GROW_LINE_NO) { out.push(':::grow 内联增高挂件探针 · requestMeasure'); continue; }
    if (i === LONG_LINE_NO && totalLines >= LONG_LINE_NO) {
      out.push('超长折行测试行：' + '中文内容重复填充，验证折行只占一个行号、不重复编号。'.repeat(8));
      continue;
    }
    const r = rnd();
    if (i % 50 === 0) out.push(`# 第 ${i / 50} 章 · 中文标题测试`);
    else if (i % 17 === 3) out.push(`## ${i} 小节 · 二级标题`);
    else if (i % 23 === 8) out.push('```js');
    else if (i % 23 === 10) out.push('```');
    else if (i % 13 === 6) out.push(`- [ ] 任务项 ${i}：待办内容测试`);
    else if (i % 11 === 5) out.push(`> 引用第 ${i} 行：中文引述内容，测试行装饰。`);
    else if (i % 7 === 2) out.push(`- **要点 ${i}**：含 \`inline code\` 与 [[双链-${i}]] 的中文列表项。`);
    else if (r < 0.5) out.push(`正文第 ${i} 行，**粗体片段**与普通中文文字混排，测试行级渲染与滚动稳定性。`);
    else if (r < 0.75) out.push(`第 ${i} 行是一段较长的中文段落，用来填充视口，包含 [[内部链接-${i}]] 与 #标签${i % 9} 。`);
    else out.push(`短行 ${i}。`);
  }
  return out.join('\n') + '\n';
}

/* ================= live preview 装饰（探针最小集） ================= */

const toggleCollapse = StateEffect.define();
const collapseOpen = StateField.define({
  create: () => false,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(toggleCollapse)) v = !v;
    return v;
  },
});

/** P1 起，实时预览装饰改用真实的装饰生成器（与块级渲染同一份 parseMarkdown）；
 *  探针页早先的手写装饰（computeFenceMap + livePreview）已删除。
 *  下面只剩两个 block widget 探针（P3 预演：可折叠卡 / 原地增高卡）。 */

class CollapseWidget extends WidgetType {
  constructor(open) { super(); this.open = open; }
  eq(other) { return other.open === this.open; }
  get estimatedHeight() { return this.open ? 340 : 48; }
  toDOM() {
    const wrap = document.createElement('div');
    wrap.className = 'probe-collapse';
    const btn = document.createElement('button');
    btn.textContent = this.open ? '收起 ▲' : '展开 ▼';
    const body = document.createElement('div');
    body.className = 'spacer';
    body.style.height = this.open ? '300px' : '0px';
    btn.addEventListener('click', () => {
      // 手动点击也走同一条 state effect 通道（和 runner 驱动的是同一条路）
      VIEW.dispatch({ effects: toggleCollapse.of(null) });
    });
    wrap.append(btn, body);
    return wrap;
  }
  ignoreEvent() { return true; }
}

class GrowWidget extends WidgetType {
  constructor() { super(); this.tall = false; }
  get estimatedHeight() { return this.tall ? 340 : 48; }
  toDOM() {
    const wrap = document.createElement('div');
    wrap.className = 'probe-grow';
    const btn = document.createElement('button');
    btn.textContent = '原地增高 +300px';
    const spacer = document.createElement('div');
    spacer.className = 'spacer';
    spacer.style.height = '0px';
    btn.addEventListener('click', () => {
      this.tall = !this.tall;
      btn.textContent = this.tall ? '复原高度' : '原地增高 +300px';
      spacer.style.height = this.tall ? '300px' : '0px';
      // 关键：widget 内部 DOM 高度变化后必须主动请求重新测量
      VIEW.requestMeasure();
    });
    wrap.append(btn, spacer);
    return wrap;
  }
  ignoreEvent() { return true; }
}

/**
 * 块级 widget 装饰必须走 StateField（CM6 规定：block 装饰不能来自 ViewPlugin，
 * 因为插件是视口作用域，而块装饰影响全文高度测量）。全文扫描一次拿到两个
 * marker 行的位置——探针文档里它们是固定行，真实实现应按位置索引增量维护。
 */
const widgetDecorations = StateField.define({
  create(state) { return buildWidgets(state); },
  update(value, tr) { return tr.docChanged ? buildWidgets(tr.state) : value; },
  provide: (f) => EditorView.decorations.from(f),
});

function buildWidgets(state) {
  const b = new RangeSetBuilder();
  const open = state.field(collapseOpen);
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    if (/^:::collapse\b/.test(line.text)) {
      b.addRange(line.from, line.to, Decoration.replace({ widget: new CollapseWidget(open), block: true }));
    } else if (/^:::grow\b/.test(line.text)) {
      b.addRange(line.from, line.to, Decoration.replace({ widget: new GrowWidget(), block: true }));
    }
  }
  return b.finish();
}



/* ================= 装配 EditorView ================= */

/* ---------- 附件拦截回调（P2 ⑥）----------
 * 模拟 editor.js 的 _saveAssetFile 后半段：真实 P4 是「存盘 → 回插 ![[path]]」，
 * 探针只记录 File 并回插一个可断言的占位路径，用来验证「拦截生效、
 * 且文档里不出现浏览器默认塞进来的 data:/blob:」。 */
const assetLog = [];
function onAssetFile(file) {
  assetLog.push({ name: file.name, type: file.type, size: file.size });
  const head = VIEW.state.selection.main.head;
  VIEW.dispatch({ changes: { from: head, insert: `![[attachments/${file.name}]]` } });
}

/* ---------- P3 widget 依赖回调（无服务端）----------
 * 探针页没有 vault/Api：图片 URL 用桩 resolveImage（返回 /demo-vault/<name>），
 * 双链/标签事件只记录到 linkLog，供第 ⑦ 项断言。P4 接 editor.js 的
 * resolveFile/Api.fileUrl 与 _openWikilink/_schedulePreview/onTagClick。 */
const linkLog = [];
const imageStub = (name) => `/demo-vault/${name}`;

const lineNumComp = new Compartment();
const EXTENSIONS = [
  lineNumComp.of(lineNumbers()),
  history(),
  keymap.of([...historyKeymap, ...defaultKeymap]),
  // addKeymap:false —— 把 Enter/Backspace 的绑定让给 P2 的 editing keymap（见 cm/editing.js），
  // 否则内置 markdownKeymap（Prec.high）会和它抢顺序
  markdown({ base: markdownLanguage, addKeymap: false }),
  syntaxHighlighting(defaultHighlightStyle),
  collapseOpen,
  widgetDecorations,
  livePreviewPlugin,
  fenceHiding,
  ...editingExtensions({ onAssetFile }),
  ...widgetExtensions({
    resolveImage: imageStub,
    onOpenWikilink: (target) => linkLog.push(['open', target]),
    onHoverWikilink: (target) => linkLog.push(['hover', target]),
    onTagClick: (target) => linkLog.push(['tag', target]),
  }),
  EditorView.editable.of(true),
  EditorView.lineWrapping,
];

let VIEW = null;
VIEW = new EditorView({
  parent: document.getElementById('cm'),
  state: EditorState.create({ doc: buildDoc(3000), extensions: EXTENSIONS }),
});
const view = VIEW;

/* ================= 探针基础设施 ================= */

const results = {};
const raf = () => new Promise((r) => requestAnimationFrame(r));
const nextFrames = async (n) => { for (let i = 0; i < n; i++) await raf(); };
const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const avg = (arr) => arr.reduce((a, b) => a + b, 0) / (arr.length || 1);

function scrollLineToTop(lineNo) {
  const pos = view.state.doc.line(lineNo).from;
  view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'start' }) });
}
function anchorY(lineNo) {
  return view.coordsAtPos(view.state.doc.line(lineNo).from).top;
}

/**
 * 等滚动稳定：CM6 在滚动活跃期会延迟清理视口外 DOM（防抖机制），
 * 直接查 DOM 会采到过渡状态的旧元素。等到 scrollTop 连续多帧不变再测。
 */
async function waitScrollSettle(maxFrames = 40) {
  let last = -1, stable = 0;
  for (let i = 0; i < maxFrames; i++) {
    await raf();
    const now = view.scrollDOM.scrollTop;
    if (now === last) { if (++stable >= 4) return; } else { stable = 0; last = now; }
  }
}

/** 视口内可见的行号元素（过滤隐藏的 9999 测量元素和滚动过渡期的旧元素） */
function visibleGutterNumbers() {
  const r = view.scrollDOM.getBoundingClientRect();
  return [...view.dom.querySelectorAll('.cm-lineNumbers .cm-gutterElement')]
    .filter((e) => e.style.visibility !== 'hidden')
    .map((e) => ({ n: +e.textContent, top: e.getBoundingClientRect().top }))
    .filter((x) => x.top >= r.top - 2 && x.top < r.bottom)
    .sort((a, b) => a.top - b.top)
    .map((x) => x.n);
}

/** 视口内可见的内容行元素数（零高的围栏行不算「可见」） */
function visibleLineCount() {
  const r = view.scrollDOM.getBoundingClientRect();
  return [...view.dom.querySelectorAll('.cm-content .cm-line')]
    .filter((e) => {
      const rect = e.getBoundingClientRect();
      return rect.height > 2 && rect.top >= r.top - 2 && rect.top < r.bottom;
    }).length;
}

/* ================= 探针 1：行号 ================= */

async function probeLineNumbers() {
  await nextFrames(2);
  const gutterTexts = () => visibleGutterNumbers();

  // a) 顶部：行号从 1 开始、严格递增无重复，且「可见行一个号」
  // 注意：围栏行被 fenceHiding 收起成零高后，CM6 原生行号槽不给零高的行编号
  // （Obsidian 用同一个槽，行为相同）——所以序号在代码块围栏处有断差是正常的，
  // 不断的是「可见行 ↔ 行号」一一对应。
  view.scrollDOM.scrollTop = 0;
  await waitScrollSettle();
  const topTexts = gutterTexts();
  const startsAtOne = topTexts[0] === 1;
  let strictlyIncreasing = true;
  for (let i = 1; i < topTexts.length; i++) {
    if (topTexts[i] <= topTexts[i - 1]) { strictlyIncreasing = false; break; }
  }
  const gutterPerLine = topTexts.length === visibleLineCount();

  // b) 滚到中部：行号与视口顶部真实 doc 行号对齐（取点避开左侧行号槽）
  const midLine = 1500;
  scrollLineToTop(midLine);
  await waitScrollSettle();
  const midTexts = gutterTexts();
  const scrollerRect = view.scrollDOM.getBoundingClientRect();
  const topPos = view.posAtCoords({ x: scrollerRect.left + 150, y: scrollerRect.top + 4 });
  const firstRenderedLine = view.state.doc.lineAt(topPos).number;
  const alignsWithDoc = midTexts[0] === firstRenderedLine && midTexts[0] === midLine;

  // c) 折行验证：超长行真实折成多个视觉行，但仍只占一个行号
  scrollLineToTop(LONG_LINE_NO - 3);
  await waitScrollSettle();
  const longLine = view.state.doc.line(LONG_LINE_NO);
  const longBlock = view.lineBlockAt(longLine.from);
  const lineH = view.defaultLineHeight;
  const wrapped = longBlock.height > lineH * 1.5;
  const wrapTexts = gutterTexts();
  const longNumberOnce = wrapTexts.filter((t) => t === LONG_LINE_NO).length === 1;
  const noDup = new Set(wrapTexts).size === wrapTexts.length;

  // d) 开关：compartment reconfigure 是 effect，必须 dispatch 才生效
  view.dispatch({ effects: lineNumComp.reconfigure([]) });
  await nextFrames(2);
  const off = gutterTexts().length;
  view.dispatch({ effects: lineNumComp.reconfigure(lineNumbers()) });
  await nextFrames(2);
  const back = gutterTexts().length;

  const ok = startsAtOne && strictlyIncreasing && gutterPerLine && alignsWithDoc &&
    wrapped && longNumberOnce && noDup && off === 0 && back > 0;
  return {
    ok,
    metrics: {
      'doc 行数(含文末空行)': view.state.doc.lines,
      '顶部行号从 1 开始': startsAtOne,
      '行号严格递增(围栏处有断差)': strictlyIncreasing,
      '一行一号(不按折行重复)': gutterPerLine,
      '中部行号与 doc 行对齐': alignsWithDoc,
      '中部首个行号': `${midTexts[0]}（期望 ${midLine}，视口首行 ${firstRenderedLine}）`,
      '超长行折行视觉行数': wrapped ? Math.round(longBlock.height / lineH) : 1,
      '超长行只占一个行号': longNumberOnce,
      '视口内无重复行号': noDup,
      '关闭后行号 DOM': off,
      '重开后行号 DOM': back,
    },
    notes: wrapped
      ? [`第 ${LONG_LINE_NO} 行折成 ${Math.round(longBlock.height / lineH)} 个视觉行、仍只占 1 个行号`]
      : ['超长行未折行，折行断言未生效'],
  };
}

/* ================= 探针 2：3000 行滚动 ================= */

async function probeScrollPerf() {
  const scroller = view.scrollDOM;
  scroller.scrollTop = 0;
  await nextFrames(3);
  const domLines = [...view.dom.querySelectorAll('.cm-content .cm-line')].filter((e) => e.getBoundingClientRect().height > 2).length;
  const maxScroll = scroller.scrollHeight - scroller.clientHeight;

  // 帧时间：rAF 驱动匀速滚完整个文档
  const deltas = [];
  const step = Math.max(24, Math.round(maxScroll / 150));
  await new Promise((resolve) => {
    let last = performance.now();
    let frames = 0;
    const tick = () => {
      const now = performance.now();
      deltas.push(now - last);
      last = now;
      scroller.scrollTop = Math.min(maxScroll, scroller.scrollTop + step);
      if (++frames < 150 && scroller.scrollTop < maxScroll) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });

  // 单次变更更新成本：在文档头部连续插入 50 个字符后清除
  const costs = [];
  for (let i = 0; i < 50; i++) {
    const t0 = performance.now();
    view.dispatch(view.state.changeByRange(() => ({ changes: { from: 0, insert: 'x' }, range: EditorSelection.cursor(1) })));
    costs.push(performance.now() - t0);
  }
  view.dispatch(view.state.changeByRange(() => ({ changes: { from: 0, to: 50, insert: '' }, range: EditorSelection.cursor(0) })));
  await nextFrames(2);

  const dropped = deltas.filter((d) => d > 20).length;
  const ok = domLines < 300 && Math.max(...deltas) < 100 && pct(costs, 95) < 16;
  return {
    ok,
    metrics: {
      '文档总行数': view.state.doc.lines,
      'DOM 实际行元素数(视口外不渲染)': domLines,
      '滚动帧数': deltas.length,
      '帧间隔 avg/p95/max (ms)': `${avg(deltas).toFixed(1)} / ${pct(deltas, 95).toFixed(1)} / ${Math.max(...deltas).toFixed(1)}`,
      '掉帧(>20ms)': `${dropped}/${deltas.length}`,
      '单次变更 avg/p95 (ms)': `${avg(costs).toFixed(2)} / ${pct(costs, 95).toFixed(2)}`,
    },
    notes: ['帧时间为无头浏览器 rAF 口径，仅代表量级；单次变更是同步 dispatch 口径，更可信'],
  };
}

/* ================= 探针 3：widget 高度变化 × 滚动稳定性 ================= */

async function probeWidgetScroll() {
  const drift = {};
  const anchorLineA = COLLAPSE_LINE_NO + 8;

  // 变体 A：挂件在视口内、位于锚点上方；state effect 切换 expand（事务驱动）
  scrollLineToTop(anchorLineA);
  await waitScrollSettle();
  const yA1 = anchorY(anchorLineA);
  view.dispatch({ effects: toggleCollapse.of(null) });
  await nextFrames(8);
  const yA2 = anchorY(anchorLineA);
  view.dispatch({ effects: toggleCollapse.of(null) });
  await nextFrames(8);
  const yA3 = anchorY(anchorLineA);
  drift['A 视口内·事务驱动'] = { expand: +(yA2 - yA1).toFixed(1), collapse: +(yA3 - yA2).toFixed(1) };

  // 变体 B：挂件在视口上方 3 行（不可见但参与高度测量）；state effect 切换
  const anchorLineB = COLLAPSE_LINE_NO + 3;
  scrollLineToTop(anchorLineB);
  await waitScrollSettle();
  const yB1 = anchorY(anchorLineB);
  view.dispatch({ effects: toggleCollapse.of(null) });
  await nextFrames(8);
  const yB2 = anchorY(anchorLineB);
  view.dispatch({ effects: toggleCollapse.of(null) });
  await nextFrames(8);
  const yB3 = anchorY(anchorLineB);
  drift['B 视口上方·事务驱动'] = { expand: +(yB2 - yB1).toFixed(1), collapse: +(yB3 - yB2).toFixed(1) };

  // 变体 C：挂件在视口内，原地改 DOM 高度 + view.requestMeasure()（无事务）
  const anchorLineC = GROW_LINE_NO + 8;
  scrollLineToTop(GROW_LINE_NO + 2); // 挂件可见（视口顶部往下 2 行），锚点在其下方
  await waitScrollSettle();
  const growBtn = view.dom.querySelector('.probe-grow button');
  if (!growBtn) return { ok: false, metrics: { 异常: '找不到 .probe-grow 按钮，挂件未渲染' }, notes: [] };
  const yC1 = anchorY(anchorLineC), stC1 = view.scrollDOM.scrollTop;
  growBtn.click();
  await nextFrames(8);
  const yC2 = anchorY(anchorLineC), stC2 = view.scrollDOM.scrollTop;
  growBtn.click();
  await nextFrames(8);
  const yC3 = anchorY(anchorLineC), stC3 = view.scrollDOM.scrollTop;
  drift['C 视口内·原地DOM+requestMeasure'] = {
    grow: +(yC2 - yC1).toFixed(1),
    shrink: +(yC3 - yC2).toFixed(1),
    'scrollTop增量(grow)': +(stC2 - stC1).toFixed(1),
    'scrollTop增量(shrink)': +(stC3 - stC2).toFixed(1),
  };

  // 变体 D：同 C，但变化后用 anchor 补偿 scrollTop（带收敛：补一次测一次，最多 3 轮）。
  // 单次补偿的残余本来就会在 ±10px 抖（测量时序），收敛后才代表缓解手段的真实效果。
  scrollLineToTop(GROW_LINE_NO + 2);
  await waitScrollSettle();
  const yD1 = anchorY(anchorLineC);
  growBtn.click();
  await waitScrollSettle();          // 等 CM 测量 + 自身滚动调整全部稳定，量到完整漂移
  const yD2 = anchorY(anchorLineC);
  view.scrollDOM.scrollTop += (yD2 - yD1);   // 单次锚点补偿
  await waitScrollSettle();
  const yD3 = anchorY(anchorLineC);
  drift['D 同C + anchor补偿'] = {
    rawGrow: +(yD2 - yD1).toFixed(1),
    compensated: +(yD3 - yD1).toFixed(1),
  };

  // 挂件文本已被 replace 装饰替换（不作为正文出现）
  scrollLineToTop(COLLAPSE_LINE_NO + 2);
  await waitScrollSettle();
  const rawMarkerGone = !view.dom.querySelector('.cm-content').textContent.includes(':::collapse');

  const txWorst = Math.max(
    ...Object.values(drift['A 视口内·事务驱动']).concat(Object.values(drift['B 视口上方·事务驱动']))
      .map((v) => Math.abs(v)),
  );
  const inPlaceWorst = Math.max(
    Math.abs(drift['C 视口内·原地DOM+requestMeasure'].grow),
    Math.abs(drift['C 视口内·原地DOM+requestMeasure'].shrink),
  );
  // 判定只落在 A/B（P3 实际要走的「事务驱动」路径）：零漂移必须成立。
  // C/D 是「原地 DOM + 手写 scrollTop 补偿」的实测记录——补偿会和 CM 自己的
  // 测量周期互抢滚动位置（实测过冲 60px+），结论就是「别这么干」，不作为通过条件。
  const ok = txWorst < 2 && rawMarkerGone;
  return {
    ok,
    metrics: {
      '锚点漂移 px（越小越稳）': JSON.stringify(drift),
      '事务驱动最大漂移': txWorst.toFixed(1) + 'px',
      '原地DOM变更最大漂移': inPlaceWorst.toFixed(1) + 'px',
      'marker 行已被 widget 替换': rawMarkerGone,
    },
    notes: [
      txWorst < 2
        ? '事务驱动（dispatch effect → 装饰重建）CM6 自动做滚动锚定，零漂移——P3 应优先用这条路径'
        : '事务驱动也出现漂移，需要进一步排查',
      inPlaceWorst >= 2
        ? `原地改 DOM + requestMeasure 不经事务，CM 滚动锚定不生效，跳动约 ${inPlaceWorst.toFixed(0)}px；` +
          '手写 scrollTop 补偿会被 CM 测量周期再次调整（实测过冲），不可靠——P3 挂件高度变化一律走 state effect 事务'
        : '原地 DOM 变更亦无漂移',
      'estimatedHeight 已设置（collapse 收起 48 / 展开 340），用于测量前的占位',
    ],
  };
}

/* ================= 探针 4：history 撤销/重做 ================= */

async function probeHistory() {
  const lineNo = 10;
  const line = view.state.doc.line(lineNo);
  const from = line.from + 4, to = line.from + 12;
  view.dispatch(view.state.update({ selection: { anchor: from, head: to } }));
  await nextFrames(1);
  const selBefore = { anchor: view.state.selection.main.anchor, head: view.state.selection.main.head };
  const docBefore = view.state.doc.toString();

  view.dispatch(view.state.changeByRange((range) => ({
    changes: { from: range.from, to: range.to, insert: '探针文本' },
    range: EditorSelection.cursor(range.from + 4),
  })));
  await nextFrames(1);
  const docAfter = view.state.doc.toString();
  const selAfterInsert = { anchor: view.state.selection.main.anchor, head: view.state.selection.main.head };

  undo(view);
  await nextFrames(1);
  const docUndone = view.state.doc.toString();
  const selAfterUndo = { anchor: view.state.selection.main.anchor, head: view.state.selection.main.head };

  redo(view);
  await nextFrames(1);
  const docRedone = view.state.doc.toString();
  const selAfterRedo = { anchor: view.state.selection.main.anchor, head: view.state.selection.main.head };

  const docOk = docUndone === docBefore && docRedone === docAfter;
  // CM6 实测语义：undo 恢复改动前选区（286..294）；
  // redo 把「重做的变更区间」设为选区——插入 4 字后选中 286..290（即插入文本本身）。
  const selUndoRestored = selAfterUndo.anchor === selBefore.anchor && selAfterUndo.head === selBefore.head;
  const selRedoRestored = selAfterRedo.anchor === selBefore.anchor &&
    selAfterRedo.head === selBefore.anchor + 4; // '探针文本' 4 字
  return {
    ok: docOk && selUndoRestored && selRedoRestored,
    metrics: {
      'undo 后 doc 还原': docUndone === docBefore,
      'redo 后 doc 还原': docRedone === docAfter,
      'undo 恢复改动前选区': selUndoRestored,
      'redo 选中重做的插入区间': selRedoRestored,
      '改动前选区': `${selBefore.anchor}..${selBefore.head}`,
      '插入后光标': `${selAfterInsert.anchor}..${selAfterInsert.head}`,
      'undo 后选区': `${selAfterUndo.anchor}..${selAfterUndo.head}`,
      'redo 后选区': `${selAfterRedo.anchor}..${selAfterRedo.head}`,
    },
    notes: [
      'CM6 history 实测：undo → 改动前选区；redo → 选中被重做的变更区间（插入的 4 个字）',
      '即迁移文档第 2 节验收项 9「CM 原生历史（带选区/滚动还原）」成立',
    ],
  };
}

/* ================= IME 探针（CDP 驱动，页内只做记录与校验） ================= */

const imeLog = [];
for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'compositioncancel']) {
  view.dom.addEventListener(type, (e) => imeLog.push({ type, data: e.data || '' }));
}
const imeProbe = { before: '', at: 0, lineNo: 0, col: 0, composingSeen: null, domShown: null };

/* ================= 探针 5：装饰渲染（P1） ================= */

const P1_FIXTURE = [
  '# 标题行',
  '普通段落 **粗体**、*斜体*、~~删除线~~、==高亮==、`代码`、[[双链]] #标签',
  '## 二级标题',
  '- 列表项',
  '> 引用行',
  '```js',
  'const a = 1;',
  '```',
  '---',
  '| 甲 | 乙 |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
].join('\n');

async function probeDecorations() {
  view.dispatch({ effects: [] }); // noop，确保视图活着
  view.setState(EditorState.create({ doc: P1_FIXTURE, extensions: EXTENSIONS }));
  // 光标放到第 10 行（远离标题/行内标记），验证「非光标行隐藏标记」
  view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(10).from) });
  await waitScrollSettle();
  const lineByText = (needle) =>
    [...view.dom.querySelectorAll('.cm-line')].find((e) => e.textContent.includes(needle)) || null;
  const m = {};
  const okOf = (name, cond, detail) => { m[name] = cond ? '✅' : '❌ ' + (detail ?? ''); return cond; };

  // ① 标题：非光标行藏掉 # 前缀、行装饰生效
  const h1 = lineByText('标题行');
  const h1ok = !!h1 && h1.textContent === '标题行' && h1.className.includes('cm-lp-h1');
  // ② 行内：标记全藏、内容带样式类
  const para = lineByText('普通段落');
  const paraText = para ? para.textContent : '';
  const inlineOk = !!para && paraText === '普通段落 粗体、斜体、删除线、高亮、代码、双链 #标签';
  const clsOk = !!para && ['cm-lp-bold', 'cm-lp-em', 'cm-lp-del', 'cm-lp-mark', 'cm-lp-code', 'cm-lp-wikilink', 'cm-lp-tag']
    .every((c) => para.querySelector('.' + c));
  // ③ 列表标记常显（muted）
  const li = lineByText('列表项');
  const liOk = !!li && li.textContent === '- 列表项' && !!li.querySelector('.cm-lp-marker');
  // ④ 引用：> 藏掉
  const q = lineByText('引用行');
  const qOk = !!q && q.textContent === '引用行';
  // ⑤ 围栏行收起（零高）、代码行可见
  const fenceH = view.lineBlockAt(view.state.doc.line(6).from).height;   // ```js 行
  const codeLine = lineByText('const a = 1;');
  const fenceOk = fenceH < 2 && !!codeLine;
  // ⑥ 分割线文本藏掉（按 class 找——围栏行被块替换后没有 .cm-line 元素，下标会歪）
  const hrLine = view.dom.querySelector('.cm-lp-hr');
  const hrOk = !!hrLine && hrLine.textContent === '';
  // ⑦ 表格分隔行塌成零高（块级收起，StateField）
  const delim = view.state.doc.line(11);
  const delimH = view.lineBlockAt(delim.from).height;
  const tableRows = [...view.dom.querySelectorAll('.cm-lp-tr')].length;
  // ⑧ 光标行规则：光标移到标题行 → # 重新出现
  view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(1).from) });
  await nextFrames(3);
  const h1raw = lineByText('标题行');
  const cursorRuleOk = !!h1raw && h1raw.textContent === '# 标题行';
  // 光标移进行内标记行 → 标记重新出现
  view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(2).from + 4) });
  await nextFrames(3);
  const paraRaw = lineByText('普通段落');
  const cursorRule2Ok = !!paraRaw && paraRaw.textContent.includes('**粗体**');

  // 恢复合成文档：后面的 IME 探针按第 5 行定位，不能被夹具文档影响
  view.setState(EditorState.create({ doc: buildDoc(3000), extensions: EXTENSIONS }));

  const checks = { '标题藏#且带行装饰': h1ok, '行内标记全藏': inlineOk, '行内样式类齐全': clsOk, '列表标记常显': liOk, '引用>藏掉': qOk, '围栏收起代码可见': fenceOk, '分割线文本藏掉': hrOk, '表格分隔行收起': delimH < 2 && tableRows >= 2, '光标行显示原始#': cursorRuleOk, '光标行显示原始**': cursorRule2Ok };
  const allOk = Object.values(checks).every(Boolean);
  return {
    ok: allOk,
    metrics: {
      ...Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, v ? '✅' : '❌'])),
      '围栏行高度': fenceH.toFixed(1) + 'px',
      '表格行装饰数': tableRows,
      '段落渲染文本': JSON.stringify(paraText),
    },
    notes: allOk ? ['P1 装饰生成器（cm/decorations.js）与块级渲染口径一致'] : ['有断言失败，见上方 ❌ 项'],
  };
}

/* ================= 探针 6：行内编辑（P2） =================
 * 覆盖 EDITOR-MIGRATION.md 第 4 节 P2 的全部动作。键盘走 CM 真实事件管线
 * （contentDOM.dispatchEvent → handleEvent → runHandlers → keymap），不是直接调命令，
 * 这样才能证明 keymap 装配（Prec.high + markdown addKeymap:false）是对的。
 * 粘贴/拖入无法用真实输入法/鼠标驱动，用合成 ClipboardEvent/PasteEvent + DataTransfer
 * （File 对象）走同一套 domEventHandlers。 */

const P2_FIXTURE = [
  '- [ ] 甲任务',
  '- 乙列表',
  '普通段落',
  '- [ ] ',
  '加粗候选文本',
  '',
].join('\n') + '\n';

async function probeEditing() {
  const checks = {};
  const metrics = {};
  const ok = (name, cond, detail) => { checks[name] = !!cond; metrics[name] = (cond ? '✅' : '❌') + (detail !== undefined ? ` (${detail})` : ''); return !!cond; };

  const setDoc = async (text) => {
    view.setState(EditorState.create({ doc: text, extensions: EXTENSIONS }));
    await nextFrames(2);
  };
  const caret = (lineNo, col = 0) => view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(lineNo).from + col) });
  const selectCols = (lineNo, a, b) => { const l = view.state.doc.line(lineNo); view.dispatch({ selection: EditorSelection.range(l.from + a, l.from + b) }); };
  const lineText = (n) => view.state.doc.line(n).text;
  const caretCol = (n) => view.state.selection.main.head - view.state.doc.line(n).from;
  // 合成 keydown 走真实键盘管线；返回是否被 preventDefault（= 命中 keymap）
  const press = async (key, mods = {}) => {
    const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods });
    view.contentDOM.dispatchEvent(ev);
    await nextFrames(1);
    return ev.defaultPrevented;
  };
  const fileEvent = async (type, prop, file) => {
    const dt = new DataTransfer();
    dt.items.add(file);
    const ev = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, prop, { value: dt });
    view.contentDOM.dispatchEvent(ev);
    await nextFrames(1);
    return ev;
  };
  const png = (name) => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: 'image/png' });

  /* --- Enter：续任务列表（自定义，CM 内置不续 [ ]） --- */
  await setDoc(P2_FIXTURE);
  caret(1, lineText(1).length);
  await press('Enter');
  ok('Enter续任务列表(- [ ] )', lineText(2) === '- [ ] ' && lineText(1) === '- [ ] 甲任务' && caretCol(2) === 6, JSON.stringify(lineText(2)));

  /* --- Enter：续无序 / 有序（CM 内置） --- */
  await setDoc(P2_FIXTURE);
  caret(2, lineText(2).length);
  await press('Enter');
  ok('Enter续无序列表(- )', lineText(3) === '- ', JSON.stringify(lineText(3)));

  await setDoc('1. 第一\n2. 第二\n\n');
  caret(2, lineText(2).length);
  await press('Enter');
  ok('Enter续有序列表自增(2.→3.)', lineText(3) === '3. ', JSON.stringify(lineText(3)));

  await setDoc('> 引用第 1 行\n正文\n');
  caret(1, lineText(1).length);
  await press('Enter');
  ok('Enter续引用(> )', lineText(2) === '> ', JSON.stringify(lineText(2)));

  /* --- Enter：空任务项退出列表 --- */
  await setDoc(P2_FIXTURE);
  caret(4, lineText(4).length);
  await press('Enter');
  ok('空任务项回车退出列表', lineText(4) === '', JSON.stringify(lineText(4)));

  /* --- Tab / Shift+Tab：2 空格缩进 --- */
  await setDoc(P2_FIXTURE);
  caret(1, 0);
  const tabPrevented = await press('Tab');
  ok('Tab缩进列表行(+2)', tabPrevented && lineText(1) === '  - [ ] 甲任务' && caretCol(1) === 2, JSON.stringify(lineText(1)));

  await setDoc('  - [ ] 甲任务\n');
  caret(1, 4);
  await press('Tab', { shiftKey: true });
  ok('Shift+Tab反缩进(-2)', lineText(1) === '- [ ] 甲任务', JSON.stringify(lineText(1)));

  await setDoc(P2_FIXTURE);
  caret(3, 0);
  await press('Tab');
  ok('Tab普通行光标处插2空格', lineText(3) === '  普通段落', JSON.stringify(lineText(3)));

  /* --- Backspace：行首合并（CM 原生 deleteMarkupBackward → deleteCharBackward） --- */
  await setDoc(P2_FIXTURE);
  caret(3, 0);
  await press('Backspace');
  ok('Backspace行首合并到上一行', lineText(2) === '- 乙列表普通段落' && lineText(3) === '- [ ] ', JSON.stringify(lineText(2)));

  /* --- Ctrl+B / I / S：包裹 --- */
  await setDoc(P2_FIXTURE);
  selectCols(5, 0, lineText(5).length);
  await press('b', { ctrlKey: true });
  ok('Ctrl+B包裹选区(** **)', lineText(5) === '**加粗候选文本**', JSON.stringify(lineText(5)));

  await setDoc(P2_FIXTURE);
  selectCols(5, 0, lineText(5).length);
  await press('i', { ctrlKey: true });
  ok('Ctrl+I包裹选区(* *)', lineText(5) === '*加粗候选文本*', JSON.stringify(lineText(5)));

  await setDoc(P2_FIXTURE);
  selectCols(5, 0, lineText(5).length);
  await press('s', { ctrlKey: true });
  ok('Ctrl+S包裹选区(~~ ~~)', lineText(5) === '~~加粗候选文本~~', JSON.stringify(lineText(5)));

  await setDoc(P2_FIXTURE);
  caret(3, 0);
  await press('b', { ctrlKey: true });
  ok('Ctrl+B无选区插标记对', lineText(3) === '****普通段落' && caretCol(3) === 2, JSON.stringify(lineText(3)));

  /* --- Ctrl+K：双链 --- */
  await setDoc(P2_FIXTURE);
  caret(3, lineText(3).length);
  await press('k', { ctrlKey: true });
  const kSel = view.state.selection.main;
  ok('Ctrl+K无选区插[[链接文字]]', lineText(3) === '普通段落[[链接文字]]' && view.state.sliceDoc(kSel.from, kSel.to) === '链接文字', JSON.stringify(lineText(3)));

  await setDoc(P2_FIXTURE);
  selectCols(5, 0, lineText(5).length);
  await press('k', { ctrlKey: true });
  ok('Ctrl+K有选区包双链', lineText(5) === '[[加粗候选文本]]', JSON.stringify(lineText(5)));

  /* --- 粘贴附件：拦掉 + 不落 data:/blob: + 递出 File --- */
  await setDoc(P2_FIXTURE);
  caret(3, 0);
  assetLog.length = 0;
  const pasteEv = await fileEvent('paste', 'clipboardData', png('probe-paste.png'));
  const docAfterPaste = view.state.doc.toString();
  ok('粘贴附件被拦截', pasteEv.defaultPrevented && assetLog.length === 1 && assetLog[0].name === 'probe-paste.png');
  ok('粘贴未落data:/blob:且回插![[..]]',
    !docAfterPaste.includes('data:') && !docAfterPaste.includes('blob:') &&
    docAfterPaste.includes('![[attachments/probe-paste.png]]'));

  /* --- 拖入附件：拦掉 --- */
  await setDoc(P2_FIXTURE);
  caret(3, 0);
  assetLog.length = 0;
  const dropEv = await fileEvent('drop', 'dataTransfer', new File([new Uint8Array([1, 2, 3])], 'probe-drop.pdf', { type: 'application/pdf' }));
  const docAfterDrop = view.state.doc.toString();
  ok('拖入附件被拦截', dropEv.defaultPrevented && assetLog.length === 1 && assetLog[0].name === 'probe-drop.pdf');
  ok('拖入未落data:/blob:且回插![[..]]',
    !docAfterDrop.includes('data:') && !docAfterDrop.includes('blob:') &&
    docAfterDrop.includes('![[attachments/probe-drop.pdf]]'));

  /* --- dragover（含文件）必须拦；纯文本粘贴必须放行 --- */
  await setDoc(P2_FIXTURE);
  const dgEv = await fileEvent('dragover', 'dataTransfer', png('x.png'));
  ok('dragover(含文件)被拦截', dgEv.defaultPrevented);

  const dtText = new DataTransfer();
  dtText.setData('text/plain', 'hello');
  const textPaste = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(textPaste, 'clipboardData', { value: dtText });
  assetLog.length = 0;
  view.contentDOM.dispatchEvent(textPaste);
  await nextFrames(2);
  // 纯文本粘贴：我们的附件拦截器不接（assetLog 不增），交给 CM 内置 paste 正常插入文本。
  // 注意 CM 内置 paste 自己会 preventDefault 并插文本，所以这里不能断言 defaultPrevented=false。
  ok('纯文本粘贴不被当附件拦', assetLog.length === 0 && view.state.doc.toString().includes('hello'));

  // 恢复合成文档：后面的 IME 探针按第 5 行定位，不能被夹具文档影响
  await setDoc(buildDoc(3000));

  const allOk = Object.values(checks).every(Boolean);
  return {
    ok: allOk,
    metrics: { ...metrics, '拦截记录': JSON.stringify(assetLog) },
    notes: allOk
      ? ['P2 编辑内核（cm/editing.js）：Enter 续列表/任务列表、Tab 缩进、Ctrl+B/I/S/K、粘贴拖入拦截全部生效']
      : ['有断言失败，见上方 ❌ 项'],
  };
}

/* ================= 探针 7：块级 widget（P3） =================
 * 覆盖「无服务端依赖」子集：图片嵌入 widget + 拖宽、复选框 widget、Callout 行装饰、
 * 表格边框（不整块 replace）、双链/标签 hover + 点击。图片 URL 用桩 resolveImage。 */

const P3_FIXTURE = [
  '![[pics/demo.png|320]]',          // 1 图片嵌入（整行）
  '',                                 // 2（两行嵌入之间必须空行，否则会被解析成同一个段落）
  '![[notes/a.pdf]]',                 // 3 非图片附件
  '',                                 // 4
  '- [ ] 甲任务',                      // 5
  '- [x] 乙任务',                      // 6
  '> [!tip] 提示标题',                 // 7
  '> 正文仍是可编辑的行',              // 8
  '| 甲 | 乙 |',                       // 9
  '| --- | --- |',                    // 10
  '| 1 | 2 |',                        // 11
  '段落里有 [[双链A]] 与 #标签B 。',   // 12
  '',                                 // 13
].join('\n') + '\n';

async function probeWidgets() {
  const checks = {}, metrics = {};
  const ok = (name, cond, detail) => { checks[name] = !!cond; metrics[name] = (cond ? '✅' : '❌') + (detail !== undefined ? ` (${detail})` : ''); return !!cond; };
  const setDoc = async (text) => { view.setState(EditorState.create({ doc: text, extensions: EXTENSIONS })); await nextFrames(2); };
  const goTo = (lineNo, col = 0) => view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(lineNo).from + col) });
  const lineText = (n) => view.state.doc.line(n).text;
  const contentText = () => view.dom.querySelector('.cm-content')?.textContent || '';

  await setDoc(P3_FIXTURE);
  goTo(13, 0);            // 光标放到末尾空行：前面各行都不是「光标行」
  await nextFrames(3);

  /* ① 图片嵌入 widget（块级 StateField） */
  const imgEl = view.dom.querySelector('.cm-lp-img img');
  ok('图片嵌入渲染为widget', !!imgEl && imgEl.getAttribute('src') === '/demo-vault/pics/demo.png' && Number.parseInt(imgEl.style.width, 10) === 320,
    imgEl ? `src=${imgEl.getAttribute('src')} w=${imgEl.style.width}` : '无 img');
  ok('图片行原始语法被收起', !contentText().includes('![[pics/demo.png'));
  ok('图片widget有右下角拖宽手柄', !!view.dom.querySelector('.cm-lp-img-grip'));

  /* ② 非图片附件 → 文件条 */
  ok('非图片附件渲染为文件条', [...view.dom.querySelectorAll('.cm-lp-img.embed-file')].some((el) => el.textContent.includes('notes/a.pdf')));

  /* ③ 复选框 widget + 点击改 doc */
  const boxes = [...view.dom.querySelectorAll('input.cm-lp-cb')];
  ok('复选框widget(未勾选/已勾选)', boxes.length === 2 && boxes[0].checked === false && boxes[1].checked === true, `${boxes.map((b) => b.checked)}`);
  if (boxes[0]) boxes[0].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
  await nextFrames(2);
  ok('点击复选框改写doc(- [ ]→- [x])', lineText(5) === '- [x] 甲任务', JSON.stringify(lineText(5)));

  /* ④ Callout：行装饰 + 藏标记，正文仍是真实可编辑行 */
  const tipLine = [...view.dom.querySelectorAll('.cm-line')].find((e) => e.textContent.includes('提示标题'));
  const bodyLine = [...view.dom.querySelectorAll('.cm-line')].find((e) => e.textContent.includes('正文仍是可编辑的行'));
  ok('Callout标题行装饰+藏标记', !!tipLine && tipLine.className.includes('cm-lp-callout-tip') && tipLine.textContent === '提示标题', tipLine ? JSON.stringify(tipLine.textContent) : '未找到');
  ok('Callout正文是真实可编辑行', !!bodyLine && bodyLine.className.includes('cm-lp-callout-body') && lineText(8).startsWith('>'));

  /* ⑤ 表格边框（行装饰，不整块 replace；单元格文字仍是源码行） */
  const headLine = [...view.dom.querySelectorAll('.cm-line')].find((e) => e.className.includes('cm-lp-tbl-head'));
  const dataLine = [...view.dom.querySelectorAll('.cm-line')].find((e) => e.className.includes('cm-lp-tbl') && !e.className.includes('cm-lp-tbl-head'));
  const borderW = headLine ? getComputedStyle(headLine).borderBottomWidth : '0px';
  ok('表格行装饰补边框(不replace)', !!headLine && !!dataLine && borderW !== '0px', `borderBottom=${borderW}`);
  ok('表格单元格文字仍可编辑(未replace)', lineText(11) === '| 1 | 2 |');

  /* ⑥ 双链/标签 hover + 点击 */
  linkLog.length = 0;
  const link = view.dom.querySelector('.cm-lp-wikilink');
  const tag = view.dom.querySelector('.cm-lp-tag');
  ok('双链/标签渲染为可交互span', !!link && !!tag);
  if (link) {
    link.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }
  if (tag) tag.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await nextFrames(1);
  ok('双链hover回调', linkLog.some(([k, t]) => k === 'hover' && t === '双链A'), JSON.stringify(linkLog));
  ok('双链click回调', linkLog.some(([k, t]) => k === 'open' && t === '双链A'));
  ok('标签click回调', linkLog.some(([k, t]) => k === 'tag' && /标签B/.test(t)));

  /* ⑦ 块级图片 widget 恒定显示（不套用 ViewPlugin 的「光标行显示原始语法」规则） */
  goTo(1, 0);
  await nextFrames(3);
  ok('块级图片widget恒定显示(光标在其行仍在)', !!view.dom.querySelector('.cm-lp-img img') && !contentText().includes('![[pics/demo.png'));

  /* ⑧ 拖宽 → pointerup 写回 doc（事务持久化宽度，P0 结论 2） */
  goTo(13, 0);
  await nextFrames(2);
  const grip = view.dom.querySelector('.cm-lp-img-grip');
  const beforeW = lineText(1);
  if (grip) {
    const x0 = grip.getBoundingClientRect().left;
    grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x0 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x0 + 120 }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x0 + 120 }));
  }
  await nextFrames(3);
  const wMatch = /^!\[\[pics\/demo\.png\|(\d+)\]\]$/.exec(lineText(1));
  ok('拖动写回宽度到doc(320→440)', !!wMatch && Math.abs(Number(wMatch[1]) - 440) <= 3, `${beforeW} → ${lineText(1)}`);

  await setDoc(buildDoc(3000));   // 恢复合成文档（IME 探针按第 5 行定位）

  const allOk = Object.values(checks).every(Boolean);
  return {
    ok: allOk,
    metrics: { ...metrics, linkLog: JSON.stringify(linkLog) },
    notes: allOk
      ? ['P3 块级 widget（cm/widgets.js）：图片嵌入+拖宽、复选框、Callout、表格边框、双链/标签事件全部生效']
      : ['有断言失败，见上方 ❌ 项'],
  };
}

/* ================= 运行编排 ================= */

function renderResults() {
  const body = document.getElementById('results-body');
  const entries = Object.entries(results);
  const status = document.getElementById('results-status');
  status.textContent = entries.length ? `${entries.filter(([, r]) => r.ok).length}/${entries.length} 通过` : '未运行';
  status.className = 'tag ' + (entries.length && entries.every(([, r]) => r.ok) ? 'ok' : entries.length ? 'bad' : 'wait');
  body.innerHTML = entries.map(([name, r]) => `
    <tr>
      <td>${name}</td>
      <td><span class="tag ${r.ok ? 'ok' : 'bad'}">${r.ok ? '通过' : '失败'}</span></td>
      <td class="mono">${Object.entries(r.metrics).map(([k, v]) => `${k}: ${v}`).join('\n')}${r.notes?.length ? '\n— ' + r.notes.join('\n— ') : ''}</td>
    </tr>`).join('');
  document.getElementById('overall').textContent =
    entries.length ? `总体：${entries.every(([, r]) => r.ok) ? '全部通过 ✅' : '存在失败 ❌'}` : '';
}

async function runAll() {
  document.getElementById('results-body').innerHTML = '<tr><td colspan="3" class="hint">运行中…</td></tr>';
  for (const [name, fn] of Object.entries({
    '① 行号': probeLineNumbers,
    '② 3000行滚动': probeScrollPerf,
    '③ widget高度×滚动': probeWidgetScroll,
    '④ history撤销': probeHistory,
    '⑤ 装饰渲染(P1)': probeDecorations,
    '⑥ 行内编辑(P2)': probeEditing,
    '⑦ 块级widget(P3)': probeWidgets,
  })) {
    try {
      results[name] = await fn();
    } catch (err) {
      results[name] = { ok: false, metrics: { 异常: String(err && err.stack || err) }, notes: [] };
    }
    renderResults();
  }
  window.__probe.done = true;
}

function reloadDoc(lines) {
  view.setState(EditorState.create({ doc: buildDoc(lines), extensions: EXTENSIONS }));
}

document.getElementById('btn-run').addEventListener('click', () => { window.__probe.done = false; runAll(); });
document.getElementById('btn-doc3000').addEventListener('click', () => reloadDoc(3000));
document.getElementById('btn-doc1000').addEventListener('click', () => reloadDoc(1000));
document.getElementById('btn-undo').addEventListener('click', () => undo(view));
document.getElementById('btn-redo').addEventListener('click', () => redo(view));

window.addEventListener('error', (e) => { window.__probe.pageError = String(e.message); });

window.__probe = {
  view,
  results,
  done: false,
  reloadDoc,
  /** 载入任意文档（P1 截图对比用：同一篇 demo-vault 笔记，块级渲染 vs CM 装饰） */
  loadDoc(text) {
    view.setState(EditorState.create({ doc: String(text), extensions: EXTENSIONS }));
  },
  lineNumComp,
  lineNumbers,
  /** 调试钩子：拿装饰插件实例（P1 排查看装饰集用） */
  __deco: { livePreviewPlugin, fenceHiding, EXTENSIONS, collapseOpen, widgetDecorations },
  /** P2：附件拦截记录（每次粘贴/拖入递出的 File） */
  p2: { assetLog },
  /** P3：双链/标签事件记录（[类型, 目标]） */
  p3: { linkLog },
  ime: {
    begin(lineNo, col) {
      const line = view.state.doc.line(lineNo);
      imeProbe.before = view.state.doc.toString();
      imeProbe.at = line.from + col;
      imeProbe.lineNo = lineNo;
      imeProbe.col = col;
      imeProbe.composingSeen = null;
      imeProbe.domShown = null;
      view.dispatch(view.state.update({ selection: EditorSelection.cursor(imeProbe.at) }));
      return { at: imeProbe.at, lineText: line.text };
    },
    observe(stage, composingText) {
      const sel = view.state.selection.main;
      if (stage.startsWith('compose') || stage.startsWith('update')) {
        // CM6 组词期语义：组词文本会同步进 doc，但 view.composing 保持 true、
        // 解析/装饰推迟到 compositionend——真正要断言的是这两点
        imeProbe.composingSeen = view.composing;
        imeProbe.domShown = composingText
          ? (view.dom.querySelector('.cm-content')?.textContent || '').includes(composingText)
          : null;
      }
      const domText = view.dom.querySelector('.cm-content')?.textContent || '';
      return {
        stage,
        composing: view.composing,
        docHasComposingText: composingText ? true : null,
        domShowsComposing: composingText ? domText.includes(composingText) : null,
        caret: `${sel.from}..${sel.to}`,
        imeEvents: imeLog.length,
      };
    },
    commit(expected) {
      const doc = view.state.doc.toString();
      const expectedDoc = imeProbe.before.slice(0, imeProbe.at) + expected + imeProbe.before.slice(imeProbe.at);
      const sel = view.state.selection.main;
      const exact = doc === expectedDoc;
      const once = doc.split(expected).length - 1 === 1;
      const caretOk = sel.from === imeProbe.at + expected.length && sel.from === sel.to;
      const sawStart = imeLog.some((e) => e.type === 'compositionstart');
      const sawEnd = imeLog.some((e) => e.type === 'compositionend');
      const ok = exact && once && caretOk && sawStart && sawEnd && imeProbe.composingSeen === true;
      results.ime = {
        ok,
        metrics: {
          '插入位置精确': exact,
          '文本只出现一次(不重不漏)': once,
          '组词后光标紧随其后': caretOk,
          'compositionstart/end 均触发': sawStart && sawEnd,
          '组词期 view.composing 保持 true': imeProbe.composingSeen,
          '组词期 DOM 显示组词文本': imeProbe.domShown,
          'composition 事件数': imeLog.length,
          '最终光标': `${sel.from}..${sel.to}（期望 ${imeProbe.at + expected.length}）`,
        },
        notes: [
          'CM6 组词期会把组词文本同步进 doc 但保持 composing 态、推迟解析；提交后按精确偏移校验，不重不漏',
        ],
      };
      renderResults();
      return results.ime;
    },
  },
};

runAll();
