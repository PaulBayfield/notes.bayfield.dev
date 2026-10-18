// Exporting a collection or the whole workspace. Outline builds the zip in the background; we
// watch it and offer the download once it's ready.

import { useState } from "react";
import { downloadExport, exportCollection, exportWorkspace, fileOperationInfo, type Collection, type ExportFormat, type FileOperation } from "../lib/api";
import type { StringKey } from "../lib/i18n";
import { useSettings } from "../lib/settings";
import { Dialog } from "./Dialogs";

export const EXPORT_FORMATS: { value: ExportFormat; title: string; extension: string; hint: StringKey }[] = [
  { value: "outline-markdown", title: "Markdown", extension: ".md", hint: "formatMarkdownHint" },
  { value: "okf", title: "Open Knowledge Format", extension: ".okf", hint: "formatOkfHint" },
  { value: "html", title: "HTML", extension: ".html", hint: "formatHtmlHint" },
  { value: "textbundle", title: "TextBundle", extension: ".textbundle", hint: "formatTextBundleHint" },
  { value: "json", title: "JSON", extension: ".json", hint: "formatJsonHint" },
];

const POLL_MS = 2000;
const GIVE_UP_MS = 30 * 60 * 1000;

/** Waits for an export to finish. Resolves with it once complete; rejects if it failed. */
export async function waitForExport(op: FileOperation): Promise<FileOperation> {
  const start = Date.now();
  let current = op;
  while (current.state === "creating" || current.state === "uploading") {
    if (Date.now() - start > GIVE_UP_MS) throw new Error("The export is taking too long. Look for it later in Settings → Export.");
    await new Promise((r) => setTimeout(r, POLL_MS));
    current = await fileOperationInfo(op.id);
  }
  if (current.state !== "complete") throw new Error(current.error || "The export failed.");
  return current;
}

/** Format and options; `onExport` starts it. */
export function ExportForm({
  collection,
  canIncludePrivate,
  busy,
  onExport,
}: {
  collection?: Collection;
  /** Workspace exports: admins may include collections they aren't a member of. */
  canIncludePrivate?: boolean;
  busy: boolean;
  onExport: (format: ExportFormat, includeAttachments: boolean, includePrivate: boolean) => void;
}) {
  const { t } = useSettings();
  const [format, setFormat] = useState<ExportFormat>("outline-markdown");
  const [attachments, setAttachments] = useState(true);
  const [includePrivate, setIncludePrivate] = useState(true);

  return (
    <form
      className="export-form"
      onSubmit={(e) => {
        e.preventDefault();
        onExport(format, attachments, includePrivate);
      }}
    >
      <div className="export-formats" role="radiogroup">
        {EXPORT_FORMATS.map((f) => (
          <label key={f.value} className={`export-format${format === f.value ? " active" : ""}`}>
            <input type="radio" name="format" checked={format === f.value} onChange={() => setFormat(f.value)} />
            <span className="export-format-text">
              <span className="export-format-title">
                {f.title} <span className="muted">{f.extension}</span>
              </span>
              <span className="settings-hint">{t(f.hint)}</span>
            </span>
          </label>
        ))}
      </div>
      <label className="export-option">
        <input type="checkbox" checked={attachments} onChange={(e) => setAttachments(e.target.checked)} />
        <span className="export-format-text">
          <span>{t("includeAttachments")}</span>
          <span className="settings-hint">{t("includeAttachmentsHint")}</span>
        </span>
      </label>
      {!collection && canIncludePrivate && (
        <label className="export-option">
          <input type="checkbox" checked={includePrivate} onChange={(e) => setIncludePrivate(e.target.checked)} />
          <span className="export-format-text">
            <span>{t("includePrivate")}</span>
            <span className="settings-hint">{t("includePrivateHint")}</span>
          </span>
        </label>
      )}
      <div className="dialog-actions">
        <button className="primary-button" disabled={busy}>
          {busy ? t("exporting") : t("export")}
        </button>
      </div>
    </form>
  );
}

/**
 * Starts an export and, in the background, tells when it's ready (with a download button).
 * Returns the started export.
 */
export async function startExport(
  target: { collection?: Collection; includePrivate?: boolean },
  format: ExportFormat,
  includeAttachments: boolean,
  notify: { flash: (message: string, action?: () => void, label?: string) => void; onError: (e: unknown) => void; t: (key: StringKey) => string },
): Promise<FileOperation> {
  const op = target.collection
    ? await exportCollection(target.collection.id, format, includeAttachments)
    : await exportWorkspace(format, includeAttachments, target.includePrivate ?? true);
  notify.flash(notify.t("exportStarted"));
  void waitForExport(op).then(
    (done) => notify.flash(notify.t("exportReady"), () => void downloadExport(done).catch(notify.onError), notify.t("download")),
    notify.onError,
  );
  return op;
}

export function ExportDialog({
  collection,
  onClose,
  flash,
  onError,
}: {
  collection: Collection;
  onClose: () => void;
  flash: (message: string, action?: () => void, label?: string) => void;
  onError: (e: unknown) => void;
}) {
  const { t } = useSettings();
  const [busy, setBusy] = useState(false);
  return (
    <Dialog title={t("exportCollectionTitle", { name: collection.name })} onClose={onClose}>
      <p className="dialog-text">{t("exportCollectionHint")}</p>
      <ExportForm
        collection={collection}
        busy={busy}
        onExport={async (format, attachments) => {
          setBusy(true);
          try {
            await startExport({ collection }, format, attachments, { flash, onError, t });
            onClose();
          } catch (e) {
            onError(e);
            setBusy(false);
          }
        }}
      />
    </Dialog>
  );
}
