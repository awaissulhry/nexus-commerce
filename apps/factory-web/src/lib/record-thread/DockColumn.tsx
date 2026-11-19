'use client'

import type { KeyboardEvent, ReactNode } from 'react'
import './record-thread.css'

/**
 * F-OP-201 (order page plan N4; 11-dock §0.1, §1) — THE card of a record's dock for a view that is not a thread (All of <Customer>,
 * read only): the same `section.fw-rt-column.is-docked` RecordThread draws when docked (the same container `fw-rtcol`, the same band
 * classes of record-thread.css), so every scope of a dock sits in ONE card that never differs: pick band → Head row (44 px) → the
 * body that scrolls → the fixed foot. View only: it draws what its host hands it and imports no office code.
 */
export interface DockColumnProps {
  /** The card's accessible name ("All of Brand Alpha · Read only"). */
  readonly label: string
  /** The pick band (the dock's ThreadPick): the first band; absent when there is nothing to pick. */
  readonly top?: ReactNode
  /** The Head row, drawn as it is (its own 44 px `.fw-rth`). */
  readonly head?: ReactNode
  /** What scrolls (the page never does). */
  readonly body: ReactNode
  /** The fixed foot (where a thread has its box). */
  readonly foot?: ReactNode
  /** The card's own keys (a list's J / K). */
  readonly onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void
}

export function DockColumn({ label, top, head, body, foot, onKeyDown }: DockColumnProps) {
  return (
    <section className="fw-rt-column is-docked" aria-label={label} onKeyDown={onKeyDown}>
      {top ? <div className="fw-rt-top">{top}</div> : null}
      {head ?? null}
      <div className="fw-rt-scroll">{body /* F-OP-304: not .fw-rt-body, the message words' class (card.css) */}</div>
      {foot ? <div className="fw-rt-foot">{foot}</div> : null}
    </section>
  )
}
