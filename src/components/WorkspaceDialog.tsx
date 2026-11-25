import { useEffect, useState } from "react";
import { forgetWorkspace, host, listAccounts, savedSessions, switchWorkspace, type Account } from "../lib/accounts";
import { authInfo, call, can } from "../lib/api";
import type { Session } from "../lib/auth";
import { availableTeams, createTeam, type AvailableTeam } from "../lib/integrations";
import { isTauri } from "../lib/platform";
import { useSettings } from "../lib/settings";
import { Avatar } from "./Avatar";
import { Dialog } from "./Dialogs";
import { Plus, Settings, X } from "./icons";

interface Props {
  session: Session;
  onClose: () => void;
  onOpenSettings: () => void;
  /** Sign in to another workspace; `server` when it's a known one (signed out, or on this server). */
  onAdd: (server?: string) => void;
  onSignOut: () => void;
  onError: (e: unknown) => void;
}

const origin = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
};

/** A workspace address from a name: "Famille Martin" → "famille-martin". */
const slug = (name: string) =>
  name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);

function NewWorkspaceDialog({ session, onClose, onCreated, onError }: { session: Session; onClose: () => void; onCreated: (url: string, transferUrl: string) => void; onError: (e: unknown) => void }) {
  const { t } = useSettings();
  const [name, setName] = useState("");
  const [subdomain, setSubdomain] = useState("");
  const [busy, setBusy] = useState(false);
  const address = subdomain || slug(name);
  // Where workspaces live on this server: "<address>.<workspaceDomain>".
  const [domain, setDomain] = useState(host(session.server));
  useEffect(() => {
    void call<{ workspaceDomain?: string }>("auth.config")
      .then((r) => r.data.workspaceDomain && setDomain(r.data.workspaceDomain))
      .catch(() => {});
  }, []);

  const submit = async () => {
    setBusy(true);
    try {
      const { team, transferUrl } = await createTeam({ name: name.trim(), subdomain: address || undefined });
      onCreated(team.url, transferUrl);
    } catch (e) {
      onError(e);
      setBusy(false);
    }
  };

  return (
    <Dialog title={t("newWorkspace")} onClose={onClose}>
      <p className="dialog-text">{t("newWorkspaceHint")}</p>
      <form
        className="settings-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && address) void submit();
        }}
      >
        <label>
          <span>{t("nameLabel")}</span>
          <input className="text-field" autoFocus value={name} maxLength={255} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          <span>
            {t("workspaceAddress")}
            <span className="settings-hint">{t("workspaceAddressHint", { address: `${address || "…"}.${domain}` })}</span>
          </span>
          <input className="text-field mono" value={address} maxLength={63} placeholder={slug(name) || "team"} onChange={(e) => setSubdomain(slug(e.target.value))} />
        </label>
        <div className="dialog-actions">
          <button type="button" className="text-button" onClick={onClose}>
            {t("cancel")}
          </button>
          <button className="primary-button" disabled={busy || !name.trim() || !address}>
            {busy ? <span className="spinner" /> : t("create")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** The workspaces used on this device and the person's others on this server: switch, add, create, or sign out. */
export function WorkspaceDialog({ session, onClose, onOpenSettings, onAdd, onSignOut, onError }: Props) {
  const { t } = useSettings();
  const [others, setOthers] = useState<Account[]>(() => (isTauri ? listAccounts().filter((a) => a.server !== session.server) : []));
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [switching, setSwitching] = useState<string | null>(null);
  const [onServer, setOnServer] = useState<AvailableTeam[]>([]);
  const [canCreate, setCanCreate] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    void savedSessions().then(setSaved);
    // The person's other workspaces here (also on Outline's cloud), and whether they may create one.
    void availableTeams()
      .then((teams) => setOnServer(teams.filter((w) => w.id !== session.team.id)))
      .catch(() => {});
    void authInfo()
      .then((env) => setCanCreate(can(env, session.team.id, "createTeam")))
      .catch(() => {});
  }, [session.team.id]);

  const known = new Set([session.server, ...others.map((a) => a.server)].map(origin));
  const extra = onServer.filter((w) => !known.has(origin(w.url)));

  const pick = async (a: Account) => {
    if (!saved.has(a.server)) return onAdd(a.server);
    setSwitching(a.server);
    try {
      await switchWorkspace(a.server);
    } catch (e) {
      setSwitching(null);
      setSaved((s) => new Set([...s].filter((x) => x !== a.server)));
      onError(e);
    }
  };

  /** Another workspace of this server: the browser goes there; the desktop app signs in to it. */
  const open = (url: string) => {
    if (isTauri) onAdd(origin(url));
    else location.href = url;
  };

  const remove = async (a: Account) => {
    try {
      await forgetWorkspace(a.server);
      setOthers((list) => list.filter((x) => x.server !== a.server));
    } catch (e) {
      onError(e);
    }
  };

  return (
    <Dialog title={t("workspaces")} onClose={onClose}>
      {isTauri && <p className="dialog-text">{t("workspacesHint")}</p>}
      <div className="workspace-list">
        <div className="workspace-item current">
          <div className="workspace-pick">
            <Avatar user={{ name: session.team.name, color: "var(--primary)", avatarUrl: session.team.avatarUrl }} size={32} className="square" />
            <span className="workspace-text">
              <span className="workspace-name">{session.team.name}</span>
              <span className="workspace-host">{session.user.email ? `${host(session.server)} · ${session.user.email}` : host(session.server)}</span>
            </span>
            <span className="badge">{t("currentWorkspace")}</span>
          </div>
          <button className="icon-button small" title={t("workspaceSettings")} aria-label={t("workspaceSettings")} onClick={onOpenSettings}>
            <Settings size={14} />
          </button>
        </div>
        {others.map((a) => (
          <div key={a.server} className="workspace-item">
            <button className="workspace-pick" disabled={switching !== null} onClick={() => void pick(a)}>
              <Avatar user={{ name: a.name, color: "var(--primary)", avatarUrl: a.logo }} size={32} className="square" />
              <span className="workspace-text">
                <span className="workspace-name">{a.name}</span>
                <span className="workspace-host">{a.userEmail ? `${host(a.server)} · ${a.userEmail}` : host(a.server)}</span>
              </span>
              {switching === a.server ? <span className="spinner" /> : !saved.has(a.server) && <span className="badge">{t("signedOutWorkspace")}</span>}
            </button>
            <button className="icon-button small" title={t("removeWorkspace")} aria-label={t("removeWorkspace")} disabled={switching !== null} onClick={() => void remove(a)}>
              <X size={14} />
            </button>
          </div>
        ))}
        {extra.length > 0 && <div className="settings-nav-label workspace-section">{t("yourOtherWorkspaces")}</div>}
        {extra.map((w) => (
          <div key={w.id} className="workspace-item">
            <button className="workspace-pick" onClick={() => open(w.url)}>
              <Avatar user={{ name: w.name, color: "var(--primary)", avatarUrl: w.avatarUrl }} size={32} className="square" />
              <span className="workspace-text">
                <span className="workspace-name">{w.name}</span>
                <span className="workspace-host">{host(origin(w.url))}</span>
              </span>
              <span className="badge">{t("open")}</span>
            </button>
          </div>
        ))}
      </div>
      <div className="dialog-actions workspace-actions">
        <button className="text-button" onClick={onSignOut}>
          {t("signOutOf", { name: session.team.name })}
        </button>
        <span className="toolbar-spacer" />
        {canCreate && (
          <button className="text-button" onClick={() => setCreating(true)}>
            <Plus size={14} />
            {t("newWorkspace")}
          </button>
        )}
        {isTauri && (
          <button className="primary-button" onClick={() => onAdd()}>
            <Plus size={14} />
            {t("addWorkspace")}
          </button>
        )}
      </div>
      {creating && (
        <NewWorkspaceDialog
          session={session}
          onClose={() => setCreating(false)}
          onError={onError}
          onCreated={(url, transferUrl) => {
            setCreating(false);
            // The browser signs in there with the one-time link; the desktop app through the provider.
            if (isTauri) onAdd(origin(url));
            else location.href = transferUrl;
          }}
        />
      )}
    </Dialog>
  );
}
