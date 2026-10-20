/**
 * test/_engine-helpers.mjs — 测试助手（单内核：CodeMirror 6）
 * ------------------------------------------------------------------
 * 编辑器只有 CM6 一套实现。这个文件把各套件的公共工具
 * （取文本、取光标、点行、行号槽）集中在一处。
 */

/** 文档文本（权威文本） */
export async function getMd(page) {
  return page.evaluate(() => window.__editor.getContent());
}

/** 当前光标偏移（cm：state.selection.head） */
export async function caretOffset(page) {
  return page.evaluate(() => window.__editor.view.state.selection.main.head);
}

/** 把光标放到 md 的某个字符偏移（cm：view.dispatch） */
export async function setCaretAtOffset(page, offset) {
  await page.evaluate((off) => {
    const ed = window.__editor;
    ed.view.dispatch({ selection: { anchor: off } });
    ed.view.focus();
  }, offset);
}

/** 设选区 [anchor, head]（cm：view.dispatch） */
export async function setSelection(page, anchor, head) {
  await page.evaluate(({ a, h }) => {
    const ed = window.__editor;
    ed.view.dispatch({ selection: { anchor: a, head: h } });
    ed.view.focus();
  }, { a: anchor, h: head });
}

/** 第 n 行（1-based）的文本 */
export async function lineText(page, n) {
  return page.evaluate((ln) => window.__editor.view.state.doc.line(ln).text, n);
}

/** 光标所在行的文本 */
export async function caretLineText(page) {
  return page.evaluate(() => {
    const st = window.__editor.view.state;
    return st.doc.lineAt(st.selection.main.head).text;
  });
}

/** 光标所在行是否为空行 */
export async function caretLineIsEmpty(page) {
  return page.evaluate(() => {
    const st = window.__editor.view.state;
    return st.doc.lineAt(st.selection.main.head).text.trim() === '';
  });
}

/** 把光标放到最后一个「非空文本行」的行尾 */
export async function caretAtEndOfText(page) {
  await page.evaluate(() => {
    const ed = window.__editor;
    const doc = ed.view.state.doc;
    let line = doc.line(doc.lines);
    while (line.number > 1 && line.text.trim() === '') line = doc.line(line.number - 1);
    ed.view.dispatch({ selection: { anchor: line.to } });
    ed.view.focus();
  });
}

/** 点击第 n 行（1-based）：cm 点 .cm-line。返回点击坐标（失败返回 null） */
export async function clickLine(page, n, opts = {}) {
  const box = await page.evaluate((ln) => {
    const line = document.querySelectorAll('#editor-live .cm-line')[ln - 1];
    if (!line) return null;
    const r = line.getBoundingClientRect();
    return { x: r.left + Math.min(30, r.width / 2), y: r.top + Math.min(10, r.height / 2) };
  }, n);
  if (!box) return null;
  await page.mouse.click(box.x, box.y, { button: opts.button || 'left' });
  return box;
}

/** 行号槽的编号列表：过滤掉 CM 用来测宽度的占位元素（编号 > 文档行数） */
export async function gutterNumbers(page) {
  return page.evaluate(() => {
    const max = window.__editor.view.state.doc.lines;
    return [...document.querySelectorAll('#editor-live .cm-lineNumbers .cm-gutterElement')]
      .map((el) => Number(el.textContent.trim()))
      .filter((n) => Number.isFinite(n) && n >= 1 && n <= max);
  });
}

/** 行号槽是否显示（看 .cm-lineNumbers 是否存在） */
export async function gutterVisible(page) {
  return page.evaluate(() => document.querySelectorAll('#editor-live .cm-lineNumbers').length === 1);
}

/** 把光标放到「含某段文字的行」的行尾（cm 用 view.dispatch） */
export async function setCaretOnLineContaining(page, text) {
  await page.evaluate((t) => {
    const ed = window.__editor;
    const doc = ed.view.state.doc;
    for (let n = 1; n <= doc.lines; n++) {
      const line = doc.line(n);
      if (line.text.includes(t)) { ed.view.dispatch({ selection: { anchor: line.to } }); break; }
    }
    ed.view.focus();
  }, text);
}

/** 纯函数：md 里某段文本的位置（辅助算偏移） */
export function offsetOf(md, snippet) {
  const i = md.indexOf(snippet);
  if (i < 0) throw new Error(`offsetOf: md 里找不到「${snippet}」`);
  return i;
}
