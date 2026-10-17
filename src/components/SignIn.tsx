import { useState } from "react";
import { serverConfig, signIn, type Provider, type ServerConfig } from "../lib/auth";
import { isTauri } from "../lib/platform";
import { useSettings } from "../lib/settings";
import { WindowControls } from "./Toolbar";

export function SignIn({ error: initialError, onSignedIn }: { error: string | null; onSignedIn: () => void }) {
  const { t, settings, update } = useSettings();
  const [server, setServer] = useState(settings.lastServer);
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [busy, setBusy] = useState<"config" | "browser" | null>(null);
  const [error, setError] = useState<string | null>(initialError);

  const lookup = async () => {
    setBusy("config");
    setError(null);
    try {
      const next = await serverConfig(server);
      setConfig(next);
      update({ lastServer: next.server.replace(/^https:\/\//, "") });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const [viaBrowser, setViaBrowser] = useState(false);
  const start = async (provider: Provider) => {
    if (!config) return;
    setBusy("browser");
    setError(null);
    try {
      await signIn(config.server, provider, viaBrowser);
      onSignedIn();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Empty: the sign-in window was closed.
      setError(message || null);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="signin" data-tauri-drag-region>
      {isTauri && (
        <div className="signin-controls">
          <WindowControls />
        </div>
      )}
      <div className="signin-card">
        <img className="signin-logo" src={config?.logo ?? `${import.meta.env.BASE_URL}favicon.svg`} alt="" />
        <h1>{config?.name ?? t("appName")}</h1>
        {!isTauri ? (
          <>
            <p className="muted">{t("webSignedOut")}</p>
            <a className="primary-button" href="/">
              {t("webSignIn")}
            </a>
            <button className="link-button" onClick={() => location.reload()}>
              {t("reload")}
            </button>
          </>
        ) : !config ? (
          <form
            className="signin-form"
            onSubmit={(e) => {
              e.preventDefault();
              void lookup();
            }}
          >
            <p className="muted">{t("signinHint")}</p>
            <input className="text-input" aria-label={t("serverLabel")} value={server} onChange={(e) => setServer(e.target.value)} placeholder="notes.example.com" spellCheck={false} autoFocus />
            <button className="primary-button" disabled={!server.trim() || busy !== null}>
              {busy === "config" ? t("connecting") : t("continue")}
            </button>
          </form>
        ) : (
          <div className="signin-form">
            {busy === "browser" ? (
              <>
                <p className="muted">{t(viaBrowser ? "waitingBrowser" : "waitingWindow")}</p>
                <span className="spinner large" />
              </>
            ) : config.providers.length ? (
              config.providers.map((p) => (
                <button key={p.id} className="primary-button" onClick={() => void start(p)}>
                  {t("signInWith", { name: p.name })}
                </button>
              ))
            ) : (
              <p className="muted">{t("noProviders")}</p>
            )}
            {busy !== "browser" && config.providers.length > 0 && (
              <label className="signin-option">
                <input type="checkbox" checked={viaBrowser} onChange={(e) => setViaBrowser(e.target.checked)} />
                {t("useBrowser")}
              </label>
            )}
            <button
              className="link-button"
              onClick={() => {
                setConfig(null);
                setBusy(null);
              }}
            >
              {busy === "browser" ? t("cancel") : t("changeServer")}
            </button>
          </div>
        )}
        {error && <p className="error-text">{error}</p>}
      </div>
    </div>
  );
}
