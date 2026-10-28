'use client'

import type { ReactNode } from 'react'
import { Star } from 'lucide-react'
import { Tooltip } from '../primitives/Tooltip'
import { nextRatingFilter, ratingBarRows, ratingTotal, type RatingCounts, type RatingStars } from './ratingBarsModel'

export interface RatingBarsProps {
  /** Ratings per star, 5 stars FIRST: `[five, four, three, two, one]`. */
  counts: RatingCounts
  /** The bar whose filter is on. */
  selected?: RatingStars | null
  /** Bars become filter buttons. Pressing the pressed bar sends `null` (filter off). */
  onSelect?: (stars: RatingStars | null) => void
  /** 18 px rows for cards and grid rows (22 px otherwise). */
  compact?: boolean
  /** Shown instead of five empty bars when there are no ratings. Default "No ratings yet". */
  emptyLabel?: string
  /** The second line of the empty state (not in `compact`). Default "The spread shows here after the first rating arrives." */
  emptyHint?: ReactNode
  /** Why a bar with no ratings is held. Default "No 3-star ratings to show". */
  zeroReason?: (stars: RatingStars) => string
  /** The group's accessible name. Default "Ratings by stars". */
  label?: string
  className?: string
}

/**
 * How ratings spread over 5…1 stars (Reviews parts, 2026-10-26). Each bar shows its count and its share; the shares are
 * whole percents that add up to 100. With `onSelect` every bar is a toggle button (`aria-pressed`, named "5 stars: 82
 * ratings, 64%"); a bar with no ratings is held — focusable, `aria-disabled`, says why on hover and focus — never
 * disabled. No ratings at all shows `emptyLabel`, never a row of zeros. The track is `.nds-progress`.
 */
export function RatingBars({
  counts, selected = null, onSelect, compact = false, emptyLabel = 'No ratings yet',
  emptyHint = 'The spread shows here after the first rating arrives.', zeroReason, label = 'Ratings by stars', className,
}: RatingBarsProps) {
  const cls = `nds-ratingbars${compact ? ' compact' : ''}${className ? ` ${className}` : ''}`
  if (ratingTotal(counts) === 0) {
    return (
      <div className={cls} role="group" aria-label={label}>
        <div className="nds-ratingbars-empty" role="status">
          <Star size={18} aria-hidden focusable={false} />
          <span className="nds-ratingbars-empty-text">
            <span className="t">{emptyLabel}</span>
            {!compact && emptyHint != null && <span className="d">{emptyHint}</span>}
          </span>
        </div>
      </div>
    )
  }
  return (
    <div className={cls} role="group" aria-label={label}>
      {ratingBarRows(counts, zeroReason).map(row => {
        const body = (
          <>
            <span className="nds-ratingbars-star">{row.stars}<Star aria-hidden focusable={false} /></span>
            <span className="nds-progress" aria-hidden><span className="bar" style={{ width: `${row.pct}%` }} /></span>
            <span className="nds-ratingbars-count" aria-hidden>{row.count.toLocaleString('en-US')}</span>
            <span className="nds-ratingbars-pct" aria-hidden>{row.pct}%</span>
          </>
        )
        if (!onSelect) {
          return <div key={row.stars} className="nds-ratingbars-row static" role="img" aria-label={row.label}>{body}</div>
        }
        const pressed = selected === row.stars
        if (row.heldReason) {
          return (
            <Tooltip key={row.stars} label={row.heldReason} portal>
              <button
                type="button"
                className="nds-ratingbars-row"
                aria-pressed={pressed}
                aria-disabled
                aria-description={row.heldReason}
                aria-label={row.label}
                onClick={event => event.preventDefault()}
              >
                {body}
              </button>
            </Tooltip>
          )
        }
        return (
          <button
            key={row.stars}
            type="button"
            className="nds-ratingbars-row"
            aria-pressed={pressed}
            aria-label={row.label}
            onClick={() => onSelect(nextRatingFilter(selected, row.stars))}
          >
            {body}
          </button>
        )
      })}
    </div>
  )
}
