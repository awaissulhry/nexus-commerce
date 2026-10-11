/**
 * Bid page, Bids view — "live": how often the view asks whether anything moved (KEYWORD-AUTO.md). Pure, tested in Node
 * (`liveModel.vitest.test.ts`).
 *
 *   GET /api/advertising/bids/cursor?<the view's scope>  →  { latestChangeAt, waiting, sent }   (no-store)
 *
 * Every 5 s while a change of the view is on its way (waiting or sent: a row's `delivery`, or the cursor's own counts),
 * every 60 s otherwise; never while the tab is hidden (it asks once when the tab shows again). A change that stays on its
 * way for more than 5 minutes (an Ask-me change waiting for a person, a slow Amazon) is not about to land: the view then
 * asks every 30 s, and says nothing about it — the chip stays Queued / Sent. The rows are read again only when the
 * cursor moved, so a quiet view costs one tiny read a minute and nothing flickers.
 */
import type { ChangeState } from '../_shared/delivery'

export interface BidsCursor { latestChangeAt: string | null; waiting: number; sent: number }

export const FAST_MS = 5_000
export const SLOW_MS = 60_000
/** The pace once a change has been on its way for longer than `BACKOFF_AFTER_MS`. */
export const BACKOFF_MS = 30_000
export const BACKOFF_AFTER_MS = 5 * 60_000

/** A change of the view is on its way to Amazon. */
export function inFlight(rows: ReadonlyArray<{ delivery?: ChangeState | null }>, cursor: BidsCursor | null): boolean {
  if (cursor && (cursor.waiting > 0 || cursor.sent > 0)) return true
  return rows.some((r) => r.delivery === 'waiting' || r.delivery === 'sent')
}

/** The next ask, in ms; null while the tab is hidden. `inFlightMs`: how long a change has been on its way. */
export function pollDelay(opts: { hidden: boolean; inFlight: boolean; inFlightMs?: number }): number | null {
  if (opts.hidden) return null
  if (!opts.inFlight) return SLOW_MS
  return (opts.inFlightMs ?? 0) > BACKOFF_AFTER_MS ? BACKOFF_MS : FAST_MS
}

/**
 * Since when a change of the view has been on its way (ms): the earlier of when the view first saw one in flight and the
 * oldest Queued / Sent row's change; null when nothing is in flight.
 */
export function inFlightSince(
  rows: ReadonlyArray<{ delivery?: ChangeState | null; lastChange?: { at: string } | null }>,
  firstSeen: number | null,
): number | null {
  let since = firstSeen
  for (const r of rows) {
    if (r.delivery !== 'waiting' && r.delivery !== 'sent') continue
    const t = r.lastChange ? Date.parse(r.lastChange.at) : NaN
    if (Number.isFinite(t) && (since == null || t < since)) since = t
  }
  return since
}

/** Did anything move since the last ask? The first answer is the baseline (the rows were just read). */
export function cursorMoved(before: BidsCursor | null, now: BidsCursor): boolean {
  if (!before) return false
  return before.latestChangeAt !== now.latestChangeAt || before.waiting !== now.waiting || before.sent !== now.sent
}

/** The cursor out of an answer; null when it is not one (the route is not there yet: the view stops asking). */
export function cursorOf(body: unknown): BidsCursor | null {
  const b = body as { latestChangeAt?: unknown; waiting?: unknown; sent?: unknown } | null
  if (!b || typeof b !== 'object' || !('latestChangeAt' in b)) return null
  return {
    latestChangeAt: typeof b.latestChangeAt === 'string' ? b.latestChangeAt : null,
    waiting: typeof b.waiting === 'number' ? b.waiting : 0,
    sent: typeof b.sent === 'number' ? b.sent : 0,
  }
}

/** The row's delivery chip: Queued / Sent / Failed always; Live only just after it landed (the last 10 min). */
export const JUST_LANDED_MS = 10 * 60_000
export function deliveryChip(row: { delivery?: ChangeState | null; lastChange?: { at: string } | null }, now: number = Date.now()): ChangeState | null {
  const d = row.delivery
  if (!d) return null
  if (d === 'waiting' || d === 'sent' || d === 'failed') return d
  if (d === 'live' && row.lastChange) {
    const t = Date.parse(row.lastChange.at)
    return Number.isFinite(t) && now - t <= JUST_LANDED_MS ? 'live' : null
  }
  return null
}
