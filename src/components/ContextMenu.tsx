import { useLayoutEffect, useRef, useState } from "react";
import { useDismiss } from "./Toolbar";
import { MenuList, type MenuEntry } from "./Menu";

/** A menu at the pointer, kept inside the window. */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuEntry[]; onClose: () => void }) {
  const ref = useDismiss(true, onClose);
  const inner = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({ left: Math.min(x, window.innerWidth - width - 8), top: Math.max(8, Math.min(y, window.innerHeight - height - 8)) });
  }, [x, y]);
  return (
    <div ref={ref}>
      <div ref={inner} className="menu context-menu" role="menu" style={{ position: "fixed", ...pos, right: "auto" }}>
        <MenuList items={items} onClose={onClose} />
      </div>
    </div>
  );
}
