'use client'

/**
 * PES.4 — one read path for the drawer's server reads.
 *
 * 🔴 Why this exists, in one sentence: `requestId` in #290 fixed the two instances, and this fixes
 * the shape that produced them.
 *
 * Three hooks here (`useFieldHistory`, `useCompare`, `useRecordState`) had each hand-rolled the
 * same `{status, data, error, reload}` machine around a fetch — the same five-member status union
 * byte-for-byte, the same 404/501 → `unavailable` split, three times. Each was written carefully.
 * But the staleness guard was a line every author had to remember independently, and two of three
 * did not (FE.1, #290) — which is the signature of duplicated plumbing rather than of careless
 * authors. A rule that must be re-remembered per copy is a rule that will be missed per copy.
 *
 * **It takes a producer, not a URL.** A `useStudioRead(url)` would have fitted exactly one of the
 * three: compare is N parallel reads with per-target failure tolerance, and record-state is two
 * sequential reads merged into one keyspace. Owning the state machine and letting the caller own
 * the request absorbs all three, where a URL-shaped hook would have left two exceptions behind —
 * and exceptions are where the next missed guard would live.
 *
 * What it guarantees, so no caller has to:
 *
 *  - **Last request wins.** A monotonic id, not an effect-scoped flag: `reload()` calls `start()`
 *    directly, where there is no cleanup to trip. A superseded request cannot write state — not on
 *    success, and not on failure either, since a slow 500 landing after a fast 200 would otherwise
 *    replace good data with an error.
 *  - **The superseded request is aborted**, not merely ignored: the browser caps connections per
 *    origin, and a pane the operator is clicking through can hold several open at once.
 *  - **A deadline.** #284's class — a `fetch` with no timeout waits as long as the network makes it,
 *    and a drawer that never resolves shows a spinner that means nothing. 30s, then an error that
 *    says it was given up on rather than answered.
 *  - **404/501 is `unavailable`, not `error`** — "this endpoint has not shipped" is a different
 *    sentence from "this request failed", and the drawer says so. `studioFetch` applies the split
 *    at the one place it is decided.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

export type StudioReadStatus = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'

/** #284 — no drawer read waits longer than this. */
export const STUDIO_READ_DEADLINE_MS = 30_000

/** The endpoint is not there: 404 (not mounted) or 501 (mounted, declaring itself unimplemented). */
export class NotShipped extends Error {
  constructor(status?: number) {
    super(`endpoint not shipped${status ? ` (HTTP ${status})` : ''}`)
    this.name = 'NotShipped'
  }
}

/**
 * A drawer read. Applies ONLY the not-shipped split and returns the response otherwise — callers
 * still decide what their own non-ok statuses mean, because they differ: compare reads 400/204 as
 * "no listing on this coordinate", record-state reads the error body for a message.
 */
export async function studioFetch(url: string, signal: AbortSignal): Promise<Response> {
  const res = await fetch(url, { cache: 'no-store', credentials: 'include', signal })
  if (res.status === 404 || res.status === 501) throw new NotShipped(res.status)
  return res
}

export type StudioReadRun<T> = (signal: AbortSignal) => Promise<T>

export interface StudioRead<T> {
  status: StudioReadStatus
  data: T | null
  error: string | null
  reload: () => void
}

interface Snapshot<T> {
  status: StudioReadStatus
  data: T | null
  error: string | null
}

const IDLE: Snapshot<never> = { status: 'idle', data: null, error: null }

function describe(e: unknown, timedOut: boolean): string {
  if (timedOut) {
    return `No response after ${Math.round(STUDIO_READ_DEADLINE_MS / 1000)}s — the request was given up on, not answered.`
  }
  return e instanceof Error ? e.message : String(e)
}

/**
 * @param run     The request. MUST be memoised by the caller — its identity is what re-runs the
 *                read, exactly as a `useEffect` dep would.
 * @param enabled False parks the hook at `idle` without fetching, and aborts anything in flight.
 */
export function useStudioRead<T>(run: StudioReadRun<T>, enabled: boolean): StudioRead<T> {
  const [snap, setSnap] = useState<Snapshot<T>>(IDLE)
  const requestId = useRef(0)
  const inFlight = useRef<AbortController | null>(null)

  const start = useCallback((): (() => void) => {
    inFlight.current?.abort()
    inFlight.current = null
    if (!enabled) {
      requestId.current++
      setSnap(IDLE)
      return () => {}
    }

    const mine = ++requestId.current
    const stale = () => mine !== requestId.current
    const ctl = new AbortController()
    inFlight.current = ctl
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      ctl.abort()
    }, STUDIO_READ_DEADLINE_MS)

    // 🔴 `data: null`, NOT the previous data kept for a smoother refresh. Holding it means the
    // moment the read's subject changes — a different field, a different instant — the OLD
    // subject's data renders under the NEW subject's label until the response lands. That is #290
    // again wearing a nicer name, and it reads as fact rather than as a stale frame.
    setSnap({ status: 'loading', data: null, error: null })

    void (async () => {
      try {
        const data = await run(ctl.signal)
        if (stale()) return
        setSnap({ status: 'ready', data, error: null })
      } catch (e) {
        if (stale()) return
        if (e instanceof NotShipped) {
          setSnap({ status: 'unavailable', data: null, error: null })
          return
        }
        setSnap({ status: 'error', data: null, error: describe(e, timedOut) })
      } finally {
        clearTimeout(timer)
        if (inFlight.current === ctl) inFlight.current = null
      }
    })()

    return () => {
      // Bumping the id here is what makes the abort safe under StrictMode's mount/unmount/mount:
      // the cancelled first run can no longer write, and the second run starts clean.
      requestId.current++
      clearTimeout(timer)
      ctl.abort()
    }
  }, [run, enabled])

  useEffect(() => start(), [start])

  const reload = useCallback(() => {
    start()
  }, [start])

  return useMemo(
    () => ({ status: snap.status, data: snap.data, error: snap.error, reload }),
    [snap, reload],
  )
}
