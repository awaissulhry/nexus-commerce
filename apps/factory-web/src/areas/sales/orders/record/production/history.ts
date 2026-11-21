import { isAutomaticReason } from '@nexus/factory-domain/sales/amendments/reasons'
import { PROMISE_REASON_CODES, promiseReasonOf, type PromiseReasonCode } from '@nexus/factory-domain/sales/portal-orders/promise'
import type { Order } from '../../api'
import { NEAR_MS, type ToldChange } from '../told'

/**
 * F-PT-204 (order PRODUCTION tab, 10-design §5 Block D, S4; bugs B21–B24) — the promise history inside Dates & plan, without a
 * screen: every move of the promise, newest first — from → to (a move of lines on different days says each line's own day, never
 * "— → 19 Dec": B-PT-011's `fromByLine`), which lines, why in office words (the curated reason, the office's own note apart and
 * "office only", what the customer reads — nothing when no reason was given: the automatic words, translated), who and when — and
 * the order's FIRST promise as "Date set", never counted as a move (B-PT-011's `kind`; the headline's count is the read's own:
 * `headline.promise.moves`, ONE rule with Overview).
 */

type Entry = Order['promiseHistory'][number]

/** Why a move happened, split: the reason the customer reads (a curated code), the office's own note, or the automatic words. */
export type MoveReason = { readonly kind: 'none' } | { readonly kind: 'automatic' } | { readonly kind: 'given'; readonly code: PromiseReasonCode; readonly note: string | null }

export function moveReasonOf(text: string | null): MoveReason {
  if (!text || text.trim() === '') return { kind: 'none' }
  if (isAutomaticReason(text)) return { kind: 'automatic' }
  const code = promiseReasonOf(text)
  const head = /^\s*\[?([A-Za-z_]+)\]?\s*(?::\s*([\s\S]*))?$/.exec(text)
  const named = head && (PROMISE_REASON_CODES as readonly string[]).includes(head[1]!.toUpperCase())
  // "CODE: note" — the note is the office's; a text that names no code is all the office's note (the customer reads "Our planning changed").
  const note = named ? (head[2]?.trim() || null) : code === 'PLANNING' && text.trim().toUpperCase() !== 'PLANNING' ? text.trim() : null
  return { kind: 'given', code, note }
}

export interface MoveRow {
  readonly key: string
  readonly at: string
  readonly actorId: string
  /** The days before → after: each line's own day for a lines' move on different days (B-PT-011), else the one day. */
  readonly from: readonly { readonly lineId: string | null; readonly from: string | null }[]
  readonly to: string
  /** Whole days later (+) or sooner (−) — of the one "from" day; null when the lines came from different days or none. */
  readonly delta: number | null
  readonly lineIds: readonly string[]
  readonly reason: MoveReason
}

export interface PromiseHistory {
  /** The moves, newest first (a SET row is never one). */
  readonly moves: readonly MoveRow[]
  /** The order's first promise ("Date set"): its day and when; null when the history holds no SET row. */
  readonly set: { readonly to: string; readonly at: string; readonly actorId: string } | null
}

const dayNumber = (value: string): number => Math.round(Date.parse(`${value.slice(0, 10)}T12:00:00Z`) / 86_400_000)

/** A row is the first promise: B-PT-011 says SET; an older answer (no kind): the oldest row that had no day before. */
const isSet = (entry: Entry, oldest: boolean): boolean => (entry.kind ? entry.kind === 'SET' : oldest && entry.from === null)

export function promiseHistoryOf(history: Order['promiseHistory']): PromiseHistory {
  const sorted = [...history].sort((a, b) => b.at.localeCompare(a.at))
  const last = sorted.length - 1
  const setRow = sorted.find((entry, index) => isSet(entry, index === last)) ?? null
  const moves = sorted
    .filter((entry) => entry !== setRow)
    .map((entry, index): MoveRow => {
      const byLine = entry.fromByLine && entry.fromByLine.length > 0 ? entry.fromByLine : null
      const from = byLine ? byLine.map((line) => ({ lineId: line.lineId, from: line.from })) : [{ lineId: null, from: entry.from }]
      const days = new Set(from.map((line) => line.from))
      const one = days.size === 1 ? (from[0]!.from ?? null) : null
      return { key: `${entry.at}-${index}`, at: entry.at, actorId: entry.actorId, from, to: entry.to, delta: one ? dayNumber(entry.to) - dayNumber(one) : null, lineIds: entry.lineIds, reason: moveReasonOf(entry.reason) }
    })
  return { moves, set: setRow ? { to: setRow.to, at: setRow.at, actorId: setRow.actorId } : null }
}

/** The told line of a move: the promise change nearest its time (≤ 10 min) — its message (Who was told…, Show in the thread). */
export function toldOfMove(at: string, changes: readonly ToldChange[]): ToldChange | null {
  const time = Date.parse(at)
  if (Number.isNaN(time)) return null
  let best: { change: ToldChange; gap: number } | null = null
  for (const change of changes) {
    if (change.eventType !== 'sales_order.promise_changed') continue
    const gap = Math.abs(Date.parse(change.occurredAt) - time)
    if (Number.isNaN(gap) || gap > NEAR_MS) continue
    if (!best || gap < best.gap) best = { change, gap }
  }
  return best?.change ?? null
}

/** The moves shown open: the newest; the older ones fold ("Show N earlier"). */
export const MOVES_OPEN = 1
