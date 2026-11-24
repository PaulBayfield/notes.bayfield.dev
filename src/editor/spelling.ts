// Spelling from the Windows spell checker (desktop app on Windows), in all the user's writing
// languages: misspelled words underlined, suggestions for the right-click menu, and correcting
// words as you type from Windows' autocorrect list. WebView2's own spell check is off in the
// editor there: it only knows the display language, so it underlined every English word on a
// French Windows.

import { Plugin, PluginKey, type EditorState, type Transaction } from "prosemirror-state";
import type { Node } from "prosemirror-model";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import { isTauri, isWindows } from "../lib/platform";

/** WebView2 underlines words but can't tell the page its suggestions, so the app asks Windows. */
export const SYSTEM_SPELLING = isTauri && isWindows;

export interface Spelling {
  misspelled: boolean;
  suggestions: string[];
  autocorrect: string | null;
}

/** The languages the webview spell checks in (the user's Windows languages). */
const languages = () => [...new Set([...(navigator.languages ?? []), navigator.language, "en-US"].filter(Boolean))];

async function invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export const checkWord = (word: string) => invoke<Spelling>("spelling_check", { word, languages: languages() });

/** Adds the word to the Windows dictionary, then checks the document again. */
export async function addWord(view: EditorView, word: string) {
  await invoke("spelling_add", { word, languages: languages() });
  refreshSpelling(view);
}

/** Letters, digits and apostrophes or hyphens inside a word ("don't", "well-known"). */
const WORD = /[\p{L}\p{M}\p{N}]+(?:['’-][\p{L}\p{M}\p{N}]+)*/gu;

function inCode(state: EditorState, pos: number) {
  const $pos = state.doc.resolve(pos);
  return !!$pos.parent.type.spec.code || $pos.marks().some((m) => m.type.spec.code);
}

/** The word at `pos` (touching it at either end counts), outside code. */
export function wordAt(state: EditorState, pos: number): { from: number; to: number; word: string } | null {
  const $pos = state.doc.resolve(pos);
  if (!$pos.parent.isTextblock || inCode(state, pos)) return null;
  // Inline nodes (mentions, emoji) take one position, so offsets in this text match the document.
  const text = $pos.parent.textBetween(0, $pos.parent.content.size, undefined, "￼");
  const offset = $pos.parentOffset;
  for (const m of text.matchAll(WORD)) {
    const start = m.index;
    const end = start + m[0].length;
    if (start > offset) break;
    if (end >= offset && !/\d/.test(m[0])) return { from: $pos.start() + start, to: $pos.start() + end, word: m[0] };
  }
  return null;
}

/** Replaces the word if it's still there, keeping its formatting. */
export function replaceWord(view: EditorView, at: { from: number; to: number; word: string }, replacement: string) {
  const { state } = view;
  if (at.to > state.doc.content.size || state.doc.textBetween(at.from, at.to) !== at.word) return false;
  view.dispatch(state.tr.insertText(replacement, at.from, at.to));
  return true;
}

let autocorrectEnabled = true;

/** Follows the autocorrect setting (and spell check: no underlines, no corrections). */
export function setAutocorrect(on: boolean) {
  autocorrectEnabled = on;
}

/** The last correction, so Backspace straight after it can put the word back. */
interface Correction {
  from: number;
  original: string;
  replacement: string;
  /** Where the cursor is just after it: past the replacement and the character that ended the word. */
  after: number;
}

const key = new PluginKey("autocorrect");

/**
 * Corrects a word when it's finished (a space or punctuation is typed after it), if Windows has a
 * correction for it on its autocorrect list ("teh" becomes "the"). Backspace straight after
 * puts the word as typed back.
 */
export function autocorrectPlugin(enabled: () => boolean): Plugin {
  let last: Correction | null = null;
  return new Plugin({
    key,
    props: {
      handleTextInput(view, from, to, text) {
        last = null;
        if (!SYSTEM_SPELLING || !autocorrectEnabled || from !== to || !/^[\s.,;:!?)\]}"”'’]$/.test(text)) return false;
        if (!enabled()) return false;
        const at = wordAt(view.state, from);
        if (!at || at.to !== from || at.word.length < 2) return false;
        void checkWord(at.word)
          .then((r) => {
            if (!r.autocorrect || r.autocorrect === at.word || view.isDestroyed) return;
            // Typed after the word since: the text still has to be the word and what ended it.
            const { doc } = view.state;
            if (at.to + 1 > doc.content.size || doc.textBetween(at.from, at.to + 1) !== at.word + text) return;
            if (!replaceWord(view, at, r.autocorrect)) return;
            last = { from: at.from, original: at.word, replacement: r.autocorrect, after: at.from + r.autocorrect.length + 1 };
          })
          .catch(() => {});
        return false;
      },
      handleKeyDown(view, event) {
        const correction = last;
        if (event.key !== "Backspace") {
          if (!["Shift", "Control", "Alt", "Meta"].includes(event.key)) last = null;
          return false;
        }
        last = null;
        const { state } = view;
        if (!correction || !state.selection.empty || state.selection.from !== correction.after) return false;
        const end = correction.from + correction.replacement.length;
        if (state.doc.textBetween(correction.from, end) !== correction.replacement) return false;
        view.dispatch(state.tr.insertText(correction.original, correction.from, end));
        return true;
      },
      handleClick() {
        last = null;
        return false;
      },
    },
  });
}

// ---------- Underlining misspelled words ----------

interface SpellState {
  /** The misspelled words, underlined. */
  errors: DecorationSet;
  /** What has changed since the last check, to check again. */
  dirty: [number, number][];
}

type SpellMeta = { refresh: true } | { checked: { doc: Node; ranges: [number, number][]; found: [number, number][] } };

const spellKey = new PluginKey<SpellState>("spellcheck");

/** Checks the whole document again (spell check turned on, a word added to the dictionary). */
export function refreshSpelling(view: EditorView) {
  if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(spellKey, { refresh: true } satisfies SpellMeta));
}

/** The parts of the new document a transaction changed. */
function changedRanges(tr: Transaction): [number, number][] {
  const out: [number, number][] = [];
  tr.mapping.maps.forEach((map, i) => {
    const rest = tr.mapping.slice(i + 1);
    map.forEach((_oldFrom, _oldTo, from, to) => out.push([rest.map(from, -1), rest.map(to, 1)]));
  });
  return out;
}

/** A link written out as its address isn't checked. */
const looksLikeUrl = (text: string) => /^\S*[./@]\S*$/.test(text.trim());

/**
 * A textblock's text as the spell checker sees it: one character per document position (so
 * offsets map straight back), with code, link addresses and inline nodes blanked out.
 */
function checkableText(block: Node): string {
  let text = "";
  block.forEach((child) => {
    if (!child.isText) return void (text += " ".repeat(child.nodeSize));
    const skip = child.marks.some((m) => m.type.spec.code || (m.type.name === "link" && looksLikeUrl(child.text!)));
    text += skip ? " ".repeat(child.text!.length) : child.text!;
  });
  return text;
}

/** Waits for a pause in typing before checking. */
const CHECK_DELAY = 400;

/**
 * Underlines misspelled words, checked by Windows in all the user's languages. Only the
 * paragraphs that changed are checked again, after a pause; the word being typed (the cursor at
 * its end) isn't underlined until you've moved on, as in browsers.
 */
export function spellcheckPlugin(enabled: () => boolean): Plugin {
  return new Plugin<SpellState>({
    key: spellKey,
    state: {
      init: (_config, state) => ({ errors: DecorationSet.empty, dirty: [[0, state.doc.content.size]] }),
      apply(tr, prev, oldState) {
        const meta = tr.getMeta(spellKey) as SpellMeta | undefined;
        if (meta && "refresh" in meta) return { errors: DecorationSet.empty, dirty: [[0, tr.doc.content.size]] };
        let errors = prev.errors.map(tr.mapping, tr.doc);
        let dirty = prev.dirty.map(([a, b]) => [tr.mapping.map(a, -1), tr.mapping.map(b, 1)] as [number, number]);
        if (tr.docChanged) {
          for (const [from, to] of changedRanges(tr)) {
            errors = errors.remove(errors.find(from, to));
            dirty.push([from, to]);
          }
        }
        // Results for a document that has changed since are dropped (it's checked again).
        if (meta && "checked" in meta && meta.checked.doc === oldState.doc && !tr.docChanged) {
          const { ranges, found } = meta.checked;
          for (const [from, to] of ranges) errors = errors.remove(errors.find(from, to));
          errors = errors.add(tr.doc, found.map(([from, to]) => Decoration.inline(from, to, { class: "spell-error" })));
          dirty = [];
        }
        return { errors, dirty };
      },
    },
    props: {
      decorations(state) {
        if (!SYSTEM_SPELLING || !enabled()) return null;
        const { errors } = spellKey.getState(state)!;
        const { selection } = state;
        if (!selection.empty) return errors;
        const typing = errors.find(selection.head, selection.head).filter((d) => d.to === selection.head);
        return typing.length ? errors.remove(typing) : errors;
      },
    },
    view(view) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let running = false;
      const check = async () => {
        if (view.isDestroyed || running || !enabled()) return;
        const { state } = view;
        const { dirty } = spellKey.getState(state)!;
        if (!dirty.length) return;
        // The whole paragraphs around what changed.
        const blocks: { pos: number; text: string }[] = [];
        const ranges: [number, number][] = [];
        const size = state.doc.content.size;
        const clamp = (n: number) => Math.max(0, Math.min(n, size));
        for (const [a, b] of dirty) {
          state.doc.nodesBetween(clamp(a), clamp(b), (node, pos) => {
            if (!node.isTextblock) return true;
            if (!ranges.some(([from]) => from === pos)) {
              ranges.push([pos, pos + node.nodeSize]);
              if (!node.type.spec.code) blocks.push({ pos, text: checkableText(node) });
            }
            return false;
          });
        }
        running = true;
        try {
          const results = blocks.length
            ? await invoke<[number, number][][]>("spelling_errors", { texts: blocks.map((b) => b.text), languages: languages() })
            : [];
          const found = results.flatMap((list, i) =>
            list.map(([start, length]) => [blocks[i].pos + 1 + start, blocks[i].pos + 1 + start + length] as [number, number]),
          );
          if (!view.isDestroyed) {
            const meta: SpellMeta = { checked: { doc: state.doc, ranges, found } };
            view.dispatch(view.state.tr.setMeta(spellKey, meta).setMeta("addToHistory", false));
          }
        } catch {
          // Checked again on the next change.
        } finally {
          running = false;
        }
        // Changed while checking: once more.
        if (!view.isDestroyed && spellKey.getState(view.state)!.dirty.length) schedule();
      };
      const schedule = () => {
        clearTimeout(timer);
        timer = setTimeout(() => void check(), CHECK_DELAY);
      };
      if (SYSTEM_SPELLING) schedule();
      return {
        update(view, prevState) {
          if (!SYSTEM_SPELLING) return;
          const now = spellKey.getState(view.state)!;
          if (now.dirty.length && now !== spellKey.getState(prevState)) schedule();
        },
        destroy: () => clearTimeout(timer),
      };
    },
  });
}
