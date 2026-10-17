// Collections, their document trees and stars. Kept current by Outline's live events, with a
// slow refresh as a safety net.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { collectionTree, listCollections, listStars, type Collection, type Doc, type NavNode, type Star } from "./api";
import { collectionIdsOf, onRealtime } from "./realtime";

const REFRESH_MS = 10 * 60 * 1000;
const FOCUS_REFRESH_MS = 60 * 1000;

export interface Located {
  node: NavNode;
  collection: Collection;
  /** Ancestors, root first. */
  path: NavNode[];
}

export function useWorkspace(onError: (e: unknown) => void) {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [trees, setTrees] = useState<Record<string, NavNode[]>>({});
  const [stars, setStars] = useState<{ stars: Star[]; documents: Doc[] }>({ stars: [], documents: [] });
  const [loaded, setLoaded] = useState(false);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const refresh = useCallback(async () => {
    try {
      const [cols, starred] = await Promise.all([listCollections(), listStars()]);
      cols.sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0));
      const treeList = await Promise.all(cols.map((c) => collectionTree(c.id).catch(() => [] as NavNode[])));
      setCollections(cols);
      setTrees(Object.fromEntries(cols.map((c, i) => [c.id, treeList[i]])));
      setStars(starred);
      setLoaded(true);
    } catch (e) {
      onErrorRef.current(e);
    }
  }, []);

  const refreshCollection = useCallback(async (id: string) => {
    try {
      const tree = await collectionTree(id);
      setTrees((t) => ({ ...t, [id]: tree }));
    } catch (e) {
      onErrorRef.current(e);
    }
  }, []);

  const refreshStars = useCallback(async () => {
    try {
      setStars(await listStars());
    } catch (e) {
      onErrorRef.current(e);
    }
  }, []);

  useEffect(() => {
    void refresh();
    let last = Date.now();
    const tick = () => {
      last = Date.now();
      void refresh();
    };
    const timer = setInterval(tick, REFRESH_MS);
    const onFocus = () => Date.now() - last > FOCUS_REFRESH_MS && tick();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  // Live events: refetch just what changed, batched (a move touches several collections at once).
  useEffect(() => {
    let collectionsDirty = new Set<string>();
    let all = false;
    let stars = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wasDisconnected = false;
    const flush = () => {
      timer = undefined;
      if (all) void refresh();
      else collectionsDirty.forEach((id) => void refreshCollection(id));
      if (stars && !all) void refreshStars();
      collectionsDirty = new Set();
      all = stars = false;
    };
    const schedule = () => (timer ??= setTimeout(flush, 300));
    return onRealtime(({ event, data }) => {
      if (event === "disconnected") wasDisconnected = true;
      else if (event === "connected") {
        // Events may have been missed while offline.
        if (wasDisconnected) (all = true), schedule();
        wasDisconnected = false;
      } else if (event.startsWith("collections.")) (all = true), schedule();
      else if (event.startsWith("stars.")) (stars = true), schedule();
      else if (event === "entities" || event.startsWith("documents.")) {
        const ids = collectionIdsOf(data);
        if (ids.length) ids.forEach((id) => collectionsDirty.add(id));
        else if (event !== "entities") all = true;
        // Titles and icons of starred documents live in the stars list.
        stars = true;
        schedule();
      }
    });
  }, [refresh, refreshCollection, refreshStars]);

  /** Optimistically renames a document everywhere it appears. */
  const renameLocal = useCallback((id: string, title: string) => {
    const rename = (nodes: NavNode[]): NavNode[] => nodes.map((n) => (n.id === id ? { ...n, title } : n.children.length ? { ...n, children: rename(n.children) } : n));
    setTrees((t) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, rename(v)])));
    setStars((s) => ({ ...s, documents: s.documents.map((d) => (d.id === id ? { ...d, title } : d)) }));
  }, []);

  const index = useMemo(() => {
    const map = new Map<string, Located>();
    for (const collection of collections) {
      const walk = (nodes: NavNode[], path: NavNode[]) => {
        for (const node of nodes) {
          const located = { node, collection, path };
          map.set(node.id, located);
          const urlId = node.url.split("-").pop();
          if (urlId) map.set(urlId, located);
          walk(node.children, [...path, node]);
        }
      };
      walk(trees[collection.id] ?? [], []);
    }
    return map;
  }, [collections, trees]);

  return { collections, trees, stars, loaded, refresh, refreshCollection, refreshStars, renameLocal, locate: (id: string) => index.get(id) };
}

export type Workspace = ReturnType<typeof useWorkspace>;

/** Outline icons are either an emoji or the name of one of its own icons (which we don't ship). */
export function emojiIcon(icon: string | null | undefined): string | null {
  return icon && /\p{Extended_Pictographic}/u.test(icon) ? icon : null;
}
