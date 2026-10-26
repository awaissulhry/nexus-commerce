'use client'

/**
 * Reviews › Requests › Timing — the send-hour heatmap: weekday × hour, shaded by the review rate of requests sent at
 * that hour (last 90 days), hatched where none was sent, the hour we send each day outlined. Each cell's words are its
 * tooltip ("Tue 10:00 · 212 sent · 13 reviews after · 6.1% · we send at this hour"); the table under it carries the
 * same hours for the keyboard. DS Heatmap (`marked`, `cellWords`).
 */
import { Banner, Heatmap } from '@/design-system/components'
import { Button, Skeleton } from '@/design-system/primitives'
import { heatView, type ConversionReport, type WindowRow } from './timingModel'
import s from './timing.module.css'

export interface SendHourHeatmapProps {
  report: ConversionReport | null
  rows: readonly WindowRow[]
  error: string | null
  onRetry: () => void
}

export function SendHourHeatmap({ report, rows, error, onRetry }: SendHourHeatmapProps) {
  if (error) {
    return (
      <Banner tone="danger" title="Could not read the review rate by hour" action={<Button size="sm" onClick={onRetry}>Try again</Button>}>
        {error}
      </Banner>
    )
  }
  if (!report) return <Skeleton height={200} />
  const view = heatView(report, rows)
  return (
    <div className={s.heat}>
      <div className={s.heatScroll}>
        <Heatmap
          data={view.data}
          rowLabels={view.rowLabels}
          colLabels={view.colLabels}
          colTitles={view.colTitles}
          marked={view.marked}
          cellWords={view.cellWords}
          emptyLabel="none sent"
          className={s.heatGrid}
        />
      </div>
      <ul className={s.legend} aria-label="How to read the heatmap">
        <li><span className={`${s.swatch} ${s.swatchLight}`} aria-hidden /> lighter = fewer reviews</li>
        <li><span className={`${s.swatch} ${s.swatchDark}`} aria-hidden /> darker = more</li>
        <li><span className={`${s.swatch} ${s.swatchNone}`} aria-hidden /> none sent at that hour</li>
        <li><span className={`${s.swatch} ${s.swatchMarked}`} aria-hidden /> we send at this hour</li>
      </ul>
      {!report.hasReviews && <p className={s.muted}>No reviews in these 90 days yet: every hour shows the same until reviews arrive.</p>}
    </div>
  )
}
