/**
 * Reviews area — the period a page looks at (Overview, Inbox, Queue, Insights): parsed from and written to the
 * address (`?period=`), said in words, and turned into the dates it covers with the period before it for "change"
 * figures. Pure, tested in reviewsPeriod.vitest.test.ts.
 */

export const PERIODS = ['7d', '30d', '90d', '12m', 'all'] as const
export type Period = (typeof PERIODS)[number]

/** The period a page shows when the address names none. */
export const DEFAULT_PERIOD: Period = '30d'

/** A period from the address; anything else (missing, misspelt) is `fallback`. */
export function parsePeriod(raw: string | null | undefined, fallback: Period = DEFAULT_PERIOD): Period {
  const value = raw?.trim().toLowerCase()
  return (PERIODS as readonly string[]).includes(value ?? '') ? (value as Period) : fallback
}

/** The address value for a period, or null when it is the default (the address then leaves `period` out). */
export function serializePeriod(period: Period, fallback: Period = DEFAULT_PERIOD): string | null {
  return period === fallback ? null : period
}

export interface PeriodWords {
  /** "last 30 days" — in a sentence ("New reviews, last 30 days"). */
  label: string
  /** "30 days" — on a control. */
  short: string
  /** "the 30 days before" — what a change compares against; null for All time. */
  prev: string | null
}

const WORDS: Record<Period, PeriodWords> = {
  '7d': { label: 'last 7 days', short: '7 days', prev: 'the 7 days before' },
  '30d': { label: 'last 30 days', short: '30 days', prev: 'the 30 days before' },
  '90d': { label: 'last 90 days', short: '90 days', prev: 'the 90 days before' },
  '12m': { label: 'last 12 months', short: '12 months', prev: 'the 12 months before' },
  all: { label: 'all time', short: 'All time', prev: null },
}

export function periodWords(period: Period): PeriodWords {
  return WORDS[period]
}

export interface PeriodRange {
  /** Start of the period; null for All time. */
  from: Date | null
  to: Date
  /** The period before it, of the same length; null for All time. */
  prevFrom: Date | null
  prevTo: Date | null
}

const DAY = 86_400_000

/** `months` calendar months before `date` (UTC), the day clamped to the end of a shorter month. */
function monthsBefore(date: Date, months: number): Date {
  const d = new Date(date.getTime())
  const day = d.getUTCDate()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() - months)
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(day, lastDay))
  return d
}

/** The dates a period covers, ending at `now`, and the period before it. */
export function periodRange(period: Period, now: Date = new Date()): PeriodRange {
  const to = new Date(now.getTime())
  if (period === 'all') return { from: null, to, prevFrom: null, prevTo: null }
  if (period === '12m') {
    const from = monthsBefore(to, 12)
    return { from, to, prevFrom: monthsBefore(to, 24), prevTo: from }
  }
  const days = period === '7d' ? 7 : period === '30d' ? 30 : 90
  const from = new Date(to.getTime() - days * DAY)
  return { from, to, prevFrom: new Date(from.getTime() - days * DAY), prevTo: from }
}
