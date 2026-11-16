// Navigation in tabs. A tab shows one page, or two side by side (split view); each of those
// panes has its own back/forward history, and one of them has the focus: the toolbar, the
// sidebar and the shortcuts act on it. The web build mirrors the focused page in the address bar
// (and its back/forward buttons); the desktop build keeps it all in memory.

import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "./platform";

export type ListPage = "drafts" | "archive" | "trash";

export type Route = { name: "home" } | { name: "doc"; id: string } | { name: "collection"; id: string } | { name: ListPage };

const LIST_PAGES: ListPage[] = ["drafts", "archive", "trash"];

const BASE = import.meta.env.BASE_URL;

export function routePath(r: Route): string {
  if (r.name === "doc") return `doc/${r.id}`;
  if (r.name === "collection") return `collection/${r.id}`;
  if (r.name === "home") return "";
  return r.name;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The id in a path segment: a whole UUID, or the url id after Outline's "title-" slug. */
function idOf(segment: string): string {
  return segment.match(UUID)?.[0] ?? segment.slice(segment.lastIndexOf("-") + 1);
}

export function parseRoute(path: string): Route {
  const m = path.match(/^\/?(doc|collection)\/([^/]+)\/?$/);
  if (m?.[1] === "doc") return { name: "doc", id: idOf(m[2]) };
  if (m?.[1] === "collection") return { name: "collection", id: idOf(m[2]) };
  const page = path.replace(/^\/|\/$/g, "") as ListPage;
  if (LIST_PAGES.includes(page)) return { name: page };
  return { name: "home" };
}

export const sameRoute = (a: Route, b: Route) => routePath(a) === routePath(b);

/** One side of a tab, with its own history. */
export interface Pane {
  stack: Route[];
  index: number;
}

export interface Tab {
  /** Stable for the tab's life (React keys, the web history, remembered scroll positions). */
  id: number;
  /** One pane, or two in split view (left, right). */
  panes: Pane[];
  /** The pane with the focus. */
  focus: number;
}

interface Tabs {
  tabs: Tab[];
  /** Index of the open tab. */
  active: number;
}

/** Closed tabs Ctrl+Shift+T can bring back, most recent last. */
const MAX_CLOSED = 20;

/** Between the two pages of a split tab when tabs are saved as text. */
const SPLIT_SEPARATOR = "||";

let nextId = 1;
const newPane = (route: Route): Pane => ({ stack: [route], index: 0 });
const newTab = (routes: Route[]): Tab => ({ id: nextId++, panes: routes.slice(0, 2).map(newPane), focus: 0 });
const paneRoute = (pane: Pane) => pane.stack[pane.index];
/** The page in the focused pane. */
const current = (tab: Tab) => paneRoute(tab.panes[tab.focus]);

/** A tab saved as text: its page, or both pages of a split ("doc/a||doc/b"). */
export const tabPath = (tab: Tab) => tab.panes.map((p) => routePath(paneRoute(p))).join(SPLIT_SEPARATOR);
export const parseTabPath = (path: string): Route[] => path.split(SPLIT_SEPARATOR).map(parseRoute);

const urlRoute = () => parseRoute(location.pathname.slice(BASE.length - 1));

/** Web: the address bar shows the focused page. */
function mirror(s: Tabs, push: boolean) {
  if (isTauri) return;
  const tab = s.tabs[s.active];
  const pane = tab.panes[tab.focus];
  const url = BASE + routePath(paneRoute(pane)) + location.search;
  window.history[push ? "pushState" : "replaceState"]({ tab: tab.id, pane: tab.focus, i: pane.index }, "", url);
}

/** A copy of `s` with the open tab changed by `fn`. */
function withTab(s: Tabs, fn: (tab: Tab) => Tab): Tabs {
  const tab = s.tabs[s.active];
  const next = fn(tab);
  if (next === tab) return s;
  const tabs = [...s.tabs];
  tabs[s.active] = next;
  return { ...s, tabs };
}

/** A copy of `tab` with its focused pane changed by `fn`. */
function withPane(tab: Tab, fn: (pane: Pane) => Pane): Tab {
  const pane = tab.panes[tab.focus];
  const next = fn(pane);
  if (next === pane) return tab;
  const panes = [...tab.panes];
  panes[tab.focus] = next;
  return { ...tab, panes };
}

/**
 * The open tabs, reopened from `initial` (each tab's pages, and which tab was open). On the web
 * a link to a page opens it in the open tab.
 */
export function useTabs(initial: Route[][], initialActive: number) {
  const [state, setState] = useState<Tabs>(() => {
    const saved = initial.filter((routes) => routes.length);
    const routes = saved.length ? saved : [[{ name: "home" } as Route]];
    const s: Tabs = { tabs: routes.map(newTab), active: Math.min(Math.max(0, initialActive), routes.length - 1) };
    if (!isTauri) {
      const fromUrl = urlRoute();
      if (fromUrl.name !== "home") s.tabs[s.active] = newTab([fromUrl]);
      mirror(s, false);
    }
    return s;
  });
  const closed = useRef<Route[][]>([]);

  /** Applies a change; `push` adds a web history entry, otherwise the current one is replaced. */
  const change = useCallback((fn: (s: Tabs) => Tabs, push = false) => {
    setState((s) => {
      const next = fn(s);
      if (next !== s) mirror(next, push);
      return next;
    });
  }, []);

  /** Opens a page in the focused pane. */
  const navigate = useCallback(
    (route: Route, replace = false) =>
      change(
        (s) =>
          withTab(s, (tab) =>
            withPane(tab, (pane) => {
              if (sameRoute(paneRoute(pane), route)) return pane;
              const index = replace ? pane.index : pane.index + 1;
              return { stack: [...pane.stack.slice(0, index), route], index };
            }),
          ),
        !replace,
      ),
    [change],
  );

  const go = useCallback(
    (delta: 1 | -1) =>
      change((s) =>
        withTab(s, (tab) =>
          withPane(tab, (pane) => {
            const index = pane.index + delta;
            return index < 0 || index >= pane.stack.length ? pane : { ...pane, index };
          }),
        ),
      ),
    [change],
  );

  /** Opens `route` in a new tab next to the open one; `focus` switches to it. */
  const openTab = useCallback(
    (route: Route = { name: "home" }, focus = true) =>
      change((s) => {
        const tabs = [...s.tabs];
        tabs.splice(s.active + 1, 0, newTab([route]));
        return { tabs, active: focus ? s.active + 1 : s.active };
      }, focus),
    [change],
  );

  /** Opens a copy of a tab (both its pages, in split view) next to it. */
  const duplicateTab = useCallback(
    (i: number) =>
      change((s) => {
        const tab = s.tabs[i];
        if (!tab) return s;
        const tabs = [...s.tabs];
        tabs.splice(i + 1, 0, { ...newTab(tab.panes.map(paneRoute)), focus: tab.focus });
        return { tabs, active: i + 1 };
      }, true),
    [change],
  );

  const selectTab = useCallback(
    (i: number) => change((s) => (i === s.active || i < 0 || i >= s.tabs.length ? s : { ...s, active: i })),
    [change],
  );

  /** Closes a tab (the open one by default). The last tab stays: closing it goes home instead. */
  const closeTab = useCallback(
    (i?: number) =>
      change((s) => {
        const at = i ?? s.active;
        const tab = s.tabs[at];
        if (!tab) return s;
        closed.current = [...closed.current, tab.panes.map(paneRoute)].slice(-MAX_CLOSED);
        if (s.tabs.length === 1) return { tabs: [newTab([{ name: "home" }])], active: 0 };
        const tabs = s.tabs.filter((_, k) => k !== at);
        // Closing the open tab opens the one to its right (or left, at the end), like a browser.
        const active = at < s.active ? s.active - 1 : at === s.active ? Math.min(at, tabs.length - 1) : s.active;
        return { tabs, active };
      }),
    [change],
  );

  const reopenClosedTab = useCallback(() => {
    const routes = closed.current.pop();
    if (!routes) return;
    change((s) => {
      const tabs = [...s.tabs];
      tabs.splice(s.active + 1, 0, newTab(routes));
      return { tabs, active: s.active + 1 };
    }, true);
  }, [change]);

  const moveTab = useCallback(
    (from: number, to: number) =>
      change((s) => {
        if (from === to || from < 0 || to < 0 || from >= s.tabs.length || to >= s.tabs.length) return s;
        const tabs = [...s.tabs];
        const [tab] = tabs.splice(from, 1);
        tabs.splice(to, 0, tab);
        const activeId = s.tabs[s.active].id;
        return { tabs, active: tabs.findIndex((t) => t.id === activeId) };
      }),
    [change],
  );

  /**
   * Split view: shows `route` (by default the focused page again) beside the focused page and
   * gives it the focus. Already split, it opens in the other pane.
   */
  const openSplit = useCallback(
    (route?: Route) =>
      change(
        (s) =>
          withTab(s, (tab) => {
            const page = route ?? current(tab);
            if (tab.panes.length === 1) return { ...tab, panes: [...tab.panes, newPane(page)], focus: 1 };
            const other = 1 - tab.focus;
            const pane = tab.panes[other];
            const panes = [...tab.panes];
            if (!sameRoute(paneRoute(pane), page)) panes[other] = { stack: [...pane.stack.slice(0, pane.index + 1), page], index: pane.index + 1 };
            return { ...tab, panes, focus: other };
          }),
        true,
      ),
    [change],
  );

  /** Closes one side of the split view; the other stays, alone. */
  const closePane = useCallback(
    (pane: number) =>
      change((s) =>
        withTab(s, (tab) => {
          if (tab.panes.length < 2) return tab;
          return { ...tab, panes: tab.panes.filter((_, k) => k !== pane), focus: 0 };
        }),
      ),
    [change],
  );

  /** Gives a pane of the open tab the focus (a click in it). */
  const focusPane = useCallback(
    (pane: number) => change((s) => withTab(s, (tab) => (tab.focus === pane || pane >= tab.panes.length ? tab : { ...tab, focus: pane }))),
    [change],
  );

  // Web: the browser's own back/forward buttons, which may lead to another tab's page.
  useEffect(() => {
    if (isTauri) return;
    const onPop = (e: PopStateEvent) => {
      const route = urlRoute();
      setState((s) => {
        const at = s.tabs.findIndex((t) => t.id === e.state?.tab);
        const tab = s.tabs[at];
        const p = typeof e.state?.pane === "number" ? e.state.pane : 0;
        const i = typeof e.state?.i === "number" ? e.state.i : -1;
        const pane = tab?.panes[p];
        if (tab && pane && i >= 0 && i < pane.stack.length && sameRoute(pane.stack[i], route)) {
          const panes = [...tab.panes];
          panes[p] = { ...pane, index: i };
          const tabs = [...s.tabs];
          tabs[at] = { ...tab, panes, focus: p };
          return { tabs, active: at };
        }
        // A page from before (or a closed tab): it opens in the focused pane.
        return withTab(s, (t) => withPane(t, () => newPane(route)));
      });
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const tab = state.tabs[state.active];
  const pane = tab.panes[tab.focus];
  return {
    /** The focused page. */
    route: current(tab),
    tabs: state.tabs,
    active: state.active,
    /** The open tab. */
    tab,
    navigate,
    back: () => go(-1),
    forward: () => go(1),
    canBack: pane.index > 0,
    canForward: pane.index < pane.stack.length - 1,
    openTab,
    duplicateTab,
    selectTab,
    closeTab,
    reopenClosedTab,
    moveTab,
    openSplit,
    closePane,
    focusPane,
    currentRoute: current,
    paneRoute,
  };
}

export type TabsApi = ReturnType<typeof useTabs>;
