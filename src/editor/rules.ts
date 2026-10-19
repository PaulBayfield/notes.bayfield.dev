// Markdown-style shortcuts while typing, and the keyboard map.

import { InputRule, inputRules, textblockTypeInputRule, wrappingInputRule, undoInputRule } from "prosemirror-inputrules";
import type { MarkType, Node } from "prosemirror-model";
import { canJoin, findWrapping } from "prosemirror-transform";
import { keymap } from "prosemirror-keymap";
import { NodeSelection, TextSelection, type Command, type EditorState, type Plugin } from "prosemirror-state";
import { baseKeymap, chainCommands, setBlockType, toggleMark, exitCode, joinUp, joinDown } from "prosemirror-commands";
import { liftListItem, sinkListItem, splitListItem } from "prosemirror-schema-list";
import { goToNextCell } from "prosemirror-tables";
import { insertMathCmd, makeBlockMathInputRule, makeInlineMathInputRule, mathBackspaceCmd, REGEX_BLOCK_MATH_DOLLARS, REGEX_INLINE_MATH_DOLLARS } from "@benrbray/prosemirror-math";
import { undo as yUndo, redo as yRedo } from "y-prosemirror";
import { undo as historyUndo, redo as historyRedo } from "prosemirror-history";
import { blocks, createTable, exitBlock, insertBlock, toggleCheckbox, toggleHeading, toggleList, toggleWrap } from "./commands";
import {
  addRowAndMove,
  arrowFromBlock,
  BLOCK_MENU_EVENT,
  currentBlock,
  duplicateBlock,
  editSelectedBlock,
  selectBlock,
  toggleHighlight,
  backspaceToParagraph,
  enterInCode,
  indentInCode,
  lineEdgeInCode,
  moveBlock,
  moveOutOfTable,
  newlineInCode,
  outdentInCode,
  selectAllInCode,
  toggleCode,
  toggleCodeBlock,
  toggleListStyle,
} from "./editing";
import { schema } from "./schema";
import { toggleAllToggles } from "./nodeviews";
import { languageId } from "./codeLanguages";
import { isMac } from "../lib/platform";

const { nodes, marks } = schema;

/**
 * `**bold**`-style rule. Patterns use a lookbehind so the match is exactly the delimited text.
 * When it fires, the last delimiter character is still being typed (not yet in the document).
 */
function markRule(pattern: RegExp, type: MarkType): InputRule {
  return new InputRule(pattern, (state, match, start, end) => {
    const [full, inner] = match;
    if (!inner || state.doc.resolve(start).parent.type.spec.code) return null;
    const delimiter = (full.length - inner.length) / 2;
    const tr = state.tr;
    tr.delete(start + delimiter + inner.length, end);
    tr.delete(start, start + delimiter);
    tr.addMark(start, start + inner.length, type.create());
    tr.removeStoredMark(type);
    return tr;
  });
}

/**
 * `[ ] ` or `[x] ` at the start of a line makes a to-do. In a bulleted list (`- [ ] `), only
 * that item becomes a to-do: the list is split around it.
 */
function checklistRule(): InputRule {
  return new InputRule(/^\s*\[([ xX]?)\]\s$/, (state, match, start, end) => {
    const checked = /x/i.test(match[1]);
    const tr = state.tr.delete(start, end);
    const $pos = tr.doc.resolve(start);
    const d = $pos.depth;
    const inBullet = d >= 3 && $pos.index(d - 1) === 0 && $pos.node(d - 1).type === nodes.list_item && $pos.node(d - 2).type === nodes.bullet_list;
    if (inBullet) {
      const list = $pos.node(d - 2);
      const listPos = $pos.before(d - 2);
      const index = $pos.index(d - 2);
      const items: Node[] = [];
      list.forEach((item) => items.push(item));
      const parts: Node[] = [];
      if (index > 0) parts.push(nodes.bullet_list.create(null, items.slice(0, index)));
      parts.push(nodes.checkbox_list.create(null, nodes.checkbox_item.create({ checked }, items[index].content)));
      if (index < items.length - 1) parts.push(nodes.bullet_list.create(null, items.slice(index + 1)));
      tr.replaceWith(listPos, listPos + list.nodeSize, parts);
      // Same nesting depth, so the cursor only moves by the extra list boundaries.
      return tr.setSelection(TextSelection.create(tr.doc, start + (index > 0 ? 2 : 0)));
    }
    if ($pos.parent.type !== nodes.paragraph) return null;
    const range = $pos.blockRange();
    if (!range) return null;
    return tr.wrap(range, [{ type: nodes.checkbox_list }, { type: nodes.checkbox_item, attrs: { checked } }]);
  });
}

/**
 * Replaces typed text with a symbol (`->` becomes `→`), as in Outline's SmartText. When the
 * pattern has a capture group, only that part is replaced and the rest of the match is kept.
 * Never fires in code. Backspace straight after undoes it.
 */
function textRule(pattern: RegExp, symbol: string): InputRule {
  return new InputRule(pattern, (state, match, start, end) => {
    const $start = state.doc.resolve(start);
    if ($start.parent.type.spec.code || marks.code_inline.isInSet(state.storedMarks ?? $start.marks())) return null;
    if (match[1] === undefined) return state.tr.insertText(symbol, start, end);
    const from = start + match[0].lastIndexOf(match[1]);
    // The last character of the match is still being typed, so it isn't in the document yet.
    return state.tr.insertText(symbol, from, Math.min(from + match[1].length, end));
  });
}

/** Arrows and typography, from Outline and Notion. */
const smartText = (): InputRule[] => [
  // "<=" has already become "≤" by the time ">" is typed, and "<-" "←".
  textRule(/(?:<=>|≤>)$/, "⇔"),
  textRule(/(?:<->|←>)$/, "↔"),
  textRule(/=>$/, "⇒"),
  textRule(/->$/, "→"),
  textRule(/<-$/, "←"),
  textRule(/>=$/, "≥"),
  textRule(/<=$/, "≤"),
  textRule(/!=$/, "≠"),
  // Not after a pipe, which would clash with typing a table row.
  textRule(/(?:^|[^|-])(--\s)$/, "— "),
  textRule(/(?:^|\s)(1\/2)$/, "½"),
  textRule(/(?:^|\s)(3\/4)$/, "¾"),
  textRule(/\(c\)$/i, "©"),
  textRule(/\(r\)$/i, "®"),
  textRule(/\(tm\)$/i, "™"),
  textRule(/\.\.\.$/, "…"),
  textRule(/(?:^|[\s{[(<'"‘“])(")$/, "“"),
  textRule(/^(?!.*`)[\s\S]*(")$/, "”"),
  textRule(/(?:^|[\s{[(<'"‘“])(')$/, "‘"),
  textRule(/^(?!.*`)[\s\S]*(')$/, "’"),
];

/** In a code block or inline code. */
function inCode(state: EditorState, pos: number): boolean {
  const $pos = state.doc.resolve(pos);
  return !!$pos.parent.type.spec.code || !!marks.code_inline.isInSet(state.storedMarks ?? $pos.marks());
}

/** A link written without a scheme ("example.com") goes to https. */
const withScheme = (href: string) => (/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(href) ? href : `https://${href}`);

/** `[text](url)` becomes a link. The closing parenthesis is still being typed. */
function linkRule(): InputRule {
  return new InputRule(/(?<!!)\[([^[\]]+)\]\((\S+)\)$/, (state, match, start, end) => {
    if (inCode(state, start)) return null;
    const link = marks.link.create({ href: withScheme(match[2]) });
    const tr = state.tr.replaceWith(start, end, schema.text(match[1], link.addToSet(state.doc.resolve(start).marks())));
    return tr.removeStoredMark(marks.link);
  });
}

/** `![alt](url)` or `![alt](url "title")` becomes an image. Quotes may already be curly. */
function imageRule(): InputRule {
  return new InputRule(/!\[([^[\]]*)\]\((\S+?)(?:\s+["“]([^"”]*)["”])?\)$/, (state, match, start, end) => {
    if (inCode(state, start)) return null;
    return state.tr.replaceWith(start, end, nodes.image.create({ src: withScheme(match[2]), alt: match[1] || null, title: match[3] || null }));
  });
}

/** `|--` at the start of an empty line makes a table. */
function tableRule(): InputRule {
  return new InputRule(/^\|--$/, (state, _match, start) => {
    const $start = state.doc.resolve(start);
    if ($start.parent.type !== nodes.paragraph) return null;
    const from = $start.before();
    const tr = state.tr.replaceWith(from, $start.after(), createTable(2, 2));
    return tr.setSelection(TextSelection.near(tr.doc.resolve(from + 1)));
  });
}

/** The value of a Roman numeral ("iv" is 4), or 0 when it isn't one. */
function romanValue(text: string): number {
  const digits: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
  const s = text.toLowerCase();
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const value = digits[s[i]];
    if (!value) return 0;
    total += value < (digits[s[i + 1]] ?? 0) ? -value : value;
  }
  // Rejects things like "iiii" or "vx" by writing the number back out.
  const back = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]] as const;
  let n = total;
  let written = "";
  for (const [v, r] of back) while (n >= v) (written += r), (n -= v);
  return written === s ? total : 0;
}

/** Which number a list marker stands for in each list style. */
function markerValue(marker: string, listStyle: string): number {
  if (listStyle === "number") return /^\d+$/.test(marker) ? +marker : 0;
  const lower = marker === marker.toLowerCase();
  if (listStyle.startsWith("lower") !== lower) return 0;
  if (listStyle.endsWith("roman")) return romanValue(marker);
  return /^[a-z]$/i.test(marker) ? marker.toLowerCase().charCodeAt(0) - 96 : 0;
}

/**
 * `1. `, `a. `, `A. `, `i. ` or `I. ` starts a numbered, lettered or Roman list. A marker that
 * follows on from the list just above continues it (so "i. " after "h." is a letter); otherwise
 * "i"/"I" starts Roman numerals and other single letters start a lettered list.
 */
function orderedListRule(): InputRule {
  return new InputRule(/^(\d+|[a-zA-Z]|[ivxlcdm]+|[IVXLCDM]+)\.\s$/, (state, match, start, end) => {
    const marker = match[1];
    const $start = state.doc.resolve(start);
    const d = $start.depth;
    const index = $start.index(d - 1);
    const before = index > 0 ? $start.node(d - 1).child(index - 1) : null;
    let listStyle: string | null = null;
    let order = 0;
    let continues = false;
    if (before?.type === nodes.ordered_list && markerValue(marker, before.attrs.listStyle) === before.attrs.order + before.childCount) {
      listStyle = before.attrs.listStyle;
      order = before.attrs.order + before.childCount;
      continues = true;
    } else if (/^\d+$/.test(marker)) [listStyle, order] = ["number", +marker];
    else if (/^i$/i.test(marker) || (marker.length > 1 && romanValue(marker))) {
      listStyle = marker === marker.toLowerCase() ? "lower-roman" : "upper-roman";
      order = romanValue(marker);
    } else if (marker.length === 1) {
      listStyle = marker === marker.toLowerCase() ? "lower-alpha" : "upper-alpha";
      order = markerValue(marker, listStyle);
    }
    if (!listStyle || !order) return null;
    const tr = state.tr.delete(start, end);
    const range = tr.doc.resolve(start).blockRange();
    const wrapping = range && findWrapping(range, nodes.ordered_list, { order, listStyle });
    if (!range || !wrapping) return null;
    tr.wrap(range, wrapping);
    const previous = tr.doc.resolve(start - 1).nodeBefore;
    if (continues && previous?.type === nodes.ordered_list && canJoin(tr.doc, start - 1)) tr.join(start - 1);
    return tr;
  });
}

function rules(): Plugin {
  return inputRules({
    rules: [
      linkRule(),
      imageRule(),
      tableRule(),
      ...smartText(),
      textblockTypeInputRule(/^(#{1,4})\s$/, nodes.heading, (m) => ({ level: m[1].length })),
      wrappingInputRule(/^\s*>\s$/, nodes.blockquote),
      checklistRule(),
      wrappingInputRule(/^\s*([-+*])\s$/, nodes.bullet_list),
      orderedListRule(),
      wrappingInputRule(/^\s*\+\+\+\s$/, nodes.container_toggle, () => ({ id: crypto.randomUUID() })),
      // "```" then a space (optionally with a language: "```ts ").
      textblockTypeInputRule(/^```([\w+#-]*)\s$/, nodes.code_fence, (m) => ({ language: languageId(m[1]) })),
      new InputRule(/^(?:---|___|\*\*\*)$/, (state, match, start) => {
        const $start = state.doc.resolve(start);
        if ($start.parent.type !== nodes.paragraph) return null;
        const from = $start.before();
        const tr = state.tr.replaceWith(from, $start.after(), [nodes.hr.create({ markup: match[0] }), nodes.paragraph.create()]);
        return tr.setSelection(TextSelection.create(tr.doc, from + 2));
      }),
      new InputRule(/^:::(info|success|tip|warning)?\s$/, (state, match, start, end) => {
        const style = match[1] || "info";
        const tr = state.tr.delete(start, end);
        const $pos = tr.doc.resolve(start);
        const range = $pos.blockRange();
        if (!range) return null;
        return tr.wrap(range, [{ type: nodes.container_notice, attrs: { style } }]);
      }),
      markRule(/(?<![*\w])\*\*([^*\s](?:[^*]*[^*\s])?)\*\*$/, marks.strong),
      markRule(/(?<![_\w])__([^_\s](?:[^_]*[^_\s])?)__$/, marks.underline),
      markRule(/(?<![*\w])\*([^*\s](?:[^*]*[^*\s])?)\*$/, marks.em),
      markRule(/(?<![_\w])_([^_\s](?:[^_]*[^_\s])?)_$/, marks.em),
      markRule(/(?<![~\w])~~([^~\s](?:[^~]*[^~\s])?)~~$/, marks.strikethrough),
      // Notion's single tilde.
      markRule(/(?<![~\w])~([^~\s](?:[^~]*[^~\s])?)~$/, marks.strikethrough),
      markRule(/(?<![=\w])==([^=\s](?:[^=]*[^=\s])?)==$/, marks.highlight),
      markRule(/(?<![`\w])`([^`]+)`$/, marks.code_inline),
      makeInlineMathInputRule(REGEX_INLINE_MATH_DOLLARS, nodes.math_inline),
      makeBlockMathInputRule(REGEX_BLOCK_MATH_DOLLARS, nodes.math_block),
    ],
  });
}

const hardBreak: Command = chainCommands(exitCode, (state, dispatch) => {
  if (dispatch) dispatch(state.tr.replaceSelectionWith(nodes.br.create()).scrollIntoView());
  return true;
});

function keys(collab: boolean): Plugin {
  const undo = collab ? yUndo : historyUndo;
  const redo = collab ? yRedo : historyRedo;
  const splitItem = chainCommands(splitListItem(nodes.checkbox_item, { checked: false }), splitListItem(nodes.list_item));
  const sink = chainCommands(sinkListItem(nodes.checkbox_item), sinkListItem(nodes.list_item));
  const lift = chainCommands(liftListItem(nodes.checkbox_item), liftListItem(nodes.list_item));
  return keymap({
    "Mod-z": undo,
    "Mod-y": redo,
    "Shift-Mod-z": redo,
    Backspace: chainCommands(undoInputRule, mathBackspaceCmd, backspaceToParagraph),
    // With nothing selected, Ctrl+B is left to the app (it toggles the sidebar, as in Calendar).
    "Mod-b": (state, dispatch) => !state.selection.empty && toggleMark(marks.strong)(state, dispatch),
    "Mod-i": toggleMark(marks.em),
    "Mod-u": toggleMark(marks.underline),
    // Strikethrough over a selection (Outline); with nothing selected, duplicates the block (Notion).
    "Mod-d": (state, dispatch) =>
      state.selection.empty || state.selection instanceof NodeSelection
        ? duplicateBlock(state, dispatch) || toggleMark(marks.strikethrough)(state, dispatch)
        : toggleMark(marks.strikethrough)(state, dispatch),
    "Mod-Shift-s": toggleMark(marks.strikethrough),
    "Mod-e": toggleMark(marks.code_inline),
    "Mod-`": toggleMark(marks.code_inline),
    "Mod-Shift-c": toggleCode,
    "Shift-Ctrl-\\": toggleCodeBlock,
    "Mod-Shift-h": toggleHighlight,
    "Mod-Space": insertMathCmd(nodes.math_inline),
    "Shift-Enter": chainCommands(newlineInCode, hardBreak),
    "Mod-Enter": chainCommands(toggleCheckbox, addRowAndMove, exitBlock),
    Enter: chainCommands(editSelectedBlock, enterInCode, splitItem),
    Tab: chainCommands(indentInCode, goToNextCell(1), addRowAndMove, sink),
    "Shift-Tab": chainCommands(outdentInCode, goToNextCell(-1), lift),
    "Mod-a": selectAllInCode,
    ...(isMac ? { "Ctrl-a": lineEdgeInCode(-1), "Ctrl-e": lineEdgeInCode(1) } : {}),
    ArrowUp: chainCommands(arrowFromBlock(-1), moveOutOfTable(-1)),
    ArrowDown: chainCommands(arrowFromBlock(1), moveOutOfTable(1)),
    "Shift-ArrowUp": arrowFromBlock(-1, true),
    "Shift-ArrowDown": arrowFromBlock(1, true),
    // Headings: Ctrl+Alt+number, or Outline's Ctrl+Shift+number.
    "Mod-Alt-0": setBlockType(nodes.paragraph),
    "Mod-Alt-1": toggleHeading(1),
    "Mod-Alt-2": toggleHeading(2),
    "Mod-Alt-3": toggleHeading(3),
    "Mod-Alt-4": toggleHeading(4),
    "Shift-Ctrl-0": setBlockType(nodes.paragraph),
    "Shift-Ctrl-1": toggleHeading(1),
    "Shift-Ctrl-2": toggleHeading(2),
    "Shift-Ctrl-3": toggleHeading(3),
    "Shift-Ctrl-4": toggleHeading(4),
    "Shift-Ctrl-5": toggleListStyle("upper-alpha"),
    "Shift-Ctrl-6": toggleListStyle("lower-alpha"),
    "Mod-Shift-7": toggleList(nodes.ordered_list, nodes.list_item),
    "Mod-Shift-8": toggleList(nodes.bullet_list, nodes.list_item),
    "Mod-Shift-9": toggleList(nodes.checkbox_list, nodes.checkbox_item),
    // Indents code or a list item; elsewhere, a quote.
    "Mod-]": chainCommands(indentInCode, sink, toggleWrap(nodes.blockquote)),
    "Mod-[": chainCommands(outdentInCode, lift),
    "Ctrl->": toggleWrap(nodes.blockquote),
    "Mod-Alt-c": insertBlock(blocks.codeFence()),
    "Alt-ArrowUp": joinUp,
    "Alt-ArrowDown": joinDown,
    // Moving blocks: Outline's keys, then Notion's.
    "Mod-Alt-ArrowUp": moveBlock(-1),
    "Mod-Alt-ArrowDown": moveBlock(1),
    "Mod-Shift-ArrowUp": moveBlock(-1),
    "Mod-Shift-ArrowDown": moveBlock(1),
    "Mod-Alt-t": toggleAllToggles,
    "Mod-/": (state) => {
      if (!currentBlock(state)) return false;
      window.dispatchEvent(new Event(BLOCK_MENU_EVENT));
      return true;
    },
    Escape: selectBlock,
  });
}

/** `collab`: undo through Yjs (shared documents) rather than ProseMirror history. */
export const editorKeymaps = (collab = true): Plugin[] => [rules(), keys(collab), keymap(baseKeymap)];
