import { useMemo, useState } from "react";
import { createCollection, updateCollection, type Collection, type CollectionPermission } from "../lib/api";
import { OUTLINE_ICONS } from "../lib/outlineIcons";
import { useSettings } from "../lib/settings";
import { emojiIcon } from "../lib/workspace";
import { Dialog } from "./Dialogs";
import { EntityIcon } from "./EntityIcon";

/** Outline's palette (shared/constants.ts), plus Rosé Pine's accents. */
const COLORS = ["#4E5C6E", "#0366D6", "#2BC2FF", "#9E5CF7", "#FF825C", "#FF5C80", "#FFBE0B", "#42DED1", "#00D084", "#FF4DFA", "#2F362F", "#c4a7e7", "#ebbcba", "#31748f", "#f6c177", "#eb6f92"];
const ICON_NAMES = Object.keys(OUTLINE_ICONS);

/** Create a collection, or edit one (name, icon, colour, and who can access it). */
export function CollectionDialog({ collection, onDone, onClose, onError }: { collection?: Collection; onDone: (c: Collection) => void; onClose: () => void; onError: (e: unknown) => void }) {
  const { t } = useSettings();
  const [name, setName] = useState(collection?.name ?? "");
  const [icon, setIcon] = useState<string | null>(collection?.icon ?? "collection");
  const [color, setColor] = useState<string>(collection?.color ?? COLORS[Math.floor(Math.random() * 11)]);
  const [permission, setPermission] = useState<CollectionPermission>((collection?.permission as CollectionPermission) ?? "read_write");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const icons = useMemo(() => ICON_NAMES.filter((n) => n.toLowerCase().includes(query.toLowerCase())), [query]);

  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const input = { name: name.trim(), icon, color, permission };
      onDone(collection ? await updateCollection(collection.id, input) : await createCollection(input));
      onClose();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title={collection ? t("editCollection") : t("newCollection")} onClose={onClose}>
      <form
        className="collection-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="collection-name-row">
          <span className="collection-preview" style={{ color }}>
            <EntityIcon icon={icon} color={color} size={28} fallback={<span className="collection-letter" style={{ background: color }}>{(name || "?").charAt(0).toUpperCase()}</span>} />
          </span>
          <input className="text-input" autoFocus placeholder={t("collectionName")} value={name} onChange={(e) => setName(e.target.value)} />
        </div>

        <div className="color-row">
          {COLORS.map((c) => (
            <button key={c} type="button" className={`color-swatch${c === color ? " active" : ""}`} style={{ background: c }} aria-label={c} onClick={() => setColor(c)} />
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
                if (!last) setIcon(null);
                else if (emojiIcon(last)) setIcon(last);
              }}
            />
          </div>
          <div className="icon-grid">
            <button type="button" className={`icon-cell${!icon ? " active" : ""}`} title={t("letter")} onClick={() => setIcon(null)}>
              <span className="collection-letter" style={{ background: color }}>
                {(name || "?").charAt(0).toUpperCase()}
              </span>
            </button>
            {icons.map((n) => (
              <button key={n} type="button" className={`icon-cell${icon === n ? " active" : ""}`} title={n} onClick={() => setIcon(n)}>
                <EntityIcon icon={n} color={color} size={20} fallback={null} />
              </button>
            ))}
          </div>
        </div>

        <label className="settings-grid-row">
          <span>{t("access")}</span>
          <select value={permission ?? ""} onChange={(e) => setPermission((e.target.value || null) as CollectionPermission)}>
            <option value="read_write">{t("accessEdit")}</option>
            <option value="read">{t("accessView")}</option>
            <option value="">{t("accessPrivate")}</option>
          </select>
        </label>

        <div className="dialog-actions">
          <button type="button" className="text-button" onClick={onClose}>
            {t("cancel")}
          </button>
          <button className="primary-button" disabled={!name.trim() || busy}>
            {collection ? t("save") : t("create")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
