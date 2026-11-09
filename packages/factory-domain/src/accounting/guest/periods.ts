import { isMonth, monthLabel, monthOfDay, periodOfMonth, type Month, type PeriodLanguage } from '../periods'

/**
 * The accountant's periods (B-W2b-201; design portal.guest.accountant › period "Choose month, quarter or year; locked
 * periods marked"). Pure.
 *
 * What the accountant may read is the months finance HANDED OVER: a month is handed over by its numbered accounting export
 * (an EXPORTED batch of the company whose period holds it, B-W2a-39 — the export is the hand-over to the accountant). A
 * month not exported yet is not the accountant's (409 PERIOD_NOT_SHARED, "ask finance"); a later re-export changes nothing
 * here (the month stays handed over and its newest files are listed).
 *
 * The accountant picks a month (`2026-10`), a calendar quarter (`2026-Q4`) or a calendar year (`2026`): VAT is settled by
 * calendar month or quarter. A quarter or a year covers only its handed-over months (the others are named "not handed
 * over yet"); one with none is refused like a month.
 */

export const GUEST_PERIOD_KINDS = ['MONTH', 'QUARTER', 'YEAR'] as const
export type GuestPeriodKind = (typeof GUEST_PERIOD_KINDS)[number]

/** `2026-10`, `2026-Q4` or `2026`. */
export const GUEST_PERIOD = /^(\d{4})(?:-(0[1-9]|1[0-2])|-Q([1-4]))?$/

export interface GuestPeriod {
  /** As written in the address and the API: `2026-10`, `2026-Q4`, `2026`. */
  readonly key: string
  readonly kind: GuestPeriodKind
  readonly year: number
  /** The months it covers, oldest first. */
  readonly months: readonly Month[]
  /** Its first and last day (Europe/Rome days). */
  readonly start: string
  readonly end: string
}

const pad = (value: number): string => String(value).padStart(2, '0')

/** The period a key names, or null when it names none (a bad key, a year outside 2000–2999). */
export function parseGuestPeriod(value: unknown): GuestPeriod | null {
  if (typeof value !== 'string') return null
  const match = GUEST_PERIOD.exec(value.trim())
  if (!match) return null
  const year = Number(match[1])
  if (year < 2000 || year > 2999) return null
  const months: Month[] = match[2]
    ? [`${year}-${match[2]}`]
    : match[3]
      ? [0, 1, 2].map((offset) => `${year}-${pad((Number(match[3]) - 1) * 3 + 1 + offset)}`)
      : Array.from({ length: 12 }, (_, index) => `${year}-${pad(index + 1)}`)
  const kind: GuestPeriodKind = match[2] ? 'MONTH' : match[3] ? 'QUARTER' : 'YEAR'
  return Object.freeze({ key: value.trim(), kind, year, months: Object.freeze(months), start: periodOfMonth(months[0]!).start, end: periodOfMonth(months[months.length - 1]!).end })
}

const QUARTER_WORDS = { en: (q: number, year: number) => `Q${q} ${year}`, it: (q: number, year: number) => `${q}° trimestre ${year}` } as const

/** `October 2026` / `ottobre 2026`, `Q4 2026` / `4° trimestre 2026`, `2026`. */
export function guestPeriodWords(period: GuestPeriod, language: PeriodLanguage = 'en'): string {
  if (period.kind === 'MONTH') return monthLabel(period.months[0]!, language)
  if (period.kind === 'YEAR') return String(period.year)
  return QUARTER_WORDS[language](quarterOf(period.months[0]!), period.year)
}

/** The calendar quarter of a month (1 … 4). */
export const quarterOf = (month: Month): number => Math.floor((Number(month.slice(5, 7)) - 1) / 3) + 1

/** The months finance handed over: every month of the company's EXPORTED batches (each a whole-month period). */
export function handedOverMonths(batches: readonly { readonly periodStart: string; readonly periodEnd: string }[]): Month[] {
  const months = new Set<Month>()
  for (const batch of batches) {
    let month = monthOfDay(batch.periodStart)
    const last = monthOfDay(batch.periodEnd)
    // Whole months, at most a few years: walk them one by one.
    for (let step = 0; isMonth(month) && month <= last && step < 120; step++) {
      months.add(month)
      const year = Number(month.slice(0, 4))
      const number = Number(month.slice(5, 7))
      month = number === 12 ? `${year + 1}-01` : `${year}-${pad(number + 1)}`
    }
  }
  return [...months].sort()
}

export interface PeriodShare {
  /** Every month of the period, oldest first, and whether it was handed over. */
  readonly months: readonly { readonly month: Month; readonly shared: boolean }[]
  /** The handed-over ones. */
  readonly shared: readonly Month[]
}

/** Which months of the period the accountant may read. */
export function shareOf(period: GuestPeriod, handedOver: ReadonlySet<Month> | readonly Month[]): PeriodShare {
  const set = handedOver instanceof Set ? handedOver : new Set(handedOver as readonly Month[])
  const months = period.months.map((month) => ({ month, shared: set.has(month) }))
  return { months, shared: months.filter((entry) => entry.shared).map((entry) => entry.month) }
}

export interface PeriodChoices {
  /** Newest first, each with at least one handed-over month. */
  readonly months: readonly string[]
  readonly quarters: readonly string[]
  readonly years: readonly string[]
}

/** What the period picker offers: the handed-over months, and the quarters and years that hold one. */
export function periodChoices(handedOver: readonly Month[]): PeriodChoices {
  const months = [...new Set(handedOver)].filter(isMonth).sort().reverse()
  const quarters = [...new Set(months.map((month) => `${month.slice(0, 4)}-Q${quarterOf(month)}`))]
  const years = [...new Set(months.map((month) => month.slice(0, 4)))]
  return { months, quarters, years }
}

/** The period the page opens on: the newest handed-over month, or null. */
export const latestHandedOver = (handedOver: readonly Month[]): Month | null => [...handedOver].filter(isMonth).sort().at(-1) ?? null

/** The month of a day lies inside the period's handed-over months. */
export const dayShared = (day: string, share: PeriodShare): boolean => share.shared.includes(monthOfDay(day))
