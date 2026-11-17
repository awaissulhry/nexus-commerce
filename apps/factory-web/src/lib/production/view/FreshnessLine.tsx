'use client'

import { Pill } from '@nexus/ui/primitives'
import { freshView, type FreshMode } from '../model'
import { useProductionWords } from '../words'
import '../production-parts.css'

export interface FreshnessLineProps {
  /** Live by push, read again on a timer, offline, or connecting. "Live" only when the page really gets pushes (R7). */
  mode: FreshMode
  /** The last good read (an instant); null: not read yet. */
  asOf: string | null
  /** How often a timer reads again (seconds): "refreshes every minute". */
  everySeconds?: number
}

/**
 * F-PR-01 — how fresh the figures are, as a time (09-design §1.9, rule R7): "● Live · as of 10:42" with the DS Pill's
 * live dot when pushed; "Updated 10:42 · refreshes every minute" when the page reads again on a timer (the portal today);
 * "Offline · as of 10:44"; "Connecting…"; "Not read yet". A status line (`role="status"`), never a control.
 */
export function FreshnessLine({ mode, asOf, everySeconds }: FreshnessLineProps) {
  const w = useProductionWords()
  const view = freshView(mode, asOf ? w.time(asOf) : null, everySeconds)
  const words = w.say(view.words)
  return (
    <span className="fw-prp-fresh" role="status">
      {view.dot ? (
        <Pill tone={view.dot} dot>
          {words}
        </Pill>
      ) : (
        <span className="fw-prp-sub">{words}</span>
      )}
    </span>
  )
}
