// The calendar that opens from a date mention, as in the Calendar app: a month grid in a
// floating layer under (or above) the badge.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { parseISODate, PICK_DATE_EVENT, toISODate, type PickDateRequest } from "../editor/dates";
import { useSettings } from "../lib/settings";
import { ChevronLeft, ChevronRight } from "./icons";

const GAP = 4;
const MARGIN = 8;

const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
/** The Monday on or before `d`. */
const startOfWeek = (d: Date) => addDays(d, -((d.getDay() + 6) % 7));

/** Mounted once: shows the calendar whenever a date mention asks for it. */
export function DatePickerHost() {
  const [request, setRequest] = useState<PickDateRequest | null>(null);
  useEffect(() => {
    const open = (e: Event) => setRequest((e as CustomEvent<PickDateRequest>).detail);
    window.addEventListener(PICK_DATE_EVENT, open);
    return () => window.removeEventListener(PICK_DATE_EVENT, open);
  }, []);
  const close = useCallback(() => {
    setRequest((r) => {
      r?.onClose?.();
      return null;
    });
  }, []);
  if (!request) return null;
  return <DatePopover key={request.value} request={request} onClose={close} />;
}

function DatePopover({ request, onClose }: { request: PickDateRequest; onClose: () => void }) {
  const { lang } = useSettings();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const selected = parseISODate(request.value) ?? new Date();
  const [month, setMonth] = useState(() => new Date(selected.getFullYear(), selected.getMonth(), 1));
  const locale = lang === "fr" ? "fr-FR" : "en-GB";

  useLayoutEffect(() => {
    const a = request.anchor.getBoundingClientRect();
    const el = ref.current;
    if (!el) return;
    const below = a.bottom + GAP + el.offsetHeight <= window.innerHeight - MARGIN;
    setPos({
      left: Math.min(Math.max(MARGIN, a.left), window.innerWidth - el.offsetWidth - MARGIN),
      top: below ? a.bottom + GAP : Math.max(MARGIN, a.top - GAP - el.offsetHeight),
    });
  }, [request.anchor]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!ref.current?.contains(target) && !request.anchor.contains(target)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
    };
    const onScroll = (e: Event) => !ref.current?.contains(e.target as Node) && onClose();
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onClose);
    };
  }, [request.anchor, onClose]);

  const today = new Date();
  const cells = Array.from({ length: 42 }, (_, i) => addDays(startOfWeek(month), i));
  const title = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(month);
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "narrow" });
  const shift = (n: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1));
  const pick = (d: Date) => {
    request.onPick(toISODate(d));
    onClose();
  };

  return createPortal(
    <div
      ref={ref}
      className="picker"
      style={pos ?? { left: -9999, top: 0, visibility: "hidden" }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="picker-month">
        <div className="mini-month-head">
          <span className="mini-month-title">{title.charAt(0).toUpperCase() + title.slice(1)}</span>
          <button type="button" className="icon-button small" onClick={() => shift(-1)}>
            <ChevronLeft />
          </button>
          <button type="button" className="icon-button small" onClick={() => shift(1)}>
            <ChevronRight />
          </button>
        </div>
        <div className="mini-month-row">
          {cells.slice(0, 7).map((d) => (
            <span key={d.getDay()} className="mini-weekday">
              {weekday.format(d)}
            </span>
          ))}
        </div>
        <div className="picker-days">
          {cells.map((d) => {
            const classes = ["mini-day", d.getMonth() !== month.getMonth() && "outside", sameDay(d, today) && "today", sameDay(d, selected) && "selected"];
            return (
              <button type="button" key={d.getTime()} className={classes.filter(Boolean).join(" ")} onClick={() => pick(d)}>
                <span>{d.getDate()}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
