// The bell in the header: Outline's latest notifications, with an unread badge.

import { useCallback, useEffect, useState } from "react";
import { listNotifications, markAllNotificationsRead, markNotificationRead, type AppNotification } from "../lib/api";
import type { StringKey } from "../lib/i18n";
import { onRealtime } from "../lib/realtime";
import type { Route } from "../lib/router";
import { useSettings } from "../lib/settings";
import { Avatar } from "./Avatar";
import { useDismiss } from "./Toolbar";
import { BellIcon, Check } from "./icons";

export type BadgeStyle = "count" | "indicator" | "disabled";

const EVENT_TEXT: Record<string, StringKey> = {
  "documents.publish": "evPublished",
  "documents.update": "evEdited",
  "revisions.create": "evEdited",
  "collections.create": "evCreatedCollection",
  "documents.mentioned": "evMentioned",
  "comments.mentioned": "evMentioned",
  "documents.group_mentioned": "evGroupMentioned",
  "comments.group_mentioned": "evGroupMentioned",
  "comments.create": "evCommented",
  "comments.resolve": "evResolved",
  "reactions.create": "evReacted",
  "documents.add_user": "evShared",
  "collections.add_user": "evInvitedTo",
  "groups.add_user": "evAddedToGroup",
  "groups.remove_user": "evRemovedFromGroup",
  "access_requests.create": "evRequestedAccess",
  "emails.invite_accepted": "evInviteAccepted",
};

interface Props {
  badge: BadgeStyle;
  collectionName: (id: string) => string | undefined;
  onNavigate: (route: Route) => void;
  /** A comment notification: open the page with that comment showing. */
  onOpenComment: (documentId: string, commentId: string) => void;
  onError: (e: unknown) => void;
}

export function NotificationsButton({ badge, collectionName, onNavigate, onOpenComment, onError }: Props) {
  const { t, f } = useSettings();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<AppNotification[] | null>(null);
  const [unseen, setUnseen] = useState(0);
  const ref = useDismiss(open, () => setOpen(false));

  const load = useCallback(() => {
    listNotifications(30).then(
      (r) => {
        setItems(r.notifications);
        setUnseen(r.unseen);
      },
      () => setItems((x) => x ?? []),
    );
  }, []);

  useEffect(() => {
    load();
    const stop = onRealtime(({ event }) => {
      if (event === "notifications.create" || event === "notifications.update" || event === "connected") load();
    });
    // A safety net in case a live event was missed.
    const timer = setInterval(load, 5 * 60 * 1000);
    return () => {
      stop();
      clearInterval(timer);
    };
  }, [load]);

  const unread = unseen;

  const subject = (n: AppNotification) => {
    if (n.event === "collections.create" || n.event === "collections.add_user") return (n.collectionId && collectionName(n.collectionId)) || t("aCollection");
    if (n.event === "groups.add_user" || n.event === "groups.remove_user") return n.group?.name ?? t("aGroup");
    if (n.event === "emails.invite_accepted") return "";
    return n.document?.title || t("aDocument");
  };

  const openItem = (n: AppNotification) => {
    setOpen(false);
    if (!n.viewedAt) {
      setUnseen((u) => Math.max(0, u - 1));
      setItems((list) => list?.map((x) => (x.id === n.id ? { ...x, viewedAt: new Date().toISOString() } : x)) ?? null);
      markNotificationRead(n.id).catch(onError);
    }
    if (n.documentId && n.commentId) onOpenComment(n.documentId, n.commentId);
    else if (n.documentId) onNavigate({ name: "doc", id: n.documentId });
    else if (n.collectionId) onNavigate({ name: "collection", id: n.collectionId });
  };

  const readAll = () => {
    const now = new Date().toISOString();
    setUnseen(0);
    setItems((list) => list?.map((x) => ({ ...x, viewedAt: x.viewedAt ?? now })) ?? null);
    markAllNotificationsRead().catch(onError);
  };

  return (
    <div className="menu-anchor" ref={ref}>
      <button
        className={`icon-button notifications-button${open ? " active" : ""}`}
        title={t("notifications")}
        aria-label={unread ? `${t("notifications")} (${unread})` : t("notifications")}
        onClick={() => {
          if (!open) load();
          setOpen(!open);
        }}
      >
        <BellIcon />
        {unread > 0 && badge === "count" && <span className="notification-count">{unread > 99 ? "99+" : unread}</span>}
        {unread > 0 && badge === "indicator" && <span className="notification-dot" />}
      </button>
      {open && (
        <div className="menu notifications-popover" role="dialog" aria-label={t("notifications")}>
          <div className="notifications-header">
            <strong>{t("notifications")}</strong>
            {unread > 0 && (
              <button className="link-button with-icon" onClick={readAll}>
                <Check size={14} /> {t("markAllRead")}
              </button>
            )}
          </div>
          <div className="notifications-list">
            {items === null ? (
              <div className="skeleton-rows" />
            ) : items.length === 0 ? (
              <p className="muted notifications-empty">{t("notificationsEmpty")}</p>
            ) : (
              items.map((n) => {
                const actor = n.actor?.name ?? t("someone");
                const text = n.event === "emails.export_completed" ? t("evExport") : EVENT_TEXT[n.event] ? t(EVENT_TEXT[n.event], { emoji: n.data?.emoji ?? "" }) : n.event;
                return (
                  <button key={n.id} className={`notification-item${n.viewedAt ? "" : " unread"}`} onClick={() => openItem(n)}>
                    {n.actor ? <Avatar user={n.actor} size={28} /> : <span className="notification-icon"><BellIcon size={14} /></span>}
                    <span className="notification-text">
                      <span>
                        {n.event !== "emails.export_completed" && <strong>{actor} </strong>}
                        {text} {subject(n) && <strong>{subject(n)}</strong>}
                      </span>
                      <span className="settings-hint">{f.relative(n.createdAt)}</span>
                    </span>
                    {!n.viewedAt && <span className="notification-dot inline" />}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
