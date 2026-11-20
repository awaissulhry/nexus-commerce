import type { Order } from '../../api'
import type { Phrase } from '../../model'
import type { Dates, Headline } from './api'
import { AFTER } from './model'
// ---- F-OO-143: a refused new date (the ONE waiting list's DATE row) and Decide… (the ONE promise dialog, its follow-up named) ----
import { romeToday } from '../../model'
import type { WaitingRow } from './model'
import type { BandDialog, RecordDialog } from '../record-model'
// ---- end F-OO-143

/**
 * F-OO-100 (order overview lane: one file per section) — Next dates, its rules moved out of model.ts unchanged (F-SA-233, P16).
 * The requested date's field id stays in model.ts: Lines and the overview acts read it too.
 *
 * F-OO-141 (order overview lane; 10-design §4; review F8): the card's rows — the promise first (how often it moved), what the plan
 * says against it (derived: "(from the plan)"), the date the customer asked for, then the order's open gates. The shipping
 * milestone is never listed (its target IS the promise, its own row), nor "Production start" (not a next date, review F8).
 */

const phrase = (key: string, params?: Record<string, string | number>): Phrase => (params ? { key, params } : { key })

/** One of the order's open gates (late first). */
export interface NextDate {
  readonly id: string
  /** The gate this milestone is (a Discuss names it by its reference); null: none read. */
  readonly gateId: string | null
  readonly gateKind: string | null
  readonly label: string | null
  readonly target: string | null
  readonly late: number | null
}

/** The next open gates, three at most: late first (most late first), then by target. Only gates (F-OO-141). */
export function nextDatesOf(dates: Dates | null | undefined, count = 3): NextDate[] {
  const open = (dates?.milestones ?? []).filter((row) => row.kind === 'GATE' && row.state !== 'DONE')
  const sorted = [...open].sort((a, b) => Number((b.late ?? 0) > 0) - Number((a.late ?? 0) > 0) || (b.late ?? 0) - (a.late ?? 0) || (a.target ?? '9999').localeCompare(b.target ?? '9999'))
  return sorted.slice(0, count).map((row) => ({ id: row.id, gateId: row.gateId, gateKind: row.gateKind, label: row.label, target: row.target, late: row.late }))
}

// ---- F-OO-141: Promised (ex-factory) and what the plan says against it -----------------------------------------------------------

/** "Promised (ex-factory)": the promise in force and how it moved; null without a promise ("—"). */
export interface PromiseRow {
  readonly date: string
  /** "{date} · moved 2× · +6 d since first promised" or "{date} · moved 1×"; null: it never moved (a first promise is no move, B-OO-007). */
  readonly moved: Phrase | null
}

export function promiseRowOf(order: Pick<Order, 'promiseDate'>, headline: Pick<Headline, 'promise'> | null | undefined): PromiseRow | null {
  const date = headline?.promise.date ?? order.promiseDate
  if (!date) return null
  const moves = headline?.promise.moves ?? 0
  const slip = headline?.promise.slipDays ?? null
  if (moves > 0 && slip !== null && slip !== 0) return { date, moved: phrase('dates.promisedMoved', { date, count: moves, days: slip > 0 ? `+${slip}` : String(slip) }) }
  if (moves > 0) return { date, moved: phrase('dates.promisedMovedOnly', { date, count: moves }) }
  return { date, moved: null }
}

/**
 * "Plan says ready": the published plan's finish against the promise — after it (by n days), before it, on the promise day; with
 * no promise, the plan's day alone; nothing planned yet ("Nothing plans it yet"). Derived, never set here. Not said when the dates
 * were not read (no claim) nor after production (the plan is history then).
 */
export type PlanSays =
  | { readonly kind: 'after'; readonly date: string; readonly days: number }
  | { readonly kind: 'before'; readonly date: string; readonly days: number }
  | { readonly kind: 'same'; readonly date: string }
  | { readonly kind: 'plain'; readonly date: string }
  | { readonly kind: 'none'; readonly warn: boolean }

/** Days from one calendar day to another (`YYYY-MM-DD`, whole days; a later `to` is positive). */
const daysFrom = (from: string, to: string): number => Math.round((Date.parse(`${to.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) / 86_400_000)

export function planSaysOf(order: Pick<Order, 'status'>, promise: string | null, dates: Pick<Dates, 'planned'> | null | undefined): PlanSays | null {
  if (!dates || AFTER.includes(order.status)) return null
  const finish = dates.planned.finish
  // Nothing plans an order that has a promise: amber, the cause of "At risk" (a waiting order is not planned yet: plain words).
  if (!finish) return { kind: 'none', warn: !!promise && order.status !== 'PENDING_APPROVAL' }
  if (!promise) return { kind: 'plain', date: finish }
  const days = daysFrom(promise, finish)
  if (days > 0) return { kind: 'after', date: finish, days }
  if (days < 0) return { kind: 'before', date: finish, days: -days }
  return { kind: 'same', date: finish }
}

/** The plan's words in amber: it ends after the promise, or nothing plans an order that has one. */
export const planWarns = (plan: PlanSays): boolean => plan.kind === 'after' || (plan.kind === 'none' && plan.warn)
// ---- end F-OO-141

// ---- F-OO-143 (order overview 10-design §4.2; review F1, F3; replaces F-OP-105): the new date the customer refused ----------------
/**
 * How long a waiting row has waited: whole days from the Rome day it started to today (Rome); 0 the same day; null when the read
 * does not know when it started. Never negative (a start "after" today is today).
 */
export function ageDaysOf(since: string | null, today: string): number | null {
  if (!since) return null
  const start = Date.parse(since)
  if (Number.isNaN(start)) return null
  return Math.max(0, daysFrom(romeToday(new Date(start)), today))
}

/** An age in words: "2 d" / "2 g", the same day "today" / "oggi". */
export const ageWordsOf = (days: number): Phrase => (days === 0 ? phrase('dates.ageToday') : phrase('dates.age', { days }))

/** A new date the customer refused whose follow-up is still open: the waiting list's DATE row BRAND_REQUEST · REPROMISE (F3). */
export interface RefusedDate {
  readonly key: string
  /** The refused REPROMISE request — its follow-up task has the same id (planning/promise-keep brand-answer). */
  readonly requestId: string
  /** Days since the customer refused it (the row's `since` = the answer's time); null: not known. */
  readonly age: number | null
}

/**
 * The refused new dates of the ONE waiting list (`waiting.dates`, never a second read): each REPROMISE row with its request. The row
 * carries no date (review F1: "refused the new date", today's words). It is a date, so it is not in the Changes badge (F3).
 */
export function refusedDatesOf(rows: readonly Pick<WaitingRow, 'key' | 'kind' | 'sub' | 'ref' | 'since' | 'place'>[], today: string): RefusedDate[] {
  return rows.flatMap((row) => (row.place === 'DATE' && row.kind === 'BRAND_REQUEST' && row.sub === 'REPROMISE' && row.ref?.type === 'ApprovalRequest' ? [{ key: row.key, requestId: row.ref.id, age: ageDaysOf(row.since, today) }] : []))
}

/** Decide…: the ONE promise dialog (BandDialog `promise`) with the refused request named — no "Keep the date" (N14 dropped). */
export const decideDialogOf = (refused: Pick<RefusedDate, 'requestId'>): BandDialog => ({ kind: 'promise', followUp: { requestId: refused.requestId } })

/** The promise dialog's follow-up when Decide… opened it; null when Change… did (or another dialog is open). */
export const followUpOf = (dialog: RecordDialog | null | undefined): { readonly requestId: string } | null => (dialog?.kind === 'promise' ? (dialog.followUp ?? null) : null)
// ---- end F-OO-143
