import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { NavNode } from "../lib/api";
import { useSettings } from "../lib/settings";
import type { Workspace } from "../lib/workspace";
import { EntityIcon } from "./EntityIcon";
import { FileText, X } from "./icons";

export function Dialog({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const { t } = useSettings();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`dialog${wide ? " wide" : ""}`} role="dialog" aria-label={title}>
        <div className="dialog-header">
          <h2>{title}</h2>
          <button className="icon-button small" aria-label={t("close")} onClick={onClose}>
            <X />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  message,
  confirm,
  danger,
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  confirm: string;
  danger?: boolean;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}) {
  const { t } = useSettings();
  const [busy, setBusy] = useState(false);
  return (
    <Dialog title={title} onClose={onClose}>
      <p className="dialog-text">{message}</p>
      <div className="dialog-actions">
        <button className="text-button" onClick={onClose}>
          {t("cancel")}
        </button>
        <button
          className={`primary-button${danger ? " danger" : ""}`}
          disabled={busy}
          autoFocus
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
              onClose();
            } finally {
              setBusy(false);
            }
          }}
        >
          {confirm}
        </button>
      </div>
    </Dialog>
  );
}

/** Pick a new place for a document: a collection's top level, or under another document. */
export function MoveDialog({
  workspace,
  docId,
  title,
  onMove,
  onClose,
}: {
  workspace: Workspace;
  docId: string;
  title: string;
  onMove: (collectionId: string, parentId: string | null) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useSettings();
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<{ collectionId: string; parentId: string | null } | null>(null);
  const [busy, setBusy] = useState(false);

  const rows = useMemo(() => {
    const out: { key: string; label: string; depth: number; icon?: string | null; color?: string | null; collectionId: string; parentId: string | null; isCollection: boolean }[] = [];
    const q = query.trim().toLowerCase();
    for (const c of workspace.collections) {
      out.push({ key: c.id, label: c.name, depth: 0, icon: c.icon, color: c.color, collectionId: c.id, parentId: null, isCollection: true });
      const walk = (nodes: NavNode[], depth: number) => {
        for (const n of nodes) {
          // Not into itself or its own children.
          if (n.id === docId) continue;
          if (!q || n.title.toLowerCase().includes(q))
            out.push({ key: n.id, label: n.title || t("untitled"), depth, icon: n.icon, color: n.color, collectionId: c.id, parentId: n.id, isCollection: false });
          walk(n.children, depth + 1);
        }
      };
      walk(workspace.trees[c.id] ?? [], 1);
    }
    return q ? out.filter((r) => r.isCollection || r.label.toLowerCase().includes(q)) : out;
  }, [workspace, docId, query, t]);

  return (
    <Dialog title={t("moveTitle", { title: title || t("untitled") })} onClose={onClose}>
      <input className="text-input" autoFocus placeholder={t("searchPlaceholder")} value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="move-list">
        {rows.map((r) => {
          const selected = target?.collectionId === r.collectionId && target.parentId === r.parentId;
          return (
            <button
              key={r.key}
              className={`move-row${selected ? " active" : ""}${r.isCollection ? " collection" : ""}`}
              style={{ paddingLeft: 10 + (query ? 0 : r.depth * 16) }}
              onClick={() => setTarget({ collectionId: r.collectionId, parentId: r.parentId })}
              onDoubleClick={() => setTarget({ collectionId: r.collectionId, parentId: r.parentId })}
            >
              <span className="tree-icon">
                <EntityIcon icon={r.icon} color={r.color} size={18} fallback={r.isCollection ? <span className="collection-dot" style={{ ["--c" as string]: r.color ?? "var(--primary)" }} /> : <FileText size={14} />} />
              </span>
              <span className="tree-title">{r.label}</span>
            </button>
          );
        })}
      </div>
      <div className="dialog-actions">
        <button className="text-button" onClick={onClose}>
          {t("cancel")}
        </button>
        <button
          className="primary-button"
          disabled={!target || busy}
          onClick={async () => {
            if (!target) return;
            setBusy(true);
            try {
              await onMove(target.collectionId, target.parentId);
              onClose();
            } finally {
              setBusy(false);
            }
          }}
        >
          {t("move")}
        </button>
      </div>
    </Dialog>
  );
}
