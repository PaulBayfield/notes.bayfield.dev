import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { makeFormats, makeT, resolveLang, type Formats, type Lang, type Translate } from "./i18n";
import { activeCustomTheme, themeVars, type CustomTheme } from "./prefs";

export type Theme = "system" | "light" | "dark" | "rosepine" | "rosepine-dawn";
export type EditorFont = "sans" | "serif" | "mono";

export interface Settings {
  theme: Theme;
  /** Custom themes, made on prefs.bayfield.dev and synced from there. */
  customThemes: CustomTheme[];
  /** The custom theme in use (its id), laid over `theme`; "" for none. */
  customTheme: string;
  language: "auto" | Lang;
  sidebar: boolean;
  /** Sidebar width in pixels, set by dragging its edge. */
  sidebarWidth: number;
  /** Right panel: the document's table of contents and details. */
  panel: boolean;
  /** Documents use the full window width instead of a reading column. */
  fullWidth: boolean;
  /** A document's sub-pages are listed under it. */
  subPages: boolean;
  font: EditorFont;
  fontSize: number;
  spellcheck: boolean;
  /** Collaborators' cursors show a small dot instead of their name (the name shows on hover). */
  minimiseCursorNames: boolean;
  /** Ids of expanded rows in the sidebar tree. */
  expanded: string[];
  /** Sidebar sections the user folded ("starred", or a collection id). */
  folded: string[];
  /** Desktop: last server signed in to. */
  lastServer: string;
  /** Reopened on launch: the open tab's page. */
  lastPath: string;
  /** Reopened on launch: every open tab's page (both, for a split tab), and which one was open. */
  tabs: string[];
  activeTab: number;
  /** Split view: the left side's share of the width. */
  splitRatio: number;
  /** Desktop: the close button hides the window to the tray instead of quitting. */
  closeToTray: boolean;
  /** Desktop: when launched at startup, stay in the tray. */
  startMinimized: boolean;
  /** A new version the user chose not to be told about again. */
  skippedUpdate: string;
  /** The server (origin) that `lastPath`, `tabs`, `expanded` and `folded` belong to. */
  activeServer: string;
  /** Those settings for the other servers, kept while another one is in use. */
  servers: Record<string, ServerSettings>;
}

/** Settings that only make sense on one server: they name its pages and collections. */
export type ServerSettings = Pick<Settings, "lastPath" | "tabs" | "activeTab" | "expanded" | "folded">;

/** Puts away the current server's own settings and brings back `server`'s. */
export function forServer(s: Settings, server: string): Partial<Settings> {
  if (s.activeServer === server) return {};
  // First run with this setting: what's there belongs to the server in use.
  if (!s.activeServer) return { activeServer: server };
  const servers = { ...s.servers, [s.activeServer]: { lastPath: s.lastPath, tabs: s.tabs, activeTab: s.activeTab, expanded: s.expanded, folded: s.folded } };
  // Saved before tabs existed: no tabs (the last page reopens instead).
  const saved: Partial<ServerSettings> | undefined = servers[server];
  const next: ServerSettings = { lastPath: "", expanded: [], folded: [], tabs: [], activeTab: 0, ...saved };
  delete servers[server];
  return { ...next, servers, activeServer: server };
}

const STORAGE_KEY = "notes.settings";
/** The custom theme's CSS variables, for index.html to set before the app loads (no flash). */
const THEME_VARS_KEY = "notes.themeVars";

const DEFAULTS: Settings = {
  theme: "system",
  customThemes: [],
  customTheme: "",
  language: "auto",
  sidebar: true,
  sidebarWidth: 248,
  panel: false,
  fullWidth: false,
  subPages: true,
  font: "sans",
  fontSize: 16,
  spellcheck: true,
  minimiseCursorNames: false,
  expanded: [],
  folded: [],
  lastServer: import.meta.env.VITE_OUTLINE_URL ?? "notes.bayfield.dev",
  lastPath: "",
  tabs: [],
  activeTab: 0,
  splitRatio: 0.5,
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
    // Match the installed app's title bar to the theme.
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
    if (bg) document.querySelector('meta[name="theme-color"]')?.setAttribute("content", bg);
  }, [resolvedTheme]);

  // A custom theme (made on prefs.bayfield.dev): its colours over its base theme.
  const customKey = JSON.stringify(activeCustomTheme(settings));
  const customVars = useMemo(() => {
    const custom = JSON.parse(customKey) as CustomTheme | null;
    if (!custom) return {};
    const vars = themeVars(custom);
    if (custom.colors.bg || custom.colors.text) vars["--bg-weekend"] = "color-mix(in srgb, var(--bg) 97%, var(--text))";
    if (custom.colors["bg-sidebar"]) vars["--code-bg"] = "var(--bg-sidebar)";
    return vars;
  }, [customKey]);
  useEffect(() => {
    const root = document.documentElement.style;
    try {
      // What index.html set from the last session, if this theme no longer sets it.
      for (const k of Object.keys(JSON.parse(localStorage.getItem(THEME_VARS_KEY) ?? "{}") as object)) if (!(k in customVars)) root.removeProperty(k);
    } catch {
      // Nothing was set then.
    }
    for (const [k, v] of Object.entries(customVars)) root.setProperty(k, v);
    try {
      if (Object.keys(customVars).length) localStorage.setItem(THEME_VARS_KEY, JSON.stringify(customVars));
      else localStorage.removeItem(THEME_VARS_KEY);
    } catch {
      // Only the first paint uses it.
    }
    // The installed app's title bar follows the background.
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
    if (bg) document.querySelector('meta[name="theme-color"]')?.setAttribute("content", bg);
    return () => {
      for (const k of Object.keys(customVars)) root.removeProperty(k);
    };
  }, [customVars]);

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
