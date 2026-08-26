'use client'

/**
 * GX.5 — the hourly tab.
 *
 * The old hourly report was a flat list of campaign-hours, which is the least useful shape for a
 * feed whose entire value is that it is current to THIS HOUR while every other feed is a day or
 * more behind. Three questions it can answer and no daily report can: what is happening right now
 * and is it normal for this hour; which hour of which weekday actually converts; and both of those
 * per market, because attention pooled across four markets is nobody's day.
 *
 * ── 🔴 The hours are UTC and are not converted ────────────────────────────────
 *
 * Amazon Marketing Stream delivers them in UTC and Amazon's budget day rolls at 00:00 UTC, not at
 * marketplace midnight. Shifting them into Rome time would make the chart feel local and every
 * dayparting or budget decision taken from it land against the wrong day boundary. The surface
 * says UTC on every axis instead.
 *
 * ── Why both comparisons use the DS Heatmap ───────────────────────────────────
 *
 * Today against the same weekday last week needs ONE shared scale — that comparison IS the point,
 * and two lines on independently auto-scaled axes would draw a quiet day and a busy one at the
 * same height. `Heatmap` normalises across every cell it is given, so a 2 × 24 grid gets a shared
 * scale by construction and needs no new chart. The same component then draws the 7 × 24 grid.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Card } from '@/design-system/components/Card'
import { Heatmap } from '@/design-system/components/Heatmap'
import { Pill } from '@/design-system/primitives/Pill'
import { SegmentedControl } from '@/design-system/primitives/SegmentedControl'
import { AdsDataGrid, type GridColumn } from '../campaigns/_grid/AdsDataGrid'
import { fetchHourlyPulse, type HourlyCampaign, type HourlyPulse } from './hourly-api'
import { fmtCount, fmtMoney, fmtShare } from './strategy-api'
import { Caveats, ProvenanceStrip, StatCard, TabState } from './StrategyBits'

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const HOURS = Array.from({ length: 24 }, (_, h) => (h % 3 === 0 ? String(h).padStart(2, '0') : ''))

type Measure = 'cost' | 'clicks' | 'cvr'
const MEASURES: Array<{ value: Measure; label: string }> = [
  { value: 'cost', label: 'Spend' },
  { value: 'clicks', label: 'Clicks' },
  { value: 'cvr', label: 'CVR' },
]

export function HourlyTab({ market }: { market: string }) {
  const [data, setData] = useState<HourlyPulse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const [measure, setMeasure] = useState<Measure>('cost')

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  // No all-markets view: an hour-of-day pattern pooled across four markets is nobody's day, and
  // the stream's coverage is wildly uneven between them. Default to Italy, which holds 28,004 of
  // the rows, and let the header switch.
  const chosen = market === 'all' ? 'IT' : market

  useEffect(() => {
    const ac = new AbortController()
    setLoading(true)
    fetchHourlyPulse({ marketplace: chosen }, ac.signal)
      .then((d) => { setData(d); setError(null) })
      .catch((e: unknown) => { if ((e as Error).name !== 'AbortError') setError((e as Error).message) })
      .finally(() => { if (!ac.signal.aborted) setLoading(false) })
    return () => ac.abort()
  }, [chosen, nonce])

  /** Today against the same weekday last week, on ONE scale — the comparison is the point. */
  const compareGrid = useMemo(() => {
    if (!data) return null
    const pick = (p: { cost: number; clicks: number; orders: number }) =>
      measure === 'cost' ? p.cost : measure === 'clicks' ? p.clicks : (p.clicks > 0 ? p.orders / p.clicks : 0)
    return [data.todaySeries.map(pick), data.comparisonSeries.map(pick)]
  }, [data, measure])

  /** The 7 × 24 grid. Null stays null so an absent cell is hatched, never the palest shade. */
  const heatGrid = useMemo(() => {
    if (!data) return null
    const by = new Map(data.heat.map((c) => [`${c.weekday}:${c.hour}`, c]))
    return Array.from({ length: 7 }, (_, w) => Array.from({ length: 24 }, (_, h) => {
      const c = by.get(`${w}:${h}`)
      if (!c || c.days === 0) return null
      return measure === 'cost' ? c.cost : measure === 'clicks' ? c.clicks : c.cvr
    }))
  }, [data, measure])

  const columns: GridColumn<HourlyCampaign>[] = useMemo(() => [
    { key: 'cost', label: 'Spend', sortValue: (r) => r.cost, render: (r) => fmtMoney(r.cost) },
    { key: 'clicks', label: 'Clicks', sortValue: (r) => r.clicks, render: (r) => fmtCount(r.clicks) },
    { key: 'sales', label: 'Sales', sortValue: (r) => r.sales, render: (r) => fmtMoney(r.sales) },
    { key: 'orders', label: 'Orders', sortValue: (r) => r.orders, render: (r) => fmtCount(r.orders) },
    {
      key: 'acos',
      label: 'ACOS',
      tip: 'Undefined with no sales — shown as an em-dash, never 0%.',
      sortValue: (r) => r.acos,
      render: (r) => (r.acos == null ? <span className="rpt-dash">—</span> : fmtShare(r.acos, 1)),
    },
  ], [])

  if (error || (loading && !data)) return <TabState loading={loading} error={error} onRetry={reload} />
  if (!data) return null

  const fmt = (v: number) => (measure === 'cvr' ? `${(v * 100).toFixed(1)}%` : measure === 'cost' ? fmtMoney(v) : fmtCount(v))
  const t = data.totals.today
  const c = data.totals.comparison
  const delta = (a: number, b: number) => (b > 0 ? `${a > b ? '↗' : '↘'} ${(Math.abs(a / b - 1) * 100).toFixed(0)}%` : '—')
  const mine = data.markets.find((m) => m.marketplace === data.marketplace)

  return (
    <div className="rpx">
      <ProvenanceStrip
        source="Amazon Marketing Stream · live"
        grain="campaign × hour, UTC"
        held={`${data.heatWindowDays} days behind the grid`}
        markets={data.markets.map((m) => ({ marketplace: m.marketplace, lagDays: m.lagDays, late: m.idle }))}
        extra={(
          <>
            <span className="k">Measure</span>
            <SegmentedControl
              value={measure}
              onChange={(v) => setMeasure(v as Measure)}
              options={MEASURES}
              ariaLabel="Which measure the grids show"
            />
          </>
        )}
      />

      {mine?.idle && (
        <Card>
          <div className="rpx-empty">
            <b>{data.marketplace} has no enabled campaigns.</b> The stream reports what serves, so it
            produces no rows for an idle market — the last delivery was {mine.lastDay ?? 'never'}.
            That is the pipeline working, not failing.
          </div>
        </Card>
      )}

      <div className="rpx-stats">
        <StatCard
          label={`Today · ${data.today} UTC`}
          value={fmtMoney(t.cost)}
          sub={data.throughHour == null
            ? 'no rows delivered yet today'
            : `through ${String(data.throughHour).padStart(2, '0')}:59 UTC`}
        />
        <StatCard label="Clicks today" value={fmtCount(t.clicks)} sub={<>{delta(t.clicks, c.clicks)} vs the same weekday last week</>} />
        <StatCard label="Sales today" value={fmtMoney(t.sales)} sub={<>{delta(t.sales, c.sales)} vs {data.comparisonDay}</>} />
        <StatCard
          label="Same weekday last week"
          value={fmtMoney(c.cost)}
          sub={<>{data.comparisonDay} · the only fair comparison for an hour-of-day pattern</>}
        />
      </div>

      <Card
        header="Today against the same weekday last week"
        description="Both rows are drawn on one shared scale, so a quiet hour looks quiet. Hours are UTC."
        headerAction={<Pill tone="neutral">{MEASURES.find((m) => m.value === measure)?.label}</Pill>}
      >
        {compareGrid && (
          <Heatmap
            data={compareGrid}
            rowLabels={['Today', DAY_LABELS[new Date(`${data.comparisonDay}T00:00:00Z`).getUTCDay()]]}
            colLabels={HOURS}
            format={fmt}
            emptyLabel="no rows"
          />
        )}
      </Card>

      <Card
        header="Which hour of which weekday works"
        description={`${data.heatWindowDays} days of history. A hatched cell holds no rows at all — which is a different answer from nothing being spent.`}
      >
        {heatGrid && (
          <Heatmap
            data={heatGrid}
            rowLabels={DAY_LABELS}
            colLabels={HOURS}
            format={fmt}
            emptyLabel="no rows in this window"
          />
        )}
      </Card>

      <Card header="Spending today" description="Campaign grain — the stream carries nothing below it.">
        <AdsDataGrid<HourlyCampaign>
          rows={data.topCampaigns}
          rowId={(r) => r.id ?? r.label}
          noun="Campaign"
          firstColLabel="Campaign"
          firstSortValue={(r) => r.label}
          renderFirst={(r) => (r.href
            ? <Link href={r.href} className="gx-open">{r.label}</Link>
            : <span className="gx-plain">{r.label}</span>)}
          columns={columns}
          selectable={false}
          showTotal={false}
          storageKey="rpx-hourly-campaigns"
          emptyLabel={data.throughHour == null ? 'Nothing has served yet today.' : 'No campaign spent today.'}
        />
      </Card>

      <Caveats items={data.caveats} title="How to read this" />
    </div>
  )
}
