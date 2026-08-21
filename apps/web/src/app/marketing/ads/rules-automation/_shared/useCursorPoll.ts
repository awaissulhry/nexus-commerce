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
 * afterwards. Placement and Rank can take it as-is.
 *
 * ── 🔴 THE CURSOR CONTRACT (RA.SPINE S2, ratified 2026-08-12) ───────────────────────────────────
 *
 * This replaces the substrate spec's §1.3 — a single account-wide `GET /advertising/pulse` returning
 * ledger cursors, polled by one provider and shared by every open page. **That design is withdrawn
 * as falsified**, and the measurement that falsified it is the one above: at 00:30 Rome on
 * 2026-08-12, `max(AdTarget.updatedAt)` and the newest `AdvertisingActionLog` row were **134 minutes
 * apart**, because `ads-keyword-bid-resync` writes `bidCents` from Amazon's value and leaves no
 * ledger row at all. A ledger cursor would have sat reporting "nothing changed" through every bid
 * edit an operator made in Seller Central. One account-wide cursor cannot be honest about eleven
 * different subjects, because the tables that move are not the same tables.
 *
 * What replaces it, and what a page adopting this hook owes:
 *
 *   **Each page brings its own cursor, over fields that actually move when ITS subject moves, and
 *   it measures that rather than assuming it.**
 *
 * The two existing callers reached OPPOSITE conclusions from the same question, which is the proof
 * that the question has to be asked per page:
 *
 *   · **Bid** rejected the audit log as load-bearing and keys on `{ targetsAt, loggedAt, n }`,
 *     where `targetsAt = max(AdTarget.updatedAt)` carries the weight.
 *   · **Budget** rejected the row timestamp and keys on a *value* fingerprint, because
 *     `Campaign.updatedAt` fires ~7×/day against ~3 real budget changes and would light the banner
 *     more often wrongly than rightly.
 *
 * Neither could have used the other's shape. **Copying a sibling's cursor without re-measuring is
 * the one way to misuse this hook** — it produces a page that feels live and is lying, which is
 * strictly worse than a page that is visibly stale. `n` is the third field on Bid's because neither
 * timestamp moves on a create or a delete; ask that question too.
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
  /**
   * 🔴 Pass `false` while a WRITE IS IN FLIGHT or a DRAWER IS OPEN. (RA.SPINE S2.)
   *
   * The hook never refetches on its own — rule 1 — so this is not about rows moving. It is about
   * the two moments when even the *offer* is wrong:
   *
   *   · **A write in flight.** The page is holding an optimistic value. A tick landing mid-flight
   *     reads the pre-write cursor, sets `stale`, and invites the operator to refresh away their
   *     own uncommitted edit — the banner blames the server for the operator's own keystroke.
   *     Re-enable when the write settles, not when it is sent.
   *   · **A drawer or inspector is open.** The subject on screen is one row, and `check()` fires on
   *     `window.focus` — so clicking back into the tab from another window pops a banner over an
   *     open panel about rows the operator is not currently looking at.
   *
   * Disabling stops the interval AND the focus/visibility listeners, so no tick can arrive at all;
   * it does not merely suppress the banner. The last cursor read is kept, so re-enabling does not
   * re-announce a change that was already on screen.
   */
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

/**
 * RT.2 — read the cursor ONCE per data load, to serve as `baseline`.
 *
 * Bid, Budget and Placement get their baseline free: their one read returns `cursor` on the
 * payload, so the poll compares against the exact cursor the rendered rows were read with. The five
 * pages wired in RT.2 have no such field — several make three or four reads with no single payload
 * to hang it on — and `baseline: null` makes `stale` unreachable, which is how Apply Rules came to
 * poll a 404 in silence for a fortnight without anyone noticing.
 *
 * So: read the cursor alongside the data, key it to the same reload signal, and hand it back.
 *
 * 🔴 There is a real gap between the data landing and this resolving — a change inside that window
 * is baked into the baseline and never announced. That is the honest trade for not restructuring
 * five payloads, and it is bounded: the reads are milliseconds apart, and the NEXT change still
 * fires. A payload-carried cursor is strictly better; a page adding one should stop calling this.
 */
export function useCursorBaseline<C extends Record<string, unknown>>(
  url: string,
  params: Record<string, string>,
  reloadKey: unknown,
): C | null {
  const [baseline, setBaseline] = useState<C | null>(null)
  const key = JSON.stringify(params)
  useEffect(() => {
    let alive = true
    // Null it first: a stale baseline from the previous scope would compare against the new
    // scope's cursor and announce "changed" when all that changed is what you asked for.
    setBaseline(null)
    const qs = new URLSearchParams(JSON.parse(key) as Record<string, string>).toString()
    void fetch(`${url}${qs ? `?${qs}` : ''}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (alive && j) setBaseline(j as C) })
      .catch(() => { /* same rule 3: a failed cursor read is silent */ })
    return () => { alive = false }
  }, [url, key, reloadKey])
  return baseline
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

  // A baseline with NEW CONTENT (scope change, reload, or the caller re-baselining after its own
  // write) makes any held poll cursor obsolete: comparing an old cursor against a fresh baseline
  // announces the caller's own write as someone else's change, and the false banner stands until
  // the next tick. Keyed on content, not identity — a caller may rebuild the object every render.
  const baselineKey = baseline == null ? null : JSON.stringify(baseline)
  useEffect(() => { if (baselineKey != null) setCursor(null) }, [baselineKey])

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
