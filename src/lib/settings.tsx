import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { makeFormats, makeT, resolveLang, type Formats, type Lang, type Translate } from "./i18n";

export type Theme = "system" | "light" | "dark" | "rosepine" | "rosepine-dawn";
export type EditorFont = "sans" | "serif" | "mono";

export interface Settings {
  theme: Theme;
  language: "auto" | Lang;
  sidebar: boolean;
  /** Sidebar width in pixels, set by dragging its edge. */
  sidebarWidth: number;
  /** Right panel: the document's table of contents and details. */
  panel: boolean;
  /** Documents use the full window width instead of a reading column. */
  fullWidth: boolean;
  font: EditorFont;
  fontSize: number;
  spellcheck: boolean;
  /** Ids of expanded rows in the sidebar tree. */
  expanded: string[];
  /** Sidebar sections the user folded ("starred", or a collection id). */
  folded: string[];
  /** Desktop: last server signed in to. */
  lastServer: string;
  /** Reopened on launch. */
  lastPath: string;
  /** Desktop: the close button hides the window to the tray instead of quitting. */
  closeToTray: boolean;
  /** Desktop: when launched at startup, stay in the tray. */
  startMinimized: boolean;
  /** A new version the user chose not to be told about again. */
  skippedUpdate: string;
  /** The server (origin) that `lastPath`, `expanded` and `folded` belong to. */
  activeServer: string;
  /** Those settings for the other servers, kept while another one is in use. */
  servers: Record<string, ServerSettings>;
}

/** Settings that only make sense on one server: they name its pages and collections. */
export type ServerSettings = Pick<Settings, "lastPath" | "expanded" | "folded">;

/** Puts away the current server's own settings and brings back `server`'s. */
export function forServer(s: Settings, server: string): Partial<Settings> {
  if (s.activeServer === server) return {};
  // First run with this setting: what's there belongs to the server in use.
  if (!s.activeServer) return { activeServer: server };
  const servers = { ...s.servers, [s.activeServer]: { lastPath: s.lastPath, expanded: s.expanded, folded: s.folded } };
  const next = servers[server] ?? { lastPath: "", expanded: [], folded: [] };
  delete servers[server];
  return { ...next, servers, activeServer: server };
}

const STORAGE_KEY = "notes.settings";

const DEFAULTS: Settings = {
  theme: "system",
  language: "auto",
  sidebar: true,
  sidebarWidth: 248,
  panel: false,
  fullWidth: false,
  font: "sans",
  fontSize: 16,
  spellcheck: true,
  expanded: [],
  folded: [],
  lastServer: import.meta.env.VITE_OUTLINE_URL ?? "notes.bayfield.dev",
  lastPath: "",
  closeToTray: true,
  startMinimized: true,
  skippedUpdate: "",
  activeServer: "",
  servers: {},
};

function load(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") };
  } catch {
    return DEFAULTS;
  }
}

function save(settings: Settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Not critical.
  }
}

interface SettingsContextValue {
  settings: Settings;
  update: (patch: Partial<Settings> | ((s: Settings) => Partial<Settings>)) => void;
  t: Translate;
  f: Formats;
  lang: Lang;
}

// Kept across dev hot reloads, so components loaded before and after a reload share it.
const SettingsContext: React.Context<SettingsContextValue | null> = (import.meta.hot?.data.settingsContext as React.Context<SettingsContextValue | null> | undefined) ?? createContext<SettingsContextValue | null>(null);
if (import.meta.hot) import.meta.hot.data.settingsContext = SettingsContext;

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState(load);
  const [systemDark, setSystemDark] = useState(darkQuery.matches);

  useEffect(() => {
    const onChange = () => setSystemDark(darkQuery.matches);
    darkQuery.addEventListener("change", onChange);
    return () => darkQuery.removeEventListener("change", onChange);
  }, []);

  const resolvedTheme = settings.theme === "system" ? (systemDark ? "dark" : "light") : settings.theme;
  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
  }, [resolvedTheme]);

  const value = useMemo<SettingsContextValue>(() => {
    const lang = resolveLang(settings.language);
    document.documentElement.lang = lang;
    return {
      settings,
      update: (patch) =>
        setSettings((s) => {
          const next = { ...s, ...(typeof patch === "function" ? patch(s) : patch) };
          save(next);
          return next;
        }),
      t: makeT(lang),
      f: makeFormats(lang),
      lang,
    };
  }, [settings]);

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const value = useContext(SettingsContext);
  if (!value) throw new Error("useSettings outside SettingsProvider");
  return value;
}
