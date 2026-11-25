// Who can open a collection: everyone in the workspace (its default permission), people and groups
// added to it, and its public link. Outline's collection "Share" / "Permissions" panel.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  addCollectionGroup,
  addCollectionUser,
  call,
  can,
  collectionGroupMemberships,
  collectionMemberships,
  collectionShareInfo,
  createCollectionShare,
  listGroups,
  listUsers,
  removeCollectionGroup,
  removeCollectionUser,
  revokeShare,
  updateCollection,
  updateShare,
  type Collection,
  type CollectionGroupMembership,
  type CollectionMembership,
  type CollectionPermission,
  type DocumentPermission,
  type Group,
  type Share,
  type User,
} from "../lib/api";
import { useSettings } from "../lib/settings";
import { Avatar } from "./Avatar";
import { Copy, Globe, Users } from "./icons";

const PERMISSIONS: [DocumentPermission, "canView" | "canEdit" | "canManage"][] = [
  ["read", "canView"],
  ["read_write", "canEdit"],
  ["admin", "canManage"],
];

interface Props {
  collection: Collection;
  me: User;
  onChanged: () => void;
  onError: (e: unknown) => void;
  flash: (message: string) => void;
}

export function CollectionAccessPanel({ collection, me, onChanged, onError, flash }: Props) {
  const { t } = useSettings();
  const [members, setMembers] = useState<{ membership: CollectionMembership; user: User }[] | null>(null);
  const [groups, setGroups] = useState<{ membership: CollectionGroupMembership; group: Group }[]>([]);
  const [share, setShare] = useState<Share | null>(null);
  const [everyone, setEveryone] = useState<CollectionPermission>((collection.permission as CollectionPermission) ?? null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<User[]>([]);
  const [groupResults, setGroupResults] = useState<Group[]>([]);
  const [newPermission, setNewPermission] = useState<DocumentPermission>("read_write");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // What the person may do here (the collection's policies): manage access, share it on the web.
  const [canManage, setCanManage] = useState(false);
  const [canShare, setCanShare] = useState(false);

  const load = useCallback(async () => {
    const [info, m, g, s] = await Promise.all([
      call("collections.info", { id: collection.id }).catch(() => null),
      collectionMemberships(collection.id).catch(() => ({ memberships: [], users: [] })),
      collectionGroupMemberships(collection.id).catch(() => ({ groupMemberships: [], groups: [] })),
      collectionShareInfo(collection.id).catch(() => null),
    ]);
    if (info) {
      setCanManage(can(info, collection.id, "update"));
      setCanShare(can(info, collection.id, "share"));
    }
    setMembers(m.memberships.map((membership) => ({ membership, user: m.users.find((u) => u.id === membership.userId)! })).filter((x) => x.user));
    setGroups(g.groupMemberships.map((membership) => ({ membership, group: g.groups.find((x) => x.id === membership.groupId)! })).filter((x) => x.group));
    setShare(s);
  }, [collection.id]);
  useEffect(() => void load().catch(onError), [load, onError]);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      setGroupResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      listUsers(query.trim(), 6)
        .then((users) => !cancelled && setResults(users.filter((u) => !members?.some((m) => m.user.id === u.id))))
        .catch(() => {});
      listGroups(query.trim(), 4)
        .then((list) => !cancelled && setGroupResults(list.filter((g) => !groups.some((m) => m.group.id === g.id))))
        .catch(() => {});
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, members, groups]);

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

  const memberCount = (g: Group) => (g.memberCount === 1 ? t("groupMember") : t("groupMembers", { count: g.memberCount }));
  const label = (p: DocumentPermission) => t(PERMISSIONS.find(([v]) => v === p)?.[1] ?? "canView");
  const permissionSelect = (value: DocumentPermission, onChange: (v: DocumentPermission | "remove") => void, removable = true) => (
    <select value={value} disabled={busy} aria-label={t("permission")} onChange={(e) => onChange(e.target.value as DocumentPermission | "remove")}>
      {PERMISSIONS.map(([v, l]) => (
        <option key={v} value={v}>
          {t(l)}
        </option>
      ))}
      {removable && <option value="remove">{t("removeAccess")}</option>}
    </select>
  );
  const isPublic = !!share?.published;

  return (
    <div className="share-panel embedded">
      {canManage && (
        <div className="share-invite">
          <input ref={input} className="text-input" autoFocus placeholder={t("invitePlaceholder")} value={query} onChange={(e) => setQuery(e.target.value)} />
          <select value={newPermission} onChange={(e) => setNewPermission(e.target.value as DocumentPermission)} aria-label={t("permission")}>
            {PERMISSIONS.map(([value, l]) => (
              <option key={value} value={value}>
                {t(l)}
              </option>
            ))}
          </select>
        </div>
      )}
      {(results.length > 0 || groupResults.length > 0) && (
        <div className="share-results">
          {groupResults.map((g) => (
            <button
              key={g.id}
              className="share-row clickable"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await addCollectionGroup(collection.id, g.id, newPermission);
                  setQuery("");
                  input.current?.focus();
                }, t("invited", { name: g.name }))
              }
            >
              <span className="share-icon">
                <Users size={15} />
              </span>
              <span className="share-name">
                {g.name}
                <span className="share-sub">{memberCount(g)}</span>
              </span>
              <span className="share-hint">{t("invite")}</span>
            </button>
          ))}
          {results.map((u) => (
            <button
              key={u.id}
              className="share-row clickable"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await addCollectionUser(collection.id, u.id, newPermission);
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
          {t("everyoneInWorkspace")}
          <span className="share-sub">{t("everyoneInWorkspaceHint")}</span>
        </span>
        {canManage ? (
          <select
            value={everyone ?? ""}
            disabled={busy}
            aria-label={t("permission")}
            onChange={(e) => {
              const value = (e.target.value || null) as CollectionPermission;
              setEveryone(value);
              void act(async () => {
                await updateCollection(collection.id, { permission: value });
                onChanged();
              });
            }}
          >
            <option value="">{t("noAccess")}</option>
            <option value="read">{t("canView")}</option>
            <option value="read_write">{t("canEdit")}</option>
          </select>
        ) : (
          <span className="share-hint">{everyone === "read_write" ? t("canEdit") : everyone === "read" ? t("canView") : t("noAccess")}</span>
        )}
      </div>
      {groups.map(({ membership, group }) => (
        <div key={membership.id} className="share-row">
          <span className="share-icon">
            <Users size={15} />
          </span>
          <span className="share-name">
            {group.name}
            <span className="share-sub">{memberCount(group)}</span>
          </span>
          {canManage
            ? permissionSelect(membership.permission, (v) => void act(() => (v === "remove" ? removeCollectionGroup(collection.id, group.id) : addCollectionGroup(collection.id, group.id, v))))
            : <span className="share-hint">{label(membership.permission)}</span>}
        </div>
      ))}
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
            {canManage && user.id !== me.id
              ? permissionSelect(membership.permission, (v) => void act(() => (v === "remove" ? removeCollectionUser(collection.id, user.id) : addCollectionUser(collection.id, user.id, v))))
              : <span className="share-hint">{label(membership.permission)}</span>}
          </div>
        ))
      )}

      {canShare && (
        <>
          <div className="share-section-title">{t("publicLink")}</div>
          <label className="share-row toggle">
            <span className="share-icon">
              <Globe size={16} />
            </span>
            <span className="share-name">
              {t("publishCollection")}
              <span className="share-sub">{isPublic ? t("anyoneWithLinkCollection") : t("onlyPeopleWithAccess")}</span>
            </span>
            <input
              type="checkbox"
              className="switch"
              checked={isPublic}
              disabled={busy || !canManage}
              onChange={(e) => {
                const on = e.target.checked;
                void act(
                  () => (share ? (on ? updateShare(share.id, { published: true }) : revokeShare(share.id)) : createCollectionShare(collection.id)),
                  on ? t("nowPublic") : t("noLongerPublic"),
                );
              }}
            />
          </label>
          {isPublic && share && (
            <>
              <div className="share-link">
                <input className="text-input" readOnly value={share.url} onFocus={(e) => e.target.select()} />
                <button className="icon-button" title={t("copyLink")} onClick={() => void navigator.clipboard?.writeText(share.url).then(() => flash(t("linkCopied")))}>
                  <Copy size={15} />
                </button>
              </div>
              {canManage && (
                <>
                  <label className="share-option">
                    <span>{t("allowIndexing")}</span>
                    <input type="checkbox" className="switch" checked={share.allowIndexing} disabled={busy} onChange={(e) => void act(() => updateShare(share.id, { allowIndexing: e.target.checked }))} />
                  </label>
                  <label className="share-option">
                    <span>{t("showLastUpdated")}</span>
                    <input type="checkbox" className="switch" checked={!!share.showLastUpdated} disabled={busy} onChange={(e) => void act(() => updateShare(share.id, { showLastUpdated: e.target.checked }))} />
                  </label>
                  <label className="share-option">
                    <span>{t("showToc")}</span>
                    <input type="checkbox" className="switch" checked={!!share.showTOC} disabled={busy} onChange={(e) => void act(() => updateShare(share.id, { showTOC: e.target.checked }))} />
                  </label>
                </>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
