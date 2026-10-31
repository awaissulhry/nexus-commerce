'use client'

/**
 * FloorElapsed — a count-up or count-down time at numeral size (B-W2b-28, design part FloorElapsed): the running
 * operation, an open help call, the time clocked in today, a break that ends.
 *
 *   <FloorElapsed label="In lavorazione" since={op.startedAt} carriedMs={op.carriedMs} paused={op.paused}
 *                 labels={ds.floorElapsed} />
 *   <FloorElapsed label="Chiamata aperta" since={call.openedAt} warnAfterMs={5 * 60_000} dangerAfterMs={10 * 60_000} />
 *   <FloorElapsed label="Oggi" since={clockedInAt} precision="minutes" />
 *   <FloorElapsed label="Fine pausa" until={breakEndsAt} />
 *
 * - ONE shared second-ticker for the page (`elapsedTicker.ts`), stopped while the tab is hidden. A numeral re-renders
 *   only when its text changes (once a minute in `minutes` precision).
 * - A screen reader hears minute-level words in a polite live region ("12 minutes"), so it changes once a minute,
 *   never every second; `announce={false}` keeps the words but stops the live updates (a page with its own region).
 * - Tones rise with `warnAfterMs` / `dangerAfterMs`; a countdown past zero says "Over" and counts on in the danger
 *   tone. Colour is never alone: a clock icon becomes a warning icon, and paused / over carry a word.
 * - Sized by the density: the numeral is 1.6 × `--nds-density-font-numeral` (64 px on the floor tier, 154 px on the
 *   display tier), `size="md"` the numeral size itself.
 * - Server render: with `now` it draws that moment; without, a dash until the client reads the clock.
 */
import { useCallback, useId, useSyncExternalStore, type ReactNode } from 'react'
import { AlertTriangle, Clock, Pause } from 'lucide-react'

import { mergeLabels } from '../../lib/labels'
import { elapsedTicker } from './elapsedTicker'
import { FLOOR_ELAPSED_LABELS, type FloorElapsedLabels } from './FloorElapsedLabels'
import {
  elapsedClock,
  elapsedHoursMinutes,
  elapsedIsoDuration,
  elapsedMoment,
  elapsedReading,
  elapsedTone,
  elapsedWords,
  type ElapsedPrecision,
  type ElapsedTone,
} from './floorElapsedModel'
import '../floor.css'
import './floorElapsed.css'

export interface FloorElapsedProps {
  /** Count up from this moment — an ISO instant or epoch ms. */
  since?: string | number | null
  /** Count down to this moment. Wins over `since`. */
  until?: string | number | null
  /** Time counted before `since` (earlier runs); with `paused`, the total to show. */
  carriedMs?: number
  /** Frozen: shows `carriedMs` and the word "Paused". */
  paused?: boolean
  /** `seconds` (default): "12:07". `minutes`: "7 h 42 min" — the time clocked in. */
  precision?: ElapsedPrecision
  /** What is timed ("In lavorazione"); also the screen reader's name for the time. */
  label?: ReactNode
  /** The words a screen reader hears before the time when `label` is not plain text. */
  srLabel?: string
  warnAfterMs?: number
  dangerAfterMs?: number
  /** Polite minute-level updates for a screen reader. Default true. */
  announce?: boolean
  /** `lg` (default) 1.6 × the numeral size; `md` the numeral size. */
  size?: 'md' | 'lg'
  /** The read's clock, for a server render that matches the first client render. */
  now?: number
  labels?: Partial<FloorElapsedLabels>
  id?: string
}

const noop = () => () => {}

/** What one snapshot draws. */
interface ElapsedView {
  over: boolean
  tone: ElapsedTone
  /** The clock form ("12:07", "+0:45"); empty in `minutes` precision. */
  text: string
  hm: { h: number; m: string } | null
  /** The time cut to whole minutes: the screen reader's words. */
  minuteMs: number
  iso: string
}

export function FloorElapsed({
  since,
  until,
  carriedMs,
  paused = false,
  precision = 'seconds',
  label,
  srLabel,
  warnAfterMs,
  dangerAfterMs,
  announce = true,
  size = 'lg',
  now,
  labels,
  id,
}: FloorElapsedProps) {
  const lw = mergeLabels(FLOOR_ELAPSED_LABELS, labels)
  const sinceMs = elapsedMoment(since)
  const untilMs = elapsedMoment(until)
  const counting = (sinceMs !== undefined || untilMs !== undefined) && !paused
  const known = sinceMs !== undefined || untilMs !== undefined || paused
  const input = { since: sinceMs, until: untilMs, carriedMs, paused }

  // The snapshot is the view on screen, as one string: a numeral re-renders only when its text changes, and the server
  // render, the hydration and the first client render all draw from the same snapshot.
  const viewAt = (at: number): string => {
    const r = elapsedReading(input, at)
    const view: ElapsedView = {
      over: r.over,
      tone: elapsedTone(r, { warnAfterMs, dangerAfterMs }),
      text: precision === 'minutes' ? '' : `${r.over ? '+' : ''}${elapsedClock(r.ms, r.mode)}`,
      hm: precision === 'minutes' ? elapsedHoursMinutes(r.ms) : null,
      minuteMs: Math.floor(r.ms / 60000) * 60000,
      // The duration only to the minute in `minutes` precision, so the snapshot does not change every second.
      iso: elapsedIsoDuration(precision === 'minutes' ? Math.floor(r.ms / 60000) * 60000 : r.ms, r.mode),
    }
    return JSON.stringify(view)
  }
  const subscribe = useCallback((notify: () => void) => elapsedTicker().subscribe(notify), [])
  const snapshot = useSyncExternalStore(
    counting ? subscribe : noop,
    () => (known ? viewAt(elapsedTicker().now()) : null),
    () => (known && (now !== undefined || !counting) ? viewAt(now ?? 0) : null),
  )

  const auto = useId()
  const labelId = `${auto}-label`
  const view: ElapsedView | null = snapshot === null ? null : (JSON.parse(snapshot) as ElapsedView)
  const tone = view?.tone ?? 'neutral'
  const words = view ? elapsedWords({ ms: view.minuteMs, over: view.over }, lw) : ''
  const name = srLabel ?? (typeof label === 'string' ? label : '')
  const hm = view?.hm ?? null

  return (
    <div
      id={id}
      className="nds-floor-elapsed"
      data-size={size}
      data-tone={tone}
      data-paused={paused ? 'true' : undefined}
      data-over={view?.over ? 'true' : undefined}
      role="group"
      aria-labelledby={label ? labelId : undefined}
    >
      {label ? (
        <span id={labelId} className="nds-floor-elapsed-label">
          {label}
        </span>
      ) : null}
      <span className="nds-floor-elapsed-row">
        <span className="nds-floor-icon nds-floor-elapsed-icon" aria-hidden>
          {paused ? <Pause /> : tone === 'neutral' ? <Clock /> : <AlertTriangle />}
        </span>
        <time className="nds-floor-elapsed-time" dateTime={view?.iso} aria-hidden>
          {view === null ? (
            '—'
          ) : hm ? (
            <>
              {hm.h > 0 ? (
                <>
                  {hm.h}
                  <span className="nds-floor-elapsed-unit">{lw.hourUnit}</span>{' '}
                </>
              ) : null}
              {hm.h > 0 ? hm.m : String(Number(hm.m))}
              <span className="nds-floor-elapsed-unit">{lw.minuteUnit}</span>
            </>
          ) : (
            view.text
          )}
        </time>
        {paused ? <span className="nds-floor-elapsed-state">{lw.paused}</span> : view?.over ? <span className="nds-floor-elapsed-state">{lw.overWord}</span> : null}
      </span>
      <span className="nds-floor-sr" aria-live={announce ? 'polite' : 'off'} aria-atomic="true">
        {view ? (name ? `${name}: ${words}` : words) : ''}
        {paused && view ? ` (${lw.paused})` : ''}
      </span>
    </div>
  )
}
