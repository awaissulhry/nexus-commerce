'use client'

/**
 * Reviews Overview — "Rating and reviews": reviews per day (week, month) on the left axis and the average rating on the
 * right (DS PerformanceGraph; hover shows both values). A bucket without a rated review is a gap in the rating line,
 * never a 0. The same chart in words sits under it for a screen reader.
 */
import { useMemo } from 'react'
import { Card, EmptyState, PerformanceGraph, type ChartSeries } from '@/design-system/components'
import { Button, Skeleton } from '@/design-system/primitives'
import { chart } from '@/design-system/tokens'
import Link from '@/lib/workspaces/Link'
import { insightsHref } from '../_lib/reviewsLinks'
import { chartSubtitle, chartUnit, overviewPeriodWords, trendRows, trendSummary, type TrendBucket, type TrendPoint } from './overviewModel'
import type { OverviewPeriod } from './overviewQuery'
import { SectionError } from './SectionError'
import s from './overview.module.css'

export interface TrendCardProps {
  trend: { bucket: TrendBucket; points: TrendPoint[] } | null
  error: string | null
  loading: boolean
  period: OverviewPeriod
  /** "eBay Italy" when the page is scoped to one channel. */
  scope: string | null
  onRetry: () => void
}

export function TrendCard({ trend, error, loading, period, scope, onRetry }: TrendCardProps) {
  const bucket = trend?.bucket ?? 'day'
  const rows = useMemo(() => (trend ? trendRows(trend.points, trend.bucket) : []), [trend])
  // Recharts takes colours as props (tokens/colors.ts `chart`); a null rating is a gap in its line.
  const left = useMemo<ChartSeries>(() => ({ key: 'reviews', label: chartUnit(bucket), color: chart.reference, axis: 'left', axisLabel: chartUnit(bucket), format: (v) => Math.round(v).toLocaleString('en') }), [bucket])
  const right = useMemo<ChartSeries>(() => ({ key: 'avg', label: 'Average rating', color: chart.actual, axis: 'right', axisLabel: 'Average rating', format: (v) => v.toFixed(1) }), [])
  const total = trend ? trend.points.reduce((n, p) => n + p.reviews, 0) : 0

  return (
    <Card
      className={s.trend}
      header="Rating and reviews"
      headingLevel={2}
      description={chartSubtitle(bucket, period, scope)}
      headerAction={
        <Button asChild variant="link" size="sm">
          <Link href={insightsHref('themes')}>See themes</Link>
        </Button>
      }
    >
      {error ? (
        <SectionError error={error} onRetry={onRetry} busy={loading} />
      ) : !trend ? (
        <div className={s.skeletonBlock} aria-hidden>
          <Skeleton height={220} />
        </div>
      ) : total === 0 ? (
        <EmptyState title={`No reviews in the ${overviewPeriodWords(period).label}`} description="New reviews show here as they arrive." />
      ) : (
        <>
          <PerformanceGraph data={rows as unknown as Array<Record<string, number | string>>} xKey="when" left={left} right={right} height={240} />
          <p className="nds-vh">{trendSummary(trend.points, trend.bucket, period)}</p>
        </>
      )}
    </Card>
  )
}
