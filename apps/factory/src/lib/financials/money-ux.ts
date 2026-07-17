/**
 * EPF2.1 — money-page UX folds (pure, client-safe, tested). Everything the
 * rebuilt /financials client needs to compute WITHOUT a server round-trip:
 * EU-safe amount parsing (the old modal broke on `1.234,56` — first-comma-only
 * replace), the context-sensitive payment-kind default (FD13: DEPOSIT while
 * the gate is open, else BALANCE), the "last 12 months" Rome default window,
 * the by-month drill-through day window, and the by-order page cursor codec.
 * No Prisma, no Date-now inside the folds — callers pass instants.
 */
import { romeMonthKey } from "./rome-time";

/**
 * Parse a human EUR amount into cents. Handles BOTH separator conventions:
 * `1.234,56` (IT) and `1,234.56` (EN) → 123456. Rules: when both `.` and `,`
 * appear, the LAST one is the decimal separator; a SOLE separator followed by
 * exactly 3 digits is thousands grouping (`1.234` → 123400); otherwise it is
 * the decimal separator with 1–2 digits (`1,5` → 150). Currency signs and
 * spaces are ignored. Returns the MAGNITUDE in cents (sign preserved for
 * completeness) or null when unparseable — the caller decides refusal copy.
 */
export function parseAmountToCents(raw: string): number | null {
  const s = raw.replace(/[€\s ]/g, "");
  if (!s || !/^[-+]?[0-9.,]+$/.test(s)) return null;
  const sign = s.startsWith("-") ? -1 : 1;
  const digits = s.replace(/^[-+]/, "");
  if (!/\d/.test(digits)) return null;
  const lastDot = digits.lastIndexOf(".");
  const lastComma = digits.lastIndexOf(",");
  const sep = Math.max(lastDot, lastComma);
  let intPart: string;
  let fracPart: string;
  if (lastDot >= 0 && lastComma >= 0) {
    // both conventions present — the last separator is the decimal one
    intPart = digits.slice(0, sep).replace(/[.,]/g, "");
    fracPart = digits.slice(sep + 1);
    if (!/^\d{1,2}$/.test(fracPart)) return null;
  } else if (sep >= 0) {
    const head = digits.slice(0, sep);
    const tail = digits.slice(sep + 1);
    const seps = (digits.match(/[.,]/g) ?? []).length;
    if (seps > 1 || (tail.length === 3 && head.length > 0)) {
      // `1.234.567` / `1,234` — grouping, no decimal part
      intPart = digits.replace(/[.,]/g, "");
      fracPart = "";
    } else {
      intPart = head;
      fracPart = tail;
      if (!/^\d{1,2}$/.test(fracPart)) return null;
    }
  } else {
    intPart = digits;
    fracPart = "";
  }
  if (!/^\d*$/.test(intPart) || (intPart === "" && fracPart === "")) return null;
  const cents = Number(intPart || "0") * 100 + Number((fracPart || "0").padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? sign * cents : null;
}

/**
 * FD13 context-sensitive kind default: while a required deposit is still
 * unmet the modal proposes DEPOSIT; once met (or none required) BALANCE.
 * Grain-stripped callers (no depositRequiredCents) fall back to BALANCE.
 */
export function defaultPaymentKind(fin: { depositRequiredCents?: number; depositMet?: boolean }): "DEPOSIT" | "BALANCE" {
  return (fin.depositRequiredCents ?? 0) > 0 && fin.depositMet !== true ? "DEPOSIT" : "BALANCE";
}

/**
 * The default view's `from`: first day of the Rome month 11 months before the
 * given instant — "last 12 months" = the current Rome month + the 11 before
 * it. Returns a `YYYY-MM-DD` Rome-local day for `?from=`.
 */
export function defaultWindowFrom(nowISO: string): string {
  const [y, m] = romeMonthKey(nowISO).split("-").map(Number);
  const months = y * 12 + (m - 1) - 11;
  const fy = Math.floor(months / 12);
  const fm = (months % 12) + 1;
  return `${fy}-${String(fm).padStart(2, "0")}-01`;
}

/** By-month drill-through: a Rome `YYYY-MM` → its first/last Rome-local days for `?from=&to=`. Null when malformed. */
export function monthDayWindow(monthKey: string): { from: string; to: string } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(monthKey.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { from: `${m[1]}-${m[2]}-01`, to: `${m[1]}-${m[2]}-${String(lastDay).padStart(2, "0")}` };
}

/** By-order page cursor codec — `<createdAtISO>~<orderId>`, matching topNewest's (createdAt DESC, id ASC) order. */
export function encodeOrderCursor(c: { createdAtISO: string; orderId: string }): string {
  return `${c.createdAtISO}~${c.orderId}`;
}

export function parseOrderCursor(raw: string | null | undefined): { createdAtISO: string; orderId: string } | null {
  if (!raw) return null;
  const i = raw.indexOf("~");
  if (i <= 0) return null;
  const createdAtISO = raw.slice(0, i);
  const orderId = raw.slice(i + 1);
  if (!orderId || Number.isNaN(Date.parse(createdAtISO))) return null;
  return { createdAtISO, orderId };
}
