import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DOMSerializer, Fragment, type Node } from "prosemirror-model";
import { schema } from "../editor/schema";
import { resolveUrl } from "../lib/api";
import { isTauri } from "../lib/platform";
import { useSettings } from "../lib/settings";
import { EntityIcon } from "./EntityIcon";
import { ChevronLeft, ChevronRight, X } from "./icons";

/** Slides: a title slide, then one per h1/h2 heading or divider (same rule as Outline). */
function splitIntoSlides(doc: Node): Node[][] {
  const slides: Node[][] = [];
  let current: Node[] = [];
  doc.forEach((node) => {
    const isDivider = node.type === schema.nodes.hr;
    const isBreak = node.type === schema.nodes.heading && node.attrs.level <= 2;
    if ((isDivider || isBreak) && current.length) {
      slides.push(current);
      current = [];
    }
    if (!isDivider) current.push(node);
  });
  if (current.length) slides.push(current);
  return slides.filter((s) => s.some((n) => n.textContent.trim() || n.type.isAtom || n.childCount));
}

function SlideBody({ nodes }: { nodes: Node[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.replaceChildren(DOMSerializer.fromSchema(schema).serializeFragment(Fragment.from(nodes)));
    // Attachments need the app's authenticated URLs.
    el.querySelectorAll("img").forEach((img) => img.setAttribute("src", resolveUrl(img.getAttribute("src"))));
    el.querySelectorAll("a").forEach((a) => a.setAttribute("target", "_blank"));
  }, [nodes]);
  return <div ref={ref} className="doc-content slide-content" />;
}

export function Presentation({ title, icon, color, doc, onClose }: { title: string; icon?: string | null; color?: string | null; doc: Node; onClose: () => void }) {
  const { t } = useSettings();
  const slides = useMemo(() => splitIntoSlides(doc), [doc]);
  const [index, setIndex] = useState(0);
  const total = slides.length + 1;

  // Full screen while presenting.
  useEffect(() => {
    if (isTauri) {
      void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().setFullscreen(true));
      return () => void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().setFullscreen(false));
    }
    void document.documentElement.requestFullscreen?.().catch(() => {});
    return () => {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"].includes(e.key)) setIndex((i) => Math.min(total - 1, i + 1));
      else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(e.key)) setIndex((i) => Math.max(0, i - 1));
      else if (e.key === "Home") setIndex(0);
      else if (e.key === "End") setIndex(total - 1);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [onClose, total]);

  return (
    <div className="presentation" onClick={(e) => e.target === e.currentTarget && setIndex((i) => Math.min(total - 1, i + 1))}>
      <div className="slide" key={index}>
        {index === 0 ? (
          <div className="title-slide">
            {icon && <EntityIcon icon={icon} color={color} size={72} fallback={null} />}
            <h1>{title || t("untitled")}</h1>
          </div>
        ) : (
          <SlideBody nodes={slides[index - 1]} />
        )}
      </div>
      <div className="presentation-controls">
        <button className="icon-button" disabled={index === 0} onClick={() => setIndex((i) => i - 1)} aria-label={t("previous")}>
          <ChevronLeft />
        </button>
        <span>
          {index + 1} / {total}
        </span>
        <button className="icon-button" disabled={index === total - 1} onClick={() => setIndex((i) => i + 1)} aria-label={t("next")}>
          <ChevronRight />
        </button>
        <button className="icon-button" onClick={onClose} aria-label={t("close")} title="Esc">
          <X />
        </button>
      </div>
    </div>
  );
}
