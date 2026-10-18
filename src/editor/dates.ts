// Date mentions ("@today", "@friday", "@20/10"), stored as Outline does: a mention of type "date"
// whose modelId is the day ("2026-10-18") or a moment ("2026-10-18T13:00").

const DAY = 24 * 60 * 60 * 1000;

/** "2026-10-18", in local time. */
export function toISODate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The date of a stored value, in local time. Null if it isn't one. */
export function parseISODate(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(iso);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

const hasTime = (iso: string) => /T\d{2}:\d{2}/.test(iso);

const normalize = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’']/g, "")
    .toLowerCase()
    .trim();

const today = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** Words for days relative to today, in English and French. */
const RELATIVE: [string, number][] = [
  ["today", 0],
  ["tomorrow", 1],
  ["yesterday", -1],
  ["aujourdhui", 0],
  ["demain", 1],
  ["hier", -1],
  ["apres-demain", 2],
  ["apres demain", 2],
  ["avant-hier", -2],
  ["avant hier", -2],
];

const WEEKDAYS: string[][] = [
  ["sunday", "dimanche"],
  ["monday", "lundi"],
  ["tuesday", "mardi"],
  ["wednesday", "mercredi"],
  ["thursday", "jeudi"],
  ["friday", "vendredi"],
  ["saturday", "samedi"],
];

const MONTHS: string[][] = [
  ["january", "janvier"],
  ["february", "fevrier"],
  ["march", "mars"],
  ["april", "avril"],
  ["may", "mai"],
  ["june", "juin"],
  ["july", "juillet"],
  ["august", "aout"],
  ["september", "septembre"],
  ["october", "octobre"],
  ["november", "novembre"],
  ["december", "decembre"],
];

/** A month from its name or the start of it ("oct", "octobre"). */
function monthOf(word: string): number | null {
  if (word.length < 3) return null;
  const i = MONTHS.findIndex((names) => names.some((n) => n.startsWith(word)));
  return i < 0 ? null : i;
}

/** The next time it's that weekday, from tomorrow on. */
function nextWeekday(day: number): Date {
  const base = today();
  return addDays(base, ((day - base.getDay() + 7) % 7) || 7);
}

/** A full date the year is left out of: this year, or next if it's already past. */
function upcoming(month: number, day: number, year?: number): Date | null {
  const base = today();
  let d = new Date(year ?? base.getFullYear(), month, day);
  if (d.getMonth() !== month) return null;
  if (year === undefined && d < addDays(base, -7)) d = new Date(base.getFullYear() + 1, month, day);
  return d;
}

/**
 * The dates a mention query could mean, best first. Matches words as they're typed ("tom"
 * offers tomorrow), weekdays ("fri", "next friday", "vendredi prochain"), "in 3 days",
 * and written dates ("2026-10-20", "20/10", "20 oct", "oct 20").
 */
export function datesFor(query: string): string[] {
  const q = normalize(query).replace(/\s+/g, " ");
  if (q.length < 2) return [];
  const out: Date[] = [];

  for (const [word, offset] of RELATIVE) if (word.startsWith(q)) out.push(addDays(today(), offset));

  const weekday = q.replace(/^next |^this | prochain$| prochaine$/g, "");
  if (weekday.length >= 3) WEEKDAYS.forEach((names, day) => names.some((n) => n.startsWith(weekday)) && out.push(nextWeekday(day)));

  let m: RegExpExecArray | null;
  if ((m = /^(?:in|dans) (\d{1,3}) ?(days?|jours?|weeks?|semaines?)$/.exec(q))) {
    const n = Number(m[1]) * (/^(w|s)/.test(m[2]) ? 7 : 1);
    out.push(addDays(today(), n));
  }
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(q))) {
    const d = upcoming(Number(m[2]) - 1, Number(m[3]), Number(m[1]));
    if (d) out.push(d);
  }
  if ((m = /^(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?$/.exec(q))) {
    const year = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : undefined;
    const d = upcoming(Number(m[2]) - 1, Number(m[1]), year);
    if (d) out.push(d);
  }
  if ((m = /^(\d{1,2})(?:st|nd|rd|th|er)? ([a-z]+)(?: (\d{4}))?$/.exec(q)) || (m = /^([a-z]+) (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?$/.exec(q))) {
    const [day, name] = /^\d/.test(m[1]) ? [Number(m[1]), m[2]] : [Number(m[2]), m[1]];
    const month = monthOf(name);
    const d = month === null ? null : upcoming(month, day, m[3] ? Number(m[3]) : undefined);
    if (d) out.push(d);
  }

  return [...new Set(out.map(toISODate))];
}

/** How a date mention reads: "Today", "Tomorrow", "Friday 23 Oct"… with its time if it has one. */
export function dateLabel(iso: string, lang: string): string {
  const d = parseISODate(iso);
  if (!d) return iso;
  const locale = lang === "fr" ? "fr-FR" : "en-GB";
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - today().getTime()) / DAY);
  let label: string;
  if (Math.abs(days) <= 1) {
    label = new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(days, "day");
    label = label.charAt(0).toUpperCase() + label.slice(1);
  } else {
    const sameYear = d.getFullYear() === new Date().getFullYear();
    label = new Intl.DateTimeFormat(locale, { weekday: Math.abs(days) < 7 ? "long" : "short", day: "numeric", month: "short", year: sameYear ? undefined : "numeric" }).format(d);
  }
  if (hasTime(iso)) label += ` ${new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(d)}`;
  return label;
}

/** The date written out in full, for hints and tooltips. */
export function dateLong(iso: string, lang: string): string {
  const d = parseISODate(iso);
  if (!d) return iso;
  return new Intl.DateTimeFormat(lang === "fr" ? "fr-FR" : "en-GB", { dateStyle: "full", timeStyle: hasTime(iso) ? "short" : undefined }).format(d);
}

/** The stored value with its day changed, keeping its time if it had one. */
export function withDay(iso: string, day: string): string {
  const time = /T\d{2}:\d{2}/.exec(iso)?.[0];
  return time ? `${day}${time}` : day;
}
