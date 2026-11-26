// Every emoji, one category at a time (rendering all ~1,900 at once made the picker lag), with
// recently used ones first. Used by the icon picker and by "/emoji" in the editor.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { customEmojiList, customEmojiSrc, loadEmojiCatalog, type CatalogEmoji, type EmojiCategory } from "../editor/emoji";
import type { StringKey } from "../lib/i18n";
import { useSettings } from "../lib/settings";

const RECENT_KEY = "notes.recentEmoji";
const RECENT_MAX = 24;
/** Searching "a" matches most of the catalog; past this many it's narrowed by typing more. */
const SEARCH_MAX = 200;

function readRecent(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function pushRecent(emoji: string): string[] {
  const list = [emoji, ...readRecent().filter((e) => e !== emoji)].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // Private mode: recents just aren't remembered.
  }
  return list;
}

const CATEGORIES: Record<string, { label: StringKey; glyph: string }> = {
  people: { label: "emojiPeople", glyph: "😀" },
  nature: { label: "emojiNature", glyph: "🐻" },
  foods: { label: "emojiFoods", glyph: "🍔" },
  activity: { label: "emojiActivity", glyph: "⚽" },
  places: { label: "emojiPlaces", glyph: "✈️" },
  objects: { label: "emojiObjects", glyph: "💡" },
  symbols: { label: "emojiSymbols", glyph: "🔣" },
  flags: { label: "emojiFlags", glyph: "🏳️" },
};
const RECENT = "recent";
const CUSTOM = "custom";

export function EmojiGrid({
  query,
  current,
  none,
  noneLabel,
  onPick,
  withCustom,
}: {
  query: string;
  /** The emoji currently chosen, highlighted. */
  current?: string | null;
  /** A first cell for "no emoji", when there's one to clear. */
  none?: ReactNode;
  noneLabel?: string;
  /** The picked emoji, or null for the "none" cell. A custom one has its id as shortcode and no native. */
  onPick: (emoji: CatalogEmoji | null) => void;
  /** Offer the workspace's custom emoji too (the editor, where they're stored by id). */
  withCustom?: boolean;
}) {
  const { t } = useSettings();
  const [categories, setCategories] = useState<EmojiCategory[] | null>(null);
  const [recent, setRecent] = useState(readRecent);
  const [tab, setTab] = useState(() => (readRecent().length ? RECENT : "people"));
  useEffect(() => {
    void loadEmojiCatalog().then(setCategories);
  }, []);

  const custom = withCustom ? customEmojiList() : [];
  const customCell = (e: { id: string; name: string }) => (
    <button key={e.id} type="button" className="icon-cell emoji-cell" title={`:${e.name}:`} onClick={() => onPick({ native: "", name: e.name, shortcode: e.id, search: e.name })}>
      <img className="custom-emoji" src={customEmojiSrc(e.id)} alt={`:${e.name}:`} />
    </button>
  );
  const byNative = useMemo(() => new Map(categories?.flatMap((c) => c.emojis.map((e) => [e.native, e] as const))), [categories]);
  const q = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!q || !categories) return null;
    const out: CatalogEmoji[] = [];
    for (const c of categories) for (const e of c.emojis) if (out.length < SEARCH_MAX && e.search.includes(q)) out.push(e);
    return out;
  }, [q, categories]);

  if (!categories) return <div className="skeleton-rows small" />;

  const pick = (e: CatalogEmoji) => {
    setRecent(pushRecent(e.native));
    onPick(e);
  };
  const cell = (e: CatalogEmoji) => (
    <button key={e.native} type="button" className={`icon-cell emoji-cell${current === e.native ? " active" : ""}`} title={`:${e.shortcode}:`} onClick={() => pick(e)}>
      {e.native}
    </button>
  );
  const shown =
    tab === RECENT
      ? recent.map((native) => byNative.get(native) ?? { native, name: native, shortcode: native, search: "" })
      : (categories.find((c) => c.id === tab)?.emojis ?? []);
  const customMatches = q ? custom.filter((e) => e.name.includes(q)) : [];
  const tabs = [
    ...(recent.length ? [{ id: RECENT, label: t("emojiRecent"), glyph: "🕘" }] : []),
    ...(custom.length ? [{ id: CUSTOM, label: t("emojiCustom"), glyph: "⭐" }] : []),
    ...categories.map((c) => ({ id: c.id, label: CATEGORIES[c.id] ? t(CATEGORIES[c.id].label) : c.id, glyph: CATEGORIES[c.id]?.glyph ?? "•" }))];

  return (
    <div className="emoji-picker">
      <div className="emoji-tabs" role="tablist">
        {tabs.map((c) => (
          <button
            key={c.id}
            type="button"
            role="tab"
            title={c.label}
            aria-label={c.label}
            aria-selected={!matches && tab === c.id}
            className={`emoji-tab${!matches && tab === c.id ? " active" : ""}`}
            onClick={() => setTab(c.id)}
          >
            {c.glyph}
          </button>
        ))}
      </div>
      <div className="icon-grid emoji-picker-grid">
        {matches ? (
          matches.length || customMatches.length ? (
            <>
              {customMatches.map(customCell)}
              {matches.map(cell)}
            </>
          ) : (
            <div className="emoji-empty">{t("noEmoji")}</div>
          )
        ) : (
          <>
            {none !== undefined && (
              <button type="button" className={`icon-cell${!current ? " active" : ""}`} title={noneLabel} onClick={() => onPick(null)}>
                {none}
              </button>
            )}
            {tab === CUSTOM ? custom.map(customCell) : shown.map(cell)}
          </>
        )}
      </div>
    </div>
  );
}
