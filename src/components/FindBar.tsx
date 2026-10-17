import { useEffect, useRef, useState, type RefObject } from "react";
import type { EditorView } from "prosemirror-view";
import { findKey, replaceAll, replaceCurrent, setFind, stepFind } from "../editor/find";
import { useSettings } from "../lib/settings";
import { ChevronDown, ChevronUp, X } from "./icons";

/** Search (and replace) in the open document. */
export function FindBar({ viewRef, editable, onClose }: { viewRef: RefObject<EditorView | null>; editable: boolean; onClose: () => void }) {
  const { t } = useSettings();
  const [query, setQuery] = useState(() => {
    const view = viewRef.current;
    if (!view) return "";
    const { from, to } = view.state.selection;
    const selected = view.state.doc.textBetween(from, to, " ");
    return selected.length < 80 ? selected : "";
  });
  const [replacement, setReplacement] = useState("");
  const [showReplace, setShowReplace] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [, rerender] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    setFind(view, { query, caseSensitive, current: 0 });
    rerender((n) => n + 1);
  }, [query, caseSensitive, viewRef]);

  // Clear highlights when closing.
  useEffect(
    () => () => {
      const view = viewRef.current;
      if (view && !view.isDestroyed) setFind(view, { query: "" });
    },
    [viewRef],
  );

  const view = viewRef.current;
  const state = view ? findKey.getState(view.state) : undefined;
  const count = state?.matches.length ?? 0;
  const step = (d: 1 | -1) => {
    if (view) stepFind(view, d);
    rerender((n) => n + 1);
  };

  return (
    <div className="find-bar" onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), onClose())}>
      <div className="find-row">
        <input
          ref={input}
          value={query}
          placeholder={t("findPlaceholder")}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              step(e.shiftKey ? -1 : 1);
            }
          }}
        />
        <span className="find-count">{query ? (count ? `${(state?.current ?? 0) + 1}/${count}` : t("noResults")) : ""}</span>
        <button className={`icon-button small${caseSensitive ? " active" : ""}`} title={t("matchCase")} onClick={() => setCaseSensitive((c) => !c)}>
          Aa
        </button>
        <button className="icon-button small" title={`${t("previous")} (Shift+Enter)`} disabled={!count} onClick={() => step(-1)}>
          <ChevronUp size={14} />
        </button>
        <button className="icon-button small" title={`${t("next")} (Enter)`} disabled={!count} onClick={() => step(1)}>
          <ChevronDown size={14} />
        </button>
        {editable && (
          <button className={`icon-button small${showReplace ? " active" : ""}`} title={t("replace")} onClick={() => setShowReplace((s) => !s)}>
            ⇄
          </button>
        )}
        <button className="icon-button small" title={`${t("close")} (Esc)`} onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      {showReplace && editable && (
        <div className="find-row">
          <input
            value={replacement}
            placeholder={t("replaceWith")}
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && view) {
                e.preventDefault();
                replaceCurrent(view, replacement);
                rerender((n) => n + 1);
              }
            }}
          />
          <button className="text-button" disabled={!count} onClick={() => view && (replaceCurrent(view, replacement), rerender((n) => n + 1))}>
            {t("replace")}
          </button>
          <button className="text-button" disabled={!count} onClick={() => view && (replaceAll(view, replacement), rerender((n) => n + 1))}>
            {t("replaceAll")}
          </button>
        </div>
      )}
    </div>
  );
}
