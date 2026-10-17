import { useEffect, useRef, useState } from "react";
import { documentActivity, resolveUrl, userDetails, type User, type UserDetails } from "../lib/api";
import { useSettings } from "../lib/settings";
import { Clock, Eye, Pencil } from "./icons";

/** A user's picture, or their initial on their colour. */
export function Avatar({ user, size = 24, className = "" }: { user: Pick<User, "name" | "color" | "avatarUrl">; size?: number; className?: string }) {
  const [broken, setBroken] = useState(false);
  const style = { width: size, height: size, fontSize: Math.round(size * 0.45), background: user.color };
  if (user.avatarUrl && !broken)
    return <img className={`avatar-img ${className}`} src={resolveUrl(user.avatarUrl)} alt="" style={style} onError={() => setBroken(true)} draggable={false} />;
  return (
    <span className={`avatar-initial ${className}`} style={style}>
      {user.name.charAt(0).toUpperCase()}
    </span>
  );
}

const ROLE_LABELS: Record<string, "roleAdmin" | "roleMember" | "roleViewer" | "roleGuest"> = {
  admin: "roleAdmin",
  member: "roleMember",
  viewer: "roleViewer",
  guest: "roleGuest",
};

/** The card shown when hovering someone who's in the document (like Outline's). */
export function PresenceCard({
  userId,
  name,
  color,
  status,
  documentId,
}: {
  userId: string;
  name: string;
  color: string;
  status: "viewing" | "editing" | "away";
  /** The open page, to say when they last edited and viewed it. */
  documentId?: string;
}) {
  const { t, lang, f } = useSettings();
  const [details, setDetails] = useState<UserDetails | null>(null);
  const [activity, setActivity] = useState<{ edited?: string; viewed?: string } | null>(null);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    void userDetails(userId)
      .then(setDetails)
      .catch(() => {});
    if (documentId)
      void documentActivity(documentId).then(({ views, revisions }) => {
        // Revisions come newest first.
        const edit = revisions.find((r) => r.createdBy?.id === userId || r.collaborators?.some((c) => c.id === userId));
        setActivity({ edited: edit?.createdAt, viewed: views.find((v) => v.user?.id === userId)?.lastViewedAt });
      });
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, [userId, documentId]);

  let localTime: string | null = null;
  if (details?.timezone) {
    try {
      localTime = new Intl.DateTimeFormat(lang === "fr" ? "fr-FR" : "en-US", { hour: "numeric", minute: "2-digit", timeZone: details.timezone }).format(now);
    } catch {
      localTime = null;
    }
  }
  const role = details?.role ? ROLE_LABELS[details.role] : undefined;

  return (
    <div className="presence-card">
      <div className="presence-card-head">
        <Avatar user={{ name, color, avatarUrl: details?.avatarUrl ?? null }} size={40} />
        <div>
          <div className="presence-card-name">
            {name}
            {role && role !== "roleMember" && <span className="role-badge">{t(role)}</span>}
          </div>
          {status !== "away" && <div className="presence-card-status">{t("online")}</div>}
        </div>
      </div>
      <div className="presence-card-rows">
        {localTime && (
          <div>
            <Clock size={14} /> {t("localTime", { time: localTime })}
          </div>
        )}
        {status !== "away" && (
          <div>
            <Eye size={14} /> {t(status === "editing" ? "currentlyEditing" : "currentlyViewing")}
          </div>
        )}
        {activity?.edited && (
          <div title={f.dateTime(activity.edited)}>
            <Pencil size={14} /> {t("lastEditedPage", { time: f.relative(activity.edited) })}
          </div>
        )}
        {status === "away" && activity?.viewed && (
          <div title={f.dateTime(activity.viewed)}>
            <Eye size={14} /> {t("lastViewedPage", { time: f.relative(activity.viewed) })}
          </div>
        )}
        {status === "away" && details?.lastActiveAt && (
          <div title={f.dateTime(details.lastActiveAt)}>
            <Clock size={14} /> {t("lastActive", { time: f.relative(details.lastActiveAt) })}
          </div>
        )}
        {status === "away" && activity && !activity.edited && !activity.viewed && (
          <div>
            <Pencil size={14} /> {t("editedThisPage")}
          </div>
        )}
      </div>
    </div>
  );
}

/** Wraps an element so hovering it shows a card below. */
export function HoverCard({ children, card }: { children: React.ReactNode; card: () => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), 250);
  };
  const hide = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(false), 150);
  };
  return (
    <span className="hover-card-anchor" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      {children}
      {open && <div className="hover-card">{card()}</div>}
    </span>
  );
}
