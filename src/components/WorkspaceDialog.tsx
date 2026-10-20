import { useEffect, useState } from "react";
import { forgetWorkspace, host, listAccounts, savedSessions, switchWorkspace, type Account } from "../lib/accounts";
import type { Session } from "../lib/auth";
import { isTauri } from "../lib/platform";
import { useSettings } from "../lib/settings";
import { Avatar } from "./Avatar";
import { Dialog } from "./Dialogs";
import { Plus, Settings, X } from "./icons";

interface Props {
  session: Session;
  onClose: () => void;
  onOpenSettings: () => void;
  /** Sign in to another workspace; `server` when it's one from the list that was signed out. */
  onAdd: (server?: string) => void;
  onSignOut: () => void;
  onError: (e: unknown) => void;
}

/** The workspaces used on this device: switch between them, add one, or sign out. */
export function WorkspaceDialog({ session, onClose, onOpenSettings, onAdd, onSignOut, onError }: Props) {
  const { t } = useSettings();
  const [others, setOthers] = useState<Account[]>(() => (isTauri ? listAccounts().filter((a) => a.server !== session.server) : []));
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [switching, setSwitching] = useState<string | null>(null);
  useEffect(() => {
    void savedSessions().then(setSaved);
  }, []);

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
      </div>
      <div className="dialog-actions workspace-actions">
        <button className="text-button" onClick={onSignOut}>
          {t("signOutOf", { name: session.team.name })}
        </button>
        <span className="toolbar-spacer" />
        {isTauri && (
          <button className="primary-button" onClick={() => onAdd()}>
            <Plus size={14} />
            {t("addWorkspace")}
          </button>
        )}
      </div>
    </Dialog>
  );
}
