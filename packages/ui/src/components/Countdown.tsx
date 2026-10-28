'use client'

/**
 * Countdown — the time left until a moment, live (gap G7, the approvals grid, 2026-10-05).
 *
 *   <Countdown to={row.executeAfter} label={(t) => `Runs in ${t}`} doneLabel="Starting…" onDone={refresh} />
 *
 * Why its own component and not a `live` mode on `AsOf`: `AsOf` states when something was last OBSERVED ("checked
 * 5 min ago · channel read") and its empty states mean "never checked". A countdown is a DEADLINE: it ticks, it ends,
 * and its end is an event the page acts on (`onDone`). One component with both jobs would make every `AsOf` carry a
 * timer and an end it never has.
 *
 * - Ticks every second under a minute, then every 30 s ("in 3 h") — ONE shared timer for the whole page
 *   (`countdownTicker.ts`), paused while the tab is hidden. An instance re-renders only when its words change.
 * - `onDone` runs once, when this countdown reaches zero on screen. A time that was already past when it mounted does
 *   not call it: a row whose moment passed before the read is the server's to update, not a reason to refresh again.
 * - A screen reader hears a polite update at 60 s, 30 s, 10 s and zero — never every second — and the region is
 *   cleared a few seconds later so a later read of the cell is not stale. A page with its own live region passes
 *   `announce={false}`.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

import { countdownSnapshot, countdownTarget, countdownTicker, readCountdownSnapshot } from './countdownTicker'

export interface CountdownProps {
  /** When it reaches zero — an ISO instant or epoch milliseconds. */
  to: string | number
  /** The words around the time left. Default `in 14 s`. */
  label?: (left: string) => string
  /** Shown from zero on. Default "now". */
  doneLabel?: string
  /** Called once, when this countdown reaches zero while mounted (to refresh the row, typically). */
  onDone?: () => void
  /** Polite screen-reader updates at 60 s, 30 s, 10 s and zero. Default true. */
  announce?: boolean
  /** The read's clock, for a server render that matches the first client render (as `AsOf`). */
  now?: number
  className?: string
}

const defaultLabel = (left: string) => `in ${left}`
/** How long an announcement stays in the live region before it is cleared. */
const SPOKEN_FOR_MS = 4000
const noop = () => () => {}

export function Countdown({ to, label = defaultLabel, doneLabel = 'now', onDone, announce = true, now, className }: CountdownProps) {
  const target = countdownTarget(to)
  const valid = Number.isFinite(target)
  const subscribe = useCallback((notify: () => void) => countdownTicker().subscribe(target, notify), [target])
  const snapshot = useSyncExternalStore(
    valid ? subscribe : noop,
    () => (valid ? countdownSnapshot(target - countdownTicker().now()) : null),
    // No clock on the server unless the read passed one: render the instant itself, as `AsOf` does.
    () => (valid && now !== undefined ? countdownSnapshot(target - now) : null),
  )
  const view = snapshot === null ? null : readCountdownSnapshot(snapshot)
  const done = view?.done ?? false
  const words = view === null ? '' : view.done ? doneLabel : label(view.text)

  // onDone: once, and only after this instance saw time left.
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone
  const sawTimeLeft = useRef(false)
  const fired = useRef(false)
  useEffect(() => {
    if (view === null) return
    if (!done) {
      sawTimeLeft.current = true
      fired.current = false
    } else if (sawTimeLeft.current && !fired.current) {
      fired.current = true
      onDoneRef.current?.()
    }
  }, [view === null, done])

  // Announce on a step change after mount; clear it later so the region never holds a stale time.
  const step = view?.step ?? null
  const lastStep = useRef<number | null | undefined>(undefined)
  const wordsRef = useRef(words)
  wordsRef.current = words
  const [spoken, setSpoken] = useState('')
  useEffect(() => {
    if (!announce) return
    const previous = lastStep.current
    lastStep.current = step
    if (previous === undefined || step === null || step === previous) return
    setSpoken(wordsRef.current)
    const clear = setTimeout(() => setSpoken(''), SPOKEN_FOR_MS)
    return () => clearTimeout(clear)
  }, [step, announce])

  const iso = valid ? new Date(target).toISOString() : undefined
  return (
    <span className={`nds-countdown${done ? ' done' : ''}${className ? ` ${className}` : ''}`}>
      <time dateTime={iso}>{view === null ? (iso ?? '—') : words}</time>
      {announce && <span className="nds-vh" aria-live="polite" aria-atomic="true">{spoken}</span>}
    </span>
  )
}
