/**
 * ADX G6 — the evidence an ads write carried (`AdvertisingActionLog.evidence`), as one cell of the Change Log.
 *
 * Every field optional: a write with nothing numeric to say still records a note, and most writers do not emit this
 * yet, so null is normal rather than an error.
 *
 * Free visibility numbers (2026-10-10, F3) — the cell printed "top of search impression share · 0.31 vs 0.45": no unit,
 * no date. A share is now a percent in its unit (`EVIDENCE_UNIT`), and the data day / week the decision read is said.
 */
import { pct, sharePct } from '../campaigns/_grid/format'

export interface Evidence {
  targetKey?: string; metric?: string
  /** a number in the metric's unit — or, from some writers, text already carrying its unit ("12.34%") */
  observed?: number | string | null; threshold?: number | string | null
  windowDays?: number | null; sampleSize?: number | null
  sampleUnit?: 'rows' | 'days' | 'impressions'
  note?: string
  /** the settled data day (YYYY-MM-DD) the bid optimiser decided on */
  dataDay?: string
  /** the bid brain's run, with the newest settled data day it read */
  brain?: { dataDay?: string }
  /** a weekly reading's week (its start, YYYY-MM-DD) and how many days old it was when used */
  week?: string
  ageDays?: number | null
}

/**
 * The unit of each metric's `observed` / `threshold`. Shares (impression shares, top-of-search IS, SQP shares) and
 * ACoS are FRACTIONS, the console's unit for both (`ads-trigger-fields.ts`). A metric not listed prints its number as
 * stored, because its unit is not known here.
 */
const EVIDENCE_UNIT: Record<string, 'share' | 'fraction'> = {
  topOfSearchImpressionShare: 'share',
  topOfSearchIS: 'share',
  sqpBrandShare: 'share',
  sqp_brand_impression_share: 'share',
  coverage_share: 'share',
  impressionShare: 'share',
  acos: 'fraction',
  expectedAcos: 'fraction',
}

/** One evidence value in its unit. A "share" above 1 cannot be a fraction, so it is printed as stored, never re-scaled. */
export function evidenceValue(metric: string | undefined, v: number | string): string {
  if (typeof v === 'string') return v
  const unit = metric ? EVIDENCE_UNIT[metric] : undefined
  if (unit === 'share') return v >= 0 && v <= 1 ? sharePct(v) : `${v} (unit not recorded)`
  if (unit === 'fraction') return pct(v)
  return String(v)
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}/
const day = (iso: string) => {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

/**
 * Compact one-liner: "top of search impression share · 31.00% vs 45.00% · 3 days · data day 8 Oct 2026". Deliberately
 * terse because it sits inside a grid cell; the full object goes in the title attribute.
 */
export function fmtEvidence(e: Evidence): string {
  const bits: string[] = []
  if (e.metric) bits.push(e.metric.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase())
  if (e.observed != null && e.threshold != null) bits.push(`${evidenceValue(e.metric, e.observed)} vs ${evidenceValue(e.metric, e.threshold)}`)
  else if (e.observed != null) bits.push(evidenceValue(e.metric, e.observed))
  if (e.sampleSize != null) bits.push(`${e.sampleSize} ${e.sampleUnit ?? 'rows'}`)
  else if (e.windowDays != null) bits.push(`${e.windowDays}d`)
  if (e.week && DATE_RE.test(e.week)) bits.push(`week of ${day(e.week)}${e.ageDays != null ? ` (${e.ageDays} d old)` : ''}`)
  const dataDay = e.dataDay ?? e.brain?.dataDay
  if (dataDay && DATE_RE.test(dataDay)) bits.push(`data day ${day(dataDay)}`)
  return bits.join(' · ')
}

/** Thin data should be visible on its face — some schedules hold 1-5 days where the account has 56. */
export function isThin(e: Evidence): boolean {
  if (e.sampleUnit === 'days' && typeof e.sampleSize === 'number') return e.sampleSize < 7
  return e.sampleUnit === 'rows' && e.sampleSize === 0
}
