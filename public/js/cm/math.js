import { StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { parseCached } from './decorations.js';
import { inlineMath, mathHtml } from '../math.js';

const cache = new WeakMap();
function records(state) {
  if (cache.has(state.doc)) return cache.get(state.doc);
  const formulas = [], skip = new Set();
  const walk = blocks => blocks.forEach(block => {
    if (block.type === 'fence' || block.type === 'math') {
      for (let n = block.line; n <= block.endLine; n++) skip.add(n + 1);
      if (block.type === 'math') formulas.push({ from: state.doc.line(block.line + 1).from, to: state.doc.line(block.endLine + 1).to, tex: block.tex, display: true, block: true });
    }
    if (block.blocks) walk(block.blocks);
  });
  if (state.doc.toString().includes('$')) {
    walk(parseCached(state).blocks);
    for (let n = 1; n <= state.doc.lines; n++) {
      if (skip.has(n)) continue;
      const line = state.doc.line(n);
      for (const math of inlineMath(line.text)) formulas.push({ ...math, from: line.from + math.from, to: line.from + math.to });
    }
  }
  formulas.sort((a, b) => a.from - b.from); cache.set(state.doc, formulas); return formulas;
}

class MathWidget extends WidgetType {
  constructor(math, readOnly) { super(); this.math = math; this.readOnly = readOnly; }
  eq(other) { return other.math.tex === this.math.tex && other.math.from === this.math.from && other.math.display === this.math.display && other.readOnly === this.readOnly; }
  toDOM(view) {
    const node = document.createElement(this.math.block ? 'div' : 'span');
    node.className = this.math.block ? 'cm-math-block' : 'cm-math-inline'; node.contentEditable = 'false';
    node.innerHTML = mathHtml(this.math.tex, this.math.display);
    if (!this.readOnly) {
      node.title = '点击编辑公式';
      node.onmousedown = event => {
        event.preventDefault(); event.stopPropagation();
        view.dispatch({ selection: { anchor: Math.min(this.math.to, this.math.from + (this.math.display ? 2 : 1)) } }); view.focus();
      };
    }
    return node;
  }
  ignoreEvent() { return true; }
}

export function mathPreview({ readOnly = false } = {}) {
  const build = state => {
    const decorations = [];
    for (const math of records(state)) {
      if (!readOnly && state.selection.ranges.some(range => range.from <= math.to && range.to >= math.from)) continue;
      decorations.push(Decoration.replace({ widget: new MathWidget(math, readOnly), block: !!math.block }).range(math.from, math.to));
    }
    return Decoration.set(decorations, true);
  };
  return StateField.define({ create: build, update: (value, tr) => tr.docChanged || tr.selection ? build(tr.state) : value, provide: field => EditorView.decorations.from(field) });
}
