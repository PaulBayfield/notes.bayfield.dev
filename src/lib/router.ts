// Navigation in tabs, each with its own back/forward history. The web build mirrors the open
// tab's page in the address bar (and its back/forward buttons); the desktop build keeps it all
// in memory.

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

export interface Tab {
  /** Stable for the tab's life (React keys, the web history). */
  id: number;
  stack: Route[];
  index: number;
}

interface Tabs {
  tabs: Tab[];
  /** Index of the open tab. */
  active: number;
}

/** Closed tabs Ctrl+Shift+T can bring back, most recent last. */
const MAX_CLOSED = 20;

let nextId = 1;
const newTab = (route: Route): Tab => ({ id: nextId++, stack: [route], index: 0 });
const current = (tab: Tab) => tab.stack[tab.index];

const urlRoute = () => parseRoute(location.pathname.slice(BASE.length - 1));

/** Web: the address bar shows the open tab's page. */
function mirror(s: Tabs, push: boolean) {
  if (isTauri) return;
  const tab = s.tabs[s.active];
  const url = BASE + routePath(current(tab)) + location.search;
  window.history[push ? "pushState" : "replaceState"]({ tab: tab.id, i: tab.index }, "", url);
}

/**
 * The open tabs, reopened from `initial` (pages, and which one was open). On the web a link to a
 * page opens it in the open tab.
 */
export function useTabs(initial: Route[], initialActive: number) {
  const [state, setState] = useState<Tabs>(() => {
    const routes = initial.length ? initial : [{ name: "home" } as Route];
    const s: Tabs = { tabs: routes.map(newTab), active: Math.min(Math.max(0, initialActive), routes.length - 1) };
    if (!isTauri) {
      const fromUrl = urlRoute();
      if (fromUrl.name !== "home") s.tabs[s.active] = newTab(fromUrl);
      mirror(s, false);
    }
    return s;
  });
  const closed = useRef<Route[]>([]);

  /** Applies a change; `push` adds a web history entry, otherwise the current one is replaced. */
  const change = useCallback((fn: (s: Tabs) => Tabs, push = false) => {
    setState((s) => {
      const next = fn(s);
      if (next !== s) mirror(next, push);
      return next;
    });
  }, []);

  const navigate = useCallback(
    (route: Route, replace = false) =>
      change((s) => {
        const tab = s.tabs[s.active];
        if (sameRoute(current(tab), route)) return s;
        const index = replace ? tab.index : tab.index + 1;
        const tabs = [...s.tabs];
        tabs[s.active] = { ...tab, stack: [...tab.stack.slice(0, index), route], index };
        return { ...s, tabs };
      }, !replace),
    [change],
  );

  const go = useCallback(
    (delta: 1 | -1) =>
      change((s) => {
        const tab = s.tabs[s.active];
        const index = tab.index + delta;
        if (index < 0 || index >= tab.stack.length) return s;
        const tabs = [...s.tabs];
        tabs[s.active] = { ...tab, index };
        return { ...s, tabs };
      }),
    [change],
  );

  /** Opens `route` in a new tab next to the open one; `focus` switches to it. */
  const openTab = useCallback(
    (route: Route = { name: "home" }, focus = true) =>
      change((s) => {
        const tabs = [...s.tabs];
        tabs.splice(s.active + 1, 0, newTab(route));
        return { tabs, active: focus ? s.active + 1 : s.active };
      }, focus),
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
        closed.current = [...closed.current, current(tab)].slice(-MAX_CLOSED);
        if (s.tabs.length === 1) return { tabs: [newTab({ name: "home" })], active: 0 };
        const tabs = s.tabs.filter((_, k) => k !== at);
        // Closing the open tab opens the one to its right (or left, at the end), like a browser.
        const active = at < s.active ? s.active - 1 : at === s.active ? Math.min(at, tabs.length - 1) : s.active;
        return { tabs, active };
      }),
    [change],
  );

  const reopenClosedTab = useCallback(() => {
    const route = closed.current.pop();
    if (route) openTab(route);
  }, [openTab]);

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

  // Web: the browser's own back/forward buttons, which may lead to another tab's page.
  useEffect(() => {
    if (isTauri) return;
    const onPop = (e: PopStateEvent) => {
      const route = urlRoute();
      setState((s) => {
        const at = s.tabs.findIndex((t) => t.id === e.state?.tab);
        const i = typeof e.state?.i === "number" ? e.state.i : -1;
        const tab = s.tabs[at];
        if (tab && i >= 0 && i < tab.stack.length && sameRoute(tab.stack[i], route)) {
          const tabs = [...s.tabs];
          tabs[at] = { ...tab, index: i };
          return { tabs, active: at };
        }
        // A page from before (or a closed tab): it opens in the open tab.
        const tabs = [...s.tabs];
        tabs[s.active] = { ...s.tabs[s.active], stack: [route], index: 0 };
        return { ...s, tabs };
      });
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const tab = state.tabs[state.active];
  return {
    route: current(tab),
    tabs: state.tabs,
    active: state.active,
    navigate,
    back: () => go(-1),
    forward: () => go(1),
    canBack: tab.index > 0,
    canForward: tab.index < tab.stack.length - 1,
    openTab,
    selectTab,
    closeTab,
    reopenClosedTab,
    moveTab,
    currentRoute: current,
  };
}

export type TabsApi = ReturnType<typeof useTabs>;
