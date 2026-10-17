import { useEffect, useState } from "react";
import { isTauri } from "../lib/platform";
import { getAutostart, setAutostart } from "../lib/desktop";
import { useSettings, type Settings, type Theme } from "../lib/settings";
import type { StringKey } from "../lib/i18n";
import type { User } from "../lib/api";
import { mod } from "../lib/platform";
import { X } from "./icons";

const THEMES: { id: Theme; label: StringKey }[] = [
  { id: "system", label: "themeSystem" },
  { id: "light", label: "themeLight" },
  { id: "dark", label: "themeDark" },
  { id: "rosepine", label: "themeRosepine" },
  { id: "rosepine-dawn", label: "themeRosepineDawn" },
];

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
    <section className="settings-grid">
      <h3>{t("desktop")}</h3>
      <label>
        <span>{t("launchAtStartup")}</span>
        <input
          type="checkbox"
          className="switch"
          checked={!!autostart}
          disabled={autostart === null}
          onChange={(e) => {
            const on = e.target.checked;
            setAutostartState(on);
            setAutostart(on).catch(() => setAutostartState(!on));
          }}
        />
      </label>
      <label className={autostart ? "" : "disabled"}>
        <span>{t("startMinimized")}</span>
        <input type="checkbox" className="switch" checked={settings.startMinimized} disabled={!autostart} onChange={(e) => update({ startMinimized: e.target.checked })} />
      </label>
      <label>
        <span>
          {t("closeToTray")}
          <span className="settings-hint">{t("closeToTrayHint")}</span>
        </span>
        <input type="checkbox" className="switch" checked={settings.closeToTray} onChange={(e) => update({ closeToTray: e.target.checked })} />
      </label>
    </section>
  );
}

export function SettingsDialog({ user, server, onClose, onSignOut }: { user: User; server: string; onClose: () => void; onSignOut: () => void }) {
  const { t, settings, update } = useSettings();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const select = <K extends keyof Settings>(key: K, options: [Settings[K], string][]) => (
    <select
      value={String(settings[key])}
      onChange={(e) => update({ [key]: options.find(([v]) => String(v) === e.target.value)![0] } as Partial<Settings>)}
    >
      {options.map(([value, label]) => (
        <option key={String(value)} value={String(value)}>
          {label}
        </option>
      ))}
    </select>
  );
  const toggle = (key: "fullWidth" | "spellcheck") => (
    <input type="checkbox" className="switch" checked={settings[key]} onChange={(e) => update({ [key]: e.target.checked })} />
  );

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-label={t("settings")}>
        <div className="dialog-header">
          <h2>{t("settings")}</h2>
          <button className="icon-button small" aria-label={t("close")} onClick={onClose}>
            <X />
          </button>
        </div>

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

        <section className="settings-grid">
          <label>
            <span>{t("language")}</span>
            {select("language", [
              ["auto", t("automatic")],
              ["fr", "Français"],
              ["en", "English"],
            ])}
          </label>
        </section>

        <section className="settings-grid">
          <h3>{t("editorSection")}</h3>
          <label>
            <span>{t("font")}</span>
            {select("font", [
              ["sans", t("fontSans")],
              ["serif", t("fontSerif")],
              ["mono", t("fontMono")],
            ])}
          </label>
          <label>
            <span>{t("fontSize")}</span>
            {select(
              "fontSize",
              [14, 15, 16, 17, 18, 20].map((n) => [n, `${n}px`]),
            )}
          </label>
          <label>
            <span>{t("fullWidth")}</span>
            {toggle("fullWidth")}
          </label>
          <label>
            <span>{t("spellcheck")}</span>
            {toggle("spellcheck")}
          </label>
        </section>

        {isTauri && <DesktopSettings />}

        <section>
          <h3>{t("account")}</h3>
          <div className="server-row">
            <span>
              {t("signedInAs", { name: user.name })} · <span className="muted">{server.replace(/^https?:\/\//, "")}</span>
            </span>
            <button className="text-button" onClick={onSignOut}>
              {t("signOut")}
            </button>
          </div>
        </section>

        <section>
          <h3>{t("shortcuts")}</h3>
          <ShortcutList />
        </section>
      </div>
    </div>
  );
}
