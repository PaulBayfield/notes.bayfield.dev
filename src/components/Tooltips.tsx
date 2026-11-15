// The app's own tooltips in place of the browser's: every `title` in the app becomes one, so
// nothing has to opt in. They show sooner, match the theme and can span several lines ("\n").

import { useEffect, useLayoutEffect, useRef, useState } from "react";

const DELAY = 450;
/** Moving straight to another element with a tooltip shows it at once, as menus bars do. */
const WARM = 400;

interface Tip {
  text: string;
  rect: DOMRect;
}

/** Takes the native tooltip off an element (keeping it as its label) and returns its text. */
function claim(el: Element): string {
  const title = el.getAttribute("title");
  if (title !== null) {
    el.removeAttribute("title");
    if (title) {
      (el as HTMLElement).dataset.tip = title;
      // An icon button labelled only by its title keeps that label for screen readers.
      if (!el.hasAttribute("aria-label") && !el.textContent?.trim()) el.setAttribute("aria-label", title.split("\n")[0]);
    }
  }
  return (el as HTMLElement).dataset.tip ?? "";
}

export function Tooltips() {
  const [tip, setTip] = useState<Tip | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: Element | null = null;
    let hiddenAt = 0;
    const hide = () => {
      clearTimeout(timer);
      if (current) hiddenAt = Date.now();
      current = null;
      setTip(null);
    };
    const over = (e: MouseEvent) => {
      const el = e.target instanceof Element ? e.target.closest("[title], [data-tip]") : null;
      if (el === current) return;
      clearTimeout(timer);
      if (!el) return hide();
      const text = claim(el);
      if (!text) return hide();
      const wasShowing = current !== null || Date.now() - hiddenAt < WARM;
      current = el;
      setTip(null);
      const show = () => el.isConnected && current === el && setTip({ text, rect: el.getBoundingClientRect() });
      if (wasShowing) show();
      else timer = setTimeout(show, DELAY);
    };
    const out = (e: MouseEvent) => {
      // Left the window.
      if (!e.relatedTarget) hide();
    };
    document.addEventListener("mouseover", over);
    document.addEventListener("mouseout", out);
    // Anything the user does dismisses it.
    for (const type of ["mousedown", "keydown", "wheel", "blur"] as const) window.addEventListener(type, hide, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mouseover", over);
      document.removeEventListener("mouseout", out);
      for (const type of ["mousedown", "keydown", "wheel", "blur"] as const) window.removeEventListener(type, hide, true);
    };
  }, []);

  // Below the element, centred, kept inside the window; above it when there's no room below.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!tip || !el) return setPos(null);
    const { width, height } = el.getBoundingClientRect();
    const below = tip.rect.bottom + 6 + height < window.innerHeight - 4;
    setPos({
      left: Math.max(4, Math.min(tip.rect.left + tip.rect.width / 2 - width / 2, window.innerWidth - width - 4)),
      top: below ? tip.rect.bottom + 6 : tip.rect.top - 6 - height,
    });
  }, [tip]);

  if (!tip) return null;
  return (
    <div ref={ref} className="tooltip" role="tooltip" style={pos ? { left: pos.left, top: pos.top } : { visibility: "hidden" }}>
      {tip.text}
    </div>
  );
}
