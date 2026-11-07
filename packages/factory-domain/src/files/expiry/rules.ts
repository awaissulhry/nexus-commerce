import { businessDate, type BusinessDate } from '../../core/time'

/**
 * Document expiry (COL-049; B-W2b-177 on the B-W2b-153 schema), pure. A file of a record may carry the day it stops being
 * valid (`StoredFile.expiresOn`: a certificate, a test report, a declaration, a supplier's document). The scheduler reminds
 * twice before that day — 30 days before, then 7 days before — and never twice in one window:
 *
 *   window      30 while 8..30 days are left, 7 while 0..7 days are left; none before (more than 30) or after (expired)
 *   reminded    `expiryRemindedAt`, the last reminder for this date; a window is due while no reminder was sent on or after
 *               the window's first day (a document added 5 days before its date gets the 7-day reminder only)
 *   a new date  clears the reminder (the database refuses a new date that keeps it), so the new date starts again
 *
 * Days are business days in Europe/Rome (core/time businessDate). apps/factory-api platform/files/expiry applies these
 * rules (the cron, the document's date), the web says the state with the same words.
 */

/** The reminder windows, in days before the expiry date, the earliest first. */
export const EXPIRY_WINDOWS = [30, 7] as const
export type ExpiryWindow = (typeof EXPIRY_WINDOWS)[number]

/** The earliest and latest expiry date the office may type (a document valid for more than 20 years is not a date). */
export const EXPIRY_FIRST_DAY = '2000-01-01'
export const EXPIRY_MAX_YEARS = 20

const DAY_MS = 86_400_000
const DATE = /^\d{4}-\d{2}-\d{2}$/

const utcOf = (date: BusinessDate): number => Date.parse(`${date}T00:00:00Z`)

/** A business date `days` later (or earlier, negative). */
export function addDays(date: BusinessDate, days: number): BusinessDate {
  return new Date(utcOf(date) + days * DAY_MS).toISOString().slice(0, 10)
}

/** Whole days from `today` to `expiresOn` (0: it ends today, negative: it ended). */
export function daysUntil(expiresOn: BusinessDate, today: BusinessDate): number {
  return Math.round((utcOf(expiresOn) - utcOf(today)) / DAY_MS)
}

/** A date column (`@db.Date`, read as midnight UTC) or a typed date as a business date. */
export function dayOf(value: Date | string): BusinessDate {
  return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10)
}

/** NONE: no date; VALID: more than 30 days left; EXPIRING: 0..30 days left; EXPIRED: the day has passed. */
export type ExpiryState = 'NONE' | 'VALID' | 'EXPIRING' | 'EXPIRED'

export function expiryStateOf(expiresOn: BusinessDate | null, today: BusinessDate): ExpiryState {
  if (expiresOn === null) return 'NONE'
  const left = daysUntil(expiresOn, today)
  if (left < 0) return 'EXPIRED'
  return left <= EXPIRY_WINDOWS[0] ? 'EXPIRING' : 'VALID'
}

/** Valid on `today`: no date, or a date not passed yet (the last valid day is the date itself). */
export const validOn = (expiresOn: BusinessDate | null, today: BusinessDate): boolean => expiresOn === null || expiresOn >= today

/**
 * The reminder window due now, or null: 30 or 7 days before `expiresOn`, when no reminder for this date was sent on or after
 * the window's first day. Nothing before 30 days, nothing once the date has passed.
 */
export function reminderWindowOf(file: { readonly expiresOn: BusinessDate | null; readonly remindedAt: Date | null }, today: BusinessDate): ExpiryWindow | null {
  if (file.expiresOn === null) return null
  const left = daysUntil(file.expiresOn, today)
  if (left < 0 || left > EXPIRY_WINDOWS[0]) return null
  const window: ExpiryWindow = left <= EXPIRY_WINDOWS[1] ? EXPIRY_WINDOWS[1] : EXPIRY_WINDOWS[0]
  if (file.remindedAt === null) return window
  const opened = addDays(file.expiresOn, -window)
  return businessDate(file.remindedAt) >= opened ? null : window
}

/** What is wrong with a typed expiry date, in words; null: it may be kept. A past date is kept (a document may have expired). */
export function expiryDateProblem(value: string, today: BusinessDate): string | null {
  if (!DATE.test(value) || Number.isNaN(utcOf(value)) || dayOf(new Date(utcOf(value))) !== value) return 'The expiry date is not a date (YYYY-MM-DD).'
  if (value < EXPIRY_FIRST_DAY) return 'The expiry date is too far in the past.'
  if (value > addDays(today, EXPIRY_MAX_YEARS * 366)) return `The expiry date is more than ${EXPIRY_MAX_YEARS} years away.`
  return null
}
