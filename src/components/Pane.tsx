// One page in the main area: the whole of it, or one side of a split view. It remembers how far
// down its page was scrolled (per tab, side and history entry), and brings that back when the
// page is shown again: switching tabs, or going back and forward.

import { useEffect, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { useSettings } from "../lib/settings";
import { X } from "./icons";

/** Scroll positions by `scrollKey`, for this session. */
const scrolled = new Map<string, number>();

/** How long to keep trying while the page loads (a long document can take a moment). */
const RESTORE_MS = 4000;

interface Props {
  /** Names the page as shown here: tab, side, history entry and page. */
  scrollKey: string;
  /** In split view: the side the toolbar and shortcuts act on. */
  focused: boolean;
  split: boolean;
  onFocus: () => void;
  onClose: () => void;
  style?: CSSProperties;
  children: ReactNode;
}

export function Pane(p: Props) {
  const { t } = useSettings();
  const ref = useRef<HTMLDivElement>(null);
  /** While the old position is being put back, scrolling isn't remembered. */
  const restoring = useRef(false);

  // Remember the position as the page is scrolled (scroll events don't bubble: caught on the way down).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = (e: Event) => {
      const target = e.target as HTMLElement;
      if (restoring.current || !target.classList?.contains("doc-scroll")) return;
      scrolled.set(p.scrollKey, target.scrollTop);
    };
    el.addEventListener("scroll", onScroll, true);
    return () => el.removeEventListener("scroll", onScroll, true);
  }, [p.scrollKey]);

  // Put it back once the page is long enough: documents load after the page appears.
  useLayoutEffect(() => {
    const target = scrolled.get(p.scrollKey) ?? 0;
    const el = ref.current;
    if (!target || !el) return;
    restoring.current = true;
    const start = performance.now();
    let frame = 0;
    const stop = () => {
      restoring.current = false;
      cancelAnimationFrame(frame);
      el.removeEventListener("wheel", stop, true);
      el.removeEventListener("pointerdown", stop, true);
      el.removeEventListener("keydown", stop, true);
    };
    const tick = () => {
      const scroller = el.querySelector<HTMLElement>(".doc-scroll");
      if (scroller) {
        scroller.scrollTop = target;
        if (Math.abs(scroller.scrollTop - target) < 2) return stop();
      }
      if (performance.now() - start > RESTORE_MS) return stop();
      frame = requestAnimationFrame(tick);
    };
    // Scrolling or clicking meanwhile: the reader has moved on, leave it be.
    el.addEventListener("wheel", stop, true);
    el.addEventListener("pointerdown", stop, true);
    el.addEventListener("keydown", stop, true);
    tick();
    return stop;
  }, [p.scrollKey]);

  return (
    <div
      ref={ref}
      className={`pane${p.split ? " split" : ""}${p.split && p.focused ? " focused" : ""}`}
      style={p.style}
      onPointerDownCapture={p.onFocus}
      onFocusCapture={p.onFocus}
    >
      {p.split && (
        <button className="pane-close icon-button small" title={t("closePane")} aria-label={t("closePane")} onClick={p.onClose}>
          <X size={13} />
        </button>
      )}
      {p.children}
    </div>
  );
}
