import { autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { Prec } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { parseCached } from './decorations.js';

export function wikiCompletion(complete) {
  if (!complete) return [];
  const source = async context => {
    if (context.state.readOnly) return null;
    const match = context.matchBefore(/!?\[\[[^\]\n]*/);
    if (!match || match.text.includes('|')) return null;
    const { blocks } = parseCached(context.state);
    if (blocks.some(block => block.type === 'fence' && context.pos >= block.lineStart && context.pos <= block.lineEnd)) return null;
    const line = context.state.doc.lineAt(match.from), before = line.text.slice(0, match.from - line.from);
    if ((before.match(/`/g) || []).length % 2) return null;
    const prefix = match.text.startsWith('!') ? 3 : 2, query = match.text.slice(prefix);
    const options = await complete(query);
    if (context.aborted || !options?.length) return null;
    return {
      from: match.from + prefix,
      options: options.map(item => ({ ...item, apply(view, completion, from, to) {
        const tail = view.state.doc.sliceString(to, to + 2) === ']]' ? 2 : 0;
        const insert = (item.target || item.label) + ']]';
        view.dispatch({ changes: { from, to: to + tail, insert }, selection: { anchor: from + insert.length }, userEvent: 'input.complete' });
      } })),
      filter: false,
    };
  };
  return [autocompletion({ override: [source], defaultKeymap: false }), Prec.highest(keymap.of(completionKeymap))];
}
