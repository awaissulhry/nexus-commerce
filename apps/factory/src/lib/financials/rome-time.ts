/**
 * EPF1.1 — Europe/Rome calendar helpers for the money folds (D-13: all month
 * math was UTC for a Rome-based factory). Pure, DST-safe: everything goes
 * through Intl.DateTimeFormat with an explicit timeZone — no locale string
 * tricks, no Date locale mutation. The formatters are module-cached (they are
 * expensive to construct and these run once per payment/invoice per fold).
 */

const monthFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Rome",
  year: "numeric",
  month: "2-digit",
});
const dayFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Rome",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const offsetFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Rome",
  timeZoneName: "longOffset",
  year: "numeric",
});

function parts(fmt: Intl.DateTimeFormat, t: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(t)) out[p.type] = p.value;
  return out;
}

/** `YYYY-MM` of the instant in Europe/Rome. Unparseable input falls back to its own prefix. */
export function romeMonthKey(dateISO: string): string {
  const t = Date.parse(dateISO);
  if (Number.isNaN(t)) return dateISO.slice(0, 7);
  const p = parts(monthFmt, t);
  return `${p.year}-${p.month}`;
}

/** `YYYY-MM-DD` of the instant in Europe/Rome. */
export function romeDayKey(dateISO: string): string {
  const t = Date.parse(dateISO);
  if (Number.isNaN(t)) return dateISO.slice(0, 10);
  const p = parts(dayFmt, t);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Calendar year of the instant in Europe/Rome (invoice counters are year-keyed). */
export function romeYear(dateISO: string): number {
  return Number(romeMonthKey(dateISO).slice(0, 4));
}

/** Rome's UTC offset in minutes at the given instant (+60 CET / +120 CEST). */
export function romeOffsetMinutes(atMs: number): number {
  const name = offsetFmt.formatToParts(atMs).find((p) => p.type === "timeZoneName")?.value ?? "";
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

const dayRe = /^(\d{4})-(\d{2})-(\d{2})/;

/** UTC instant of Rome midnight opening the given `YYYY-MM-DD` day. Null when unparseable. */
export function romeDayStartUtc(day: string): Date | null {
  const m = dayRe.exec(day.trim());
  if (!m) return null;
  const guess = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  if (Number.isNaN(guess)) return null;
  return new Date(guess - romeOffsetMinutes(guess) * 60_000);
}

/** UTC instant of the last millisecond of the given Rome `YYYY-MM-DD` day. Null when unparseable. */
export function romeDayEndUtc(day: string): Date | null {
  const m = dayRe.exec(day.trim());
  if (!m) return null;
  const guess = Date.parse(`${m[1]}-${m[2]}-${m[3]}T23:59:59.999Z`);
  if (Number.isNaN(guess)) return null;
  return new Date(guess - romeOffsetMinutes(guess) * 60_000);
}

/**
 * A `{gte, lte}` UTC window covering the Rome-local days `from…to` (either or
 * both optional; `YYYY-MM-DD` or a longer ISO whose date prefix is used).
 * Undefined when neither bound parses — the caller exports everything.
 */
export function romeDayWindowUtc(
  from?: string | null,
  to?: string | null,
): { gte?: Date; lte?: Date } | undefined {
  const gte = from ? romeDayStartUtc(from.slice(0, 10)) : null;
  const lte = to ? romeDayEndUtc(to.slice(0, 10)) : null;
  if (!gte && !lte) return undefined;
  return { ...(gte ? { gte } : {}), ...(lte ? { lte } : {}) };
}

/**
 * EPF1 hot-path tiles — invert a Rome `YYYY-MM` monthKey to its exact UTC
 * half-open instant window `[gte, lt)`: an instant t satisfies
 * `romeMonthKey(t) === monthKey` ⟺ `gte ≤ t < lt` (property-tested). Lets SQL
 * range-sum a Rome month TZ-exactly without materializing per-row dates.
 * Null when the key is malformed.
 */
export function romeMonthWindowUtc(monthKey: string): { gte: Date; lt: Date } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(monthKey.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  const nextY = mo === 12 ? y + 1 : y;
  const nextMo = mo === 12 ? 1 : mo + 1;
  const gte = romeDayStartUtc(`${y}-${String(mo).padStart(2, "0")}-01`);
  const lt = romeDayStartUtc(`${nextY}-${String(nextMo).padStart(2, "0")}-01`);
  if (!gte || !lt) return null;
  return { gte, lt };
}
