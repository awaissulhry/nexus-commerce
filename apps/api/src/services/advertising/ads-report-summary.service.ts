/**
 * RPT.10 — KPI totals, period comparison, and the trend series.
 *
 * Runs the SAME metric SQL as the grid and the export, over the same filters,
 * so a headline number can never disagree with the table beneath it. The only
 * thing that changes between the current and comparison figures is the date
 * window — everything else is byte-identical, which is what makes the delta mean
 * something.
 *
 * Derived metrics are recomputed per period, never differenced: the ACOS of last
 * month is `spend(last month) / sales(last month)`, not `acos(now) - acos(then)`.
 */
import prisma from '../../db.js'
import { getSpec, buildFiltersFor } from './ads-report-runner.service.js'
import { METRIC_DIRECTION, type BetterWhen, type ColumnFormat } from './ads-report-specs.js'
import type { ReportQuery } from './ads-report-runner.service.js'

export type CompareMode = 'none' | 'previous' | 'yoy'
export type Bucket = 'day' | 'week' | 'month'

export interface KpiMetric {
  id: string
  label: string
  format: ColumnFormat
  betterWhen: BetterWhen
  current: number | null
  previous: number | null
  /** Fractional change. null when there is no comparison or no baseline. */
  deltaPct: number | null
}

export interface SummaryResult {
  reportId: string
  currency: string
  compare: CompareMode
  window: { from: string | null; to: string | null }
  comparisonWindow: { from: string | null; to: string | null } | null
  metrics: KpiMetric[]
  /** Empty when the report has no meaningful timeline. */
  series: Array<Record<string, number | string | null>>
  bucket: Bucket
  timeSeries: boolean
  /** Stated plainly when there is no chart, so absence never reads as breakage. */
  noSeriesReason: string | null
  elapsedMs: number
}

const MS_DAY = 86_400_000
const iso = (d: Date) => d.toISOString().slice(0, 10)
const parse = (s: string) => new Date(`${s}T00:00:00Z`)

/**
 * Bucket width from the span. A 400-day window drawn daily is 400 unreadable
 * marks; a 7-day window drawn monthly is one.
 */
export function pickBucket(from: string | null, to: string | null): Bucket {
  if (!from || !to) return 'day'
  const days = Math.round((parse(to).getTime() - parse(from).getTime()) / MS_DAY) + 1
  if (days <= 31) return 'day'
  if (days <= 180) return 'week'
  return 'month'
}

/**
 * The comparison window.
 *
 * `previous` is the SAME NUMBER OF DAYS immediately before the current window —
 * not "last month", which would compare 31 days against 28 and report a fake 10%
 * drop every March.
 */
export function comparisonWindow(
  mode: CompareMode, from: string | null, to: string | null,
): { from: string; to: string } | null {
  if (mode === 'none' || !from || !to) return null
  const a = parse(from)
  const b = parse(to)
  if (mode === 'yoy') {
    const shift = (d: Date) => {
      const x = new Date(d)
      x.setUTCFullYear(x.getUTCFullYear() - 1)
      return iso(x)
    }
    return { from: shift(a), to: shift(b) }
  }
  const days = Math.round((b.getTime() - a.getTime()) / MS_DAY) + 1
  const prevTo = new Date(a.getTime() - MS_DAY)
  const prevFrom = new Date(prevTo.getTime() - (days - 1) * MS_DAY)
  return { from: iso(prevFrom), to: iso(prevTo) }
}

/** Postgres date_trunc unit for a bucket. */
const TRUNC: Record<Bucket, string> = { day: 'day', week: 'week', month: 'month' }

export async function reportSummary(
  q: ReportQuery & { compare?: CompareMode; metrics?: string[] },
): Promise<SummaryResult> {
  const started = Date.now()
  const spec = getSpec(q.reportId)
  const compare: CompareMode = q.compare ?? 'previous'

  // Which metrics get a tile: the caller's choice, else the spec's default
  // columns filtered to metrics, else the first five.
  const byId = new Map(spec.metrics.map((m) => [m.id, m]))
  const wanted = (q.metrics ?? []).filter((id) => byId.has(id))
  const chosen = (wanted.length
    ? wanted
    : spec.defaultColumns.filter((id) => byId.has(id))
  ).slice(0, 6)
  const metrics = (chosen.length ? chosen : spec.metrics.slice(0, 5).map((m) => m.id)).map((id) => byId.get(id)!)

  const totalsFor = async (from: string | null, to: string | null) => {
    const { whereSql, params } = buildFiltersFor(spec, { ...q, from, to })
    const sel = metrics.map((m) => `${m.sql} AS "${m.id}"`).join(', ')
    const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT ${sel} FROM ${spec.from} ${whereSql}`, ...params,
    )
    return rows[0] ?? {}
  }

  const cmpWin = comparisonWindow(compare, q.from ?? null, q.to ?? null)
  const [cur, prev] = await Promise.all([
    totalsFor(q.from ?? null, q.to ?? null),
    cmpWin ? totalsFor(cmpWin.from, cmpWin.to) : Promise.resolve({} as Record<string, unknown>),
  ])

  const num = (v: unknown): number | null => {
    if (v == null) return null
    const n = typeof v === 'bigint' ? Number(v) : Number(v as number)
    return Number.isFinite(n) ? n : null
  }

  const kpis: KpiMetric[] = metrics.map((m) => {
    const c = num(cur[m.id])
    const p = cmpWin ? num(prev[m.id]) : null
    // A delta needs a real baseline. 0 → 5 is not "+∞%", it is "new", and
    // rendering infinity would be worse than rendering nothing.
    const deltaPct = c != null && p != null && p !== 0 ? (c - p) / Math.abs(p) : null
    return {
      id: m.id, label: m.label, format: m.format,
      betterWhen: METRIC_DIRECTION[m.id] ?? null,
      current: c, previous: p, deltaPct,
    }
  })

  // ── trend series ────────────────────────────────────────────────────────
  const timeSeries = spec.timeSeries !== false
  let series: SummaryResult['series'] = []
  let noSeriesReason: string | null = null
  const bucket = pickBucket(q.from ?? null, q.to ?? null)

  if (!timeSeries) {
    noSeriesReason =
      'Each row of this report covers its own aggregation window, so there is no timeline to draw. The totals above are still exact.'
  } else {
    const { whereSql, params } = buildFiltersFor(spec, q)
    const sel = metrics.map((m) => `${m.sql} AS "${m.id}"`).join(', ')
    const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT TO_CHAR(DATE_TRUNC('${TRUNC[bucket]}', ${spec.dateCol}), 'YYYY-MM-DD') AS bucket, ${sel}
       FROM ${spec.from} ${whereSql}
       GROUP BY 1 ORDER BY 1`,
      ...params,
    )
    series = rows.map((r) => {
      const out: Record<string, number | string | null> = { bucket: String(r.bucket) }
      for (const m of metrics) out[m.id] = num(r[m.id])
      return out
    })
    if (!series.length) noSeriesReason = 'No rows in this window.'
  }

  return {
    reportId: spec.id,
    currency: spec.currency,
    compare,
    window: { from: q.from ?? null, to: q.to ?? null },
    comparisonWindow: cmpWin,
    metrics: kpis,
    series,
    bucket,
    timeSeries,
    noSeriesReason,
    elapsedMs: Date.now() - started,
  }
}
