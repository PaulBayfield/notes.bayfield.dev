import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight, Check } from "./icons";

export type MenuEntry =
  | { kind?: "item"; label: string; icon?: ReactNode; onClick: () => void; danger?: boolean; kbd?: string; checked?: boolean; disabled?: boolean }
  | { kind: "submenu"; label: string; icon?: ReactNode; items: MenuEntry[] }
  | { kind: "toggle"; label: string; checked: boolean; onChange: (checked: boolean) => void }
  | { kind: "separator" };

/** Drops leading, trailing and doubled separators (left by hidden items). */
function tidy(entries: (MenuEntry | false | null | undefined)[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const e of entries) {
    if (!e) continue;
    if (e.kind === "separator" && (!out.length || out[out.length - 1].kind === "separator")) continue;
    out.push(e);
  }
  while (out.length && out[out.length - 1].kind === "separator") out.pop();
  return out;
}

export const menu = tidy;

/** A list of menu entries, with submenus that open on hover. */
export function MenuList({ items, onClose }: { items: MenuEntry[]; onClose: () => void }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <>
      {items.map((item, i) => {
        if (item.kind === "separator") return <div key={i} className="menu-separator" />;
        if (item.kind === "toggle")
          return (
            <label key={i} className="menu-toggle" onMouseEnter={() => setOpen(null)}>
              <span>{item.label}</span>
              <input type="checkbox" className="switch" checked={item.checked} onChange={(e) => item.onChange(e.target.checked)} />
            </label>
          );
        if (item.kind === "submenu")
          return (
            <div key={i} className="menu-sub-anchor" onMouseEnter={() => setOpen(i)} onMouseLeave={() => setOpen((o) => (o === i ? null : o))}>
              <button className={open === i ? "hover" : ""} onClick={() => setOpen(open === i ? null : i)}>
                <span className="menu-item-icon">{item.icon}</span>
                <span className="menu-item-label">{item.label}</span>
                <ChevronRight size={14} />
              </button>
              {open === i && <Submenu items={item.items} onClose={onClose} />}
            </div>
          );
        return (
          <button
            key={i}
            className={item.danger ? "danger" : ""}
            disabled={item.disabled}
            onMouseEnter={() => setOpen(null)}
            onClick={() => {
              onClose();
              item.onClick();
            }}
          >
            <span className="menu-item-icon">{item.checked ? <Check size={14} /> : item.icon}</span>
            <span className="menu-item-label">{item.label}</span>
            {item.kbd && <kbd>{item.kbd}</kbd>}
          </button>
        );
      })}
    </>
  );
}

function Submenu({ items, onClose }: { items: MenuEntry[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [flip, setFlip] = useState(false);
  useLayoutEffect(() => {
    const rect = ref.current?.getBoundingClientRect();
    if (rect && rect.right > window.innerWidth - 8) setFlip(true);
  }, []);
  return (
    <div ref={ref} className={`menu submenu${flip ? " flip" : ""}`} role="menu">
      <MenuList items={items} onClose={onClose} />
    </div>
  );
}
