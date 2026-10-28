'use client'

/**
 * JobProgress — the progress of one background job, for a dialog: a label, a `ProgressBar`, a
 * count line, the elapsed time and an optional muted note ("You can close this window…").
 * Determinate when both `value` and `max` are given, indeterminate otherwise — a bar that moves
 * without a count is honest about not knowing how far along the job is.
 *
 * The count line is a polite live region that is ALWAYS mounted (empty until the first count), so
 * the first count is announced too; the elapsed time is a `timer`, never live, so it does not
 * speak every second. Numbers are tabular so the line does not jitter as they change. The clock
 * ticks once a second from `startedAt` and stops when the component unmounts.
 * Requires `styles/components.css`.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { ProgressBar } from './ProgressBar'
import { formatElapsed } from '../lib/format'

export interface JobProgressProps {
  /** What the job is doing — "Saving changes". Also the progress bar's accessible name. */
  label: string
  /** Units done. Determinate only when `max` is given too. */
  value?: number
  /** Units in total. */
  max?: number
  /** The count, in words — "120 of 400 records". Announced politely as it changes. */
  detail?: ReactNode
  /** When the job started (ms since epoch). Shows the elapsed time, ticking each second. */
  startedAt?: number
  /** Muted line under the count — "You can close this window. The job continues in Nexus." */
  note?: ReactNode
  className?: string
}

/** Percent done, or null when the job's size is unknown. */
export function jobPercent(value: number | undefined, max: number | undefined): number | null {
  if (value == null || max == null || !Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return null
  return Math.max(0, Math.min(100, (value / max) * 100))
}

function useNow(active: boolean): number | null {
  const [now, setNow] = useState<number | null>(null)
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  return now
}

export function JobProgress({ label, value, max, detail, startedAt, note, className }: JobProgressProps) {
  const pct = jobPercent(value, max)
  const now = useNow(startedAt != null)
  // Before the first tick (and on the server) the clock reads 0 s, so server and client agree.
  const elapsed = startedAt == null ? null : formatElapsed((now ?? startedAt) - startedAt)
  return (
    <div className={`nds-jobprogress${className ? ` ${className}` : ''}`}>
      <div className="nds-jobprogress-head">
        <span className="nds-jobprogress-label">{label}</span>
        {elapsed != null && (
          <span className="nds-jobprogress-elapsed" role="timer" aria-label={`${elapsed} elapsed`}>{elapsed}</span>
        )}
      </div>
      <ProgressBar ariaLabel={label} value={pct ?? 0} indeterminate={pct == null} />
      <div className="nds-jobprogress-detail" aria-live="polite" aria-atomic="true">{detail}</div>
      {note != null && note !== '' && <p className="nds-jobprogress-note">{note}</p>}
    </div>
  )
}
