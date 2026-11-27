// The audit log (admins): what happened in the workspace, who did it, from where, and what changed.
// Filters by kind, person and dates, export as CSV, and how long the workspace keeps it.

import { useEffect, useState, type ReactNode } from "react";
import { listMembers, updateTeam, type Member } from "../../lib/api";
import { listEvents, type EventChange, type EventFilters, type WorkspaceEvent } from "../../lib/integrations";
import type { StringKey, Translate } from "../../lib/i18n";
import { saveTextFile } from "../../lib/platform";
import { useSettings } from "../../lib/settings";
import { Avatar } from "../Avatar";
import { Dialog } from "../Dialogs";
import { CopyField } from "./IntegrationPages";
import { Download, FileText, Users } from "../icons";
import { Empty, Loading, PageHeader, Row, Select, useLoad, usePage } from "./common";

const PAGE_SIZE = 50;

const EVENT_GROUPS: [string, string[] | null][] = [
  ["all", null],
  ["documents", ["documents.create", "documents.publish", "documents.unpublish", "documents.archive", "documents.restore", "documents.delete", "documents.permanent_delete", "documents.move"]],
  ["collections", ["collections.create", "collections.update", "collections.delete", "collections.archive", "collections.restore", "collections.move"]],
  ["access", ["collections.add_user", "collections.remove_user", "collections.add_group", "collections.remove_group", "documents.add_user", "documents.remove_user", "documents.add_group", "documents.remove_group"]],
  ["people", ["users.create", "users.update_role", "users.suspend", "users.activate", "users.delete", "users.invite", "groups.create", "groups.update", "groups.delete", "groups.add_user", "groups.remove_user"]],
  ["sharing", ["shares.create", "shares.update", "shares.revoke"]],
  ["security", ["apiKeys.create", "apiKeys.delete", "teams.update", "teams.create"]],
];

/** A field's name in the log, when there's a nicer one than its key. */
const FIELD_LABELS: Record<string, StringKey> = {
  name: "nameLabel",
  role: "fieldRole",
  permission: "permission",
  sharing: "fieldSharing",
  commenting: "fieldCommenting",
  icon: "fieldIcon",
  color: "fieldColor",
  collectionId: "collection",
  parentDocumentId: "fieldParent",
  published: "fieldPublished",
  includeChildDocuments: "includeNested",
  allowIndexing: "allowIndexing",
  showLastUpdated: "showLastUpdated",
  showToc: "showToc",
  urlId: "fieldLinkName",
  expiresAt: "expiration",
  defaultUserRole: "sDefaultRole",
  inviteRequired: "sInviteRequired",
  memberCollectionCreate: "sCollectionCreate",
  documentEmbeds: "sEmbeds",
  allowedDomains: "sAllowedDomains",
  defaultCollectionId: "startView",
  description: "descriptionLabel",
  avatarUrl: "logo",
  "preferences.mcp": "mcpEnabled",
  "preferences.tocPosition": "tocPosition",
  "preferences.auditRetentionDays": "auditRetention",
};

const VALUE_LABELS: Record<string, StringKey> = {
  admin: "roleAdmin",
  member: "roleMember",
  viewer: "roleViewer",
  guest: "roleGuest",
  read: "canView",
  read_write: "canEdit",
};

const VIA_LABELS: Record<string, StringKey> = { cookie: "viaWeb", bearer: "viaDesktop", apiKey: "viaApiKey", oauth: "viaOAuth" };

function valueText(t: Translate, field: string, v: unknown, label?: string): string {
  if (label) return label;
  if (v === null || v === undefined || v === "") return field === "permission" ? t("noAccess") : "—";
  if (typeof v === "boolean") return v ? t("on") : t("off");
  if (typeof v === "string" && VALUE_LABELS[v]) return t(VALUE_LABELS[v]);
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return new Date(v).toLocaleDateString();
  if (Array.isArray(v)) return v.length ? v.join(", ") : "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

const fieldText = (t: Translate, field: string) => (FIELD_LABELS[field] ? t(FIELD_LABELS[field]) : field.replace(/^preferences\./, ""));

/** "Role: Member → Admin" for each change. */
function changeLines(t: Translate, changes: Record<string, EventChange> | null): string[] {
  return Object.entries(changes ?? {}).map(([field, c]) => `${fieldText(t, field)} : ${valueText(t, field, c.from, c.fromLabel)} → ${valueText(t, field, c.to, c.toLabel)}`);
}

/** Details from the event's own data: the permission given, an invite's email, a key's access… */
function dataLines(t: Translate, e: WorkspaceEvent): string[] {
  const d = e.data ?? {};
  const out: string[] = [];
  if (typeof d.permission === "string") out.push(`${t("permission")} : ${valueText(t, "permission", d.permission)}`);
  if (e.name === "users.invite" && typeof d.email === "string") out.push(`${d.email}${typeof d.role === "string" ? ` · ${valueText(t, "role", d.role)}` : ""}`);
  if (e.name === "apiKeys.create") out.push(Array.isArray(d.scope) && d.scope.length ? d.scope.join(", ") : t("scopeAll"));
  if (e.name.startsWith("shares.") && d.collectionShare) out.push(t("wholeCollection"));
  return out;
}

const describe = (t: Translate, e: WorkspaceEvent) => {
  const key = `ev_${e.name.replace(".", "_")}` as StringKey;
  const label = t(key) as string | undefined;
  return label && label !== key ? label : e.name;
};

/** What the action was about, from the names the server looked up (or kept in the event). */
function subjectText(e: WorkspaceEvent): string {
  const d = e.data ?? {};
  const named = typeof d.name === "string" ? d.name : typeof d.title === "string" ? d.title : null;
  return [e.document?.title, e.collection && !e.document ? e.collection.name : null, e.user?.name ?? (e.userId ? named : null), e.group?.name, !e.document && !e.collection && !e.user && !e.group ? named : null]
    .filter((x): x is string => !!x)
    .join(" · ");
}

function toCsv(t: Translate, events: WorkspaceEvent[]): string {
  const cell = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const head = ["date", "person", "email", "action", "event", "document", "collection", "about", "group", "details", "ip", "client", "via"];
  const rows = events.map((e) =>
    [
      new Date(e.createdAt).toISOString(),
      e.actor?.name ?? "",
      e.actor?.email ?? "",
      describe(t, e),
      e.name,
      e.document?.title ?? "",
      e.collection?.name ?? "",
      e.user?.name ?? "",
      e.group?.name ?? "",
      [...dataLines(t, e), ...changeLines(t, e.changes)].join("; "),
      e.actorIpAddress ?? "",
      e.client ?? "",
      e.via ? t(VIA_LABELS[e.via] ?? "viaWeb") : "",
    ].map((v) => cell(String(v))),
  );
  return [head.join(","), ...rows.map((r) => r.join(","))].join("\n");
}

/** Everything about one entry: what, who, on what, what changed, from where, and the raw record. */
function EventDialog({ e, onClose, onOpen }: { e: WorkspaceEvent; onClose: () => void; onOpen: (kind: "doc" | "collection", id: string) => void }) {
  const { t, f } = useSettings();
  const extra = dataLines(t, e);
  const changes = Object.entries(e.changes ?? {});
  const line = (label: string, value: ReactNode) =>
    value === null || value === undefined || value === "" ? null : (
      <div className="event-field">
        <span className="event-field-label">{label}</span>
        <span className="event-field-value">{value}</span>
      </div>
    );
  const link = (text: string, deleted: boolean, go: () => void) =>
    deleted ? (
      <span className="muted">
        {text} ({t("deletedLabel")})
      </span>
    ) : (
      <button className="link-button" onClick={go}>
        {text}
      </button>
    );
  return (
    <Dialog title={describe(t, e).replace(/^./, (c) => c.toUpperCase())} onClose={onClose} wide>
      <div className="event-sheet">
        <section>
          <h4>{t("eventWhat")}</h4>
          {line(
            t("eventWho"),
            e.actor ? (
              <span className="event-person">
                <Avatar user={e.actor} size={18} />
                {e.actor.name}
                {e.actor.email && <span className="muted">{e.actor.email}</span>}
              </span>
            ) : (
              t("someone")
            ),
          )}
          {line(t("eventWhen"), f.dateTime(e.createdAt))}
          {line(t("eventAction"), <code>{e.name}</code>)}
          {line(t("eventDocument"), e.document && link(e.document.title || t("untitled"), e.document.deleted, () => onOpen("doc", e.document!.id)))}
          {line(t("collection"), e.collection && link(e.collection.name, e.collection.deleted, () => onOpen("collection", e.collection!.id)))}
          {line(
            t("eventAbout"),
            e.user && (
              <span className="event-person">
                <Avatar user={e.user} size={18} />
                {e.user.name}
                {e.user.email && <span className="muted">{e.user.email}</span>}
              </span>
            ),
          )}
          {line(t("eventGroup"), e.group?.name)}
          {extra.map((x) => line(t("eventDetail"), x))}
        </section>

        {changes.length > 0 && (
          <section>
            <h4>{t("eventChanges")}</h4>
            <table className="event-changes">
              <thead>
                <tr>
                  <th>{t("eventField")}</th>
                  <th>{t("eventBefore")}</th>
                  <th>{t("eventAfter")}</th>
                </tr>
              </thead>
              <tbody>
                {changes.map(([field, c]) => (
                  <tr key={field}>
                    <td>{fieldText(t, field)}</td>
                    <td className="before">{valueText(t, field, c.from, c.fromLabel)}</td>
                    <td className="after">{valueText(t, field, c.to, c.toLabel)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        <section>
          <h4>{t("eventSource")}</h4>
          {line(t("eventVia"), e.via ? t(VIA_LABELS[e.via] ?? "viaWeb") : null)}
          {line(t("eventClient"), e.client)}
          {line(t("eventIp"), e.actorIpAddress)}
          {line(t("eventUserAgent"), e.userAgent && <code className="wrap">{e.userAgent}</code>)}
          {!e.via && !e.client && !e.actorIpAddress && <p className="settings-hint">{t("eventNoSource")}</p>}
        </section>

        <details className="event-raw">
          <summary>{t("eventRaw")}</summary>
          <label className="settings-form">
            <span>{t("eventId")}</span>
            <CopyField value={e.id} />
          </label>
          <pre>{JSON.stringify({ name: e.name, actorId: e.actorId, userId: e.userId, documentId: e.documentId, collectionId: e.collectionId, modelId: e.modelId, data: e.data, changes: e.changes }, null, 2)}</pre>
        </details>
      </div>
    </Dialog>
  );
}

const RETENTION: [string, StringKey | null, number | null][] = [
  ["forever", "retentionForever", null],
  ["30", null, 30],
  ["90", null, 90],
  ["180", null, 180],
  ["365", null, 365],
  ["730", null, 730],
];

export function AuditLogPage() {
  const { t, f } = useSettings();
  const { team, setTeam, flash, onError, onNavigate } = usePage();
  const [group, setGroup] = useState("all");
  const [actorId, setActorId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [pages, setPages] = useState(1);
  const [exporting, setExporting] = useState(false);
  const [people, setPeople] = useState<Member[]>([]);
  const [opened, setOpened] = useState<WorkspaceEvent | null>(null);

  useEffect(() => {
    listMembers("", "all", 0, 100)
      .then((r) => setPeople(r.data ?? []))
      .catch(() => {});
  }, []);

  const filters: EventFilters = {
    auditLog: true,
    events: EVENT_GROUPS.find(([g]) => g === group)?.[1] ?? undefined,
    actorId: actorId || undefined,
    since: from ? new Date(`${from}T00:00:00`).toISOString() : undefined,
    // The "to" day included.
    until: to ? new Date(new Date(`${to}T00:00:00`).getTime() + 86_400_000).toISOString() : undefined,
  };
  const { data } = useLoad(() => listEvents({ ...filters, limit: PAGE_SIZE * pages }), [group, actorId, from, to, pages]);
  const reset = (fn: () => void) => {
    fn();
    setPages(1);
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const all: WorkspaceEvent[] = [];
      for (let offset = 0; offset < 20_000; offset += 100) {
        const batch = await listEvents({ ...filters, limit: 100, offset });
        all.push(...batch);
        if (batch.length < 100) break;
      }
      const saved = await saveTextFile(`audit-log-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(t, all), "text/csv");
      if (saved) flash(t("exportedEvents", { n: all.length }));
    } catch (e) {
      onError(e);
    } finally {
      setExporting(false);
    }
  };

  const retention = team.preferences?.auditRetentionDays;
  const setRetention = async (value: string) => {
    const days = RETENTION.find(([v]) => v === value)?.[2] ?? null;
    const before = team;
    setTeam({ ...team, preferences: { ...team.preferences, auditRetentionDays: days } });
    try {
      setTeam(await updateTeam({ preferences: { auditRetentionDays: days } }));
      flash(t("saved"));
    } catch (e) {
      setTeam(before);
      onError(e);
    }
  };

  const chip = (icon: ReactNode, text: string, onClick?: () => void, faded?: boolean) =>
    onClick ? (
      <button
        type="button"
        className={`event-chip${faded ? " faded" : ""}`}
        onClick={(ev) => {
          ev.stopPropagation();
          onClick();
        }}
      >
        {icon}
        {text}
      </button>
    ) : (
      <span className={`event-chip static${faded ? " faded" : ""}`}>
        {icon}
        {text}
      </span>
    );

  return (
    <>
      <PageHeader title={t("auditLog")} hint={t("auditLogHint")}>
        <button className="text-button" disabled={exporting} onClick={() => void exportCsv()}>
          {exporting ? <span className="spinner" /> : <Download size={14} />}
          {t("exportCsv")}
        </button>
      </PageHeader>

      <div className="audit-filters">
        <Select value={group} options={EVENT_GROUPS.map(([g]): [string, string] => [g, t(`evGroup_${g}` as StringKey)])} onChange={(g) => reset(() => setGroup(g))} />
        <Select
          value={actorId}
          options={[["", t("everyone")], ...people.map((p): [string, string] => [p.id, p.name])]}
          onChange={(v) => reset(() => setActorId(v))}
        />
        <label className="audit-date">
          <span>{t("dateFrom")}</span>
          <input type="date" className="text-field" value={from} max={to || undefined} onChange={(e) => reset(() => setFrom(e.target.value))} />
        </label>
        <label className="audit-date">
          <span>{t("dateTo")}</span>
          <input type="date" className="text-field" value={to} min={from || undefined} onChange={(e) => reset(() => setTo(e.target.value))} />
        </label>
        {(group !== "all" || actorId || from || to) && (
          <button
            className="text-button"
            onClick={() =>
              reset(() => {
                setGroup("all");
                setActorId("");
                setFrom("");
                setTo("");
              })
            }
          >
            {t("clearFilters")}
          </button>
        )}
      </div>

      <section className="settings-rows">
        {!data ? (
          <Loading />
        ) : data.length === 0 ? (
          <Empty>{t("noEvents")}</Empty>
        ) : (
          <div className="settings-list">
            {data.map((e) => {
              const details = [...dataLines(t, e), ...changeLines(t, e.changes)];
              const meta = [f.relative(e.createdAt), e.via ? t(VIA_LABELS[e.via] ?? "viaWeb") : null, e.client, e.actorIpAddress].filter(Boolean).join(" · ");
              const leftover = !e.document && !e.collection && !e.user && !e.group ? subjectText(e) : "";
              return (
                <div
                  key={e.id}
                  className="settings-item audit-item clickable"
                  role="button"
                  tabIndex={0}
                  title={t("eventOpenDetails")}
                  onClick={() => setOpened(e)}
                  onKeyDown={(ev) => (ev.key === "Enter" || ev.key === " ") && (ev.preventDefault(), setOpened(e))}
                >
                  <Avatar user={e.actor ?? { name: "?", color: "var(--text-muted)", avatarUrl: null }} size={28} />
                  <div className="settings-item-text">
                    <span className="audit-line">
                      <strong>{e.actor?.name ?? t("someone")}</strong> {describe(t, e)}
                      {e.document &&
                        chip(<FileText size={12} />, e.document.title || t("untitled"), e.document.deleted ? undefined : () => onNavigate({ name: "doc", id: e.document!.id }), e.document.deleted)}
                      {e.collection &&
                        !e.document &&
                        chip(<span className="collection-dot" />, e.collection.name, e.collection.deleted ? undefined : () => onNavigate({ name: "collection", id: e.collection!.id }), e.collection.deleted)}
                      {e.user && chip(<Avatar user={e.user} size={14} />, e.user.name)}
                      {e.group && chip(<Users size={12} />, e.group.name)}
                      {leftover && <span className="muted"> · {leftover}</span>}
                    </span>
                    {details.length > 0 && (
                      <ul className="audit-details">
                        {details.map((d) => (
                          <li key={d}>{d}</li>
                        ))}
                      </ul>
                    )}
                    <span className="settings-hint" title={e.userAgent ?? undefined}>
                      {meta}
                    </span>
                  </div>
                  <span className="settings-item-meta" title={f.dateTime(e.createdAt)}>
                    {f.dateTime(e.createdAt)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
        {data && data.length >= PAGE_SIZE * pages && (
          <div className="dialog-actions">
            <button className="text-button" onClick={() => setPages((p) => p + 1)}>
              {t("loadMore")}
            </button>
          </div>
        )}
      </section>

      {opened && (
        <EventDialog
          e={opened}
          onClose={() => setOpened(null)}
          onOpen={(kind, id) => {
            setOpened(null);
            onNavigate({ name: kind, id });
          }}
        />
      )}

      <section className="settings-rows">
        <Row label={t("auditRetention")} hint={t("auditRetentionHint")}>
          <Select
            value={typeof retention === "number" && retention > 0 ? String(retention) : "forever"}
            options={RETENTION.map(([v, label, days]): [string, string] => [v, label ? t(label) : t("retentionDays", { n: days ?? 0 })])}
            onChange={(v) => void setRetention(v)}
          />
        </Row>
      </section>
    </>
  );
}
