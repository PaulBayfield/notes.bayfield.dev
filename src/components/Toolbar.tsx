import { useEffect, useRef, useState, type ReactNode } from "react";
import type { User } from "../lib/api";
import type { PresenceUser } from "../editor/collab";
import type { EditorStatus } from "../editor/Editor";
import { isTauri, mod } from "../lib/platform";
import { useSettings } from "../lib/settings";
import { MenuList, type MenuEntry } from "./Menu";
import { Avatar, HoverCard, PresenceCard } from "./Avatar";
import { userDetails, type Collection } from "../lib/api";
import { EntityIcon } from "./EntityIcon";
import { ArrowLeft, ArrowRight, More, PanelLeft, PanelRight, Star, WinMaximize, WinMinimize, X } from "./icons";

export interface Crumb {
  label: string;
  onClick?: () => void;
}

interface Props {
  crumbs: Crumb[];
  showSidebarToggle: boolean;
  onToggleSidebar: () => void;
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
  status?: EditorStatus;
  presence: PresenceUser[];
  starred?: boolean;
  onToggleStar?: () => void;
  docMenu?: ReactNode;
  /** Shown for drafts. */
  publish?: ReactNode;
  share?: ReactNode;
  user: User;
  panelVisible: boolean;
  onTogglePanel: () => void;
  onOpenSettings: () => void;
  onSignOut: () => void;
}

export function Toolbar(p: Props) {
  const { t } = useSettings();
  return (
    <header className="toolbar" data-tauri-drag-region>
      {p.showSidebarToggle && (
        <button className="icon-button" title={`${t("toggleSidebar")} (${mod}+B)`} onClick={p.onToggleSidebar}>
          <PanelLeft />
        </button>
      )}
      <div className="button-group nav-buttons">
        <button className="icon-button" disabled={!p.canBack} title={`${t("back")} (Alt+←)`} onClick={p.onBack}>
          <ArrowLeft />
        </button>
        <button className="icon-button" disabled={!p.canForward} title={`${t("forward")} (Alt+→)`} onClick={p.onForward}>
          <ArrowRight />
        </button>
      </div>
      <nav className="crumbs" data-tauri-drag-region>
        {p.crumbs.map((c, i) => (
          <span key={i} className="crumb" data-tauri-drag-region={c.onClick ? undefined : true}>
            {i > 0 && <span className="crumb-sep">/</span>}
            {c.onClick ? (
              <button className="crumb-link" onClick={c.onClick}>
                {c.label}
              </button>
            ) : (
              <span className="crumb-current" data-tauri-drag-region>
                {c.label}
              </span>
            )}
          </span>
        ))}
      </nav>
      <StatusDot status={p.status} />
      <div className="toolbar-spacer" data-tauri-drag-region />
      <Presence users={p.presence} />
      {p.onToggleStar && (
        <button className={`icon-button${p.starred ? " active starred" : ""}`} title={t(p.starred ? "unstar" : "star")} onClick={p.onToggleStar}>
          <Star filled={p.starred} />
        </button>
      )}
      {p.share}
      {p.publish}
      {p.docMenu}
      <AccountMenu user={p.user} onOpenSettings={p.onOpenSettings} onSignOut={p.onSignOut} />
      <button
        className={`icon-button panel-toggle${p.panelVisible ? " active" : ""}`}
        title={`${t("togglePanel")} (.)`}
        aria-pressed={p.panelVisible}
        onClick={p.onTogglePanel}
      >
        <PanelRight />
      </button>
      {isTauri && !p.panelVisible && <WindowControls />}
    </header>
  );
}

function StatusDot({ status }: { status?: EditorStatus }) {
  const { t } = useSettings();
  if (!status || status === "connected" || status === "loading") return null;
  const label =
    status === "connecting"
      ? t("statusConnecting")
      : status === "offline"
        ? t("statusOffline")
        : status === "outdated"
          ? t("statusOutdated")
          : status === "denied"
            ? t("statusDenied")
            : t("readOnly");
  return (
    <span className={`status-dot ${status}`} title={label}>
      {status === "connecting" ? <span className="spinner" /> : <span className="dot" />}
      <span className="status-label">{status === "connecting" ? t("statusConnecting") : status === "offline" ? "Offline" : t("readOnly")}</span>
    </span>
  );
}

function PresenceAvatar({ user }: { user: PresenceUser }) {
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  useEffect(() => {
    void userDetails(user.id)
      .then((d) => setAvatarUrl(d.avatarUrl))
      .catch(() => {});
  }, [user.id]);
  return (
    <HoverCard card={() => <PresenceCard userId={user.id} name={user.name} color={user.color} status={user.editing ? "editing" : "viewing"} />}>
      <span className={`presence-avatar${user.editing ? " editing" : ""}`} style={{ ["--c" as string]: user.color }}>
        <Avatar user={{ name: user.name, color: user.color, avatarUrl }} size={24} />
      </span>
    </HoverCard>
  );
}

function Presence({ users }: { users: PresenceUser[] }) {
  if (!users.length) return null;
  return (
    <div className="presence">
      {users.slice(0, 5).map((u) => (
        <PresenceAvatar key={u.id} user={u} />
      ))}
      {users.length > 5 && <span className="presence-more">+{users.length - 5}</span>}
    </div>
  );
}

export function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return ref;
}

/**
 * Publishes a draft. A draft that isn't in a collection yet asks which one to publish it in.
 */
export function PublishButton({ collections, collectionId, onPublish }: { collections: Collection[]; collectionId: string | null; onPublish: (collectionId: string) => Promise<void> }) {
  const { t } = useSettings();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const publish = async (id: string) => {
    setOpen(false);
    setBusy(true);
    try {
      await onPublish(id);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="menu-anchor" ref={ref}>
      <button className="primary-button publish-button" disabled={busy} onClick={() => (collectionId ? void publish(collectionId) : setOpen(!open))}>
        {busy ? t("publishing") : t("publish")}
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-label">{t("publishIn")}</div>
          {collections.map((c) => (
            <button key={c.id} onClick={() => void publish(c.id)}>
              <span className="menu-item-icon">
                <EntityIcon icon={c.icon} color={c.color} size={16} fallback={<span className="collection-dot" style={{ ["--c" as string]: c.color ?? "var(--primary)" }} />} />
              </span>
              <span className="menu-item-label">{c.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** A "…" button with a dropdown. */
export function DropdownMenu({ items, title }: { items: MenuEntry[]; title: string }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  return (
    <div className="menu-anchor" ref={ref}>
      <button className={`icon-button${open ? " active" : ""}`} title={title} onClick={() => setOpen(!open)}>
        <More />
      </button>
      {open && (
        <div className="menu doc-menu" role="menu">
          <MenuList items={items} onClose={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

function AccountMenu(p: { user: User; onOpenSettings: () => void; onSignOut: () => void }) {
  const { t } = useSettings();
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  return (
    <div className="menu-anchor" ref={ref}>
      <button className="avatar" title={p.user.name} onClick={() => setOpen(!open)}>
        <Avatar user={p.user} size={26} />
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-label">{p.user.email ?? p.user.name}</div>
          <button
            onClick={() => {
              setOpen(false);
              p.onOpenSettings();
            }}
          >
            {t("settings")} <kbd>{mod}+,</kbd>
          </button>
          <button onClick={p.onSignOut}>{t("signOut")}</button>
        </div>
      )}
    </div>
  );
}

export function WindowControls() {
  const { t } = useSettings();
  const run = (action: "minimize" | "toggleMaximize" | "close") => async () => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow()[action]();
  };
  return (
    <div className="window-controls">
      <button aria-label={t("minimize")} onClick={run("minimize")}>
        <WinMinimize size={14} />
      </button>
      <button aria-label={t("maximize")} onClick={run("toggleMaximize")}>
        <WinMaximize size={12} />
      </button>
      <button className="close" aria-label={t("close")} onClick={run("close")}>
        <X size={14} />
      </button>
    </div>
  );
}
