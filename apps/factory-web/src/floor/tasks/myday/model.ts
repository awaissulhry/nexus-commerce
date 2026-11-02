import { formatMoney, formatUnitPrice } from '@nexus/factory-domain/documents/format'
import type { CurrencyCode } from '@nexus/factory-domain/core/money'
import { MYDAY_CLOSE_AFTER_MS, MYDAY_MONTHS_BACK } from '@nexus/factory-domain/people/myday/rules'
import { INTL_LOCALE, type Locale } from '../../../lib/i18n/locales'
import type { MyDay, MyDispute, Mine, MyStatement } from './api'

/**
 * My day's rules without a screen (SCR-171; design floor.myday; c.c. art. 2101; GDPR art. 15; Statuto dei Lavoratori art. 4;
 * Owner answers F1, F2). Pure, so the tests hold them. The worker's own day on a tablet other people can see:
 *
 *   opens     always on the PIN pad, even a minute after a PIN sign-in: someone else may stand here by now
 *   closes    60 s without a touch (the last 10 say so): the figures leave the screen, Home opens
 *   wiped     another person on the tablet, the tab out of view, the network gone, the way back: the figures are dropped at once
 *   kept      nothing of it on the tablet but the ids of answers already opened (the badge's only memory)
 *   compares  with nothing: the worker's pieces, the line's target, never a line's output or another person
 */

/** The last seconds of the 60: "still reading?". */
export const CLOSE_WARN_MS = 10_000
export const CLOSE_IDLE_MS = MYDAY_CLOSE_AFTER_MS - CLOSE_WARN_MS

/** What the screen holds while it is open. Never kept beyond the screen's own state. */
export interface MyDayData {
  /** Today, with this month's money. */
  readonly day: MyDay
  readonly mine: Mine
  /** The same read for the month the statement shows (this month until the worker steps back). */
  readonly statement: MyDay
}

export const MESSAGE_MAX = 500

// ---- months ---------------------------------------------------------------------------------------------------------

export const firstOfMonth = (day: string): string => `${day.slice(0, 7)}-01`

function monthPlus(month: string, count: number): string {
  const [year = 0, number = 1] = month.split('-').map(Number)
  const index = year * 12 + (number - 1) + count
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`
}

export const monthBefore = (month: string): string => monthPlus(month, -1)
export const monthAfter = (month: string): string => monthPlus(month, 1)

/** The month as a person says it ("ottobre 2026"). */
export const monthWords = (month: string, locale: Locale): string => new Intl.DateTimeFormat(INTL_LOCALE[locale], { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-15T12:00:00.000Z`))

/** How far the statement steps: from this month back a year. */
export const canGoBack = (month: string, today: string): boolean => month > monthPlus(today.slice(0, 7), -MYDAY_MONTHS_BACK)
export const canGoForward = (month: string, today: string): boolean => month < today.slice(0, 7)

// ---- the ring (pace, own view only) ---------------------------------------------------------------------------------

/** The ring fills to 100 and no further: above the target it is simply full. */
export const ringShare = (percent: number | null): number => (percent === null ? 0 : Math.min(100, Math.max(0, percent)))

// ---- money ----------------------------------------------------------------------------------------------------------

export const moneyText = (amount: number, currency: string, locale: Locale): string => formatMoney(amount, currency as CurrencyCode, locale)
export const rateText = (rate: string, locale: Locale): string => formatUnitPrice(rate, locale)

// ---- records --------------------------------------------------------------------------------------------------------

export type RecordSpan = 'today' | 'period'

export interface MyRow {
  readonly key: string
  readonly recordType: 'OperationScan' | 'OffStandardEntry'
  readonly recordId: string
  readonly at: string
  readonly workDate: string
  readonly report: Mine['records'][number] | null
  readonly block: Mine['blocks'][number] | null
  readonly disputable: boolean
  readonly dispute: { readonly id: string; readonly status: string } | null
}

/** Reports and blocks as one list, newest first: the row a finger reaches first is the last thing done. */
export function rowsOf(mine: Mine, span: RecordSpan, today: string): MyRow[] {
  const rows: MyRow[] = [
    ...mine.records.map((report) => ({ key: `r:${report.scanId}`, recordType: 'OperationScan' as const, recordId: report.scanId, at: report.at, workDate: report.workDate, report, block: null, disputable: report.disputable, dispute: report.dispute })),
    ...mine.blocks.map((block) => ({ key: `b:${block.id}`, recordType: 'OffStandardEntry' as const, recordId: block.id, at: block.startedAt, workDate: block.workDate, report: null, block, disputable: block.disputable, dispute: block.dispute })),
  ]
  return rows.filter((row) => span === 'period' || row.workDate === today).sort((a, b) => (a.at === b.at ? (a.key < b.key ? -1 : 1) : a.at > b.at ? -1 : 1))
}

/** Why a row cannot be disputed now. */
export function rowHeld(row: MyRow): 'undone' | 'running' | 'open' | null {
  if (row.dispute?.status === 'OPEN') return 'open'
  if (row.disputable) return null
  return row.report ? 'undone' : 'running'
}

export const reasonsOf = (mine: Mine, row: MyRow): readonly string[] => mine.reasons[row.recordType]

export interface DisputeDraft {
  readonly reason: string | null
  readonly words: string
}

/** What Send waits for. "Other" needs the words (the API says the same). */
export function sendHeld(draft: DisputeDraft): 'reason' | 'words' | null {
  if (!draft.reason) return 'reason'
  return draft.reason === 'OTHER' && draft.words.trim() === '' ? 'words' : null
}

export const openDisputes = (mine: Mine): MyDispute[] => mine.disputes.filter((dispute) => dispute.status === 'OPEN')
export const answeredDisputes = (mine: Mine): MyDispute[] => mine.disputes.filter((dispute) => dispute.status === 'UPHELD' || dispute.status === 'REJECTED')

// ---- the statement --------------------------------------------------------------------------------------------------

/** Why the statement cannot go to the office printer now. */
export function printHeld(day: MyDay, statement: MyStatement | null): 'draft' | 'noPrinter' | null {
  if (!statement || statement.status !== 'APPROVED') return 'draft'
  return day.printer ? null : 'noPrinter'
}

// ---- the tile's badge -----------------------------------------------------------------------------------------------

const SEEN_KEY = 'nexus.floor.myday.seen'
const SEEN_MAX = 300

/** Ids of answers already opened on this tablet: the only thing My day leaves here, and it is no figure. */
export function readSeen(): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(SEEN_KEY) ?? '[]') as unknown
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

export function markSeen(ids: readonly string[]): void {
  try {
    const next = [...new Set([...readSeen(), ...ids])].slice(-SEEN_MAX)
    window.localStorage.setItem(SEEN_KEY, JSON.stringify(next))
  } catch {
    // No storage: the badge stays until the answer is older than the API's window.
  }
}

export const unreadAnswers = (ids: readonly string[], seen: readonly string[]): number => ids.filter((id) => !seen.includes(id)).length
