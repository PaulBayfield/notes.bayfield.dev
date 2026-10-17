import { useEffect, useRef, useState } from "react";
import { resolveUrl, userDetails, type User, type UserDetails } from "../lib/api";
import { useSettings } from "../lib/settings";
import { Clock, Eye } from "./icons";

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
export function PresenceCard({ userId, name, color, status }: { userId: string; name: string; color: string; status: "viewing" | "editing" }) {
  const { t, lang } = useSettings();
  const [details, setDetails] = useState<UserDetails | null>(null);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    void userDetails(userId)
      .then(setDetails)
      .catch(() => {});
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, [userId]);

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
          <div className="presence-card-status">{t("online")}</div>
        </div>
      </div>
      <div className="presence-card-rows">
        {localTime && (
          <div>
            <Clock size={14} /> {t("localTime", { time: localTime })}
          </div>
        )}
        <div>
          <Eye size={14} /> {t(status === "editing" ? "currentlyEditing" : "currentlyViewing")}
        </div>
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
