/**
 * Bid page — the ONE way the page says time, money and a period (audit 2026-10-10 S3, S4, S5). Both views (Rules and
 * Bids) and their panels import these; nothing on the page formats a date, an amount or "7 d" on its own. Pure, tested
 * in Node (`format.vitest.test.ts`).
 *
 *   time     the business's clock, Europe/Rome: "10 Oct, 23:00" (a moment), "3 Oct" (a day), "3 h ago" / "16 d ago" /
 *            "in 20 min" / "now" (relative)
 *   money    cents in the row's own currency: "€0.15", "£0.15" — never a bare number. A market Nexus has no checked
 *            limits for bills in its own money (UK in pounds); every other market in euros.
 *   period   "7 d" — the same two words in every header, chip, label and hover line
 */
import { marketLimitsOf } from '@nexus/shared/ads-market-limits'

/** The business's clock. Every time on the page is said in it. */
export const ROME = 'Europe/Rome'

// ── period ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** "7 d", "14 d", "30 d". */
export const periodWord = (days: number): string => `${days} d`
/** The page's one week. */
export const WEEK = periodWord(7)

// ── time ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const MOMENT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: ROME })
const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: ROME })
const DAY_UTC = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })

const timeOf = (iso: string | null | undefined): number | null => {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

/** A moment in Rome: "10 Oct, 23:00"; a dash when there is none. */
export function whenWords(iso: string | null | undefined): string {
  const t = timeOf(iso)
  if (t === null) return '—'
  const parts = MOMENT.formatToParts(new Date(t))
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('day')} ${get('month')}, ${get('hour')}:${get('minute')}`
}

/**
 * A day: "3 Oct". A plain day ("2026-10-03", a data day) is that calendar day as written; a moment is its day in Rome.
 */
export function dayWords(value: string | null | undefined): string {
  if (!value) return '—'
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const t = Date.parse(`${value}T00:00:00Z`)
    return Number.isFinite(t) ? DAY_UTC.format(new Date(t)) : '—'
  }
  const t = timeOf(value)
  return t === null ? '—' : DAY.format(new Date(t))
}

/** How long ago (or until), in one unit: "now", "45 min ago", "3 h ago", "16 d ago", "in 20 min"; a dash when none. */
export function relWords(iso: string | null | undefined, now: number = Date.now()): string {
  const t = timeOf(iso)
  if (t === null) return '—'
  const diff = t - now
  const mins = Math.floor(Math.abs(diff) / 60_000)
  if (mins < 1) return 'now'
  const span = mins < 60 ? `${mins} min` : mins < 48 * 60 ? `${Math.floor(mins / 60)} h` : `${Math.floor(mins / 1440)} d`
  return diff > 0 ? `in ${span}` : `${span} ago`
}

// ── money ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Markets without a checked row in the shared limits table bill in their own money; the rest in euros. */
const OTHER_CURRENCY: Readonly<Record<string, string>> = { UK: 'GBP', GB: 'GBP', SE: 'SEK', PL: 'PLN' }

/** The currency a market bills in: its checked row's, the known others', else euros. */
export function currencyOf(market: string | null | undefined): string {
  const code = (market ?? '').trim().toUpperCase()
  return marketLimitsOf(code)?.currency ?? OTHER_CURRENCY[code] ?? 'EUR'
}

const formats = new Map<string, Intl.NumberFormat>()
function moneyFormat(currency: string): Intl.NumberFormat {
  let f = formats.get(currency)
  if (!f) {
    f = new Intl.NumberFormat('en-IE', { style: 'currency', currency })
    formats.set(currency, f)
  }
  return f
}

/** Cents in a currency: "€0.15". */
export const money = (cents: number, currency: string): string => moneyFormat(currency).format(cents / 100)

/** A money cell: undefined (hidden from this person) and null (none) both read as a dash. */
export function moneyText(cents: number | null | undefined, currency: string): string {
  return typeof cents === 'number' && Number.isFinite(cents) ? money(cents, currency) : '—'
}

/** "+€0.03", "−€0.03" (a real minus sign), "±€0.00". */
export function signedMoney(deltaCents: number, currency: string): string {
  const sign = deltaCents > 0 ? '+' : deltaCents < 0 ? '−' : '±'
  return `${sign}${money(Math.abs(deltaCents), currency)}`
}

/** The currency's mark for an input box: "€", "£". */
export function currencySymbol(currency: string): string {
  return moneyFormat(currency).formatToParts(0).find((p) => p.type === 'currency')?.value ?? currency
}
