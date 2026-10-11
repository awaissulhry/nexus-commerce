'use client'

/**
 * Bid page, Bids view — the live hooks (KEYWORD-AUTO.md):
 *
 *   useBidsLive     asks the cursor every 5 s while a change is on its way (every 30 s once it has been on its way for
 *                   more than 5 minutes), every 60 s otherwise, never while the tab is hidden; calls `onMoved` only when
 *                   the cursor moved (the view reads its rows again, in place). Stops for good when the server has no
 *                   cursor route yet.
 *   useSuggested    Amazon's suggested bids for the ad groups of the rows on screen, read lazily (a few at a time) and kept
 *                   for the view's life; `supported` turns false when the server has no such route (the column hides).
 *
 * The schedule and the words are pure (`liveModel.ts`, `suggestedModel.ts`).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { readCursor, readSuggested, type BidsScope } from './bidsApi'
import { cursorMoved, pollDelay, SLOW_MS, type BidsCursor } from './liveModel'
import type { SuggestedState } from './suggestedModel'

export function useBidsLive({ scope, scopeKey, enabled, inFlight, inFlightSince, onMoved }: {
  scope: BidsScope
  /** The scope as one string: a new scope starts a new baseline. */
  scopeKey: string
  /** Only after the rows were read once (and not while the read failed). */
  enabled: boolean
  /** A change of the view is on its way (rows' delivery Queued / Sent). */
  inFlight: boolean
  /** Since when, by the rows (`liveModel.inFlightSince`, ms); the hook also counts from when it first saw one. */
  inFlightSince?: (firstSeen: number | null) => number | null
  onMoved: () => void
}): { supported: boolean } {
  const [supported, setSupported] = useState(true)
  const [hidden, setHidden] = useState(false)
  const [cursorBusy, setCursorBusy] = useState(false)
  const last = useRef<BidsCursor | null>(null)
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const movedRef = useRef(onMoved)
  movedRef.current = onMoved

  useEffect(() => { last.current = null }, [scopeKey])
  useEffect(() => {
    const update = () => setHidden(document.visibilityState === 'hidden')
    update()
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])

  const ask = useCallback(async () => {
    const { cursor, missing } = await readCursor(scopeRef.current)
    if (missing) { setSupported(false); return }
    if (!cursor) return
    const moved = cursorMoved(last.current, cursor)
    last.current = cursor
    setCursorBusy(cursor.waiting > 0 || cursor.sent > 0)
    if (moved) movedRef.current()
  }, [])

  // In flight: since when (the first time this view saw it, kept while it stays in flight). The pace is read at each ask,
  // so a change that stays Queued / Sent past 5 minutes slows the asks to every 30 s without a restart.
  const busy = inFlight || cursorBusy
  const firstSeen = useRef<number | null>(null)
  const busyRef = useRef(busy)
  busyRef.current = busy
  const sinceRef = useRef(inFlightSince)
  sinceRef.current = inFlightSince
  useEffect(() => { firstSeen.current = busy ? (firstSeen.current ?? Date.now()) : null }, [busy])
  const nextDelay = useCallback((): number => {
    const since = sinceRef.current ? sinceRef.current(firstSeen.current) : firstSeen.current
    return pollDelay({ hidden: false, inFlight: busyRef.current, inFlightMs: since == null ? 0 : Date.now() - since }) ?? SLOW_MS
  }, [])

  const active = supported && enabled && !hidden
  useEffect(() => {
    if (!active) return
    let stop = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      await ask()
      if (!stop) timer = setTimeout(() => void tick(), nextDelay())
    }
    // The first ask sets the baseline at once (and runs again when the tab shows or a change starts or stops being on
    // its way).
    void tick()
    return () => { stop = true; if (timer) clearTimeout(timer) }
  }, [active, busy, ask, nextDelay, scopeKey])

  return { supported }
}

/** How many ad groups are read at once. */
const AT_ONCE = 4

export function useSuggested({ adGroupIds, enabled, resetKey }: {
  /** The ad groups of the rows on screen, in the order shown. */
  adGroupIds: readonly string[]
  enabled: boolean
  /** A new scope or a save: read again. */
  resetKey: string
}): { states: ReadonlyMap<string, SuggestedState>; version: number; supported: boolean | null; reread: (adGroupIds: readonly string[]) => void } {
  const cache = useRef(new Map<string, SuggestedState>())
  const [version, setVersion] = useState(0)
  const [supported, setSupported] = useState<boolean | null>(null)
  const running = useRef(0)
  const queue = useRef<string[]>([])

  useEffect(() => { cache.current = new Map(); queue.current = []; setVersion((n) => n + 1) }, [resetKey])

  const pump = useCallback(() => {
    while (running.current < AT_ONCE && queue.current.length) {
      const id = queue.current.shift()!
      running.current += 1
      void readSuggested(id).then((state) => {
        running.current -= 1
        cache.current.set(id, state)
        // The route is there unless the server says it is not: a failed read keeps the column, its cells say "not read"
        // (audit R8: the column and the row ticks vanished with no word).
        if (state.kind === 'missing') setSupported(false)
        else setSupported((s) => s ?? true)
        setVersion((n) => n + 1)
        pump()
      })
    }
  }, [])

  const want = useCallback((ids: readonly string[], force: boolean) => {
    let added = false
    for (const id of ids) {
      const has = cache.current.get(id)
      if (has && !force) continue
      if (queue.current.includes(id)) continue
      cache.current.set(id, { kind: 'loading' })
      queue.current.push(id)
      added = true
    }
    if (added) { setVersion((n) => n + 1); pump() }
  }, [pump])

  const key = adGroupIds.join('|')
  useEffect(() => {
    if (!enabled || supported === false) return
    want(adGroupIds, false)
    // `key` stands for the list (a new array each render).
  }, [enabled, supported, key, resetKey, want]) // eslint-disable-line react-hooks/exhaustive-deps

  const reread = useCallback((ids: readonly string[]) => want(ids, true), [want])
  return { states: cache.current, version, supported, reread }
}
