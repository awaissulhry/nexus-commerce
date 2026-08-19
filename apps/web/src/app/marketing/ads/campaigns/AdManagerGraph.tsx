'use client'

/**
 * CBN.2e — Ad Manager "Campaign Performance" graph.
 *
 * R4 — this file is now only the DATA half. The chart itself is `_shared/MetricChart`, the one
 * time-series chart in this console, which Reporting renders too: the same frame, axes, legend,
 * tooltip, resize grip and colours, from one file.
 *
 * What changed for the operator: the two metric dropdowns — one per axis, two metrics maximum —
 * became a single multi-select. Tick as many as you want (up to six) and every ticked metric is
 * plotted, each against its own scale. That is the Amazon Advertising console's model, and it
 * answers the question the two-slot picker could not: *show me spend, sales and ACoS together.*
 *
 * What did NOT change: the 7-day trailing average beside each metric, the change annotations on
 * the timeline and inside the hover card, the drag-to-resize grip, the persisted chart height,
 * and the `/advertising/trends` request behind it. Those are the reasons this graph is worth
 * keeping, and each is now a capability of the shared chart rather than something only this
 * page has.
 */
import { useEffect, useMemo, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import { rangeBounds } from '../_shell/AdsPageHeader'
import { useChangeAnnotations, AnnotationToggle } from './ChangeAnnotations'
import { MetricChart, MAX_PLOTTED, type ChartMetric } from '../_shared/MetricChart'

// ── metric catalog (order + units match the H10 dropdown) ───────────────────
const METRICS: ChartMetric[] = [
  { key: 'spend', label: 'Spend', unit: 'eur' },
  { key: 'sales', label: 'Sales', unit: 'eur' },
  { key: 'cpc', label: 'CPC', unit: 'eur' },
  { key: 'cvr', label: 'CVR', unit: 'pct' },
  { key: 'acos', label: 'ACoS', unit: 'pct' },
  { key: 'ctr', label: 'CTR', unit: 'pct' },
  { key: 'clicks', label: 'Clicks', unit: 'count' },
  { key: 'impressions', label: 'Impressions', unit: 'count' },
  { key: 'ppcOrders', label: 'PPC Orders', unit: 'count' },
  { key: 'totalSales', label: 'Total sales', unit: 'eur' },
  { key: 'tacos', label: 'TACoS', unit: 'pct' },
]

interface TrendRow {
  date: string; impressions: number; clicks: number; orders: number
  adSpendCents: number; adSalesCents: number; totalRevenueCents: number
  acos: number | null; tacos: number | null; ctr: number | null
}

/**
 * 🔴 Percentages are FRACTIONS here, not 0–100.
 *
 * This endpoint returns ACoS as `43.47` while a report returns `0.4347`, and the shared chart
 * has to be handed one convention or the same metric formats differently depending on which
 * page you are on. The chart's own `pct` formatter multiplies by 100, so everything is
 * normalised to a fraction at the source — the one place that knows what the API meant.
 */
const metricValue = (r: TrendRow, key: string): number | null => {
  const spend = r.adSpendCents / 100, sales = r.adSalesCents / 100
  switch (key) {
    case 'spend': return spend
    case 'sales': return sales
    case 'cpc': return r.clicks > 0 ? spend / r.clicks : null
    case 'cvr': return r.clicks > 0 ? r.orders / r.clicks : null
    case 'acos': return r.acos != null ? r.acos / 100 : (sales > 0 ? spend / sales : null)
    case 'ctr': return r.ctr != null ? r.ctr / 100 : (r.impressions > 0 ? r.clicks / r.impressions : null)
    case 'clicks': return r.clicks
    case 'impressions': return r.impressions
    case 'ppcOrders': return r.orders
    case 'totalSales': return r.totalRevenueCents / 100
    case 'tacos': return r.tacos != null ? r.tacos / 100 : null
    default: return null
  }
}

const dayLong = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const STORE = 'h10-am-graph-metrics'

export function AdManagerGraph({ market, rangePreset }: { market: string; rangePreset: string }) {
  // The two persisted single choices become one persisted list. The defaults are the two the
  // dropdowns used to open on, so an operator who never touches the picker sees what they saw.
  const [selected, setSelected] = useState<string[]>(['spend', 'acos'])
  const [rows, setRows] = useState<TrendRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORE)
      if (raw) {
        const keys = (JSON.parse(raw) as string[]).filter((k) => METRICS.some((m) => m.key === k))
        if (keys.length) { setSelected(keys.slice(0, MAX_PLOTTED)); return }
      }
      // Carry over whatever the two old dropdowns were left on, so the upgrade is not a reset.
      const l = localStorage.getItem('h10-am-graph-left')
      const r = localStorage.getItem('h10-am-graph-right')
      const carried = [l, r].filter((k): k is string => !!k && METRICS.some((m) => m.key === k))
      if (carried.length) setSelected([...new Set(carried)])
    } catch { /* ignore */ }
  }, [])

  const pick = (keys: string[]) => {
    setSelected(keys)
    try { localStorage.setItem(STORE, JSON.stringify(keys)) } catch { /* ignore */ }
  }

  const { start, end } = useMemo(() => rangeBounds(rangePreset), [rangePreset])
  const startStr = ymd(start), endStr = ymd(end)

  useEffect(() => {
    let abort = false
    setLoading(true)
    const params = new URLSearchParams({ startDate: startStr, endDate: endStr })
    if (market !== 'all') params.set('marketplace', market)
    fetch(`${getBackendUrl()}/api/advertising/trends?${params.toString()}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { if (!abort) setRows((d?.rows ?? []) as TrendRow[]) })
      .catch(() => { if (!abort) setRows([]) })
      .finally(() => { if (!abort) setLoading(false) })
    return () => { abort = true }
  }, [market, startStr, endStr])

  // Every metric on every row: the chart picks the ticked ones out, so switching metrics is
  // free rather than a rebuild, and the trailing average is computed over the same values.
  const data = useMemo(
    () => rows.map((r) => {
      const out: Record<string, string | number | null> = { date: r.date }
      for (const m of METRICS) out[m.key] = metricValue(r, m.key)
      return out
    }),
    [rows],
  )

  // HX.9 — change markers over the same window the chart is already showing.
  const [annOn, setAnnOn] = useState(true)
  const [annRoutine, setAnnRoutine] = useState(false)
  const annRange = useMemo(() => {
    if (!data.length) return { start: null as Date | null, end: null as Date | null }
    // Bound the fetch by the data actually plotted, not the requested range: an empty tail would
    // otherwise pull changes for days the chart does not draw.
    return {
      start: new Date(`${data[0].date as string}T00:00:00`),
      end: new Date(`${data[data.length - 1].date as string}T23:59:59`),
    }
  }, [data])
  const { byDate: annotations, total: annTotal } = useChangeAnnotations(
    annRange.start, annRange.end, { enabled: annOn, includeRoutine: annRoutine },
  )

  return (
    <MetricChart
      title="Campaign Performance"
      subtitle={`${dayLong(startStr)} - ${dayLong(endStr)}`}
      data={data}
      metrics={METRICS}
      selected={selected}
      onSelectedChange={pick}
      loading={loading}
      emptyLabel="No advertising data in this date range."
      storageKey="h10-am-graph"
      trailingAverage={7}
      annotations={annOn ? annotations : undefined}
      annotationSlot={
        <AnnotationToggle
          on={annOn} onToggle={setAnnOn}
          includeRoutine={annRoutine} onToggleRoutine={setAnnRoutine}
          total={annTotal}
        />
      }
    />
  )
}
