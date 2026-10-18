import { useEffect, useState } from "react";
import { chooseAndUploadImage, setNotification, updateMe } from "../../lib/api";
import { getAutostart, setAutostart } from "../../lib/desktop";
import type { StringKey } from "../../lib/i18n";
import { isTauri, openExternal } from "../../lib/platform";
import { APP_VERSION, RELEASES_URL, useUpdateCheck } from "../../lib/updates";
import { useSettings, type Settings, type Theme } from "../../lib/settings";
import { Avatar } from "../Avatar";
import type { BadgeStyle } from "../NotificationsButton";
import { PageHeader, Row, Select, Switch, usePage } from "./common";

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
            <button key={id} className={`theme-card${settings.theme === id ? " active" : ""}`} onClick={() => update({ theme: id })}>
              <span className={`theme-preview ${id}`}>
                <span />
                <span />
                <span />
              </span>
              {t(label)}
            </button>
          ))}
        </div>
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
        <Row label={t("spellcheck")}>
          <Switch checked={settings.spellcheck} onChange={(on) => update({ spellcheck: on })} />
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

export function NotificationsPage() {
  const { t } = useSettings();
  const { me, setMe, flash, onError } = usePage();
  const settings = me.notificationSettings ?? {};
  const isOn = (e: (typeof EVENTS)[number]) => !!(settings[e.event] ?? e.on);
  const allOn = EVENTS.every(isOn);

  const change = (on: boolean, event?: string) => {
    const next = { ...settings };
    for (const e of EVENTS) if (!event || e.event === event) next[e.event] = on;
    setMe({ notificationSettings: next });
    setNotification(on, event).then(() => flash(t("saved")), onError);
  };

  return (
    <>
      <PageHeader title={t("notifications")} hint={t("notificationsHint")} />
      <section className="settings-rows">
        <Row label={<strong>{t("allNotifications")}</strong>}>
          <Switch checked={allOn} onChange={(on) => change(on)} />
        </Row>
        {EVENTS.map((e) => (
          <Row key={e.event} label={t(e.label)} hint={t(e.hint)}>
            <Switch checked={isOn(e)} onChange={(on) => change(on, e.event)} />
          </Row>
        ))}
      </section>
    </>
  );
}

/** The app's version, and a way to look for a newer one. */
export function AboutPage() {
  const { t, settings, update } = useSettings();
  const { server } = usePage();
  const { state, check } = useUpdateCheck(false);
  const release = state.status === "available" ? state.release : null;
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
          : t("updateAvailable", { version: release?.version ?? "" });

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
              <button
                className="primary-button"
                onClick={() => {
                  if (settings.skippedUpdate === release.version) update({ skippedUpdate: "" });
                  void openExternal(release.installer ?? release.url);
                }}
              >
                {t("download")}
              </button>
            </>
          ) : (
            <button className="text-button" disabled={state.status === "checking"} onClick={() => void check()}>
              {t("checkForUpdates")}
            </button>
          )}
        </Row>
        <Row label={t("serverLabel")}>
          <span className="muted">{server.replace(/^https?:\/\//, "")}</span>
        </Row>
        <Row label={t("releaseNotes")}>
          <button className="text-button" onClick={() => void openExternal(RELEASES_URL)}>
            {t("openInBrowser")}
          </button>
        </Row>
      </section>
    </>
  );
}
