import { useMemo, useState, type ReactNode } from "react";
import { OUTLINE_ICONS } from "../lib/outlineIcons";
import { useSettings } from "../lib/settings";
import { emojiIcon } from "../lib/workspace";
import { EntityIcon } from "./EntityIcon";

/** Outline's palette (shared/constants.ts), plus Rosé Pine's accents. */
export const COLORS = ["#4E5C6E", "#0366D6", "#2BC2FF", "#9E5CF7", "#FF825C", "#FF5C80", "#FFBE0B", "#42DED1", "#00D084", "#FF4DFA", "#2F362F", "#c4a7e7", "#ebbcba", "#31748f", "#f6c177", "#eb6f92"];
const ICON_NAMES = Object.keys(OUTLINE_ICONS);

/**
 * Colour swatches, then a searchable grid of Outline's icons with an emoji field.
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
  const [query, setQuery] = useState("");
  const icons = useMemo(() => ICON_NAMES.filter((n) => n.toLowerCase().includes(query.toLowerCase())), [query]);

  return (
    <>
      <div className="color-row">
        {COLORS.map((c) => (
          <button key={c} type="button" className={`color-swatch${c === color ? " active" : ""}`} style={{ background: c }} aria-label={c} onClick={() => onColor(c)} />
        ))}
      </div>

      <div className="icon-picker">
        <div className="icon-picker-head">
          <input className="text-input" placeholder={t("searchIcons")} value={query} onChange={(e) => setQuery(e.target.value)} />
          <input
            className="text-input emoji-input"
            placeholder="😀"
            aria-label={t("emoji")}
            value={emojiIcon(icon) ?? ""}
            onChange={(e) => {
              // Keep the last emoji typed (an emoji can be several code points).
              const last = [...new Intl.Segmenter().segment(e.target.value)].pop()?.segment;
              if (!last) onIcon(null);
              else if (emojiIcon(last)) onIcon(last);
            }}
          />
        </div>
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
      </div>
    </>
  );
}
