// Desktop-only integration: tray menu, close-to-tray, launch at startup.

import { useEffect, useRef } from "react";
import { recentlyViewed } from "./api";
import type { Translate } from "./i18n";
import { isTauri } from "./platform";
import { onRealtime } from "./realtime";

async function invoke(cmd: string, args?: Record<string, unknown>) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

/** Whether the app launches when the user logs in to Windows. */
export async function getAutostart(): Promise<boolean> {
  const { isEnabled } = await import("@tauri-apps/plugin-autostart");
  return isEnabled();
}

export async function setAutostart(on: boolean): Promise<void> {
  const { enable, disable } = await import("@tauri-apps/plugin-autostart");
  await (on ? enable() : disable());
}

/** Keeps the native side (close button, startup, tray labels) in step with settings. */
export function useDesktopSync(closeToTray: boolean, startMinimized: boolean, t: Translate) {
  useEffect(() => {
    if (isTauri) void invoke("set_close_to_tray", { enabled: closeToTray });
  }, [closeToTray]);

  useEffect(() => {
    if (isTauri) void invoke("set_start_minimized", { minimized: startMinimized });
  }, [startMinimized]);

  const labels = JSON.stringify({ open: t("trayOpen"), quit: t("trayQuit"), heading: t("trayRecent") });
  useEffect(() => {
    if (isTauri) void invoke("set_tray_labels", JSON.parse(labels));
  }, [labels]);
}

/**
 * Lists the recently viewed pages in the tray, and opens one when it's picked there.
 * `trigger` changes when the user opens something, so the list follows along.
 */
export function useTrayRecents(trigger: unknown, untitled: string, onOpen: (id: string) => void) {
  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      recentlyViewed(8)
        .then((docs) => !cancelled && invoke("set_tray_docs", { docs: docs.map((d) => ({ id: d.id, title: d.title || untitled })) }))
        .catch(() => {});
    }, 1500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [trigger, untitled]);

  // Titles change too: refresh on renames.
  useEffect(() => {
    if (!isTauri) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    return onRealtime(({ event }) => {
      if (!event.startsWith("documents.")) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        recentlyViewed(8)
          .then((docs) => invoke("set_tray_docs", { docs: docs.map((d) => ({ id: d.id, title: d.title || untitled })) }))
          .catch(() => {});
      }, 3000);
    });
  }, [untitled]);

  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen<string>("tray-open-doc", (e) => openRef.current(e.payload)).then((u) => (unlisten = u)),
    );
    return () => unlisten?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** Signed out: nothing personal stays in the tray. */
export function clearTray() {
  if (isTauri) void invoke("set_tray_docs", { docs: [] });
}
