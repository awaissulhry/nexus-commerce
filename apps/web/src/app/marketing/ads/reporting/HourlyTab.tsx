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
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Card } from '@/design-system/components/Card'
import { Heatmap } from '@/design-system/components/Heatmap'
import { Pill } from '@/design-system/primitives/Pill'
import { SegmentedControl } from '@/design-system/primitives/SegmentedControl'
import { AdsDataGrid, type GridColumn } from '../campaigns/_grid/AdsDataGrid'
import { fetchHourlyPulse, type HourlyCampaign, type HourlyPulse } from './hourly-api'
import { fmtCount, fmtMoney, fmtShare } from './strategy-api'
import { Caveats, ProvenanceStrip, StatCard, TabState } from './StrategyBits'
import { SectionLayout, type SectionSpec } from '@/design-system/patterns/SectionLayout'
import { useSections } from './useSections'

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const HOURS = Array.from({ length: 24 }, (_, h) => (h % 3 === 0 ? String(h).padStart(2, '0') : ''))

/**
 * GX.7 — the panels, and the three that ship OFF.
 *
 * `stats` is locked. The three optional ones are each a real question this tab could not answer
 * before, and each is a question you ask on some days and never on others:
 *
 *  · `pace`     — am I ahead or behind, RIGHT NOW? The per-hour grids show shape, not running
 *                 total, so neither of them answers it.
 *  · `sample`   — how many days sit behind each cell of the pattern? A cell built from one
 *                 Tuesday looks identical to one built from twelve.
 *  · `coverage` — is the stream healthy in every market? The header shows lag; this shows what
 *                 that lag is made of.
 */
const HOURLY_SECTIONS: readonly SectionSpec[] = [
  { id: 'stats', label: 'Today and the comparison', locked: true, defaultWidth: 'full' },
  { id: 'compare', label: 'Today against the same weekday last week', defaultWidth: 'full' },
  { id: 'heat', label: 'Which hour of which weekday works', defaultWidth: 'full' },
  { id: 'campaigns', label: 'Spending today', defaultWidth: 'full' },
  { id: 'pace', label: 'Pace against last week', defaultWidth: 'half', defaultHidden: true },
  { id: 'coverage', label: 'Stream coverage by market', defaultWidth: 'half', defaultHidden: true },
  { id: 'sample', label: 'How many days each cell holds', defaultWidth: 'full', defaultHidden: true },
]
const SECTION_KEY = 'rpx-hourly-sections'

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
  const sections = useSections(HOURLY_SECTIONS, SECTION_KEY)

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

  /**
   * How many distinct days sit behind each cell of the pattern above — the same 7 × 24 shape, so
   * the two read against each other cell for cell. A pale cell here is a cell of the pattern that
   * is one day's accident.
   */
  const sampleGrid = useMemo(() => {
    if (!data) return null
    const by = new Map(data.heat.map((c) => [`${c.weekday}:${c.hour}`, c]))
    return Array.from({ length: 7 }, (_, w) => Array.from({ length: 24 }, (_, h) => {
      const c = by.get(`${w}:${h}`)
      return c && c.days > 0 ? c.days : null
    }))
  }, [data])

  /**
   * Cumulative spend today against the same weekday last week, compared only up to the SAME hour.
   *
   * Comparing a part-day against a whole day is the mistake this panel exists to prevent — at
   * 10:00 it would report every day as catastrophically behind. `throughHour` is the last hour
   * the stream has delivered, and last week is summed to exactly that hour and no further; the
   * full day is shown beside it, labelled as the finished figure rather than the comparison.
   */
  const pace = useMemo(() => {
    if (!data || data.throughHour == null) return null
    const upTo = (rows: typeof data.todaySeries) => rows
      .filter((p) => p.hour <= data.throughHour!)
      .reduce((a, p) => a + p.cost, 0)
    const now = upTo(data.todaySeries)
    const then = upTo(data.comparisonSeries)
    const full = data.comparisonSeries.reduce((a, p) => a + p.cost, 0)
    return { now, then, full, scale: Math.max(now, then, full) }
  }, [data])

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
        actions={sections.controls}
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

      <SectionLayout sections={HOURLY_SECTIONS} value={sections.layout} onChange={sections.setLayout} editing={sections.arranging}>
        {{
          stats: (
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
          ),

          compare: compareGrid ? (
            <Card
              header="Today against the same weekday last week"
              description="Both rows are drawn on one shared scale, so a quiet hour looks quiet. Hours are UTC."
              headerAction={<Pill tone="neutral">{MEASURES.find((m) => m.value === measure)?.label}</Pill>}
            >
              <Heatmap
                data={compareGrid}
                rowLabels={['Today', DAY_LABELS[new Date(`${data.comparisonDay}T00:00:00Z`).getUTCDay()]]}
                colLabels={HOURS}
                format={fmt}
                emptyLabel="no rows"
              />
            </Card>
          ) : null,

          heat: heatGrid ? (
            <Card
              header="Which hour of which weekday works"
              description={`${data.heatWindowDays} days of history. A hatched cell holds no rows at all — which is a different answer from nothing being spent.`}
            >
              <Heatmap
                data={heatGrid}
                rowLabels={DAY_LABELS}
                colLabels={HOURS}
                format={fmt}
                emptyLabel="no rows in this window"
              />
            </Card>
          ) : null,

          campaigns: (
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
          ),

          // Skipped entirely before the first delivery of the day — a pace against nothing is not
          // a zero, it is a question that cannot be asked yet.
          pace: pace ? (
            <Card
              header="Pace against last week"
              description={`Cumulative spend to ${String(data.throughHour).padStart(2, '0')}:59 UTC, against the same weekday last week summed to exactly the same hour.`}
            >
              <div className="rpx-pace">
                <div className="row is-now">
                  <span className="lbl">Today, so far</span>
                  <span className="bar" aria-hidden><i style={{ width: `${pace.scale > 0 ? (pace.now / pace.scale) * 100 : 0}%` }} /></span>
                  <span className="n">{fmtMoney(pace.now)}</span>
                </div>
                <div className="row">
                  <span className="lbl">{data.comparisonDay}, to this hour</span>
                  <span className="bar" aria-hidden><i style={{ width: `${pace.scale > 0 ? (pace.then / pace.scale) * 100 : 0}%` }} /></span>
                  <span className="n">{fmtMoney(pace.then)}</span>
                </div>
                <div className="row is-ghost">
                  <span className="lbl">{data.comparisonDay}, whole day</span>
                  <span className="bar" aria-hidden><i style={{ width: `${pace.scale > 0 ? (pace.full / pace.scale) * 100 : 0}%` }} /></span>
                  <span className="n">{fmtMoney(pace.full)}</span>
                </div>
              </div>
              <p className="rpx-foot">
                {pace.then === 0
                  ? <>The same weekday last week had spent nothing by this hour, so there is no pace to be ahead or behind of.</>
                  : <>Today is <b>{Math.abs(pace.now / pace.then - 1) * 100 < 0.5 ? 'level with' : `${(Math.abs(pace.now / pace.then - 1) * 100).toFixed(0)}% ${pace.now > pace.then ? 'ahead of' : 'behind'}`}</b>{' '}
                    last week at this hour. The whole-day bar is where that day finished — not a
                    target, and not a figure today can be compared against yet.</>}
              </p>
            </Card>
          ) : null,

          coverage: (
            <Card
              header="Stream coverage by market"
              description="What the lag in the header is made of. The stream reports what serves, so an idle market producing nothing is the pipeline working."
            >
              <div className="rpx-rows">
                {data.markets.map((m) => (
                  <div key={m.marketplace} className={`row${m.idle ? ' is-thin' : ''}`}>
                    <span className="wk">{m.marketplace}</span>
                    <span className="c">
                      {m.idle
                        ? <Pill tone="neutral">no enabled campaigns</Pill>
                        : <>{m.campaigns} {m.campaigns === 1 ? 'campaign' : 'campaigns'} · {m.days} {m.days === 1 ? 'day' : 'days'} held</>}
                    </span>
                    <span className="n">{m.lastDay ?? 'never'}</span>
                    <span className="n s">{m.lagDays == null ? '—' : `${m.lagDays}d`}</span>
                  </div>
                ))}
              </div>
            </Card>
          ),

          sample: sampleGrid ? (
            <Card
              header="How many days each cell holds"
              description={`The same 7 × 24 shape as the pattern above, counting distinct days rather than measuring anything. Read them together: a striking cell backed by one day is one day.`}
            >
              <Heatmap
                data={sampleGrid}
                rowLabels={DAY_LABELS}
                colLabels={HOURS}
                format={(v) => `${v} ${v === 1 ? 'day' : 'days'}`}
                emptyLabel="no rows in this window"
              />
            </Card>
          ) : null,
        } as Record<string, ReactNode>}
      </SectionLayout>

      <Caveats items={data.caveats} title="How to read this" />
    </div>
  )
}
