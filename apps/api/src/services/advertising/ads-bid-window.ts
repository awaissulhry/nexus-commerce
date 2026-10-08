/**
 * Bid optimiser review 2026-10-08 (A + B) — what the optimiser reads about a target's own bid history. Pure: no
 * database, no clock; the caller passes the moves, the days and the data day.
 *
 * A — Amazon charges less than the bid. The optimiser's goal is a CPC (target × what a click is worth); the bid that
 * buys that CPC is the CPC ÷ r̂ (paid CPC ÷ bid), as in the bid brain (bid-brain/recipe.ts bidForAcos). r̂ is measured
 * against the bid that SERVED the window's clicks: a bid moved this morning has paid for no settled click yet, and
 * dividing the window's CPC by it would make r̂ — and so the goal — follow the optimiser's own moves.
 *
 * B — a move waits for evidence (one target went 8 → 10 → 8¢ in 6 hours on 2026-10-07/08, as the window's edge moved
 * one day at 00:00 UTC):
 *   once a data day     a target moves at most once per settled data day, whichever automatic writer moved it first
 *                       (auto-bid, a rule, an autopilot plan, an hourly plan): they do not undo each other in one day
 *   no quick reversal   a move against this optimiser's own last move (its writes carry their data day) waits
 *                       REVERSAL_WAIT_DATA_DAYS data days, while the bid is still where that move left it
 */
import { ENGINE_FLOOR_CENTS } from './bid-brain/recipe.js'

/** A move against the optimiser's own last move waits this many settled data days. */
export const REVERSAL_WAIT_DATA_DAYS = 3

const DAY_MS = 86_400_000

/** One write of a target's serving bid: when, and from → to (cents). */
export interface BidMove {
  at: Date
  fromCents: number
  toCents: number
}

/** One settled day of a target with clicks (`date` = the day's 00:00 UTC). */
export interface ClickDay {
  date: Date
  clicks: number
}

/** An automatic write of a target's bid, as the waits read it. */
export interface AutoMove {
  /** The settled data day it was decided on: stamped on the optimiser's own writes, else the day its write fell on. */
  dataDay: string
  fromCents: number
  toCents: number
  /** The writer (AdvertisingActionLog.userId), for the reason. */
  by: string
  /** True when the write carries its data day (the optimiser's own writes from this change on). */
  stamped: boolean
}

/** 'YYYY-MM-DD' of a date (UTC). */
export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** Whole data days from `a` to `b` ('YYYY-MM-DD'): positive when `b` is later. */
export function dataDaysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS)
}

/** A write that moved the serving bid: both sides at or above the 5¢ engine floor (a stop's low bid and its restore are not moves). */
export function isServingMove(fromCents: number, toCents: number): boolean {
  return Number.isFinite(fromCents) && Number.isFinite(toCents) && fromCents >= ENGINE_FLOOR_CENTS && toCents >= ENGINE_FLOOR_CENTS && fromCents !== toCents
}

/** The bid in force over one UTC day, weighted by the hours it served: before the first move its `from`, after each move its `to`. */
export function servingBidOn(dayStart: Date, moves: readonly BidMove[]): number {
  const start = dayStart.getTime()
  const end = start + DAY_MS
  let bid = moves[0].fromCents
  let at = start
  let weighted = 0
  for (const m of moves) {
    const t = m.at.getTime()
    if (t <= start) { bid = m.toCents; continue }
    if (t >= end) break
    weighted += bid * (t - at)
    at = t
    bid = m.toCents
  }
  weighted += bid * (end - at)
  return weighted / DAY_MS
}

/** How the bid that served a window was found: unchanged (no move), weighted by each day's clicks, or by time alone. */
export type WindowBidBasis = 'unchanged' | 'clicks' | 'time'

/**
 * The bid that served the window's clicks. No move since the window began: today's bid served every click. Moves and
 * daily clicks: each day's serving bid weighted by its clicks. Moves but no daily clicks (the legacy columns hold one sum
 * for the window): each bid weighted by the time it served inside the window, from `window.since` to `window.until` —
 * a move after the window's end served none of its clicks.
 */
export function windowBidCents(currentCents: number, moves: readonly BidMove[], days: readonly ClickDay[], window: { since: Date; until: Date }): { cents: number; basis: WindowBidBasis } {
  const serving = moves.filter((m) => isServingMove(m.fromCents, m.toCents)).sort((a, b) => a.at.getTime() - b.at.getTime())
  if (!serving.length) return { cents: currentCents, basis: 'unchanged' }
  let clicks = 0
  let weighted = 0
  for (const d of days) {
    if (!(d.clicks > 0)) continue
    clicks += d.clicks
    weighted += d.clicks * servingBidOn(d.date, serving)
  }
  if (clicks > 0) return { cents: weighted / clicks, basis: 'clicks' }
  const start = window.since.getTime()
  const end = window.until.getTime()
  let bid = serving[0].fromCents
  let at = start
  let sum = 0
  for (const m of serving) {
    const t = m.at.getTime()
    if (t <= start) { bid = m.toCents; continue }
    if (t >= end) break
    sum += bid * (t - at)
    at = t
    bid = m.toCents
  }
  sum += bid * (end - at)
  return { cents: end > start ? sum / (end - start) : bid, basis: 'time' }
}

/** Once a data day: why a target waits because an automatic writer already moved its bid on this data day, or null. */
export function movedThisDataDay(dataDay: string, moves: readonly AutoMove[]): string | null {
  const m = moves.find((x) => x.dataDay === dataDay && isServingMove(x.fromCents, x.toCents))
  return m ? `already moved on data day ${dataDay} (${m.fromCents} → ${m.toCents}¢ by ${m.by}) — one move per data day` : null
}

/**
 * No quick reversal: why a move from `currentCents` to `proposedCents` waits, or null. It waits when it goes against the
 * optimiser's own newest move (`stamped`), that move left the bid where it is now, and it is younger than
 * REVERSAL_WAIT_DATA_DAYS data days. A move in the same direction, or one against another writer's move, does not wait.
 */
export function reversalWait(dataDay: string, currentCents: number, proposedCents: number, moves: readonly AutoMove[]): string | null {
  const last = moves.find((x) => x.stamped && isServingMove(x.fromCents, x.toCents))
  if (!last || last.toCents !== currentCents || proposedCents === currentCents) return null
  const lastUp = last.toCents > last.fromCents
  const nowUp = proposedCents > currentCents
  if (lastUp === nowUp) return null
  const age = dataDaysBetween(last.dataDay, dataDay)
  if (age >= REVERSAL_WAIT_DATA_DAYS) return null
  return `would reverse its own ${lastUp ? 'raise' : 'cut'} ${last.fromCents} → ${last.toCents}¢ of data day ${last.dataDay} — a reversal waits ${REVERSAL_WAIT_DATA_DAYS} data days (${REVERSAL_WAIT_DATA_DAYS - age} to go)`
}
