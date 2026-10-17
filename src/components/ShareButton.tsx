import { useCallback, useEffect, useRef, useState } from "react";
import {
  addDocumentUser,
  createShare,
  documentMemberships,
  listUsers,
  removeDocumentUser,
  shareInfo,
  updateShare,
  type Collection,
  type DocumentPermission,
  type Membership,
  type Share,
  type User,
} from "../lib/api";
import { useSettings } from "../lib/settings";
import { Avatar } from "./Avatar";
import { useDismiss } from "./Toolbar";
import { Copy, Globe, ShareIcon, Users } from "./icons";

const PERMISSIONS: [DocumentPermission, "canView" | "canEdit" | "canManage"][] = [
  ["read", "canView"],
  ["read_write", "canEdit"],
  ["admin", "canManage"],
];

interface Props {
  documentId: string;
  collection?: Collection;
  me: User;
  /** Allowed to add or remove people. */
  canInvite: boolean;
  /** Allowed to publish the document on the web. */
  canShare: boolean;
  onError: (e: unknown) => void;
  flash: (message: string) => void;
}

/** "Share" in the header: invite people to the document and publish it on the web. */
export function ShareButton(p: Props) {
  const { t } = useSettings();
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  return (
    <div className="menu-anchor" ref={ref}>
      <button className={`icon-button${open ? " active" : ""}`} title={t("share")} aria-label={t("share")} aria-expanded={open} onClick={() => setOpen(!open)}>
        <ShareIcon />
      </button>
      {open && <SharePanel {...p} />}
    </div>
  );
}

function SharePanel({ documentId, collection, me, canInvite, canShare, onError, flash }: Props) {
  const { t } = useSettings();
  const [members, setMembers] = useState<{ membership: Membership; user: User }[] | null>(null);
  const [shares, setShares] = useState<Share[] | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<User[]>([]);
  const [newPermission, setNewPermission] = useState<DocumentPermission>("read_write");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const [m, s] = await Promise.all([documentMemberships(documentId), shareInfo(documentId)]);
      setMembers(m.memberships.map((membership) => ({ membership, user: m.users.find((u) => u.id === membership.userId)! })).filter((x) => x.user));
      setShares(s);
    } catch (e) {
      onError(e);
      setMembers([]);
      setShares([]);
    }
  }, [documentId, onError]);
  useEffect(() => void load(), [load]);

  // People search, for inviting.
  useEffect(() => {
    if (!query.trim()) return setResults([]);
    let cancelled = false;
    const timer = setTimeout(() => {
      listUsers(query.trim(), 6)
        .then((users) => !cancelled && setResults(users.filter((u) => u.id !== me.id && !members?.some((m) => m.user.id === u.id))))
        .catch(() => {});
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, me.id, members]);

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await fn();
      await load();
      if (done) flash(done);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  const own = shares?.find((s) => s.documentId === documentId);
  const inherited = shares?.find((s) => s.documentId !== documentId && s.published);
  const isPublic = !!own?.published;
  const workspaceAccess = collection?.permission === "read_write" ? t("workspaceCanEdit") : collection?.permission === "read" ? t("workspaceCanView") : t("workspaceNoAccess");

  return (
    <div className="share-panel" role="dialog" aria-label={t("share")}>
      {canInvite && (
        <div className="share-invite">
          <input
            ref={input}
            className="text-input"
            autoFocus
            placeholder={t("invitePlaceholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select value={newPermission} onChange={(e) => setNewPermission(e.target.value as DocumentPermission)} aria-label={t("permission")}>
            {PERMISSIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {t(label)}
              </option>
            ))}
          </select>
        </div>
      )}
      {results.length > 0 && (
        <div className="share-results">
          {results.map((u) => (
            <button
              key={u.id}
              className="share-row clickable"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await addDocumentUser(documentId, u.id, newPermission);
                  setQuery("");
                  input.current?.focus();
                }, t("invited", { name: u.name }))
              }
            >
              <Avatar user={u} size={26} />
              <span className="share-name">{u.name}</span>
              <span className="share-hint">{t("invite")}</span>
            </button>
          ))}
        </div>
      )}

      <div className="share-section-title">{t("whoHasAccess")}</div>
      <div className="share-row">
        <span className="share-icon">
          <Users size={16} />
        </span>
        <span className="share-name">
          {collection ? t("workspaceIn", { name: collection.name }) : t("workspace")}
          <span className="share-sub">{workspaceAccess}</span>
        </span>
      </div>
      {members === null ? (
        <div className="skeleton-rows small" />
      ) : (
        members.map(({ membership, user }) => (
          <div key={membership.id} className="share-row">
            <Avatar user={user} size={26} />
            <span className="share-name">
              {user.name}
              {user.id === me.id && <span className="share-sub">{t("you")}</span>}
            </span>
            {canInvite && user.id !== me.id ? (
              <select
                value={membership.permission}
                disabled={busy}
                aria-label={t("permission")}
                onChange={(e) => {
                  const value = e.target.value;
                  void act(() => (value === "remove" ? removeDocumentUser(documentId, user.id) : addDocumentUser(documentId, user.id, value as DocumentPermission)));
                }}
              >
                {PERMISSIONS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {t(label)}
                  </option>
                ))}
                <option value="remove">{t("removeAccess")}</option>
              </select>
            ) : (
              <span className="share-hint">{t(PERMISSIONS.find(([v]) => v === membership.permission)?.[1] ?? "canView")}</span>
            )}
          </div>
        ))
      )}

      <div className="share-section-title">{t("publicLink")}</div>
      <label className="share-row toggle">
        <span className="share-icon">
          <Globe size={16} />
        </span>
        <span className="share-name">
          {t("publishToWeb")}
          <span className="share-sub">{isPublic ? t("anyoneWithLink") : inherited ? t("sharedViaParent", { title: inherited.sourceTitle ?? "" }) : t("onlyPeopleWithAccess")}</span>
        </span>
        <input
          type="checkbox"
          className="switch"
          checked={isPublic}
          disabled={busy || shares === null || !canShare}
          onChange={(e) => {
            const on = e.target.checked;
            void act(() => (own ? updateShare(own.id, { published: on }) : createShare(documentId)), on ? t("nowPublic") : t("noLongerPublic"));
          }}
        />
      </label>
      {isPublic && own && (
        <>
          <div className="share-link">
            <input className="text-input" readOnly value={own.url} onFocus={(e) => e.target.select()} />
            <button
              className="icon-button"
              title={t("copyLink")}
              onClick={() => void navigator.clipboard?.writeText(own.url).then(() => flash(t("linkCopied")))}
            >
              <Copy size={15} />
            </button>
          </div>
          {canShare && (
            <>
              <label className="share-option">
                <span>{t("includeNested")}</span>
                <input
                  type="checkbox"
                  className="switch"
                  checked={own.includeChildDocuments}
                  disabled={busy}
                  onChange={(e) => void act(() => updateShare(own.id, { includeChildDocuments: e.target.checked }))}
                />
              </label>
              <label className="share-option">
                <span>{t("allowIndexing")}</span>
                <input
                  type="checkbox"
                  className="switch"
                  checked={own.allowIndexing}
                  disabled={busy}
                  onChange={(e) => void act(() => updateShare(own.id, { allowIndexing: e.target.checked }))}
                />
              </label>
            </>
          )}
        </>
      )}
    </div>
  );
}
