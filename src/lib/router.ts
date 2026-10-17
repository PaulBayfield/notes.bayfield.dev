// Minimal navigation with back/forward. The web build mirrors it in the address bar;
// the desktop build keeps it in memory.

import { useCallback, useEffect, useState } from "react";
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

export function parseRoute(path: string): Route {
  const m = path.match(/^\/?(doc|collection)\/(?:[^/]*-)?([\w-]+)\/?$/);
  if (m?.[1] === "doc") return { name: "doc", id: m[2] };
  if (m?.[1] === "collection") return { name: "collection", id: m[2] };
  const page = path.replace(/^\/|\/$/g, "") as ListPage;
  if (LIST_PAGES.includes(page)) return { name: page };
  return { name: "home" };
}

export const sameRoute = (a: Route, b: Route) => routePath(a) === routePath(b);

interface History {
  stack: Route[];
  index: number;
}

export function useRouter(initial: Route) {
  const [history, setHistory] = useState<History>(() => {
    if (!isTauri) {
      const fromUrl = parseRoute(location.pathname.slice(BASE.length - 1));
      window.history.replaceState({ i: 0 }, "", BASE + routePath(fromUrl) + location.search);
      return { stack: [fromUrl], index: 0 };
    }
    return { stack: [initial], index: 0 };
  });

  const navigate = useCallback((route: Route, replace = false) => {
    setHistory((h) => {
      if (sameRoute(h.stack[h.index], route)) return h;
      const index = replace ? h.index : h.index + 1;
      const stack = [...h.stack.slice(0, index), route];
      if (!isTauri) window.history[replace ? "replaceState" : "pushState"]({ i: index }, "", BASE + routePath(route) + location.search);
      return { stack, index };
    });
  }, []);

  const go = useCallback((delta: 1 | -1) => {
    if (!isTauri) return window.history.go(delta);
    setHistory((h) => {
      const index = h.index + delta;
      return index < 0 || index >= h.stack.length ? h : { ...h, index };
    });
  }, []);

  // Web: the browser's own back/forward buttons.
  useEffect(() => {
    if (isTauri) return;
    const onPop = (e: PopStateEvent) => {
      const i = typeof e.state?.i === "number" ? e.state.i : -1;
      setHistory((h) => {
        if (i >= 0 && i < h.stack.length && sameRoute(h.stack[i], parseRoute(location.pathname.slice(BASE.length - 1)))) return { ...h, index: i };
        return { stack: [parseRoute(location.pathname.slice(BASE.length - 1))], index: 0 };
      });
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  return {
    route: history.stack[history.index],
    navigate,
    back: () => go(-1),
    forward: () => go(1),
    canBack: history.index > 0,
    canForward: history.index < history.stack.length - 1,
  };
}
