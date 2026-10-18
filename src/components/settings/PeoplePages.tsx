import { useEffect, useState } from "react";
import {
  activateUser,
  addGroupUser,
  can,
  createGroup,
  deleteGroup,
  groupMembers,
  inviteUsers,
  listAllGroups,
  listMembers,
  listUsers,
  removeGroupUser,
  resendInvite,
  setUserRole,
  suspendUser,
  updateGroup,
  type Envelope,
  type GroupDetails,
  type Member,
  type MemberFilter,
  type User,
  type UserRole,
} from "../../lib/api";
import { useSettings } from "../../lib/settings";
import { Avatar } from "../Avatar";
import { ConfirmDialog, Dialog } from "../Dialogs";
import { DropdownMenu } from "../Toolbar";
import { ArrowLeft, Plus, Search, X } from "../icons";
import { Empty, Loading, PageHeader, Select, usePage } from "./common";

const PAGE = 50;

export function UsersPage() {
  const { t, f } = useSettings();
  const { me, teamCan, flash, onError } = usePage();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<MemberFilter>("active");
  const [result, setResult] = useState<{ env: Envelope<Member[]>; users: Member[] } | null>(null);
  const [inviting, setInviting] = useState(false);
  const isAdmin = me.role === "admin";

  const load = async (offset: number) => {
    try {
      const env = await listMembers(query, filter, offset, PAGE);
      const users = env.data ?? [];
      setResult((prev) => ({
        env: { ...env, policies: [...(offset && prev ? (prev.env.policies ?? []) : []), ...(env.policies ?? [])] },
        users: offset && prev ? [...prev.users, ...users] : users,
      }));
    } catch (e) {
      onError(e);
    }
  };
  useEffect(() => {
    const timer = setTimeout(() => void load(0), query ? 250 : 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, filter]);

  const replace = (user: Member) => setResult((r) => r && { ...r, users: r.users.map((u) => (u.id === user.id ? { ...u, ...user } : u)) });
  const act = async (run: () => Promise<Member | unknown>, message: string) => {
    try {
      const user = await run();
      if (user && typeof user === "object" && "id" in user) replace(user as Member);
      flash(message);
    } catch (e) {
      onError(e);
    }
  };

  const roles: [UserRole, string][] = [
    ["admin", t("roleAdmin")],
    ["member", t("roleMember")],
    ["viewer", t("roleViewer")],
    ["guest", t("roleGuest")],
  ];

  return (
    <>
      <PageHeader title={t("users")} hint={t("usersHint")}>
        {teamCan("inviteUser") && (
          <button className="primary-button with-icon" onClick={() => setInviting(true)}>
            <Plus size={14} /> {t("invitePeople")}
          </button>
        )}
      </PageHeader>
      <div className="settings-toolbar">
        <label className="settings-search">
          <Search size={14} />
          <input className="text-field" placeholder={t("searchPeople")} value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <Select<MemberFilter>
          value={filter}
          onChange={setFilter}
          options={[
            ["active", t("filterActive")],
            ["all", t("filterAll")],
            ["admins", t("filterAdmins")],
            ["members", t("filterMembers")],
            ["viewers", t("filterViewers")],
            ["invited", t("filterInvited")],
            ...(isAdmin ? ([["suspended", t("filterSuspended")]] as [MemberFilter, string][]) : []),
          ]}
        />
      </div>
      {!result ? (
        <Loading />
      ) : result.users.length === 0 ? (
        <Empty>{t("noResults")}</Empty>
      ) : (
        <div className="settings-list">
          {result.users.map((u) => {
            const abilities = (ability: string) => can(result.env, u.id, ability);
            const invited = !u.lastActiveAt;
            const menu = [
              ...(invited && abilities("resendInvite") ? [{ label: t("resendInvite"), onClick: () => void act(() => resendInvite(u.id), t("inviteSent")) }] : []),
              ...(u.isSuspended
                ? abilities("activate")
                  ? [{ label: t("activate"), onClick: () => void act(() => activateUser(u.id), t("userActivated", { name: u.name })) }]
                  : []
                : abilities("suspend") && u.id !== me.id
                  ? [{ label: t("suspend"), danger: true, onClick: () => void act(() => suspendUser(u.id), t("userSuspended", { name: u.name })) }]
                  : []),
            ];
            return (
              <div key={u.id} className={`settings-item${u.isSuspended ? " faded" : ""}`}>
                <Avatar user={u} size={32} />
                <div className="settings-item-text">
                  <span className="settings-item-title">
                    {u.name}
                    {u.id === me.id && <span className="muted"> · {t("you")}</span>}
                  </span>
                  <span className="settings-hint">{u.email ?? ""}</span>
                </div>
                <span className="settings-item-meta">
                  {u.isSuspended ? t("suspendedTag") : invited ? t("notSignedInYet") : u.lastActiveAt ? f.relative(u.lastActiveAt) : ""}
                </span>
                {isAdmin && u.id !== me.id ? (
                  <Select<UserRole> value={(u.role ?? "member") as UserRole} options={roles} onChange={(role) => void act(() => setUserRole(u.id, role), t("roleChanged"))} />
                ) : (
                  <span className="role-tag">{roles.find(([r]) => r === u.role)?.[1] ?? ""}</span>
                )}
                {menu.length > 0 ? <DropdownMenu title={t("more")} items={menu} /> : <span className="icon-button-placeholder" />}
              </div>
            );
          })}
          {result.users.length % PAGE === 0 && (
            <button className="text-button load-more" onClick={() => void load(result.users.length)}>
              {t("loadMore")}
            </button>
          )}
        </div>
      )}
      {inviting && (
        <InviteDialog
          canAdmin={isAdmin}
          onClose={() => setInviting(false)}
          onSent={() => {
            flash(t("invitesSent"));
            void load(0);
          }}
        />
      )}
    </>
  );
}

function InviteDialog({ canAdmin, onClose, onSent }: { canAdmin: boolean; onClose: () => void; onSent: () => void }) {
  const { t } = useSettings();
  const { onError } = usePage();
  const blank = { email: "", name: "", role: "member" as UserRole };
  const [rows, setRows] = useState([blank]);
  const [busy, setBusy] = useState(false);
  const valid = rows.filter((r) => /\S+@\S+\.\S+/.test(r.email));
  const set = (i: number, patch: Partial<typeof blank>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const roles: [UserRole, string][] = [
    ...(canAdmin ? ([["admin", t("roleAdmin")]] as [UserRole, string][]) : []),
    ["member", t("roleMember")],
    ["viewer", t("roleViewer")],
    ["guest", t("roleGuest")],
  ];
  return (
    <Dialog title={t("invitePeople")} onClose={onClose}>
      <form
        className="invite-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await inviteUsers(valid.map((r) => ({ ...r, name: r.name.trim() || r.email.split("@")[0] })));
            onSent();
            onClose();
          } catch (err) {
            onError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        {rows.map((r, i) => (
          <div key={i} className="invite-row">
            <input className="text-field" type="email" placeholder={t("emailLabel")} autoFocus={i === rows.length - 1} value={r.email} onChange={(e) => set(i, { email: e.target.value })} />
            <input className="text-field" placeholder={t("nameLabel")} value={r.name} onChange={(e) => set(i, { name: e.target.value })} />
            <Select<UserRole> value={r.role} options={roles} onChange={(role) => set(i, { role })} />
          </div>
        ))}
        <div className="dialog-actions">
          <button type="button" className="text-button with-icon" onClick={() => setRows((rs) => [...rs, blank])}>
            <Plus size={14} /> {t("addAnother")}
          </button>
          <div className="toolbar-spacer" />
          <button type="button" className="text-button" onClick={onClose}>
            {t("cancel")}
          </button>
          <button className="primary-button" disabled={busy || !valid.length}>
            {t("sendInvites")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function GroupsPage() {
  const { t } = useSettings();
  const { teamCan, onError } = usePage();
  const [env, setEnv] = useState<Envelope<{ groups: GroupDetails[] }> | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);

  const load = () => listAllGroups().then(setEnv, onError);
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const groups = env?.data?.groups ?? [];
  const group = groups.find((g) => g.id === open);
  if (group && env)
    return (
      <GroupDetail
        group={group}
        canUpdate={can(env, group.id, "update")}
        canDelete={can(env, group.id, "delete")}
        onBack={() => setOpen(null)}
        onChanged={() => void load()}
        onDeleted={() => {
          setOpen(null);
          void load();
        }}
      />
    );

  return (
    <>
      <PageHeader title={t("groups")} hint={t("groupsHint")}>
        {teamCan("createGroup") && (
          <button className="primary-button with-icon" onClick={() => setNaming(true)}>
            <Plus size={14} /> {t("newGroup")}
          </button>
        )}
      </PageHeader>
      {!env ? (
        <Loading />
      ) : groups.length === 0 ? (
        <Empty>{t("noGroups")}</Empty>
      ) : (
        <div className="settings-list">
          {groups.map((g) => (
            <button key={g.id} className="settings-item clickable" onClick={() => setOpen(g.id)}>
              <span className="group-badge">{g.name.charAt(0).toUpperCase()}</span>
              <div className="settings-item-text">
                <span className="settings-item-title">{g.name}</span>
                {g.description && <span className="settings-hint">{g.description}</span>}
              </div>
              <span className="settings-item-meta">{g.memberCount === 1 ? t("groupMember") : t("groupMembers", { count: g.memberCount })}</span>
            </button>
          ))}
        </div>
      )}
      {naming && (
        <NameDialog
          title={t("newGroup")}
          label={t("groupName")}
          onClose={() => setNaming(false)}
          onSubmit={async (name) => {
            const g = await createGroup(name);
            await load();
            setOpen(g.id);
          }}
        />
      )}
    </>
  );
}

export function NameDialog({ title, label, initial = "", onClose, onSubmit }: { title: string; label: string; initial?: string; onClose: () => void; onSubmit: (name: string) => Promise<void> }) {
  const { t } = useSettings();
  const { onError } = usePage();
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog title={title} onClose={onClose}>
      <form
        className="settings-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await onSubmit(name.trim());
            onClose();
          } catch (err) {
            onError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <input className="text-field" autoFocus placeholder={label} aria-label={label} value={name} maxLength={255} onChange={(e) => setName(e.target.value)} />
        <div className="dialog-actions">
          <button type="button" className="text-button" onClick={onClose}>
            {t("cancel")}
          </button>
          <button className="primary-button" disabled={busy || !name.trim()}>
            {t("save")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function GroupDetail({
  group,
  canUpdate,
  canDelete,
  onBack,
  onChanged,
  onDeleted,
}: {
  group: GroupDetails;
  canUpdate: boolean;
  canDelete: boolean;
  onBack: () => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const { t } = useSettings();
  const { flash, onError } = usePage();
  const [members, setMembers] = useState<{ users: User[]; admins: Set<string> } | null>(null);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<User[]>([]);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = () =>
    groupMembers(group.id).then(
      (d) => setMembers({ users: d.users, admins: new Set(d.groupMemberships.filter((m) => m.permission === "admin").map((m) => m.userId)) }),
      onError,
    );
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group.id]);
  useEffect(() => {
    if (!query.trim()) return setMatches([]);
    const timer = setTimeout(() => listUsers(query, 6).then(setMatches, onError), 200);
    return () => clearTimeout(timer);
  }, [query, onError]);

  const change = async (run: () => Promise<unknown>) => {
    try {
      await run();
      await load();
      onChanged();
    } catch (e) {
      onError(e);
    }
  };
  const inGroup = new Set(members?.users.map((u) => u.id));

  return (
    <>
      <PageHeader title={group.name} hint={group.memberCount === 1 ? t("groupMember") : t("groupMembers", { count: group.memberCount })}>
        <button className="text-button with-icon" onClick={onBack}>
          <ArrowLeft size={14} /> {t("back")}
        </button>
        {(canUpdate || canDelete) && (
          <DropdownMenu
            title={t("more")}
            items={[
              ...(canUpdate ? [{ label: t("rename"), onClick: () => setRenaming(true) }] : []),
              ...(canDelete ? [{ label: t("deleteGroup"), danger: true, onClick: () => setDeleting(true) }] : []),
            ]}
          />
        )}
      </PageHeader>
      {canUpdate && (
        <div className="menu-anchor settings-search-anchor">
          <label className="settings-search">
            <Plus size={14} />
            <input className="text-field" placeholder={t("addMember")} value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          {matches.length > 0 && (
            <div className="menu suggestions" role="listbox">
              {matches.map((u) => (
                <button
                  key={u.id}
                  disabled={inGroup.has(u.id)}
                  onClick={() => {
                    setQuery("");
                    void change(() => addGroupUser(group.id, u.id));
                  }}
                >
                  <Avatar user={u} size={20} />
                  <span className="menu-item-label">{u.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {!members ? (
        <Loading />
      ) : members.users.length === 0 ? (
        <Empty>{t("noMembers")}</Empty>
      ) : (
        <div className="settings-list">
          {members.users.map((u) => (
            <div key={u.id} className="settings-item">
              <Avatar user={u} size={28} />
              <div className="settings-item-text">
                <span className="settings-item-title">{u.name}</span>
              </div>
              {members.admins.has(u.id) && <span className="role-tag">{t("groupAdmin")}</span>}
              {canUpdate && (
                <button className="icon-button small" title={t("removeAccess")} onClick={() => void change(() => removeGroupUser(group.id, u.id))}>
                  <X size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {renaming && (
        <NameDialog
          title={t("rename")}
          label={t("groupName")}
          initial={group.name}
          onClose={() => setRenaming(false)}
          onSubmit={async (name) => {
            await updateGroup(group.id, { name });
            onChanged();
            flash(t("saved"));
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={t("deleteGroup")}
          message={t("deleteGroupMessage", { name: group.name })}
          confirm={t("delete")}
          danger
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            try {
              await deleteGroup(group.id);
              onDeleted();
            } catch (e) {
              onError(e);
            }
          }}
        />
      )}
    </>
  );
}
