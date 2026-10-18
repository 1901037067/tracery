/**
 * test/_engine-helpers.mjs — 双内核测试助手
 * ------------------------------------------------------------------
 * 编辑内核有两个实现（见 docs/EDITOR-MIGRATION.md 第 5 节）：
 *   - block：旧块级 contenteditable（DOM 即渲染后的 markdown：h1/p/li/.md-blank/.live-gutter…）
 *   - cm   ：CodeMirror 6（DOM 是 .cm-editor/.cm-content/.cm-line + .cm-lp-* 装饰）
 * 套件用 `TRACERY_TEST_ENGINE` 选内核跑同一套流程，断言面统一收敛到
 * `window.__editor.getContent()`（权威文本，两内核都有）与 CM/块级各自的 DOM。
 *
 * 用法（每个套件顶部）：
 *   import { ENGINE, IS_CM, engineUrl, getMd, ... } from './_engine-helpers.mjs';
 *   await page.goto(engineUrl(`http://localhost:${PORT}`), { waitUntil: 'networkidle0' });
 *   // 跑 cm 口径： $env:TRACERY_TEST_ENGINE='cm'; npm run test:xxx
 *
 * 默认仍是 block：它作为「块级回归网」，改成 cm 口径的套件在 cm 下另跑一遍。
 */

export const ENGINE = process.env.TRACERY_TEST_ENGINE || 'block';
export const IS_CM = ENGINE === 'cm';
export const engineUrl = (base) => `${base}/?engine=${ENGINE}`;

/** 文档文本（权威文本，两内核通用） */
export async function getMd(page) {
  return page.evaluate(() => window.__editor.getContent());
}

/** 当前光标偏移（cm：state.selection.head；块级：DOM 近似） */
export async function caretOffset(page) {
  if (IS_CM) return page.evaluate(() => window.__editor.view.state.selection.main.head);
  return page.evaluate(() => {
    const live = document.getElementById('editor-live');
    const sel = window.getSelection();
    if (!sel?.rangeCount || !live.contains(sel.anchorNode)) return 0;
    const r = document.createRange();
    r.selectNodeContents(live);
    try { r.setEnd(sel.anchorNode, sel.anchorOffset); } catch { return 0; }
    return r.toString().length;
  });
}

/** 把光标放到 md 的某个字符偏移。cm 用 view.dispatch；块级用 DOM Range（近似） */
export async function setCaretAtOffset(page, offset) {
  if (IS_CM) {
    await page.evaluate((off) => {
      const ed = window.__editor;
      ed.view.dispatch({ selection: { anchor: off } });
      ed.view.focus();
    }, offset);
    return;
  }
  await page.evaluate((off) => {
    const live = document.getElementById('editor-live');
    live.focus();
    const walker = document.createTreeWalker(live, NodeFilter.SHOW_TEXT);
    let acc = 0, node, target = null, local = 0;
    while ((node = walker.nextNode())) {
      const len = node.textContent.length;
      if (acc + len >= off) { target = node; local = off - acc; break; }
      acc += len;
    }
    const r = document.createRange();
    if (target) r.setStart(target, Math.max(0, local));
    else r.selectNodeContents(live);
    r.collapse(true);
    const s = window.getSelection();
    s.removeAllRanges(); s.addRange(r);
  }, offset);
}

/** 设选区 [anchor, head]。cm 用 view.dispatch；块级用 DOM Range（近似） */
export async function setSelection(page, anchor, head) {
  if (IS_CM) {
    await page.evaluate(({ a, h }) => {
      const ed = window.__editor;
      ed.view.dispatch({ selection: { anchor: a, head: h } });
      ed.view.focus();
    }, { a: anchor, h: head });
    return;
  }
  await page.evaluate(({ a, h }) => {
    const live = document.getElementById('editor-live');
    live.focus();
    const pick = (off) => {
      const walker = document.createTreeWalker(live, NodeFilter.SHOW_TEXT);
      let acc = 0, node;
      while ((node = walker.nextNode())) {
        const len = node.textContent.length;
        if (acc + len >= off) return { node, local: off - acc };
        acc += len;
      }
      return null;
    };
    const s = pick(a), e = pick(h);
    if (!s || !e) return;
    const r = document.createRange();
    r.setStart(s.node, Math.max(0, s.local));
    r.setEnd(e.node, Math.max(0, e.local));
    const sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(r);
  }, { a: anchor, h: head });
}

/** 第 n 行（1-based）的文本 */
export async function lineText(page, n) {
  if (IS_CM) return page.evaluate((ln) => window.__editor.view.state.doc.line(ln).text, n);
  return page.evaluate((ln) => document.getElementById('editor-live').children[ln - 1]?.textContent ?? '', n);
}

/** 光标所在行的文本 */
export async function caretLineText(page) {
  if (IS_CM) {
    return page.evaluate(() => {
      const st = window.__editor.view.state;
      return st.doc.lineAt(st.selection.main.head).text;
    });
  }
  return page.evaluate(() => {
    const sel = window.getSelection();
    const a = sel?.anchorNode;
    const el = a?.nodeType === Node.TEXT_NODE ? a.parentElement : a;
    return el?.textContent ?? '';
  });
}

/** 光标所在行是否为空行 */
export async function caretLineIsEmpty(page) {
  if (IS_CM) {
    return page.evaluate(() => {
      const st = window.__editor.view.state;
      return st.doc.lineAt(st.selection.main.head).text.trim() === '';
    });
  }
  return page.evaluate(() => {
    const sel = window.getSelection();
    const a = sel?.anchorNode;
    const el = a?.nodeType === Node.TEXT_NODE ? a.parentElement : a;
    return !!el?.classList?.contains('md-blank') || !(el?.textContent ?? '').trim();
  });
}

/** 把光标放到最后一个「非空文本行」的行尾（两内核） */
export async function caretAtEndOfText(page) {
  if (IS_CM) {
    await page.evaluate(() => {
      const ed = window.__editor;
      const doc = ed.view.state.doc;
      let line = doc.line(doc.lines);
      while (line.number > 1 && line.text.trim() === '') line = doc.line(line.number - 1);
      ed.view.dispatch({ selection: { anchor: line.to } });
      ed.view.focus();
    });
    return;
  }
  await page.evaluate(() => {
    const root = document.getElementById('editor-live');
    const last = [...root.children].filter((el) => el.textContent.trim()).pop();
    if (!last) return;
    const r = document.createRange();
    r.selectNodeContents(last);
    r.collapse(false);
    const s = window.getSelection();
    s.removeAllRanges(); s.addRange(r);
    root.focus();
  });
}

/** 点击第 n 行（1-based）：cm 点 .cm-line，块级点第 n 个子元素。返回点击坐标（失败返回 null） */
export async function clickLine(page, n, opts = {}) {
  const box = IS_CM
    ? await page.evaluate((ln) => {
        const line = document.querySelectorAll('#editor-live .cm-line')[ln - 1];
        if (!line) return null;
        const r = line.getBoundingClientRect();
        return { x: r.left + Math.min(30, r.width / 2), y: r.top + Math.min(10, r.height / 2) };
      }, n)
    : await page.evaluate((ln) => {
        const el = document.getElementById('editor-live').children[ln - 1];
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + Math.min(30, r.width / 2), y: r.top + Math.min(10, r.height / 2) };
      }, n);
  if (!box) return null;
  await page.mouse.click(box.x, box.y, { button: opts.button || 'left' });
  return box;
}

/** 行号槽的编号列表：cm 过滤掉 CM 用来测宽度的占位元素（编号 > 文档行数） */
export async function gutterNumbers(page) {
  if (IS_CM) {
    return page.evaluate(() => {
      const max = window.__editor.view.state.doc.lines;
      return [...document.querySelectorAll('#editor-live .cm-lineNumbers .cm-gutterElement')]
        .map((el) => Number(el.textContent.trim()))
        .filter((n) => Number.isFinite(n) && n >= 1 && n <= max);
    });
  }
  return page.evaluate(() => [...document.querySelectorAll('.live-gutter .ln')].map((d) => Number(d.textContent)));
}

/** 行号槽是否显示（cm 看 .cm-lineNumbers 是否存在；块级看 .live-gutter 是否 hidden） */
export async function gutterVisible(page) {
  if (IS_CM) return page.evaluate(() => document.querySelectorAll('#editor-live .cm-lineNumbers').length === 1);
  return page.evaluate(() => {
    const g = document.querySelector('.live-gutter');
    return !!g && g.hidden === false;
  });
}

/** 把光标放到「含某段文字的行」的行尾（cm 用 view.dispatch；块级无对应操作，直接跳过） */
export async function setCaretOnLineContaining(page, text) {
  if (!IS_CM) return;
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
