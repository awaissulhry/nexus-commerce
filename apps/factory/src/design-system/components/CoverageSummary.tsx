'use client'

import { AlertTriangle } from 'lucide-react'
import type { ReactNode } from 'react'
import { Tooltip } from '../primitives/Tooltip'

/**
 * CoverageSummary — a product's channel footprint, in one line that does not grow.
 *
 * The obvious design is one mark per channel, and it stops working almost immediately. Measured
 * on the products grid: a 22px lettered chip per channel fits three in a 110px column and needs
 * 162px for six; single letters collide the moment the roster is real (eBay and Etsy are both
 * `E`); and a grid that hard-codes its channel list shows a permanent grey mark for channels the
 * merchant has not connected — noise on every row, forever.
 *
 * So this counts the norm and names the exception. Eight healthy channels read `8 live`, exactly
 * as compactly as two do; the width is a function of how many DIFFERENT states are present, not
 * how many channels exist. Adding a channel changes nothing about the layout.
 *
 * The caller resolves each channel's state — this component owns the counting, the ordering and
 * the wording, so two grids cannot describe the same footprint differently. Order is by urgency:
 * errors, then drafts, then gaps, with the live count leading when there is one, because "how
 * much of this is working" is the question the eye asks first.
 *
 * A `draft` is deliberately its own state and not a kind of "missing": a listing that exists but
 * is unpublished is work half-done, and one that was never created is work not started. Folding
 * them together is exactly the bug this replaced — that column tested `live`, then `error`, and
 * let draft fall through to "not listed", which misreported 13 of 14 products on the page it
 * shipped on.
 *
 * Requires `styles/components.css`.
 */

export type CoverageState = 'live' | 'draft' | 'issues' | 'missing'

export interface CoverageChannel {
  /** Channel key, shown verbatim in the tooltip (e.g. `AMAZON`). */
  channel: string
  state: CoverageState
  /** Tooltip detail for this channel, e.g. `2 draft`. Falls back to the state word. */
  detail?: string
}

export interface CoverageSummaryProps {
  /**
   * One entry per channel that COUNTS — normally the merchant's active connections, not every
   * channel the platform supports. A channel nobody has connected is not a gap in coverage and
   * must not be counted as one.
   */
  channels: CoverageChannel[]
  className?: string
}

export function CoverageSummary({ channels, className }: CoverageSummaryProps) {
  const count = (s: CoverageState) => channels.filter((c) => c.state === s).length
  const live = count('live')
  const draft = count('draft')
  const issues = count('issues')
  const missing = count('missing')

  const parts: ReactNode[] = []
  if (live > 0) parts.push(<span key="live">{live} live</span>)
  if (issues > 0)
    parts.push(
      <span key="issues" className="iss">
        <AlertTriangle size={11} aria-hidden /> {issues}
      </span>,
    )
  if (draft > 0)
    parts.push(
      <span key="draft" className="draft">
        {draft} draft
      </span>,
    )
  // Only alongside something else. On its own, "3 missing" is a roundabout way of saying the
  // product is not listed anywhere — and that is what the empty case below says outright.
  if (missing > 0 && parts.length > 0)
    parts.push(
      <span key="missing" className="miss">
        {missing} missing
      </span>,
    )

  const label = channels.length
    ? channels.map((c) => `${c.channel}: ${c.detail ?? c.state}`).join(' · ')
    : 'No channels connected'

  return (
    <Tooltip label={label}>
      <span className={`nds-coverage${className ? ` ${className}` : ''}`}>
        {parts.length > 0 ? (
          parts
        ) : (
          <span className="miss">{channels.length ? 'not listed' : 'no channels'}</span>
        )}
      </span>
    </Tooltip>
  )
}
