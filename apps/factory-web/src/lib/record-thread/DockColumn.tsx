'use client'

import type { KeyboardEvent, ReactNode } from 'react'
import { HeadPickProvider } from './head/view/HeadPick'
import './head/head.css'
import './record-thread.css'

/**
 * F-OP-201 (order page plan N4; 11-dock §0.1, §1) — THE card of a record's dock for a view that is not a thread (All of <Customer>,
 * read only): the same `section.fw-rt-column.is-docked` RecordThread draws when docked (the same container `fw-rtcol`, the same band
 * classes of record-thread.css), so every scope of a dock sits in ONE card that never differs: Head row → the body that scrolls →
 * the fixed foot. tw- W2.1 (Z4): the dock's pick is no band of its own — the card hands it to its Head as the title (HeadPick); with
 * no Head the title alone is drawn. View only: it draws what its host hands it and imports no office code.
 */
export interface DockColumnProps {
  /** The card's accessible name ("All of Brand Alpha · Read only"). */
  readonly label: string
  /** The dock's pick (its ThreadPick): the Head's title; absent when there is nothing to pick. */
  readonly top?: ReactNode
  /** The Head row, drawn as it is (its own `.fw-rth`). */
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
      <HeadPickProvider pick={top ?? null}>
        {head ??
          (top ? (
            <div className="fw-rth is-title-only">
              <div className="fw-rth-titleblock">
                <div className="fw-rth-title">{top}</div>
              </div>
            </div>
          ) : null)}
        <div className="fw-rt-scroll">{body /* F-OP-304: not .fw-rt-body, the message words' class (card.css) */}</div>
        {foot ? <div className="fw-rt-foot">{foot}</div> : null}
      </HeadPickProvider>
    </section>
  )
}
