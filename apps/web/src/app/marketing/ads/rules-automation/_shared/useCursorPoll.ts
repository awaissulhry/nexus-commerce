'use client'

/**
 * Cursor polling for the Rules & Automation pages.
 *
 * Written by BID.S0 as `bid/useCursorPoll.ts`, shaped for this promotion and pre-blessed for it by
 * its own closing section ("moving this file into `_shared/` is the whole of the shared-layer
 * change"). BUD.1 moved it, unchanged apart from this header: the Budget page is the second caller,
 * and a second caller is the moment a page-local file either becomes shared or becomes a fork.
 *
 * 🔴 **Nothing below knows what a bid, or a budget, is.** It takes a URL, a params object and a
 * baseline cursor, and returns four fields. The page-specific parts are the endpoint and what the
 * caller compares — which is why the two callers can disagree completely about what a cursor
 * contains (Bid's is `{ targetsAt, loggedAt, n }`; Budget's is a *value* fingerprint, because
 * `Campaign.updatedAt` fires ~7×/day against ~3 real budget changes and would light the banner
 * more often wrongly than rightly) and still share every line of this file.
 *
 * The programme wants the eleven Rules & Automation pages to stay in sync with each other without a
 * reload: a rank schedule flipping to Min-bid at 00:00 changes twelve rows of the Bid grid, and an
 * operator staring at a stale grid while an engine moves bids underneath it is the failure mode
 * this exists to prevent.
 *
 * ── 🔴 Why this is not a subscription ───────────────────────────────────────────────────────────
 *
 * The ads SSE bus is inverted: it carries **0.21% of writes**, the engines publish nothing to it,
 * and writes are bursty (7% of minutes hold all of them). Subscribing to it produces a page that
 * feels live and is wrong. So: poll a cursor.
 *
 * ── What makes a cursor honest here ─────────────────────────────────────────────────────────────
 *
 * The server's cursor is `{ targetsAt, loggedAt, n }` and the load-bearing field is **`targetsAt`
 * = max(AdTarget.updatedAt)**, not the audit log. Measured 2026-08-12 at 00:30 Rome, the two were
 * **134 minutes apart**: the hourly inbound resync (`ads-keyword-bid-resync`) overwrites `bidCents`
 * with Amazon's value and leaves no `AdvertisingActionLog` row and no `CampaignBidHistory` row. A
 * poll watching only the audit spine would sit there reporting "nothing changed" through every bid
 * edit made in Seller Central. `n` is the third field because neither timestamp moves on a create
 * or a delete.
 *
 * ── Three rules this hook follows ───────────────────────────────────────────────────────────────
 *
 *   1. **Never yank rows out from under someone reading.** A change sets `stale` and offers a
 *      button; it does not refetch. The one screen in this product an operator uses to decide
 *      whether a bid is wrong is not a screen that should reorder itself mid-sentence.
 *   2. **Do not poll a background tab.** `setInterval` is throttled to once a minute or worse in a
 *      hidden tab and the request is wasted either way. It pauses on `visibilitychange` and does
 *      one immediate check on the way back, which is also when the answer matters most.
 *   3. **A failed poll is silent.** The cursor going down must never put an error on a page whose
 *      data loaded fine.
 *
 * ── The lift, done ──────────────────────────────────────────────────────────────────────────────
 *
 * BUD.1, 2026-08-12: moved here from `bid/`, no signature altered, Bid verified unchanged on prod
 * afterwards. Placement and Rank can take it as-is. A page adopting it owes exactly one thing —
 * a cursor whose fields actually move when ITS subject moves, measured rather than assumed. Bid's
 * measurement rejected the audit log as load-bearing; Budget's rejected the row timestamp. Copying
 * a sibling's cursor shape without re-measuring is the one way to misuse this hook.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

export interface CursorPollOptions<C> {
  /** absolute URL of the cursor endpoint, without a query string */
  url: string
  /** scope params — the cursor must describe the same row set the page is showing */
  params: Record<string, string>
  /** the cursor the currently-rendered payload was read with; null while loading */
  baseline: C | null
  /** how often to check, in ms. 45 s: fast enough to notice an engine tick, cheap enough to ignore */
  intervalMs?: number
  /** false while a write is in flight or a drawer is open — S3 and S4 will use this */
  enabled?: boolean
}

export interface CursorPollResult<C> {
  /** the newest cursor seen, or null if no poll has succeeded yet */
  cursor: C | null
  /** true once the server's cursor differs from `baseline` */
  stale: boolean
  /** when the last successful poll landed */
  lastCheckedAt: string | null
  /** check right now (used on tab focus, and by a manual Refresh) */
  check: () => void
}

/** Structural equality over a flat cursor object. Two cursors are the same iff every field is. */
function sameCursor<C extends Record<string, unknown>>(a: C | null, b: C | null): boolean {
  if (!a || !b) return a === b
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) if (a[k] !== b[k]) return false
  return true
}

export function useCursorPoll<C extends Record<string, unknown>>({
  url, params, baseline, intervalMs = 45_000, enabled = true,
}: CursorPollOptions<C>): CursorPollResult<C> {
  const [cursor, setCursor] = useState<C | null>(null)
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null)

  // The params object is rebuilt on every render by every caller, so the effect keys off its
  // serialisation rather than its identity. An effect keyed on the object would re-subscribe on
  // every keystroke — the same trap that makes a `defaultSort` effect loop.
  const key = JSON.stringify(params)
  const alive = useRef(true)

  const check = useCallback(() => {
    const qs = new URLSearchParams(JSON.parse(key) as Record<string, string>).toString()
    void fetch(`${url}${qs ? `?${qs}` : ''}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!alive.current || !j) return
        setCursor(j as C)
        setLastCheckedAt(new Date().toISOString())
      })
      .catch(() => { /* rule 3: a failed poll is silent */ })
  }, [url, key])

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  // A new scope means the previous cursor described a different row set; holding it would show a
  // "changed" banner that is really just "you moved".
  useEffect(() => { setCursor(null) }, [key])

  useEffect(() => {
    if (!enabled) return
    let timer: ReturnType<typeof setInterval> | null = null
    const start = () => {
      if (timer) return
      timer = setInterval(check, intervalMs)
    }
    const stop = () => { if (timer) { clearInterval(timer); timer = null } }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') { check(); start() } else stop()
    }
    if (document.visibilityState === 'visible') start()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', check)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', check)
    }
  }, [check, intervalMs, enabled])

  return {
    cursor,
    stale: !!cursor && !!baseline && !sameCursor(cursor, baseline),
    lastCheckedAt,
    check,
  }
}
