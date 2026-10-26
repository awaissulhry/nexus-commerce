'use client'

/**
 * Reviews Overview — "Rating spread": the average with its stars, the 5…1-star bars (DS RatingBars), product reviews
 * against seller feedback. Pressing a bar offers "Open N one-star reviews in the Inbox"; a bar with no ratings is held
 * and says why. The pressed bar stays in the address (`?stars=`).
 */
import { Card, KeyValue, RatingBars, StarRating, type RatingStars } from '@/design-system/components'
import { Button, Skeleton } from '@/design-system/primitives'
import Link from '@/lib/workspaces/Link'
import { ArrowRight } from 'lucide-react'
import { inboxHref } from '../_lib/reviewsLinks'
import { count, overviewPeriodWords, starsCount, starsLinkWords, zeroStarsReason, type OverviewSpread } from './overviewModel'
import type { OverviewPeriod, StarsFilter } from './overviewQuery'
import { SectionError } from './SectionError'
import s from './overview.module.css'

export interface SpreadCardProps {
  spread: OverviewSpread | null
  avgRating: number | null
  error: string | null
  loading: boolean
  period: OverviewPeriod
  stars: StarsFilter | null
  channel: string | null
  market: string | null
  onStars: (stars: StarsFilter | null) => void
  onRetry: () => void
}

export function SpreadCard({ spread, avgRating, error, loading, period, stars, channel, market, onStars, onRetry }: SpreadCardProps) {
  const rated = spread ? spread.counts.reduce((n, c) => n + c, 0) : 0
  const picked = spread && stars ? starsCount(spread.counts, stars) : 0
  const { label } = overviewPeriodWords(period)

  return (
    <Card className={s.spread} header="Rating spread" headingLevel={2} description={spread ? `${count(rated)} ${rated === 1 ? 'rating' : 'ratings'} · ${label}` : label}>
      {error ? (
        <SectionError error={error} onRetry={onRetry} busy={loading} />
      ) : !spread ? (
        <div className={s.skeletonBlock} aria-hidden>
          <Skeleton height={40} />
          <Skeleton height={110} />
        </div>
      ) : (
        <div className={s.spreadBody}>
          <div className={s.bigRating}>
            <span className={s.bigNumber}>{avgRating == null ? '—' : avgRating.toFixed(1)}</span>
            <span className={s.bigSide}>
              <StarRating value={avgRating} size="md" />
              <span className={s.muted}>{rated > 0 ? 'out of 5 · press a bar to open those reviews' : 'No ratings in this period'}</span>
            </span>
          </div>
          <RatingBars
            counts={spread.counts}
            selected={stars as RatingStars | null}
            onSelect={(next) => onStars(next as StarsFilter | null)}
            zeroReason={(n) => zeroStarsReason(n as StarsFilter, period)}
            label={`Ratings by stars, ${label}`}
          />
          {stars && picked > 0 && (
            <Button asChild size="sm" className={s.startLink}>
              <Link href={inboxHref({ stars, period, channel, market })}>
                {starsLinkWords(stars, picked)} <ArrowRight size={13} aria-hidden />
              </Link>
            </Button>
          )}
          <KeyValue
            dense
            columns={2}
            items={[
              { label: 'Product reviews', value: count(spread.product) },
              { label: 'Seller feedback', value: count(spread.seller) },
            ]}
          />
          {spread.note && <p className={s.note}>{spread.note}</p>}
          <p className={s.note}>
            eBay feedback counts as 5 (positive), 3 (neutral) or 1 star (negative). Amazon stars come only from reviews you imported: Amazon gives no rating by API.
          </p>
        </div>
      )}
    </Card>
  )
}
