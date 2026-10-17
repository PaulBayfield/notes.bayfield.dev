import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { can, ApiError, documentInfo, updateDocument, type Doc, type User } from "../lib/api";
import { useSettings } from "../lib/settings";
import { documentIdsOf, onRealtime } from "../lib/realtime";
import { EntityIcon } from "./EntityIcon";
import { FindBar } from "./FindBar";
import { embedsEnabled } from "../lib/docPrefs";
import type { HeadingPrefixStyle } from "../editor/headingPrefix";
import { Editor, type EditorStatus, type Heading } from "../editor/Editor";
import type { PresenceUser } from "../editor/collab";

export interface DocMeta {
  doc: Doc;
  canUpdate: boolean;
  canInvite: boolean;
  canShare: boolean;
}

interface Props {
  id: string;
  server: string;
  token: string;
  user: User;
  /** Focus the title right away (new documents). */
  autoFocusTitle: boolean;
  refreshToken: () => Promise<string | undefined>;
  onLoaded: (meta: DocMeta | null) => void;
  onTitleChange: (id: string, title: string) => void;
  onOpenDocument: (id: string) => void;
  onStatus: (status: EditorStatus) => void;
  onPresence: (users: PresenceUser[]) => void;
  onHeadings: (headings: Heading[]) => void;
  onError: (e: unknown) => void;
  onStartComment: (id: string) => void;
  onCommentClick: (id: string) => void;
  viewRef: RefObject<EditorView | null>;
  /** Bumped by document actions (settings changed, revision restored…) to reload. */
  reloadKey: number;
  findOpen: boolean;
  onCloseFind: () => void;
}

export function DocumentView(p: Props) {
  const { t, f, settings } = useSettings();
  const [meta, setMeta] = useState<DocMeta | null>(null);
  const [missing, setMissing] = useState(false);
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState<EditorStatus>("loading");
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const editingTitle = useRef(false);
  const pRef = useRef(p);
  pRef.current = p;
  /** Canonical id: the route may use the short url id. */
  const loadedId = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await documentInfo(p.id);
      const next = {
        doc: res.data,
        canUpdate: can(res, res.data.id, "update"),
        canInvite: can(res, res.data.id, "manageUsers"),
        canShare: can(res, res.data.id, "share"),
      };
      setMeta(next);
      loadedId.current = res.data.id;
      if (!editingTitle.current) setTitle(res.data.title);
      pRef.current.onLoaded(next);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 403 || e.status === 400)) {
        setMissing(true);
        pRef.current.onLoaded(null);
      } else pRef.current.onError(e);
    }
  }, [p.id]);

  useEffect(() => {
    setMeta(null);
    setMissing(false);
    editingTitle.current = false;
    void load();
    // Pick up renames made elsewhere: live, and when coming back to the window.
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    const stop = onRealtime(({ event, data }) => {
      if ((event === "entities" || event.startsWith("documents.")) && documentIdsOf(data).some((id) => id === p.id || id === loadedId.current)) void load();
    });
    return () => {
      window.removeEventListener("focus", onFocus);
      stop();
    };
  }, [load, p.id]);

  useEffect(() => {
    if (p.reloadKey) void load();
  }, [p.reloadKey, load]);

  // Title: saved through the API (it isn't part of the collaborative document).
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = useRef<{ id: string; title: string } | null>(null);
  const flush = useCallback(() => {
    clearTimeout(saveTimer.current);
    const next = pending.current;
    pending.current = null;
    editingTitle.current = false;
    if (next) updateDocument(next.id, { title: next.title }).catch((e) => pRef.current.onError(e));
  }, []);
  useEffect(() => flush, [p.id, flush]);

  const onTitle = (value: string) => {
    const clean = value.replace(/\n/g, "");
    setTitle(clean);
    if (!meta) return;
    editingTitle.current = true;
    pending.current = { id: meta.doc.id, title: clean };
    p.onTitleChange(meta.doc.id, clean);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flush, 500);
  };

  useLayoutEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    el.style.height = "0";
    el.style.height = `${el.scrollHeight}px`;
  }, [title, meta, settings.fontSize]);

  useEffect(() => {
    if (meta && p.autoFocusTitle) titleRef.current?.focus();
  }, [meta, p.autoFocusTitle]);

  const focusEditorStart = () => {
    const view = p.viewRef.current;
    if (!view) return;
    view.dispatch(view.state.tr.setSelection(TextSelection.atStart(view.state.doc)));
    view.focus();
  };

  if (missing) return <div className="empty-state">{t("notFound")}</div>;
  if (!meta) return <div className="doc-scroll" />;

  const { doc } = meta;
  const editable = meta.canUpdate && !doc.archivedAt && status !== "outdated" && status !== "denied" && status !== "unsupported";
  const by = doc.updatedBy?.id === p.user.id ? null : doc.updatedBy?.name;
  const embeds = embedsEnabled(doc.id);
  const headingPrefix = (doc.preferences?.headingPrefix ?? "none") as HeadingPrefixStyle;

  return (
    <div className="doc-scroll" id="doc-scroll">
      {p.findOpen && <FindBar viewRef={p.viewRef} editable={editable} onClose={p.onCloseFind} />}
      <article className={`doc${settings.fullWidth || doc.fullWidth ? " full-width" : ""} font-${settings.font}`} style={{ fontSize: settings.fontSize }}>
        {doc.icon && (
          <div className="doc-icon">
            <EntityIcon icon={doc.icon} color={doc.color} size={44} fallback={null} />
          </div>
        )}
        <textarea
          ref={titleRef}
          className="doc-title"
          rows={1}
          value={title}
          placeholder={t("titlePlaceholder")}
          readOnly={!editable}
          spellCheck={settings.spellcheck}
          onChange={(e) => onTitle(e.target.value)}
          onBlur={flush}
          onKeyDown={(e) => {
            if (e.key === "Enter" || (e.key === "ArrowDown" && e.currentTarget.selectionStart === title.length)) {
              e.preventDefault();
              focusEditorStart();
            }
          }}
        />
        <div className="doc-meta">
          {!doc.publishedAt && <span className="badge">{t("draft")}</span>}
          {!editable && meta.canUpdate === false && <span className="badge">{t("readOnly")}</span>}
          <span title={f.dateTime(doc.updatedAt)}>{by ? t("editedBy", { name: by, time: f.relative(doc.updatedAt) }) : t("edited", { time: f.relative(doc.updatedAt) })}</span>
        </div>
        <Editor
          key={`${doc.id}:${embeds}`}
          embeds={embeds}
          headingPrefix={headingPrefix}
          docId={doc.id}
          server={p.server}
          token={p.token}
          user={p.user}
          editable={editable}
          spellcheck={settings.spellcheck}
          t={t}
          refreshToken={p.refreshToken}
          onOpenDocument={p.onOpenDocument}
          onStatus={(s) => {
            setStatus(s);
            p.onStatus(s);
          }}
          onPresence={p.onPresence}
          onHeadings={p.onHeadings}
          onError={p.onError}
          onStartComment={p.onStartComment}
          onCommentClick={p.onCommentClick}
          viewRef={p.viewRef}
        />
      </article>
    </div>
  );
}
