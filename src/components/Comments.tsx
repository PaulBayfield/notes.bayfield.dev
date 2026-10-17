import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { EditorView } from "prosemirror-view";
import {
  createComment,
  deleteComment,
  listComments,
  resolveComment,
  richTextToPlain,
  unresolveComment,
  updateComment,
  type Comment,
  type User,
} from "../lib/api";
import { onRealtime } from "../lib/realtime";
import { useSettings } from "../lib/settings";
import { Avatar } from "./Avatar";
import { commentOrder, commentQuote, removeCommentMark, scrollToComment, updateCommentMark } from "../editor/comments";

let draftCleanup: ReturnType<typeof setTimeout> | undefined;

interface Props {
  documentId: string;
  user: User;
  viewRef: RefObject<EditorView | null>;
  /** Bumped when the document changes, so quotes and order follow edits. */
  docTick: number;
  /** A new comment being written (its draft mark is already in the document). */
  draftId: string | null;
  onDraftDone: () => void;
  activeId: string | null;
  onActivate: (id: string | null) => void;
  onError: (e: unknown) => void;
}

function Composer({
  placeholder,
  initial = "",
  autoFocus,
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  initial?: string;
  autoFocus?: boolean;
  onSubmit: (text: string) => Promise<void>;
  onCancel?: () => void;
}) {
  const { t } = useSettings();
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);
  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await onSubmit(text.trim());
      setText("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="comment-composer">
      <textarea
        ref={ref}
        rows={1}
        autoFocus={autoFocus}
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void submit();
          } else if (e.key === "Escape") onCancel?.();
        }}
      />
      {(text || onCancel) && (
        <div className="comment-composer-actions">
          {onCancel && (
            <button className="link-button" onClick={onCancel}>
              {t("cancel")}
            </button>
          )}
          <button className="primary-button small" disabled={!text.trim() || busy} onClick={() => void submit()}>
            {t("send")}
          </button>
        </div>
      )}
    </div>
  );
}

function CommentItem({ comment, user, onEdit, onDelete }: { comment: Comment; user: User; onEdit: (text: string) => Promise<void>; onDelete: () => void }) {
  const { t, f } = useSettings();
  const [editing, setEditing] = useState(false);
  const mine = comment.createdBy.id === user.id;
  const text = richTextToPlain(comment.data);
  return (
    <div className="comment">
      <div className="comment-head">
        <Avatar user={comment.createdBy} size={20} />
        <span className="comment-author">{comment.createdBy.name}</span>
        <span className="comment-time" title={f.dateTime(comment.createdAt)}>
          {f.relative(comment.createdAt)}
        </span>
        {mine && !editing && (
          <span className="comment-actions">
            <button className="link-button" onClick={() => setEditing(true)}>
              {t("edit")}
            </button>
            <button className="link-button" onClick={onDelete}>
              {t("delete")}
            </button>
          </span>
        )}
      </div>
      {editing ? (
        <Composer
          placeholder=""
          initial={text}
          autoFocus
          onSubmit={async (next) => {
            await onEdit(next);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <div className="comment-body">{text}</div>
      )}
    </div>
  );
}

export function Comments(p: Props) {
  const { t } = useSettings();
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const pRef = useRef(p);
  pRef.current = p;
  const view = () => pRef.current.viewRef.current;

  const load = useCallback(async () => {
    try {
      setComments(await listComments(p.documentId));
    } catch (e) {
      pRef.current.onError(e);
      setComments([]);
    }
  }, [p.documentId]);

  useEffect(() => {
    setComments(null);
    void load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = onRealtime(({ event, data }) => {
      if (!event.startsWith("comments.")) return;
      const docId = (data as { documentId?: string } | null)?.documentId;
      if (docId && docId !== p.documentId) return;
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 200);
    });
    return () => {
      stop();
      clearTimeout(timer);
    };
  }, [load, p.documentId]);

  // A draft left behind (panel closed mid-comment) is removed from the document. Deferred, so a
  // remount right away (React's dev double-mount) cancels it.
  useEffect(() => {
    clearTimeout(draftCleanup);
    return () => {
      const { draftId, viewRef } = pRef.current;
      draftCleanup = setTimeout(() => {
        if (draftId && viewRef.current && !viewRef.current.isDestroyed) removeCommentMark(viewRef.current, draftId);
      });
    };
  }, []);

  const threads = useMemo(() => {
    const doc = view()?.state.doc;
    const order = doc ? commentOrder(doc) : new Map<string, number>();
    const all = comments ?? [];
    return all
      .filter((c) => !c.parentCommentId)
      .map((c) => ({
        comment: c,
        replies: all.filter((r) => r.parentCommentId === c.id),
        quote: doc ? commentQuote(doc, c.id) : "",
        pos: order.get(c.id) ?? Number.MAX_SAFE_INTEGER,
      }))
      .sort((a, b) => a.pos - b.pos || a.comment.createdAt.localeCompare(b.comment.createdAt));
    // docTick: recompute quotes and order as the document changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comments, p.docTick]);

  const open = threads.filter((th) => !th.comment.resolvedAt);
  const resolved = threads.filter((th) => th.comment.resolvedAt);

  const act = (fn: () => Promise<unknown>) => async () => {
    try {
      await fn();
      await load();
    } catch (e) {
      p.onError(e);
    }
  };

  const draftQuote = p.draftId && view() ? commentQuote(view()!.state.doc, p.draftId) : "";

  const renderThread = (th: (typeof threads)[number]) => {
    const c = th.comment;
    const active = p.activeId === c.id;
    return (
      <div
        key={c.id}
        className={`comment-thread${active ? " active" : ""}${c.resolvedAt ? " resolved" : ""}`}
        onClick={() => {
          p.onActivate(c.id);
          const v = view();
          if (v) scrollToComment(v, c.id);
        }}
      >
        {th.quote && <div className="comment-quote">{th.quote}</div>}
        {[c, ...th.replies].map((item) => (
          <CommentItem
            key={item.id}
            comment={item}
            user={p.user}
            onEdit={async (text) => {
              await updateComment(item.id, text);
              await load();
            }}
            onDelete={act(async () => {
              await deleteComment(item.id);
              const v = view();
              if (item.id === c.id && v) removeCommentMark(v, c.id);
            })}
          />
        ))}
        <div className="comment-thread-footer" onClick={(e) => e.stopPropagation()}>
          {!c.resolvedAt && (
            <Composer
              placeholder={t("reply")}
              onSubmit={async (text) => {
                try {
                  await createComment({ id: crypto.randomUUID(), documentId: p.documentId, parentCommentId: c.id, text });
                  await load();
                } catch (e) {
                  p.onError(e);
                }
              }}
            />
          )}
          <button
            className="link-button"
            onClick={act(async () => {
              const v = view();
              if (c.resolvedAt) {
                await unresolveComment(c.id);
                if (v) updateCommentMark(v, c.id, { resolved: false });
              } else {
                await resolveComment(c.id);
                if (v) updateCommentMark(v, c.id, { resolved: true });
              }
            })}
          >
            {c.resolvedAt ? t("reopen") : t("resolve")}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="comments">
      {p.draftId && (
        <div className="comment-thread active new">
          {draftQuote && <div className="comment-quote">{draftQuote}</div>}
          <Composer
            placeholder={t("addComment")}
            autoFocus
            onSubmit={async (text) => {
              const id = p.draftId!;
              try {
                await createComment({ id, documentId: p.documentId, text });
                const v = view();
                if (v) updateCommentMark(v, id, { draft: false });
                p.onDraftDone();
                p.onActivate(id);
                await load();
              } catch (e) {
                p.onError(e);
              }
            }}
            onCancel={() => {
              const v = view();
              if (v) removeCommentMark(v, p.draftId!);
              p.onDraftDone();
            }}
          />
        </div>
      )}
      {comments === null ? (
        <div className="skeleton-rows" />
      ) : open.length === 0 && !p.draftId ? (
        <p className="panel-note">{t("noComments")}</p>
      ) : (
        open.map(renderThread)
      )}
      {resolved.length > 0 && (
        <>
          <button className="link-button resolved-toggle" onClick={() => setShowResolved((s) => !s)}>
            {showResolved ? t("hideResolved") : t("showResolved", { n: resolved.length })}
          </button>
          {showResolved && resolved.map(renderThread)}
        </>
      )}
    </div>
  );
}
