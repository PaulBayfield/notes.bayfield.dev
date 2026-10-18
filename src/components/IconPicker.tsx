import { useEffect, useMemo, useState, type ReactNode } from "react";
import { loadEmojiCatalog, type EmojiCategory } from "../editor/emoji";
import { OUTLINE_ICONS } from "../lib/outlineIcons";
import { useSettings } from "../lib/settings";
import { emojiIcon } from "../lib/workspace";
import { EntityIcon } from "./EntityIcon";

/** Outline's palette (shared/constants.ts), plus Rosé Pine's accents. */
export const COLORS = ["#4E5C6E", "#0366D6", "#2BC2FF", "#9E5CF7", "#FF825C", "#FF5C80", "#FFBE0B", "#42DED1", "#00D084", "#FF4DFA", "#2F362F", "#c4a7e7", "#ebbcba", "#31748f", "#f6c177", "#eb6f92"];
const ICON_NAMES = Object.keys(OUTLINE_ICONS);

const RECENT_KEY = "notes.recentEmoji";
const RECENT_MAX = 24;

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

const CATEGORY_LABELS = {
  people: "emojiPeople",
  nature: "emojiNature",
  foods: "emojiFoods",
  activity: "emojiActivity",
  places: "emojiPlaces",
  objects: "emojiObjects",
  symbols: "emojiSymbols",
  flags: "emojiFlags",
} as const;

/**
 * Colour swatches, then Outline's icons or every emoji, each searchable.
 * `none` is the first cell, for "no icon" (a collection's letter, nothing for a document).
 */
export function IconPicker({
  icon,
  color,
  none,
  noneLabel,
  onIcon,
  onColor,
}: {
  icon: string | null;
  color: string;
  none: ReactNode;
  noneLabel: string;
  onIcon: (icon: string | null) => void;
  onColor: (color: string) => void;
}) {
  const { t } = useSettings();
  const [tab, setTab] = useState<"icons" | "emoji">(() => (emojiIcon(icon) ? "emoji" : "icons"));
  const [query, setQuery] = useState("");
  const icons = useMemo(() => ICON_NAMES.filter((n) => n.toLowerCase().includes(query.toLowerCase())), [query]);

  return (
    <>
      {tab === "icons" && (
        <div className="color-row">
          {COLORS.map((c) => (
            <button key={c} type="button" className={`color-swatch${c === color ? " active" : ""}`} style={{ background: c }} aria-label={c} onClick={() => onColor(c)} />
          ))}
        </div>
      )}

      <div className="icon-picker">
        <div className="icon-picker-tabs" role="tablist">
          {(["icons", "emoji"] as const).map((name) => (
            <button key={name} type="button" role="tab" aria-selected={tab === name} className={`icon-picker-tab${tab === name ? " active" : ""}`} onClick={() => setTab(name)}>
              {t(name === "icons" ? "iconsTab" : "emojiTab")}
            </button>
          ))}
        </div>
        <input
          className="text-input"
          placeholder={t(tab === "icons" ? "searchIcons" : "searchEmoji")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {tab === "icons" ? (
          <div className="icon-grid">
            <button type="button" className={`icon-cell${!icon ? " active" : ""}`} title={noneLabel} onClick={() => onIcon(null)}>
              {none}
            </button>
            {icons.map((n) => (
              <button key={n} type="button" className={`icon-cell${icon === n ? " active" : ""}`} title={n} onClick={() => onIcon(n)}>
                <EntityIcon icon={n} color={color} size={20} fallback={null} />
              </button>
            ))}
          </div>
        ) : (
          <EmojiGrid query={query} current={emojiIcon(icon)} none={none} noneLabel={noneLabel} onPick={onIcon} />
        )}
      </div>
    </>
  );
}

function EmojiGrid({
  query,
  current,
  none,
  noneLabel,
  onPick,
}: {
  query: string;
  current: string | null;
  none: ReactNode;
  noneLabel: string;
  onPick: (emoji: string | null) => void;
}) {
  const { t } = useSettings();
  const [categories, setCategories] = useState<EmojiCategory[] | null>(null);
  const [recent, setRecent] = useState(readRecent);
  useEffect(() => {
    void loadEmojiCatalog().then(setCategories);
  }, []);

  const q = query.trim().toLowerCase();
  const matches = useMemo(() => (q && categories ? categories.flatMap((c) => c.emojis.filter((e) => e.search.includes(q))) : null), [q, categories]);

  if (!categories) return <div className="skeleton-rows small" />;

  const pick = (emoji: string) => {
    setRecent(pushRecent(emoji));
    onPick(emoji);
  };
  const cell = (e: { native: string; name: string }) => (
    <button key={e.native} type="button" className={`icon-cell emoji-cell${current === e.native ? " active" : ""}`} title={e.name} onClick={() => pick(e.native)}>
      {e.native}
    </button>
  );

  return (
    <div className="icon-grid emoji-grid">
      {matches ? (
        matches.length ? (
          matches.map(cell)
        ) : (
          <div className="emoji-empty">{t("noEmoji")}</div>
        )
      ) : (
        <>
          <button type="button" className={`icon-cell${!current ? " active" : ""}`} title={noneLabel} onClick={() => onPick(null)}>
            {none}
          </button>
          {recent.length > 0 && (
            <>
              <div className="emoji-category">{t("emojiRecent")}</div>
              {recent.map((native) => cell({ native, name: native }))}
            </>
          )}
          {categories.map((c) => (
            <EmojiSection key={c.id} label={c.id in CATEGORY_LABELS ? t(CATEGORY_LABELS[c.id as keyof typeof CATEGORY_LABELS]) : c.id}>
              {c.emojis.map(cell)}
            </EmojiSection>
          ))}
        </>
      )}
    </div>
  );
}

function EmojiSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <div className="emoji-category">{label}</div>
      {children}
    </>
  );
}
