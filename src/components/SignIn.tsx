import { useEffect, useState } from "react";
import { forgetWorkspace, host, listAccounts, savedSessions, switchWorkspace, type Account } from "../lib/accounts";
import { serverConfig, signIn, type Provider, type ServerConfig } from "../lib/auth";
import { isTauri } from "../lib/platform";
import { useSettings } from "../lib/settings";
import { Avatar } from "./Avatar";
import { X } from "./icons";
import { WindowControls } from "./Toolbar";

interface Props {
  error: string | null;
  onSignedIn: () => void;
  /** Adding a workspace: the one in use, left out of the list. */
  current?: string;
  /** Adding a workspace: go back to the one in use. */
  onCancel?: () => void;
  /** A server to show the sign-in options of right away. */
  start?: string;
}

export function SignIn({ error: initialError, onSignedIn, current, onCancel, start: startServer }: Props) {
  const { t, settings, update } = useSettings();
  const [server, setServer] = useState(startServer ? host(startServer) : current ? "" : settings.lastServer);
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [busy, setBusy] = useState<"config" | "browser" | "switch" | null>(null);
  const [error, setError] = useState<string | null>(initialError);
  const [accounts, setAccounts] = useState<Account[]>(() => (isTauri ? listAccounts().filter((a) => a.server !== current) : []));
  /** Workspaces still signed in on this device: picking one needs no sign-in. */
  const [saved, setSaved] = useState<Set<string>>(new Set());
  useEffect(() => {
    void savedSessions().then(setSaved);
  }, []);

  const lookup = async (address = server) => {
    setBusy("config");
    setError(null);
    try {
      const next = await serverConfig(address);
      setConfig(next);
      update({ lastServer: host(next.server) });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (startServer) void lookup(startServer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pick = async (account: Account) => {
    if (!saved.has(account.server)) {
      setServer(host(account.server));
      return void lookup(account.server);
    }
    setBusy("switch");
    setError(null);
    try {
      await switchWorkspace(account.server);
    } catch (e) {
      // Its session is gone after all: sign in again.
      setSaved((s) => new Set([...s].filter((x) => x !== account.server)));
      setBusy(null);
      setServer(host(account.server));
      void lookup(account.server);
      setError(String(e));
    }
  };

  const remove = async (account: Account) => {
    try {
      await forgetWorkspace(account.server);
      setAccounts((list) => list.filter((a) => a.server !== account.server));
    } catch (e) {
      setError(String(e));
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
        <h1>{config?.name ?? (current ? t("addWorkspace") : t("appName"))}</h1>
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
          <div className="signin-form">
            {accounts.length > 0 && (
              <>
                <div className="signin-section">{t("recentServers")}</div>
                <div className="workspace-list">
                  {accounts.map((a) => (
                    <div key={a.server} className="workspace-item">
                      <button className="workspace-pick" disabled={busy !== null} onClick={() => void pick(a)}>
                        <Avatar user={{ name: a.name, color: "var(--primary)", avatarUrl: a.logo }} size={32} className="square" />
                        <span className="workspace-text">
                          <span className="workspace-name">{a.name}</span>
                          <span className="workspace-host">{a.userEmail ? `${host(a.server)} · ${a.userEmail}` : host(a.server)}</span>
                        </span>
                        {!saved.has(a.server) && <span className="badge">{t("signedOutWorkspace")}</span>}
                      </button>
                      <button className="icon-button small" title={t("removeWorkspace")} aria-label={t("removeWorkspace")} disabled={busy !== null} onClick={() => void remove(a)}>
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="signin-section">{t("otherServer")}</div>
              </>
            )}
            <form
              className="signin-form"
              onSubmit={(e) => {
                e.preventDefault();
                void lookup();
              }}
            >
              {accounts.length === 0 && <p className="muted">{t("signinHint")}</p>}
              <input
                className="text-input"
                aria-label={t("serverLabel")}
                value={server}
                onChange={(e) => setServer(e.target.value)}
                placeholder="notes.example.com"
                spellCheck={false}
                autoFocus={accounts.length === 0}
              />
              <button className="primary-button" disabled={!server.trim() || busy !== null}>
                {busy === "config" ? t("connecting") : busy === "switch" ? t("switching") : t("continue")}
              </button>
            </form>
            {onCancel && (
              <button className="link-button" onClick={onCancel}>
                {t("cancel")}
              </button>
            )}
          </div>
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
