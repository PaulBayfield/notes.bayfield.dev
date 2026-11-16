// The open tabs, under the toolbar once there's more than one. Click to switch, middle-click or
// the cross to close, drag to reorder, "+" (or Ctrl+T) for a new tab.

import { useState, type DragEvent, type MouseEvent, type ReactNode } from "react";
import { useSettings } from "../lib/settings";
import { mod } from "../lib/platform";
import { Plus, X } from "./icons";

export interface TabInfo {
  id: number;
  title: string;
  icon: ReactNode;
}

interface Props {
  tabs: TabInfo[];
  active: number;
  onSelect: (index: number) => void;
  onClose: (index: number) => void;
  onNew: () => void;
  onMove: (from: number, to: number) => void;
  onContextMenu: (index: number, e: MouseEvent) => void;
}

const DRAG_TYPE = "application/x-notes-tab";

export function TabBar(p: Props) {
  const { t } = useSettings();
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<{ index: number; after: boolean } | null>(null);

  const onDragOver = (index: number) => (e: DragEvent<HTMLDivElement>) => {
    if (dragging === null || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = e.currentTarget.getBoundingClientRect();
    setOver({ index, after: e.clientX > rect.left + rect.width / 2 });
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    if (dragging !== null && over) {
      let to = over.index + (over.after ? 1 : 0);
      if (to > dragging) to--;
      p.onMove(dragging, to);
    }
    setDragging(null);
    setOver(null);
  };

  return (
    <div className="tab-bar" role="tablist" onDragLeave={(e) => e.currentTarget === e.target && setOver(null)}>
      {p.tabs.map((tab, i) => (
        <div
          key={tab.id}
          role="tab"
          aria-selected={i === p.active}
          tabIndex={i === p.active ? 0 : -1}
          className={[
            "tab",
            i === p.active && "active",
            dragging === i && "dragging",
            over?.index === i && (over.after ? "drop-after" : "drop-before"),
          ]
            .filter(Boolean)
            .join(" ")}
          title={tab.title}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(DRAG_TYPE, String(i));
            e.dataTransfer.effectAllowed = "move";
            setDragging(i);
          }}
          onDragOver={onDragOver(i)}
          onDrop={onDrop}
          onDragEnd={() => {
            setDragging(null);
            setOver(null);
          }}
          onClick={() => p.onSelect(i)}
          onMouseDown={(e) => e.button === 1 && e.preventDefault()}
          onAuxClick={(e) => {
            if (e.button !== 1) return;
            e.preventDefault();
            p.onClose(i);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            p.onContextMenu(i, e);
          }}
        >
          <span className="tab-icon">{tab.icon}</span>
          <span className="tab-title">{tab.title}</span>
          <button
            className="tab-close"
            title={`${t("closeTab")} (${mod}+W)`}
            aria-label={t("closeTab")}
            onClick={(e) => {
              e.stopPropagation();
              p.onClose(i);
            }}
          >
            <X size={12} />
          </button>
        </div>
      ))}
      <button className="tab-new icon-button" title={`${t("newTab")} (${mod}+T)`} aria-label={t("newTab")} onClick={p.onNew}>
        <Plus size={14} />
      </button>
    </div>
  );
}
