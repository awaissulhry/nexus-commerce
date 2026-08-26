'use client'

/**
 * RPX.2 — the Brand tab.
 *
 * Amazon's brand funnel against the category, read ONE market and ONE category node at a time.
 * Everything it draws comes from `GET /advertising/reporting/brand`, which returns a single row
 * per figure; nothing here sums, averages or blends, and there is no code path that could.
 *
 * Three things it deliberately does NOT do:
 *
 * 1. **No conversion rate between funnel stages.** Amazon publishes no mapping from detail-page
 *    views to carts or customers, so any percentage drawn between two stages would be ours
 *    presented as theirs. The stages sit side by side with a divider, not an arrow with a number.
 *
 * 2. **No percentile.** BM.0 tested the indices rather than assuming: a brand sitting exactly on
 *    the category median reads about 0.72 awareness, not 0.50. They are composite scores and are
 *    labelled as such.
 *
 * 3. **No blended all-markets total.** Picking "All markets" switches to a ratio table — each
 *    market against its OWN category tree — because the four trees are different objects and
 *    adding them describes a category that does not exist.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '@/design-system/components/Card'
import { BenchmarkBar } from '@/design-system/components/BenchmarkBar'
import { Pill } from '@/design-system/primitives/Pill'
import { Select } from '@/design-system/primitives/Select'
import { MetricChart, type ChartMetric } from '../_shared/MetricChart'
import {
  fetchBrandStrategy, fmtBenchmark, fmtDistance,
  type BrandBenchmark, type BrandStrategy,
} from './strategy-api'
import { BlockedNote, Caveats, ProvenanceStrip, StatCard, TabState } from './StrategyBits'

/**
 * The distance scale: |ln(ratio)| of 1.8 fills the bar, which is six times ahead or a sixth
 * behind. Beyond that the bar clamps and the multiple beside it carries the rest — a scale that
 * stretched to the largest value would squash every other row into the middle.
 */
const FULL_SCALE = 1.8
const TICKS = [-Math.log(5) / FULL_SCALE, -Math.log(2) / FULL_SCALE, Math.log(2) / FULL_SCALE, Math.log(5) / FULL_SCALE]

function offsetFor(b: BrandBenchmark): number | null {
  if (b.ratio == null || b.ratio <= 0 || b.distance == null) return null
  return (b.ratio >= 1 ? 1 : -1) * (b.distance / FULL_SCALE)
}

function verdictFor(b: BrandBenchmark) {
  return b.discriminates ? b.verdict : ('cannot-discriminate' as const)
}

const CHART_METRICS: ChartMetric[] = [
  { key: 'brandCustomers', label: 'Brand customers', unit: 'count' },
  { key: 'brandCustomersMedian', label: 'Category median', unit: 'count' },
  { key: 'addToCarts', label: 'Add to carts', unit: 'count' },
  { key: 'viewedDetailPageOnly', label: 'Detail page views', unit: 'count' },
  { key: 'awarenessIndex', label: 'Awareness index', unit: 'ratio' },
  { key: 'considerationIndex', label: 'Consideration index', unit: 'ratio' },
  { key: 'salesIndex', label: 'Sales index', unit: 'ratio' },
]

export function BrandTab({ market }: { market: string }) {
  const [data, setData] = useState<BrandStrategy | null>(null)
  const [node, setNode] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const [plotted, setPlotted] = useState<string[]>(['brandCustomers', 'brandCustomersMedian'])

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  // Switching market invalidates the node: the trees are different objects, and carrying an
  // Italian node name into Germany would silently fall back to its root with no explanation.
  useEffect(() => { setNode(null) }, [market])

  useEffect(() => {
    const ac = new AbortController()
    setLoading(true)
    fetchBrandStrategy({ marketplace: market, node, weeks: 26 }, ac.signal)
      .then((d) => { setData(d); setError(null) })
      .catch((e: unknown) => { if ((e as Error).name !== 'AbortError') setError((e as Error).message) })
      .finally(() => { if (!ac.signal.aborted) setLoading(false) })
    return () => ac.abort()
  }, [market, node, nonce])

  const isAll = market === 'all'

  const freshness = useMemo(() => (data?.freshness ?? []).map((f) => ({
    marketplace: f.marketplace,
    lagDays: f.lagDays,
    // Weekly feed published in arrears: 21 days is the point at which it is genuinely behind.
    late: f.lagDays != null && f.lagDays > 21,
  })), [data])

  const chartData = useMemo(
    () => (data?.series ?? []).map((p) => ({ ...p, date: p.week })),
    [data],
  )

  if (error || (loading && !data)) {
    return <TabState loading={loading} error={error} onRetry={reload} />
  }
  if (!data) return null

  return (
    <div className="rpx">
      <ProvenanceStrip
        source="Brand Metrics · Amazon Ads Insights API"
        grain="brand × week × category node"
        held={isAll
          ? `${data.freshness.length} markets`
          : `${data.weeksHeld} ${data.weeksHeld === 1 ? 'week' : 'weeks'} · ${data.firstWeek ?? '—'} → ${data.lastWeek ?? '—'}`}
        markets={freshness}
        extra={!isAll && data.nodes.length > 0 ? (
          <>
            <span className="k">Node</span>
            <Select
              value={data.node?.name ?? ''}
              onChange={(e) => setNode(e.target.value)}
              aria-label="Category node"
              className="rpx-nodesel"
            >
              {data.nodes.map((n) => (
                <option key={n.name} value={n.name}>
                  {n.name.split('/').filter(Boolean).slice(-1)[0]}{n.isRoot ? ' — root' : ''} · {n.weeks}w
                </option>
              ))}
            </Select>
          </>
        ) : null}
      />

      {isAll ? <AllMarkets data={data} /> : <OneMarket data={data} chartData={chartData} plotted={plotted} setPlotted={setPlotted} />}

      <Caveats items={data.caveats} />
    </div>
  )
}

// ── one market ────────────────────────────────────────────────────────────────

function OneMarket({
  data, chartData, plotted, setPlotted,
}: {
  data: BrandStrategy
  chartData: Array<Record<string, string | number | null>>
  plotted: string[]
  setPlotted: (k: string[]) => void
}) {
  const ntb = data.benchmarks.find((b) => b.id === 'newToBrandCustomerRate') ?? null
  const band = data.bands[0] ?? null

  if (!data.week) {
    return (
      <Card>
        <div className="rpx-empty">
          <b>No Brand Metrics for {data.marketplace}.</b> Amazon publishes this feed weekly for
          brands enrolled in Brand Registry; nothing has landed for this market.
        </div>
      </Card>
    )
  }

  return (
    <>
      <div className="rpx-stats">
        <StatCard
          label="Week"
          value={data.week}
          sub={`${data.lagDays ?? '—'} days ago · ${data.brandName ?? 'brand'}`}
        />
        {(['awareness', 'consideration', 'sales'] as const).map((k) => (
          <StatCard
            key={k}
            label={k === 'sales' ? 'Sales index' : `${k[0].toUpperCase()}${k.slice(1)} index`}
            value={data.indices[k] == null ? '—' : data.indices[k]!.toFixed(2)}
            sub="Amazon's composite score, 0–1 — not a percentile"
          />
        ))}
      </div>

      <Card header="The brand funnel" description={`Amazon's three stage indices and the counts it reports inside each, against this node's median and top performers. Week of ${data.week}.`}>
        <div className="rpx-funnel">
          {data.stages.map((s) => (
            <div key={s.id} className="rpx-stage">
              <div className="hd">
                <span className="n">{s.label}</span>
                <span className="i">{s.index == null ? '—' : s.index.toFixed(2)}</span>
              </div>
              <div className="bar"><span style={{ width: `${Math.max(0, Math.min(1, s.index ?? 0)) * 100}%` }} /></div>
              <div className="cap">Amazon&rsquo;s {s.label.toLowerCase()} index · 0 to 1</div>
              <div className="rule" />
              {s.metrics.map((m) => (
                <div key={m.id} className="rpx-stage-metric">
                  <div className="row">
                    <span className="l">{m.label}</span>
                    <span className="v">{fmtBenchmark(m.value, m.format)}</span>
                  </div>
                  <div className="cmp">
                    <span>median {fmtBenchmark(m.median, m.format)}</span>
                    <span>top {fmtBenchmark(m.top, m.format)}</span>
                    <span className={`vd is-${m.discriminates ? m.verdict : 'mute'}`}>{m.discriminates ? fmtDistance(m) : 'cannot discriminate'}</span>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
        <p className="rpx-foot">
          <b>These are indices, not percentile ranks.</b> A median-crossing test on production rows
          put a brand sitting exactly on the category median at 0.72 awareness, not 0.50.{' '}
          <b>No conversion rate is shown between stages</b>, because Amazon publishes no mapping
          from detail-page views to carts or customers — a percentage here would be ours, not theirs.
        </p>
      </Card>

      <Card
        header="Furthest from the category median"
        description="Every benchmarked figure Amazon sends for this node, ordered by how far we sit from the median brand. Distance is a ratio, so five times ahead and a fifth behind are the same size of gap."
      >
        <div className="rpx-bmk-head">
          <span>Metric</span><span>Ours</span><span>Median</span>
          <span className="scale">
            <i style={{ left: `${50 + TICKS[0] * 50}%` }}>5× behind</i>
            <i style={{ left: '50%' }} className="mid">median</i>
            <i style={{ left: `${50 + TICKS[3] * 50}%` }}>5× ahead</i>
          </span>
          <span>Read</span>
        </div>
        {data.benchmarks.map((b) => (
          <BenchmarkBar
            key={b.id}
            label={b.label}
            value={fmtBenchmark(b.value, b.format)}
            median={fmtBenchmark(b.median, b.format)}
            offset={b.discriminates ? offsetFor(b) : null}
            verdict={verdictFor(b)}
            distanceLabel={b.discriminates ? fmtDistance(b) : 'cannot discriminate'}
            note={b.discriminates
              ? 'Amazon sent no benchmark for this measure'
              : 'Amazon returns the same figure for us, the median and the top performers'}
            ticks={TICKS}
          />
        ))}
      </Card>

      <div className="rpx-two">
        <Card header="New-to-brand customers" description="The only place this account can answer the question.">
          <div className="rpx-ntb">
            <div className="lbl">New-to-brand customer rate</div>
            <div className="big">{ntb ? fmtBenchmark(ntb.value, ntb.format) : '—'}</div>
            <div className="sub">
              Weekly, brand-level, {data.marketplace}. Category median {ntb ? fmtBenchmark(ntb.median, ntb.format) : '—'}
              {ntb && !ntb.discriminates ? ' — identical to ours and to the top performers' : ''}.
            </div>
          </div>
          <BlockedNote title="Not from your ad reports">
            Sponsored Products publishes no new-to-brand column at all. Sponsored Brands offers
            fourteen and Sponsored Display eleven — and every campaign of those two types on this
            account is paused, so the ad-level fields are null on every row. This figure is Amazon&rsquo;s
            brand-level measure, which is a different grain and is labelled as one.
          </BlockedNote>

          {band && (
            <div className="rpx-band">
              <div className="lbl">Shopper engagement rate</div>
              <div className="big">
                {band.lower == null || band.upper == null ? '—' : `${band.lower}–${band.upper}%`}
              </div>
              <div className="sub">
                Amazon reports engagement as a bounded range, never a single figure. Category median{' '}
                {band.medianLower == null ? '—' : `${band.medianLower}–${band.medianUpper}%`}, top performers{' '}
                {band.topLower == null ? '—' : `${band.topLower}–${band.topUpper}%`}.
              </div>
              {!band.discriminates && (
                <div className="mute"><Pill tone="neutral">Cannot discriminate</Pill> All three bands are identical, so this benchmark cannot separate anyone in this category.</div>
              )}
            </div>
          )}
        </Card>

        <Card header="Over time" description={`${data.weeksHeld} weeks held for this node. Amazon publishes this feed weekly, so each point is one week.`}>
          <MetricChart
            title=""
            subtitle={`By week · ${data.firstWeek ?? '—'} → ${data.lastWeek ?? '—'}`}
            data={chartData}
            metrics={CHART_METRICS}
            selected={plotted}
            onSelectedChange={setPlotted}
            emptyLabel="No weeks held for this node yet."
            storageKey="rpx-brand-chart"
          />
        </Card>
      </div>
    </>
  )
}

// ── all markets ───────────────────────────────────────────────────────────────

const RATIO_ROWS = [
  { id: 'viewedDetailPageOnly', label: 'Detail page views' },
  { id: 'addToCarts', label: 'Add to carts' },
  { id: 'brandCustomers', label: 'Brand customers' },
  { id: 'customerConversionRate', label: 'Customer conversion rate' },
]

function AllMarkets({ data }: { data: BrandStrategy }) {
  if (!data.byMarket.length) {
    return <Card><div className="rpx-empty">No Brand Metrics held for any market.</div></Card>
  }
  return (
    <>
      <Card>
        <div className="rpx-lede">
          <b>Across markets we compare ratios, never totals.</b> Amazon computes each median
          against <b>one market&rsquo;s</b> category tree, and the four trees are different objects —{' '}
          <i>{data.byMarket[0]?.node.split('/').filter(Boolean).slice(-1)[0]}</i> is not the node
          Germany is measured against. Adding four markets&rsquo; counts together produces a figure for
          a category that does not exist. What <i>is</i> comparable is how far each market sits
          from its own median, so that is what this view shows.
        </div>
      </Card>

      <div className="rpx-mkts">
        {data.byMarket.map((m) => (
          <Card key={m.marketplace} header={m.marketplace} description={m.node.split('/').filter(Boolean).slice(-1)[0]}>
            <div className="rpx-idx">
              {([['Awareness', m.indices.awareness], ['Consideration', m.indices.consideration], ['Sales', m.indices.sales]] as const).map(([l, v]) => (
                <div key={l}>
                  <div className="row"><span>{l}</span><b>{v == null ? '—' : v.toFixed(2)}</b></div>
                  <div className="bar"><span style={{ width: `${Math.max(0, Math.min(1, v ?? 0)) * 100}%` }} /></div>
                </div>
              ))}
            </div>
          </Card>
        ))}
      </div>

      <Card
        header="Distance from each market's own median"
        description="Every cell is our figure divided by the median brand in that market's category tree. Comparable across markets; the raw counts are not."
      >
        <div className="rpx-ratio-grid" style={{ gridTemplateColumns: `minmax(160px, 1.2fr) repeat(${data.byMarket.length}, minmax(0, 1fr))` }}>
          <div className="hd">Metric</div>
          {data.byMarket.map((m) => <div key={m.marketplace} className="hd c">{m.marketplace}</div>)}
          {RATIO_ROWS.map((row) => (
            <RatioRow key={row.id} label={row.label} id={row.id} markets={data.byMarket} />
          ))}
        </div>
      </Card>
    </>
  )
}

function RatioRow({ label, id, markets }: { label: string; id: string; markets: BrandStrategy['byMarket'] }) {
  return (
    <>
      <div className="lbl">{label}</div>
      {markets.map((m) => {
        const b = m.benchmarks.find((x) => x.id === id)
        if (!b) return <div key={m.marketplace} className="cell c"><span className="dash">—</span></div>
        return (
          <div key={m.marketplace} className="cell c">
            <div className="mini">
              <span className="ax" aria-hidden />
              {(() => {
                const off = b.discriminates ? offsetFor(b) : null
                if (off == null) return null
                const pct = Math.min(1, Math.abs(off)) * 50
                return <span className="fill" style={off < 0 ? { right: '50%', width: `${pct}%` } : { left: '50%', width: `${pct}%` }} aria-hidden />
              })()}
            </div>
            <div className={`vd is-${b.discriminates ? b.verdict : 'mute'}`}>{b.discriminates ? fmtDistance(b) : 'cannot discriminate'}</div>
            <div className="raw">{fmtBenchmark(b.value, b.format)} vs {fmtBenchmark(b.median, b.format)}</div>
          </div>
        )
      })}
    </>
  )
}
