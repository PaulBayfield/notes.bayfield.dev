import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { recentlyViewed, search, searchTitles, type Doc } from "../lib/api";
import { useSettings } from "../lib/settings";
import type { Workspace } from "../lib/workspace";
import { EntityIcon } from "./EntityIcon";
import { FileText, Search } from "./icons";

interface Result {
  key: string;
  doc: Doc;
  context?: string;
}

/** Outline's search context wraps matches in <b>; render those as marks, everything else as text. */
function highlight(context: string): ReactNode[] {
  const clean = context.replace(/<(?!\/?b>)[^>]*>/g, "");
  return clean.split(/(<b>.*?<\/b>)/g).map((part, i) =>
    part.startsWith("<b>") ? <mark key={i}>{part.slice(3, -4)}</mark> : <span key={i}>{part.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")}</span>,
  );
}

export function SearchDialog({ workspace, onPick, onClose }: { workspace: Workspace; onPick: (doc: Doc) => void; onClose: () => void }) {
  const { t, f } = useSettings();
  const [query, setQuery] = useState("");
  const [titles, setTitles] = useState<Doc[]>([]);
  const [hits, setHits] = useState<Result[]>([]);
  const [recent, setRecent] = useState<Doc[]>([]);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    recentlyViewed(8).then(setRecent).catch(() => {});
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setTitles([]);
      setHits([]);
      return;
    }
    let cancelled = false;
    setBusy(true);
    const quick = setTimeout(() => {
      searchTitles(q, 6)
        .then((r) => !cancelled && setTitles(r))
        .catch(() => {});
    }, 80);
    const full = setTimeout(() => {
      search(q, 12)
        .then((r) => !cancelled && setHits(r.map((h) => ({ key: `c${h.document.id}`, doc: h.document, context: h.context }))))
        .catch(() => {})
        .finally(() => !cancelled && setBusy(false));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(quick);
      clearTimeout(full);
    };
  }, [query]);

  const sections = useMemo(() => {
    if (!query.trim()) return [{ title: t("recentlyViewed"), items: recent.map((d) => ({ key: `r${d.id}`, doc: d }) as Result) }];
    const titleIds = new Set(titles.map((d) => d.id));
    return [
      { title: t("searchTitles"), items: titles.map((d) => ({ key: `t${d.id}`, doc: d }) as Result) },
      { title: t("searchContent"), items: hits.filter((h) => !titleIds.has(h.doc.id) || h.context) },
    ].filter((s) => s.items.length);
  }, [query, titles, hits, recent, t]);
  const flat = sections.flatMap((s) => s.items);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(".search-result.active")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown") setActive((i) => Math.min(flat.length - 1, i + 1));
    else if (e.key === "ArrowUp") setActive((i) => Math.max(0, i - 1));
    else if (e.key === "Enter" && flat[active]) onPick(flat[active].doc);
    else return;
    e.preventDefault();
  };

  let index = -1;
  return (
    <div className="dialog-backdrop search-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="search-dialog" role="dialog" aria-label={t("search")}>
        <div className="search-input-row">
          <Search size={18} />
          <input autoFocus placeholder={t("searchPlaceholder")} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKeyDown} />
          {busy && <span className="spinner" />}
        </div>
        <div className="search-results" ref={listRef}>
          {sections.map((s) => (
            <div key={s.title}>
              <div className="search-section">{s.title}</div>
              {s.items.map((r) => {
                index++;
                const i = index;
                const collection = workspace.collections.find((c) => c.id === r.doc.collectionId);
                return (
                  <button key={r.key} className={`search-result${i === active ? " active" : ""}`} onMouseMove={() => setActive(i)} onClick={() => onPick(r.doc)}>
                    <span className="search-result-icon">
                      <EntityIcon icon={r.doc.icon} color={r.doc.color} size={20} fallback={<FileText size={16} />} />
                    </span>
                    <span className="search-result-text">
                      <span className="search-result-title">{r.doc.title || t("untitled")}</span>
                      {r.context ? (
                        <span className="search-result-extra">{highlight(r.context)}</span>
                      ) : (
                        collection && <span className="search-result-extra">{collection.name}</span>
                      )}
                    </span>
                    <span className="search-result-when">{f.relative(r.doc.updatedAt)}</span>
                  </button>
                );
              })}
            </div>
          ))}
          {query.trim() && !busy && !flat.length && <p className="search-empty">{t("noResults")}</p>}
        </div>
      </div>
    </div>
  );
}
