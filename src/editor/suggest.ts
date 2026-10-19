// Tracks "/", "@" and ":" typed at the start of a word, for the block menu, mentions and emoji,
// and "[[" anywhere, for linking to a document (as in Notion).
// The plugin only finds the trigger and query; the React menu shows the items and, while open,
// gets first pick of the arrow / Enter / Escape keys through `keys`.

import { Plugin, PluginKey, type EditorState } from "prosemirror-state";

export type Trigger = "/" | "@" | ":" | "[[";

export interface SuggestState {
  trigger: Trigger;
  query: string;
  /** Document range of trigger + query, replaced when an item is picked. */
  from: number;
  to: number;
}

export const suggestKey = new PluginKey<SuggestState | null>("suggest");

/** Set by the menu while it's open; returns true when it handled the key. */
export const suggestKeys: { current: ((e: KeyboardEvent) => boolean) | null } = { current: null };

const PATTERN = /(?:^|[\s(])([/@:])([^\s/@:]{0,40})$/;
/** Document titles have spaces, so the query after "[[" can too. */
const PAGE_PATTERN = /\[\[([^[\]\n￼]{0,60})$/;

function find(state: EditorState, dismissedAt: number | null): SuggestState | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const $pos = selection.$from;
  if ($pos.parent.type.spec.code || !$pos.parent.isTextblock) return null;
  const before = $pos.parent.textBetween(Math.max(0, $pos.parentOffset - 64), $pos.parentOffset, undefined, "￼");
  const page = before.match(PAGE_PATTERN);
  const m = page ? [page[0], "[[", page[1]] : before.match(PATTERN);
  if (!m) return null;
  const trigger = m[1] as Trigger;
  const query = m[2];
  // ":" also appears in normal writing ("Note: x"), so emoji wait for two letters.
  if (trigger === ":" && query.length < 2) return null;
  const from = $pos.pos - query.length - trigger.length;
  if (dismissedAt === from) return null;
  return { trigger, query, from, to: $pos.pos };
}

export function suggestPlugin(): Plugin {
  let dismissedAt: number | null = null;
  return new Plugin<SuggestState | null>({
    key: suggestKey,
    state: {
      init: () => null,
      apply(tr, _prev, _old, state) {
        if (tr.getMeta(suggestKey) === "dismiss") {
          const current = find(state, null);
          dismissedAt = current?.from ?? null;
          return null;
        }
        if (dismissedAt !== null) dismissedAt = tr.mapping.map(dismissedAt);
        return find(state, dismissedAt);
      },
    },
    props: {
      handleKeyDown(view, event) {
        if (!suggestKey.getState(view.state)) return false;
        if (event.key === "Escape") {
          view.dispatch(view.state.tr.setMeta(suggestKey, "dismiss"));
          return true;
        }
        return suggestKeys.current?.(event) ?? false;
      },
    },
  });
}
