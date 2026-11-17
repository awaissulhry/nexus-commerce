'use client'

import type { ReactNode } from 'react'
import './docked-stage.css'

/**
 * A design-review stand-in of the record frame (B-TH-300's follow-up from the review walk): a part of the thread is shown where it
 * lives — inside the docked thread at 40 % of the page (519 px at 1440, 711 px at 1920), beside a grey stand-in of the record's body
 * (inert, hidden from screen readers) — so a case uses the whole width (no dead space at 1920). Below 1280 px the thread alone, full
 * width, as RecordFrame shows it there. Design cases only: the live frame is areas/_shared/record-frame.
 */
export function DockedStage({ children, foot = false }: { children?: ReactNode; foot?: boolean }) {
  return (
    <div className="fw-rt-stage">
      <div className="fw-rt-stage-body" inert aria-hidden="true">
        <div className="fw-rt-stage-tabs">
          <span className="is-on" />
          <span />
          <span />
          <span />
          <span />
        </div>
        <div className="fw-rt-stage-cards">
          <div className="fw-rt-stage-card" />
          <div className="fw-rt-stage-card" />
        </div>
        <div className="fw-rt-stage-card is-tall" />
      </div>
      <div className="fw-rt-stage-dock">
        {foot && <div className="fw-rt-stage-feed" aria-hidden="true" />}
        {children}
      </div>
    </div>
  )
}
