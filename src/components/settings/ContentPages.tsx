import { useEffect, useRef, useState } from "react";
import {
  can,
  chooseAndUploadImage,
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
import { ConfirmDialog } from "../Dialogs";
import { EntityIcon } from "../EntityIcon";
import { DropdownMenu } from "../Toolbar";
import { ArrowLeft, Copy, External, FileText, Plus, Trash } from "../icons";
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

export function EmojisPage() {
  const { t } = useSettings();
  const { me, teamCan, flash, onError } = usePage();
  const [env, setEnv] = useState<Envelope<CustomEmoji[]> | null>(null);
  const [image, setImage] = useState<{ attachment: Attachment; preview: string } | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<CustomEmoji | null>(null);

  const load = () => listEmojis().then(setEnv, onError);
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pick = async () => {
    try {
      const attachment = await chooseAndUploadImage("emoji");
      if (!attachment) return;
      setImage({ attachment, preview: resolveUrl(attachment.url) });
      if (!name) setName(attachment.name.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, ""));
    } catch (e) {
      onError(e);
    }
  };
  const nameOk = EMOJI_NAME.test(name);
  const emojis = env?.data ?? [];

  return (
    <>
      <PageHeader title={t("emojis")} hint={t("emojisHint")} />
      {teamCan("createEmoji") && (
        <form
          className="emoji-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!image || !nameOk) return;
            setBusy(true);
            try {
              await createEmoji(name, image.attachment.id);
              flash(t("emojiAdded"));
              setImage(null);
              setName("");
              void load();
            } catch (err) {
              onError(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          <button type="button" className="emoji-drop" onClick={() => void pick()} title={t("chooseImage")}>
            {image ? <img src={image.preview} alt="" /> : <Plus size={18} />}
          </button>
          <label className="emoji-name">
            <span className="muted">:</span>
            <input className="text-field" placeholder="party_parrot" value={name} maxLength={100} onChange={(e) => setName(e.target.value.toLowerCase())} />
            <span className="muted">:</span>
          </label>
          <button className="primary-button" disabled={busy || !image || !nameOk}>
            {t("addEmoji")}
          </button>
          {name && !nameOk && <span className="error-text small">{t("emojiInvalidName")}</span>}
        </form>
      )}
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
