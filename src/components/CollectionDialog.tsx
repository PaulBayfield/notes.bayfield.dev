import { useState } from "react";
import { createCollection, updateCollection, type Collection, type CollectionPermission } from "../lib/api";
import { useSettings } from "../lib/settings";
import { Dialog } from "./Dialogs";
import { EntityIcon } from "./EntityIcon";
import { COLORS, IconPicker } from "./IconPicker";

/** Create a collection, or edit one (name, icon, colour, and who can access it). */
export function CollectionDialog({ collection, onDone, onClose, onError }: { collection?: Collection; onDone: (c: Collection) => void; onClose: () => void; onError: (e: unknown) => void }) {
  const { t } = useSettings();
  const [name, setName] = useState(collection?.name ?? "");
  const [icon, setIcon] = useState<string | null>(collection?.icon ?? "collection");
  const [color, setColor] = useState<string>(collection?.color ?? COLORS[Math.floor(Math.random() * 11)]);
  const [permission, setPermission] = useState<CollectionPermission>((collection?.permission as CollectionPermission) ?? "read_write");
  const [busy, setBusy] = useState(false);

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

        <IconPicker
          icon={icon}
          color={color}
          noneLabel={t("letter")}
          none={
            <span className="collection-letter" style={{ background: color }}>
              {(name || "?").charAt(0).toUpperCase()}
            </span>
          }
          onIcon={setIcon}
          onColor={setColor}
        />

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
