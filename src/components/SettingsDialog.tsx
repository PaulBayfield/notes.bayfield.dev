import { useEffect, useMemo, useState, type ReactNode } from "react";
import { authInfo, can, type Envelope, type Team, type User } from "../lib/api";
import type { StringKey } from "../lib/i18n";
import { mod } from "../lib/platform";
import { APP_VERSION } from "../lib/updates";
import type { Route } from "../lib/router";
import { useSettings } from "../lib/settings";
import type { Workspace } from "../lib/workspace";
import { BellIcon, Building, Info, Keyboard, LayoutTemplate, LinkIcon, Shield, Sliders, Smile, Upload, User as UserIcon, Users, X } from "./icons";
import { Loading, PageHeader, SettingsPageContext, type SettingsContextValue } from "./settings/common";
import { AboutPage, NotificationsPage, PreferencesPage, ProfilePage } from "./settings/AccountPages";
import { DetailsPage, ExportPage, SecurityPage } from "./settings/WorkspacePages";
import { GroupsPage, UsersPage } from "./settings/PeoplePages";
import { EmojisPage, SharesPage, TemplatesPage } from "./settings/ContentPages";

export const SHORTCUTS: { keys: string[]; label: StringKey }[] = [
  { keys: [`${mod}+K`], label: "scSearch" },
  { keys: [`${mod}+N`], label: "scNewDoc" },
  { keys: [`${mod}+B`, "\\"], label: "scSidebar" },
  { keys: ["."], label: "scPanel" },
  { keys: ["Alt+←", "Alt+→"], label: "scBackForward" },
  { keys: [`${mod}+,`], label: "scSettings" },
  { keys: ["/"], label: "scBlocks" },
  { keys: ["@"], label: "scMention" },
  { keys: [":"], label: "scEmoji" },
  { keys: [`${mod}+K`], label: "scLink" },
  { keys: [`${mod}+Alt+M`], label: "scComment" },
  { keys: [`${mod}+B`, "I", "U"], label: "scFormat" },
  { keys: [`${mod}+D`, `${mod}+E`], label: "scStrike" },
  { keys: [`${mod}+Alt+1…4`], label: "scHeadings" },
  { keys: [`${mod}+Shift+7/8/9`], label: "scLists" },
  { keys: [`${mod}+Enter`], label: "scCheck" },
  { keys: ["Shift+Enter"], label: "scBreak" },
  { keys: [`${mod}+Click`], label: "scOpenLink" },
];

export function ShortcutList() {
  const { t } = useSettings();
  return (
    <div className="shortcut-list">
      {SHORTCUTS.map((s) => (
        <div key={s.label + s.keys.join()} className="shortcut">
          <span>{t(s.label)}</span>
          <span className="keys">
            {s.keys.map((k) => (
              <kbd key={k}>{k}</kbd>
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}

export type SettingsPage = "profile" | "preferences" | "notifications" | "shortcuts" | "details" | "security" | "users" | "groups" | "templates" | "emojis" | "shares" | "export" | "about";

interface NavItem {
  id: SettingsPage;
  label: StringKey;
  icon: ReactNode;
  /** Whether the signed-in user may see the page. */
  visible?: (can: (ability: string) => boolean, me: User) => boolean;
  page: () => ReactNode;
}

const ACCOUNT: NavItem[] = [
  { id: "profile", label: "profile", icon: <UserIcon />, page: () => <ProfilePage /> },
  { id: "preferences", label: "preferences", icon: <Sliders />, page: () => <PreferencesPage /> },
  { id: "notifications", label: "notifications", icon: <BellIcon />, page: () => <NotificationsPage /> },
  {
    id: "shortcuts",
    label: "shortcuts",
    icon: <Keyboard />,
    page: () => <ShortcutsPage />,
  },
  { id: "about", label: "about", icon: <Info />, page: () => <AboutPage /> },
];

const WORKSPACE: NavItem[] = [
  { id: "details", label: "details", icon: <Building />, visible: (can) => can("update"), page: () => <DetailsPage /> },
  { id: "security", label: "security", icon: <Shield />, visible: (can) => can("update"), page: () => <SecurityPage /> },
  // Shown exactly as Outline's own settings do, from the workspace abilities it grants.
  { id: "users", label: "users", icon: <UserIcon />, visible: (can) => can("listUsers"), page: () => <UsersPage /> },
  { id: "groups", label: "groups", icon: <Users />, visible: (can) => can("listGroups"), page: () => <GroupsPage /> },
  { id: "templates", label: "templates", icon: <LayoutTemplate />, visible: (can) => can("readTemplate"), page: () => <TemplatesPage /> },
  { id: "emojis", label: "emojis", icon: <Smile />, visible: (can) => can("update"), page: () => <EmojisPage /> },
  { id: "shares", label: "sharedLinks", icon: <LinkIcon />, visible: (can) => can("listShares"), page: () => <SharesPage /> },
  { id: "export", label: "exportTitle", icon: <Upload />, visible: (can) => can("createExport"), page: () => <ExportPage /> },
];

function ShortcutsPage() {
  const { t } = useSettings();
  return (
    <>
      <PageHeader title={t("shortcuts")} />
      <ShortcutList />
    </>
  );
}

interface Props {
  user: User;
  server: string;
  workspace: Workspace;
  page?: SettingsPage;
  onClose: () => void;
  onSignOut: () => void;
  /** The signed-in user's name or picture changed. */
  onUserChange: (patch: Partial<User>) => void;
  /** The workspace name or logo changed. */
  onTeamChange: (team: Team) => void;
  onNavigate: (route: Route) => void;
  flash: (message: string, action?: () => void, label?: string) => void;
  onError: (e: unknown) => void;
}

export function SettingsDialog(p: Props) {
  const { t } = useSettings();
  const [page, setPage] = useState<SettingsPage>(p.page ?? "preferences");
  const [auth, setAuth] = useState<{ me: User; team: Team; policies: Envelope<unknown> } | null>(null);
  const { onClose, onError } = p;

  useEffect(() => {
    authInfo().then(
      (res) => setAuth({ me: res.data.user, team: res.data.team, policies: res }),
      (e) => {
        onError(e);
        onClose();
      },
    );
  }, [onClose, onError]);

  useEffect(() => {
    // Escape closes the settings, unless a dialog or menu on top of them handles it first.
    const onKey = (e: KeyboardEvent) =>
      e.key === "Escape" && !e.defaultPrevented && document.querySelectorAll(".dialog-backdrop").length === 1 && !document.querySelector(".settings-modal .menu") && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const context = useMemo<SettingsContextValue | null>(
    () =>
      auth && {
        ...auth,
        server: p.server,
        workspace: p.workspace,
        setMe: (patch) => {
          setAuth((a) => a && { ...a, me: { ...a.me, ...patch } });
          p.onUserChange(patch);
        },
        setTeam: (team) => {
          setAuth((a) => a && { ...a, team });
          p.onTeamChange(team);
        },
        flash: p.flash,
        onError: p.onError,
        onNavigate: (route) => {
          p.onClose();
          p.onNavigate(route);
        },
        onSignOut: p.onSignOut,
      },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [auth, p.server, p.workspace],
  );

  const teamCan = (ability: string) => !!auth && can(auth.policies, auth.team.id, ability);
  const me = auth?.me ?? p.user;
  const workspaceItems = auth ? WORKSPACE.filter((i) => !i.visible || i.visible(teamCan, me)) : [];
  const current = [...ACCOUNT, ...workspaceItems].find((i) => i.id === page) ?? ACCOUNT[1];

  const nav = (items: NavItem[]) =>
    items.map((i) => (
      <button key={i.id} className={`settings-nav-item${current.id === i.id ? " active" : ""}`} onClick={() => setPage(i.id)}>
        {i.icon}
        <span>{t(i.label)}</span>
      </button>
    ));

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="settings-modal" role="dialog" aria-label={t("settings")}>
        <nav className="settings-nav">
          <div className="settings-nav-label">{t("account")}</div>
          {nav(ACCOUNT)}
          {workspaceItems.length > 0 && (
            <>
              <div className="settings-nav-label">{auth?.team.name ?? t("workspace")}</div>
              {nav(workspaceItems)}
            </>
          )}
          <button className="settings-version" onClick={() => setPage("about")}>
            {t("versionLabel", { version: APP_VERSION })}
          </button>
        </nav>
        <div className="settings-content">
          <button className="icon-button small settings-close" aria-label={t("close")} onClick={onClose}>
            <X />
          </button>
          <div className="settings-page" key={current.id}>
            {context ? <SettingsPageContext.Provider value={context}>{current.page()}</SettingsPageContext.Provider> : <Loading />}
          </div>
        </div>
      </div>
    </div>
  );
}
