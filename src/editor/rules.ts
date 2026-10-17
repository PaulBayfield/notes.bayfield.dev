// Markdown-style shortcuts while typing, and the keyboard map.

import { InputRule, inputRules, textblockTypeInputRule, wrappingInputRule, undoInputRule } from "prosemirror-inputrules";
import type { MarkType, Node } from "prosemirror-model";
import { keymap } from "prosemirror-keymap";
import { TextSelection, type Command, type Plugin } from "prosemirror-state";
import { baseKeymap, chainCommands, setBlockType, toggleMark, exitCode, joinUp, joinDown, selectParentNode } from "prosemirror-commands";
import { liftListItem, sinkListItem, splitListItem } from "prosemirror-schema-list";
import { goToNextCell } from "prosemirror-tables";
import { makeBlockMathInputRule, makeInlineMathInputRule, mathBackspaceCmd, REGEX_BLOCK_MATH_DOLLARS, REGEX_INLINE_MATH_DOLLARS } from "@benrbray/prosemirror-math";
import { undo as yUndo, redo as yRedo } from "y-prosemirror";
import { undo as historyUndo, redo as historyRedo } from "prosemirror-history";
import { blocks, exitBlock, insertBlock, toggleCheckbox, toggleHeading, toggleList, toggleWrap } from "./commands";
import { schema } from "./schema";
import { languageId } from "./codeLanguages";

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

function rules(): Plugin {
  return inputRules({
    rules: [
      textblockTypeInputRule(/^(#{1,4})\s$/, nodes.heading, (m) => ({ level: m[1].length })),
      wrappingInputRule(/^\s*>\s$/, nodes.blockquote),
      checklistRule(),
      wrappingInputRule(/^\s*([-+*])\s$/, nodes.bullet_list),
      wrappingInputRule(
        /^(\d+)\.\s$/,
        nodes.ordered_list,
        (m) => ({ order: +m[1] }),
        (m, node) => node.childCount + node.attrs.order === +m[1],
      ),
      // "```" then a space (optionally with a language: "```ts ").
      textblockTypeInputRule(/^```([\w+#-]*)\s$/, nodes.code_fence, (m) => ({ language: languageId(m[1]) })),
      new InputRule(/^(?:---|\*\*\*)$/, (state, match, start) => {
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
  return keymap({
    "Mod-z": undo,
    "Mod-y": redo,
    "Shift-Mod-z": redo,
    Backspace: chainCommands(undoInputRule, mathBackspaceCmd),
    // With nothing selected, Ctrl+B is left to the app (it toggles the sidebar, as in Calendar).
    "Mod-b": (state, dispatch) => !state.selection.empty && toggleMark(marks.strong)(state, dispatch),
    "Mod-i": toggleMark(marks.em),
    "Mod-u": toggleMark(marks.underline),
    "Mod-d": toggleMark(marks.strikethrough),
    "Mod-e": toggleMark(marks.code_inline),
    "Mod-Shift-h": toggleMark(marks.highlight),
    "Shift-Enter": hardBreak,
    "Mod-Enter": chainCommands(toggleCheckbox, exitBlock),
    Enter: splitItem,
    Tab: chainCommands(goToNextCell(1), sinkListItem(nodes.checkbox_item), sinkListItem(nodes.list_item)),
    "Shift-Tab": chainCommands(goToNextCell(-1), liftListItem(nodes.checkbox_item), liftListItem(nodes.list_item)),
    "Mod-Alt-0": setBlockType(nodes.paragraph),
    "Mod-Alt-1": toggleHeading(1),
    "Mod-Alt-2": toggleHeading(2),
    "Mod-Alt-3": toggleHeading(3),
    "Mod-Alt-4": toggleHeading(4),
    "Mod-Shift-7": toggleList(nodes.ordered_list, nodes.list_item),
    "Mod-Shift-8": toggleList(nodes.bullet_list, nodes.list_item),
    "Mod-Shift-9": toggleList(nodes.checkbox_list, nodes.checkbox_item),
    "Mod-]": toggleWrap(nodes.blockquote),
    "Mod-Alt-c": insertBlock(blocks.codeFence()),
    "Alt-ArrowUp": joinUp,
    "Alt-ArrowDown": joinDown,
    Escape: selectParentNode,
  });
}

/** `collab`: undo through Yjs (shared documents) rather than ProseMirror history. */
export const editorKeymaps = (collab = true): Plugin[] => [rules(), keys(collab), keymap(baseKeymap)];
