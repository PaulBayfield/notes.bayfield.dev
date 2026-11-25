import { useEffect, useRef, useState } from "react";
import { ApiError, chooseAndUploadImage, installationInfo, setNotification, updateMe, type InstallationInfo } from "../../lib/api";
import { getAutostart, setAutostart } from "../../lib/desktop";
import { SYSTEM_SPELLING } from "../../editor/spelling";
import type { StringKey } from "../../lib/i18n";
import { isTauri, openExternal } from "../../lib/platform";
import { APP_VERSION, canInstallUpdates, installStatus, RELEASES_URL, useInstallUpdate, useUpdateCheck } from "../../lib/updates";
import { useSettings, type Settings, type Theme } from "../../lib/settings";
import { Avatar } from "../Avatar";
import type { BadgeStyle } from "../NotificationsButton";
import { PageHeader, Row, Select, Switch, usePage } from "./common";
import { connectPrefs, disconnectPrefs, usePrefsStatus, activeCustomTheme, BASE_COLORS, PREFS_URL } from "../../lib/prefs";
import { External } from "../icons";

export function ProfilePage() {
  const { t } = useSettings();
  const { me, setMe, flash, onError, server, onSignOut } = usePage();
  const [name, setName] = useState(me.name);
  const [busy, setBusy] = useState(false);

  const save = async (patch: Parameters<typeof updateMe>[0], message: string) => {
    setBusy(true);
    try {
      const user = await updateMe(patch);
      setMe({ name: user.name, avatarUrl: user.avatarUrl });
      flash(message);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };
  const changePhoto = async () => {
    try {
      const attachment = await chooseAndUploadImage("avatar");
      if (attachment) await save({ avatarUrl: attachment.url }, t("photoUpdated"));
    } catch (e) {
      onError(e);
    }
  };

  return (
    <>
      <PageHeader title={t("profile")} hint={t("profileHint")} />
      <section className="settings-rows">
        <Row label={t("photo")} hint={t("photoHint")}>
          <Avatar user={me} size={48} />
          <button className="text-button" disabled={busy} onClick={() => void changePhoto()}>
            {t("choosePhoto")}
          </button>
          {me.avatarUrl && (
            <button className="text-button" disabled={busy} onClick={() => void save({ avatarUrl: null }, t("photoUpdated"))}>
              {t("removePhoto")}
            </button>
          )}
        </Row>
        <Row label={t("nameLabel")} hint={t("nameHint")}>
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim() && name.trim() !== me.name) void save({ name: name.trim() }, t("profileSaved"));
            }}
          >
            <input className="text-field" value={name} maxLength={255} onChange={(e) => setName(e.target.value)} />
            <button className="primary-button" disabled={busy || !name.trim() || name.trim() === me.name}>
              {t("save")}
            </button>
          </form>
        </Row>
        {me.email && (
          <Row label={t("emailLabel")}>
            <span className="muted">{me.email}</span>
          </Row>
        )}
      </section>
      <section className="settings-rows">
        <h3>{t("account")}</h3>
        <Row label={t("signedInAs", { name: me.name })} hint={server.replace(/^https?:\/\//, "")}>
          <button className="text-button" onClick={onSignOut}>
            {t("signOut")}
          </button>
        </Row>
      </section>
    </>
  );
}

const THEMES: { id: Theme; label: StringKey }[] = [
  { id: "system", label: "themeSystem" },
  { id: "light", label: "themeLight" },
  { id: "dark", label: "themeDark" },
  { id: "rosepine", label: "themeRosepine" },
  { id: "rosepine-dawn", label: "themeRosepineDawn" },
];

/** Launch at startup (and minimized or not), and what the close button does. */
function DesktopSettings() {
  const { t, settings, update } = useSettings();
  const [autostart, setAutostartState] = useState<boolean | null>(null);
  useEffect(() => {
    getAutostart()
      .then(setAutostartState)
      .catch(() => setAutostartState(false));
  }, []);
  return (
    <section className="settings-rows">
      <h3>{t("desktop")}</h3>
      <Row label={t("launchAtStartup")}>
        <Switch
          checked={!!autostart}
          disabled={autostart === null}
          onChange={(on) => {
            setAutostartState(on);
            setAutostart(on).catch(() => setAutostartState(!on));
          }}
        />
      </Row>
      <Row label={t("startMinimized")} disabled={!autostart}>
        <Switch checked={settings.startMinimized} disabled={!autostart} onChange={(on) => update({ startMinimized: on })} />
      </Row>
      <Row label={t("closeToTray")} hint={t("closeToTrayHint")}>
        <Switch checked={settings.closeToTray} onChange={(on) => update({ closeToTray: on })} />
      </Row>
    </section>
  );
}


export function PreferencesPage() {
  const { t, settings, update } = useSettings();
  const { me, setMe, flash, onError } = usePage();
  const badge = (me.preferences?.notificationBadge as BadgeStyle | undefined) ?? "count";

  const select = <K extends "font" | "language">(key: K, options: [Settings[K], string][]) => (
    <Select value={settings[key]} options={options} onChange={(v) => update({ [key]: v } as Partial<Settings>)} />
  );

  return (
    <>
      <PageHeader title={t("preferences")} hint={t("preferencesHint")} />
      <section>
        <h3>{t("appearance")}</h3>
        <div className="theme-picker">
          {THEMES.map(({ id, label }) => (
            <button key={id} className={`theme-card${!activeCustomTheme(settings) && settings.theme === id ? " active" : ""}`} onClick={() => update({ theme: id, customTheme: "" })}>
              <span className={`theme-preview ${id}`}>
                <span />
                <span />
                <span />
              </span>
              <span className="theme-card-name">{t(label)}</span>
            </button>
          ))}
          {settings.customThemes.map((theme) => {
            const c = { ...BASE_COLORS[theme.base], ...theme.colors };
            return (
              <button
                key={theme.id}
                className={`theme-card${activeCustomTheme(settings)?.id === theme.id ? " active" : ""}`}
                title={theme.name}
                onClick={() => update({ theme: theme.base, customTheme: theme.id })}
              >
                <span className="theme-preview" style={{ background: c.bg, borderColor: c["border-strong"] }}>
                  <span style={{ background: c["bg-sidebar"] }} />
                  <span style={{ background: c.primary }} />
                  <span style={{ background: c.accent }} />
                </span>
                <span className="theme-card-name">{theme.name}</span>
              </button>
            );
          })}
        </div>
        <p className="theme-manage">
          {t("manageThemesHint")}{" "}
          <button className="theme-manage-link" onClick={() => void openExternal(PREFS_URL)}>
            {t("manageThemes")}
            <External size={13} />
          </button>
        </p>
      </section>
      <section className="settings-rows">
        <Row label={t("language")}>
          {select("language", [
            ["auto", t("automatic")],
            ["fr", "Français"],
            ["en", "English"],
          ])}
        </Row>
        <Row label={t("notificationBadge")} hint={t("notificationBadgeHint")}>
          <Select<BadgeStyle>
            value={badge}
            options={[
              ["count", t("badgeCount")],
              ["indicator", t("badgeIndicator")],
              ["disabled", t("badgeDisabled")],
            ]}
            onChange={(v) => {
              const preferences = { ...me.preferences, notificationBadge: v };
              setMe({ preferences });
              updateMe({ preferences }).then(() => flash(t("saved")), onError);
            }}
          />
        </Row>
      </section>
      <PrefsSyncRow />
      <section className="settings-rows">
        <h3>{t("editorSection")}</h3>
        <Row label={t("font")}>
          {select("font", [
            ["sans", t("fontSans")],
            ["serif", t("fontSerif")],
            ["mono", t("fontMono")],
          ])}
        </Row>
        <Row label={t("fontSize")}>
          <Select
            value={String(settings.fontSize)}
            options={[14, 15, 16, 17, 18, 20].map((n) => [String(n), `${n}px`])}
            onChange={(v) => update({ fontSize: Number(v) })}
          />
        </Row>
        <Row label={t("fullWidth")}>
          <Switch checked={settings.fullWidth} onChange={(on) => update({ fullWidth: on })} />
        </Row>
        <Row label={t("tocSync")} hint={t("tocSyncHint")}>
          <Switch checked={settings.tocSync} onChange={(on) => update({ tocSync: on })} />
        </Row>
        <Row label={t("spellcheck")}>
          <Switch checked={settings.spellcheck} onChange={(on) => update({ spellcheck: on })} />
        </Row>
        {SYSTEM_SPELLING && (
          <Row label={t("autocorrect")} hint={t("autocorrectHint")} disabled={!settings.spellcheck}>
            <Switch checked={settings.autocorrect} disabled={!settings.spellcheck} onChange={(on) => update({ autocorrect: on })} />
          </Row>
        )}
        <Row label={t("minimiseCursorNames")} hint={t("minimiseCursorNamesHint")}>
          <Switch checked={settings.minimiseCursorNames} onChange={(on) => update({ minimiseCursorNames: on })} />
        </Row>
        <Row label={t("smartText")} hint={t("smartTextHint")}>
          <Switch
            checked={me.preferences?.enableSmartText !== false}
            onChange={(on) => {
              // Saved in Outline, which reads the same preference.
              const preferences = { ...me.preferences, enableSmartText: on };
              setMe({ preferences });
              updateMe({ preferences }).then(() => flash(t("saved")), onError);
            }}
          />
        </Row>
      </section>
      {isTauri && <DesktopSettings />}
    </>
  );
}

/** Outline's notification events, with whether each is on when never set (as Outline decides). */
const EVENTS: { event: string; label: StringKey; hint: StringKey; on: boolean }[] = [
  { event: "documents.publish", label: "nPublish", hint: "nPublishHint", on: false },
  { event: "documents.update", label: "nUpdate", hint: "nUpdateHint", on: true },
  { event: "comments.create", label: "nComment", hint: "nCommentHint", on: true },
  { event: "comments.mentioned", label: "nMention", hint: "nMentionHint", on: true },
  { event: "documents.group_mentioned", label: "nGroupMention", hint: "nGroupMentionHint", on: true },
  { event: "comments.resolve", label: "nResolve", hint: "nResolveHint", on: true },
  { event: "reactions.create", label: "nReaction", hint: "nReactionHint", on: true },
  { event: "collections.create", label: "nCollection", hint: "nCollectionHint", on: false },
  { event: "emails.invite_accepted", label: "nInviteAccepted", hint: "nInviteAcceptedHint", on: true },
  { event: "documents.add_user", label: "nAddedToDoc", hint: "nAddedToDocHint", on: true },
  { event: "collections.add_user", label: "nAddedToCollection", hint: "nAddedToCollectionHint", on: true },
  { event: "groups.add_user", label: "nGroupMembership", hint: "nGroupMembershipHint", on: true },
  { event: "emails.export_completed", label: "nExport", hint: "nExportHint", on: true },
  { event: "access_requests.create", label: "nAccessRequest", hint: "nAccessRequestHint", on: true },
];

/** The events a server accepts, read from the error it gives for one it doesn't (older servers know fewer). */
function acceptedEvents(e: unknown): string[] | null {
  if (!(e instanceof ApiError) || e.status !== 400 || !e.message.includes("eventType")) return null;
  const list = [...e.message.matchAll(/"([a-z_]+\.[a-z_]+)"/g)].map((m) => m[1]);
  return list.length ? list : null;
}

const acceptedKey = (server: string) => `notes.notificationEvents:${server}`;

function loadAccepted(server: string): string[] | null {
  try {
    const list = JSON.parse(localStorage.getItem(acceptedKey(server)) ?? "null");
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  }
}

export function NotificationsPage() {
  const { t } = useSettings();
  const { me, setMe, flash, onError, server } = usePage();
  const settings = me.notificationSettings ?? {};
  // Per channel ({ email, app, … }) on newer servers: the email one is what these switches set.
  const isOn = (e: (typeof EVENTS)[number]) => {
    const v = settings[e.event] ?? e.on;
    return typeof v === "object" ? (v.email ?? Object.values(v).some(Boolean)) : !!v;
  };
  /** Events this server knows, once it has told us (null: all of them, as far as we know). */
  const [accepted, setAccepted] = useState(() => loadAccepted(server));
  const acceptedRef = useRef(accepted);
  const events = EVENTS.filter((e) => !accepted || accepted.includes(e.event));
  const allOn = events.every(isOn);

  // Saves run one after another, so quick toggles reach the server in the order they were made.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  // The latest settings, for changes made before the previous one re-rendered the page.
  const latest = useRef(settings);
  latest.current = settings;

  const change = (on: boolean, event?: string) => {
    const changed = (event ? EVENTS.filter((e) => e.event === event) : events).map((e) => e.event);
    const before = latest.current;
    const next = { ...before };
    for (const e of changed) next[e] = on;
    latest.current = next;
    setMe({ notificationSettings: next });
    queue.current = queue.current.then(async () => {
      try {
        // One event at a time: Outline needs an event type, there's no "all" call.
        for (const e of changed) {
          if (acceptedRef.current && !acceptedRef.current.includes(e)) continue;
          try {
            await setNotification(on, e);
          } catch (err) {
            // Not an event this server has: hide it from now on and carry on with the others.
            const list = acceptedEvents(err);
            if (!list || list.includes(e)) throw err;
            acceptedRef.current = list;
            setAccepted(list);
            try {
              localStorage.setItem(acceptedKey(server), JSON.stringify(list));
            } catch {
              // Found again next time.
            }
          }
        }
        flash(t("saved"));
      } catch (err) {
        // Put back what didn't save.
        const reverted = { ...latest.current };
        for (const e of changed) {
          if (e in before) reverted[e] = before[e];
          else delete reverted[e];
        }
        latest.current = reverted;
        setMe({ notificationSettings: reverted });
        onError(err);
      }
    });
  };

  return (
    <>
      <PageHeader title={t("notifications")} hint={t("notificationsHint")} />
      <section className="settings-rows">
        <Row label={<strong>{t("allNotifications")}</strong>}>
          <Switch checked={allOn} onChange={(on) => change(on)} />
        </Row>
        {events.map((e) => (
          <Row key={e.event} label={t(e.label)} hint={t(e.hint)}>
            <Switch checked={isOn(e)} onChange={(on) => change(on, e.event)} />
          </Row>
        ))}
      </section>
    </>
  );
}

const OUTLINE_RELEASES_URL = "https://github.com/outline/outline/releases";

/** The app's version, and a way to look for a newer one. */
export function AboutPage() {
  const { t, settings, update } = useSettings();
  const { server } = usePage();
  const { state, check } = useUpdateCheck(false);
  const release = state.status === "available" ? state.release : null;
  const installer = useInstallUpdate();
  useEffect(() => {
    void check();
  }, [check]);

  const status =
    state.status === "checking" || state.status === "idle"
      ? t("checkingUpdates")
      : state.status === "upToDate"
        ? t("upToDate")
        : state.status === "error"
          ? t("updateCheckFailed")
          : (installStatus(t, installer.state) ?? t("updateAvailable", { version: release?.version ?? "" }));

  // The Outline version the server runs (self-hosted servers only).
  const [outline, setOutline] = useState<InstallationInfo | null>(null);
  useEffect(() => {
    void installationInfo().then(setOutline);
  }, []);
  const host = server.replace(/^https?:\/\//, "");
  const behind = outline?.versionsBehind ?? -1;
  const behindLabel = behind < 0 ? t("outlineUnknown") : behind === 0 ? t("outlineUpToDate") : t(behind === 1 ? "outlineBehindOne" : "outlineBehind", { n: behind });

  return (
    <>
      <PageHeader title={t("about")} />
      <section className="settings-rows">
        <Row label={t("appName")} hint={isTauri ? t("aboutDesktop") : t("aboutWeb")}>
          <span className="version-tag">{t("versionLabel", { version: APP_VERSION })}</span>
        </Row>
        <Row label={t("updates")} hint={status}>
          {release ? (
            <>
              <button className="text-button" onClick={() => void openExternal(release.url)}>
                {t("whatsNew")}
              </button>
              {canInstallUpdates && installer.state.status !== "error" ? (
                <button
                  className="primary-button"
                  disabled={installer.state.status !== "idle"}
                  onClick={() => {
                    if (settings.skippedUpdate === release.version) update({ skippedUpdate: "" });
                    void installer.install();
                  }}
                >
                  {t("installUpdate")}
                </button>
              ) : (
                <button
                  className="primary-button"
                  onClick={() => {
                    if (settings.skippedUpdate === release.version) update({ skippedUpdate: "" });
                    void openExternal(release.installer ?? release.url);
                  }}
                >
                  {t("download")}
                </button>
              )}
            </>
          ) : (
            <button className="text-button" disabled={state.status === "checking"} onClick={() => void check()}>
              {t("checkForUpdates")}
            </button>
          )}
        </Row>
        <Row label={t("serverLabel")}>
          <span className="muted">{host}</span>
        </Row>
        {outline && (
          <>
            <Row label={t("outlineVersionLabel")}>
              <span className="version-tag">{outline.version}</span>
            </Row>
            <Row label={t("outlineLatestLabel")}>
              {outline.latestVersion ? (
                <button className="text-button" title={t("releaseNotes")} onClick={() => void openExternal(OUTLINE_RELEASES_URL)}>
                  {outline.latestVersion}
                </button>
              ) : (
                <span className="muted">{t("outlineUnknown")}</span>
              )}
            </Row>
            <Row label={t("outlineStatusLabel")}>
              <span className={`badge${behind > 0 ? " warning" : ""}`}>{behindLabel}</span>
            </Row>
          </>
        )}
        <Row label={t("releaseNotes")}>
          <button className="text-button" onClick={() => void openExternal(RELEASES_URL)}>
            {t("openInBrowser")}
          </button>
        </Row>
      </section>
    </>
  );
}

/** Theme and language shared with the other bayfield.dev apps, through prefs.bayfield.dev. */
function PrefsSyncRow() {
  const { t } = useSettings();
  const { status, email } = usePrefsStatus();
  const hint =
    status === "connected"
      ? t("prefsConnected", { email: email ?? "" })
      : status === "connecting"
        ? t("prefsApprove")
        : status === "offline"
          ? t("prefsOffline")
          : t("prefsHint");
  return (
    <section className="settings-rows">
      <h3>{t("prefsTitle")}</h3>
      <Row label={t("prefsLabel")} hint={hint}>
        {status === "connected" ? (
          <button className="text-button" onClick={() => void disconnectPrefs()}>
            {t("prefsDisconnect")}
          </button>
        ) : status === "disconnected" || status === "connecting" ? (
          <button className="primary-button" onClick={() => void connectPrefs("Notes")}>
            {t("prefsConnect")}
          </button>
        ) : null}
      </Row>
    </section>
  );
}
