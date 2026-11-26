import { useEffect, useRef, useState } from "react";
import {
  can,
  createEmoji,
  createTemplate,
  deleteEmoji,
  deleteTemplate,
  duplicateTemplate,
  listEmojis,
  listShares,
  listTemplates,
  resolveUrl,
  revokeShare,
  templateInfo,
  updateTemplate,
  uploadFile,
  type Attachment,
  type CustomEmoji,
  type Envelope,
  type RichText,
  type ShareListItem,
  type Template,
} from "../../lib/api";
import { openExternal } from "../../lib/platform";
import { useSettings } from "../../lib/settings";
import { docFrom, StaticEditor } from "../../editor/StaticEditor";
import { ConfirmDialog, Dialog } from "../Dialogs";
import { isTauri } from "../../lib/platform";
import { EntityIcon } from "../EntityIcon";
import { DropdownMenu } from "../Toolbar";
import { ArrowLeft, Copy, External, FileText, Plus, Trash, Upload } from "../icons";
import { Empty, Loading, PageHeader, Select, usePage } from "./common";

export function TemplatesPage() {
  const { t, f } = useSettings();
  const { teamCan, workspace, onNavigate, flash, onError } = usePage();
  const [env, setEnv] = useState<Envelope<Template[]> | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Template | null>(null);

  const load = () => listTemplates().then(setEnv, onError);
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (open) return <TemplateEditor id={open} onBack={() => (setOpen(null), void load())} />;

  const templates = env?.data ?? [];
  const openTemplate = (tpl: Template) => (tpl.legacy ? onNavigate({ name: "doc", id: tpl.id }) : setOpen(tpl.id));
  const create = async () => {
    try {
      const tpl = await createTemplate({ title: t("untitled") });
      setOpen(tpl.id);
    } catch (e) {
      onError(e);
    }
  };
  const legacy = templates.some((x) => x.legacy);

  return (
    <>
      <PageHeader title={t("templates")} hint={t("templatesHint")}>
        {teamCan("createTemplate") && !legacy && (
          <button className="primary-button with-icon" onClick={() => void create()}>
            <Plus size={14} /> {t("newTemplate")}
          </button>
        )}
      </PageHeader>
      {!env ? (
        <Loading />
      ) : templates.length === 0 ? (
        <Empty>{t("noTemplates")}</Empty>
      ) : (
        <div className="settings-list">
          {templates.map((tpl) => {
            const collection = workspace.collections.find((c) => c.id === tpl.collectionId);
            const canEdit = tpl.legacy || can(env, tpl.id, "update");
            return (
              <div key={tpl.id} className="settings-item">
                <button className="settings-item-main" onClick={() => openTemplate(tpl)}>
                  <EntityIcon icon={tpl.icon} color={tpl.color} size={20} fallback={<FileText size={16} />} />
                  <div className="settings-item-text">
                    <span className="settings-item-title">{tpl.title || t("untitled")}</span>
                    <span className="settings-hint">
                      {collection?.name ?? t("wholeWorkspace")} · {f.relative(tpl.updatedAt)}
                    </span>
                  </div>
                </button>
                {canEdit && (
                  <DropdownMenu
                    title={t("more")}
                    items={[
                      { label: t("edit"), onClick: () => openTemplate(tpl) },
                      ...(!tpl.legacy
                        ? [
                            {
                              label: t("duplicate"),
                              onClick: () =>
                                void duplicateTemplate(tpl.id).then(() => {
                                  flash(t("templateCreated"));
                                  void load();
                                }, onError),
                            },
                          ]
                        : []),
                      { label: t("deleteTemplate"), danger: true, onClick: () => setDeleting(tpl) },
                    ]}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
      {deleting && (
        <ConfirmDialog
          title={t("deleteTemplate")}
          message={t("deleteTemplateMessage", { title: deleting.title || t("untitled") })}
          confirm={t("delete")}
          danger
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            try {
              await deleteTemplate(deleting.id, deleting.legacy);
              flash(t("templateDeleted"));
              void load();
            } catch (e) {
              onError(e);
            }
          }}
        />
      )}
    </>
  );
}

/** A template's title, where it's offered and its contents, saved as you type. */
function TemplateEditor({ id, onBack }: { id: string; onBack: () => void }) {
  const { t, settings } = useSettings();
  const { me, workspace, onNavigate, onError } = usePage();
  const [loaded, setLoaded] = useState<{ template: Template; editable: boolean } | null>(null);
  const [title, setTitle] = useState("");
  const pending = useRef<{ title?: string; data?: RichText }>({});
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const flush = () => {
    clearTimeout(timer.current);
    const patch = pending.current;
    pending.current = {};
    if (Object.keys(patch).length) updateTemplate(id, patch).catch(onError);
  };
  const queue = (patch: { title?: string; data?: RichText }) => {
    pending.current = { ...pending.current, ...patch };
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, 800);
  };

  useEffect(() => {
    templateInfo(id).then((res) => {
      setLoaded({ template: res.data, editable: can(res, id, "update") });
      setTitle(res.data.title);
    }, onError);
    return flush;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (!loaded) return <Loading />;
  const { template, editable } = loaded;
  return (
    <>
      <div className="template-bar">
        <button className="text-button with-icon" onClick={() => (flush(), onBack())}>
          <ArrowLeft size={14} /> {t("templates")}
        </button>
        <div className="toolbar-spacer" />
        <span className="muted small">{t("templateScope")}</span>
        <Select
          value={template.collectionId ?? ""}
          disabled={!editable}
          options={[["", t("wholeWorkspace")], ...workspace.collections.map((c): [string, string] => [c.id, c.name])]}
          onChange={(v) => {
            setLoaded({ template: { ...template, collectionId: v || null }, editable });
            updateTemplate(id, { collectionId: v || null }).catch(onError);
          }}
        />
      </div>
      <input
        className="template-title"
        value={title}
        readOnly={!editable}
        placeholder={t("untitled")}
        onChange={(e) => {
          setTitle(e.target.value);
          queue({ title: e.target.value });
        }}
      />
      <div className={`template-body font-${settings.font}`} style={{ fontSize: settings.fontSize }}>
        <StaticEditor
          doc={docFrom(template.data)}
          editable={editable}
          placeholder={t("templatePlaceholder")}
          t={t}
          user={me}
          onOpenDocument={(docId) => onNavigate({ name: "doc", id: docId })}
          onChange={(data) => queue({ data })}
        />
      </div>
    </>
  );
}

const EMOJI_NAME = /^[a-z0-9_]+$/;

/** Largest emoji image accepted (they're shown at text size). */
const EMOJI_MAX_BYTES = 1024 * 1024;
const EMOJI_TYPES = ["image/png", "image/gif", "image/jpeg", "image/webp", "image/svg+xml"];

/** "Party Parrot (1).gif" → "party_parrot_1" */
const emojiNameFrom = (file: string) =>
  file
    .replace(/\.[^.]+$/, "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 50);

type EmojiStep = "choose" | "upload" | "name";

/** Adding a custom emoji, in three steps: choose an image, upload it, name it. */
function NewEmojiDialog({ taken, onClose, onAdded }: { taken: Set<string>; onClose: () => void; onAdded: (emoji: CustomEmoji) => void }) {
  const { t } = useSettings();
  const [step, setStep] = useState<EmojiStep>("choose");
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);

  const start = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    if (!EMOJI_TYPES.includes(file.type)) return setError(t("emojiWrongType"));
    if (file.size > EMOJI_MAX_BYTES) return setError(t("emojiTooBig"));
    setPreview(URL.createObjectURL(file));
    setName((n) => n || emojiNameFrom(file.name));
    setStep("upload");
    setProgress(isTauri ? null : 0);
    try {
      setAttachment(await uploadFile(file, "emoji", undefined, isTauri ? undefined : setProgress));
      setStep("name");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep("choose");
    }
  };

  const nameOk = EMOJI_NAME.test(name);
  const nameTaken = taken.has(name);
  const add = async () => {
    if (!attachment || !nameOk || nameTaken) return;
    setBusy(true);
    try {
      onAdded(await createEmoji(name, attachment.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const steps: [EmojiStep, string][] = [
    ["choose", t("emojiStepChoose")],
    ["upload", t("emojiStepUpload")],
    ["name", t("emojiStepName")],
  ];
  const at = steps.findIndex(([s]) => s === step);

  return (
    <Dialog title={t("addEmoji")} onClose={onClose}>
      <ol className="steps">
        {steps.map(([s, label], i) => (
          <li key={s} className={i < at ? "done" : i === at ? "current" : ""}>
            <span className="step-dot">{i < at ? "✓" : i + 1}</span>
            {label}
          </li>
        ))}
      </ol>

      {step === "choose" && (
        <button
          type="button"
          className={`emoji-dropzone${dragging ? " dragging" : ""}`}
          onClick={() => input.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void start(e.dataTransfer.files[0]);
          }}
        >
          <Upload size={22} />
          <strong>{t("emojiDrop")}</strong>
          <span className="settings-hint">{t("emojiDropHint")}</span>
          <input ref={input} type="file" accept={EMOJI_TYPES.join(",")} hidden onChange={(e) => void start(e.target.files?.[0])} />
        </button>
      )}

      {step === "upload" && (
        <div className="emoji-uploading">
          {preview && <img src={preview} alt="" />}
          <div className={`progress${progress === null ? " indeterminate" : ""}`} role="progressbar" aria-valuenow={progress === null ? undefined : Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
            <span style={progress === null ? undefined : { width: `${Math.round(progress * 100)}%` }} />
          </div>
          <span className="settings-hint">{progress === null ? t("uploading") : t("uploadingPercent", { n: Math.round(progress * 100) })}</span>
        </div>
      )}

      {step === "name" && (
        <form
          className="settings-form"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <div className="emoji-naming">
            {preview && <img src={preview} alt="" />}
            <label className="emoji-name">
              <span className="muted">:</span>
              <input className="text-field mono" autoFocus value={name} maxLength={50} placeholder="party_parrot" onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s+/g, "_"))} />
              <span className="muted">:</span>
            </label>
          </div>
          <span className="settings-hint">{name && !nameOk ? t("emojiInvalidName") : nameTaken ? t("emojiNameTaken") : t("emojiNameHint", { name: name || "name" })}</span>
          <div className="dialog-actions">
            <button type="button" className="text-button" onClick={onClose}>
              {t("cancel")}
            </button>
            <button className="primary-button" disabled={busy || !nameOk || nameTaken}>
              {t("addEmoji")}
            </button>
          </div>
        </form>
      )}

      {error && <p className="error-text small">{error}</p>}
    </Dialog>
  );
}

export function EmojisPage() {
  const { t } = useSettings();
  const { me, teamCan, flash, onError } = usePage();
  const [env, setEnv] = useState<Envelope<CustomEmoji[]> | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<CustomEmoji | null>(null);

  const load = () => listEmojis().then(setEnv, onError);
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const emojis = env?.data ?? [];

  return (
    <>
      <PageHeader title={t("emojis")} hint={t("emojisHint")}>
        {teamCan("createEmoji") && (
          <button className="primary-button" onClick={() => setAdding(true)}>
            <Plus size={14} />
            {t("addEmoji")}
          </button>
        )}
      </PageHeader>
      {emojis.length > 0 && <p className="settings-hint emoji-usage">{t("emojiUsage")}</p>}
      {!env ? (
        <Loading />
      ) : emojis.length === 0 ? (
        <Empty>{t("noEmojis")}</Empty>
      ) : (
        <div className="emoji-grid">
          {emojis.map((e) => (
            <div key={e.id} className="emoji-card" title={e.createdBy ? t("addedBy", { name: e.createdBy.name }) : undefined}>
              <img src={resolveUrl(e.url)} alt={e.name} />
              <span className="emoji-card-name">:{e.name}:</span>
              {(can(env, e.id, "delete") || e.createdBy?.id === me.id) && (
                <button className="icon-button small" title={t("deleteEmoji")} onClick={() => setDeleting(e)}>
                  <Trash size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {adding && (
        <NewEmojiDialog
          taken={new Set(emojis.map((e) => e.name))}
          onClose={() => setAdding(false)}
          onAdded={(e) => {
            setAdding(false);
            flash(t("emojiAddedHowTo", { name: e.name }));
            void load();
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={t("deleteEmoji")}
          message={t("deleteEmojiMessage", { name: deleting.name })}
          confirm={t("delete")}
          danger
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            try {
              await deleteEmoji(deleting.id);
              void load();
            } catch (err) {
              onError(err);
            }
          }}
        />
      )}
    </>
  );
}

export function SharesPage() {
  const { t, f } = useSettings();
  const { onNavigate, flash, onError } = usePage();
  const [shares, setShares] = useState<ShareListItem[] | null>(null);
  const [revoking, setRevoking] = useState<ShareListItem | null>(null);

  const load = () => listShares().then(setShares, onError);
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const titleOf = (s: ShareListItem) => s.documentTitle || s.sourceTitle || t("untitled");

  return (
    <>
      <PageHeader title={t("sharedLinks")} hint={t("sharesHint")} />
      {!shares ? (
        <Loading />
      ) : shares.length === 0 ? (
        <Empty>{t("noShares")}</Empty>
      ) : (
        <div className="settings-list">
          {shares.map((s) => (
            <div key={s.id} className="settings-item">
              <button className="settings-item-main" disabled={!s.documentId} onClick={() => s.documentId && onNavigate({ name: "doc", id: s.documentId })}>
                <FileText size={16} />
                <div className="settings-item-text">
                  <span className="settings-item-title">{titleOf(s)}</span>
                  <span className="settings-hint">
                    {[s.createdBy && t("sharedBy", { name: s.createdBy.name }), f.relative(s.createdAt), t("viewsCount", { n: s.views ?? 0 }), s.lastAccessedAt && t("lastViewedPage", { time: f.relative(s.lastAccessedAt) })]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </div>
              </button>
              <button
                className="icon-button small"
                title={t("copyLink")}
                onClick={() => void navigator.clipboard.writeText(s.url).then(() => flash(t("linkCopied")), onError)}
              >
                <Copy size={14} />
              </button>
              <DropdownMenu
                title={t("more")}
                items={[
                  { label: t("openInBrowser"), icon: <External size={14} />, onClick: () => void openExternal(s.url) },
                  { label: t("revoke"), danger: true, onClick: () => setRevoking(s) },
                ]}
              />
            </div>
          ))}
        </div>
      )}
      {revoking && (
        <ConfirmDialog
          title={t("revokeTitle")}
          message={t("revokeMessage", { title: titleOf(revoking) })}
          confirm={t("revoke")}
          danger
          onClose={() => setRevoking(null)}
          onConfirm={async () => {
            try {
              await revokeShare(revoking.id);
              flash(t("linkRevoked"));
              void load();
            } catch (e) {
              onError(e);
            }
          }}
        />
      )}
    </>
  );
}
