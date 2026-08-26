'use client'

/**
 * RPX.3 — the Market share tab.
 *
 * Our slice of the WHOLE market, query by query, from Amazon's Search Query Performance feed.
 * Every competitor's "share of voice" divides our impressions by our own impressions elsewhere;
 * this divides by the market's, because Amazon publishes the market's count beside ours for the
 * same query. That is a real denominator and it is the one figure a scraper cannot approximate.
 *
 * Two rules the feed forces, both visible on screen rather than in a footnote:
 *
 * · **A counted zero is not an absent one.** Purchase share prints "0 of 132" when the market
 *   bought and we did not, and an em-dash when the market bought nothing at all — 0/0 has no
 *   value. The denominator travels with the percentage so neither can be misread.
 *
 * · **Coverage travels with the trend.** Amazon delivered 1,066 query rows for Italy in one week
 *   and 8 in another. A share over eight rows is not comparable to one over a thousand, so the
 *   server marks those weeks `thin`, the line breaks across them rather than averaging them in,
 *   and the row count sits under the chart at all times.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '@/design-system/components/Card'
import { Pill } from '@/design-system/primitives/Pill'
import { AdsDataGrid, type GridColumn } from '../campaigns/_grid/AdsDataGrid'
import { MetricChart, type ChartMetric } from '../_shared/MetricChart'
import { fetchMarketShare, fmtCount, fmtShare, type MarketShare, type ShareQuery } from './strategy-api'
import { Caveats, ProvenanceStrip, TabState } from './StrategyBits'

const CHART_METRICS: ChartMetric[] = [
  { key: 'impressionShare', label: 'Impression share', unit: 'pct' },
  { key: 'clickShare', label: 'Click share', unit: 'pct' },
  { key: 'cartAddShare', label: 'Cart-add share', unit: 'pct' },
  { key: 'purchaseShare', label: 'Purchase share', unit: 'pct' },
]

export function MarketShareTab({ market }: { market: string }) {
  const [data, setData] = useState<MarketShare | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const [plotted, setPlotted] = useState<string[]>(['impressionShare', 'clickShare'])

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  // This feed has no all-markets grain that means anything: a share is per query per market, and
  // pooling four markets' impressions would invent a market nobody sells in. Default to Italy,
  // which holds 7,487 of the rows, and let the header switch.
  const chosen = market === 'all' ? 'IT' : market

  useEffect(() => {
    const ac = new AbortController()
    setLoading(true)
    fetchMarketShare({ marketplace: chosen, weeks: 12, queryLimit: 50 }, ac.signal)
      .then((d) => { setData(d); setError(null) })
      .catch((e: unknown) => { if ((e as Error).name !== 'AbortError') setError((e as Error).message) })
      .finally(() => { if (!ac.signal.aborted) setLoading(false) })
    return () => ac.abort()
  }, [chosen, nonce])

  /**
   * A thin week is drawn as a GAP, not as a point.
   *
   * Nulling the shares breaks the line there — the alternative is a point computed over eight
   * rows sitting on the same axis as one computed over a thousand, which is a comparison the
   * data does not support. Nothing is hidden: the row count stays on the coverage strip and the
   * server's caveat names the week.
   */
  const chartData = useMemo(() => (data?.series ?? []).map((w) => ({
    date: w.week,
    impressionShare: w.thin ? null : w.impressionShare,
    clickShare: w.thin ? null : w.clickShare,
    cartAddShare: w.thin ? null : w.cartAddShare,
    purchaseShare: w.thin ? null : w.purchaseShare,
  })), [data])

  const freshness = useMemo(() => (data?.freshness ?? []).map((f) => ({
    marketplace: f.marketplace,
    lagDays: f.lagDays,
    late: f.lagDays != null && f.lagDays > 21,
  })), [data])

  const columns: GridColumn<ShareQuery>[] = useMemo(() => [
    {
      key: 'marketImpressions',
      label: 'Market impressions',
      tip: 'Every impression Amazon recorded for this query, ours and everyone else’s.',
      sortValue: (r) => r.marketImpressions,
      render: (r) => fmtCount(r.marketImpressions),
    },
    {
      key: 'ourImpressions',
      label: 'Our impressions',
      sortValue: (r) => r.ourImpressions,
      render: (r) => fmtCount(r.ourImpressions),
    },
    {
      key: 'impressionShare',
      label: 'Impression share',
      tip: 'Ours ÷ the market’s, for this query and week.',
      sortValue: (r) => r.impressionShare,
      render: (r) => (r.impressionShare == null
        ? <span className="rpt-dash">—</span>
        : <b>{fmtShare(r.impressionShare)}</b>),
    },
    {
      key: 'ourClicks',
      label: 'Our clicks',
      sortValue: (r) => r.ourClicks,
      render: (r) => fmtCount(r.ourClicks),
    },
    {
      key: 'marketPurchases',
      label: 'Market purchases',
      sortValue: (r) => r.marketPurchases,
      render: (r) => fmtCount(r.marketPurchases),
    },
    {
      key: 'purchaseShare',
      label: 'Purchase share',
      tip: 'An em-dash means the market recorded no purchases on this query at all, so our share of them has no value. 0.00% means it did and none were ours.',
      sortValue: (r) => r.purchaseShare,
      render: (r) => (r.purchaseShare == null
        ? <span className="rpt-dash" title="The market recorded no purchases on this query">—</span>
        : <span className="rpx-buyshare">{fmtShare(r.purchaseShare)} <span className="d">{r.ourPurchases} of {r.marketPurchases}</span></span>),
    },
  ], [])

  if (error || (loading && !data)) return <TabState loading={loading} error={error} onRetry={reload} />
  if (!data) return null

  const held = data.weeksHeld
  const thin = data.coverage.thinWeeks.length

  return (
    <div className="rpx">
      <ProvenanceStrip
        source="Search Query Performance · Amazon Brand Analytics"
        grain="query × ASIN × week"
        held={`${held} ${held === 1 ? 'week' : 'weeks'} · ${data.firstWeek ?? '—'} → ${data.lastWeek ?? '—'}`}
        markets={freshness}
        extra={market === 'all' ? (
          <><span className="k">Market</span><span className="v">{chosen} — a share is per market; four pooled would invent one</span></>
        ) : null}
      />

      {!data.week ? (
        <Card><div className="rpx-empty"><b>No Search Query Performance held for {chosen}.</b> Amazon publishes this feed weekly, roughly ten days in arrears, for queries where our ASINs appeared.</div></Card>
      ) : (
        <>
          <Card header="Where our share goes" description={`Amazon reports the whole market's count and ours for the same query. Week of ${data.week}.`}>
            <div className="rpx-share-funnel">
              {data.funnel.map((s) => (
                <div key={s.id} className={`rpx-share-stage${s.share != null && s.share === 0 ? ' is-zero' : ''}`}>
                  <div className="lbl">{s.label.toLowerCase()} share</div>
                  <div className="val">{fmtShare(s.share)}</div>
                  <div className="sub">
                    {s.share == null
                      ? `the market recorded no ${s.label.toLowerCase()} — no denominator`
                      : `${fmtCount(s.ours)} of ${fmtCount(s.market)}`}
                  </div>
                  <div className="bar">
                    {/* Scaled against the LARGEST share in this funnel, so the shape of the drop
                        is readable at figures that all live under two per cent. */}
                    <span style={{ width: `${scaleBar(s.share, data.funnel)}%` }} />
                  </div>
                </div>
              ))}
            </div>
            <FunnelRead data={data} />
          </Card>

          <Card
            header="Share over time"
            description={`${data.series.length} weeks. The strip beneath is how many query rows Amazon delivered that week — a share computed over ${data.coverage.thinBelow} rows is not comparable to one computed over ${fmtCount(data.coverage.medianRows)}.`}
            headerAction={thin ? <Pill tone="warning">{thin} thin {thin === 1 ? 'week' : 'weeks'} excluded</Pill> : undefined}
          >
            <MetricChart
              title=""
              subtitle={`By week · ${data.firstWeek ?? '—'} → ${data.lastWeek ?? '—'}`}
              data={chartData}
              metrics={CHART_METRICS}
              selected={plotted}
              onSelectedChange={setPlotted}
              emptyLabel="No weeks held for this market."
              storageKey="rpx-share-chart"
            />
            <div className="rpx-coverage">
              <span className="k">Rows delivered</span>
              {data.series.map((w) => (
                <span key={w.week} className={`c${w.thin ? ' is-thin' : ''}`} title={`${w.week}: ${fmtCount(w.rows)} query rows`}>
                  <b>{fmtCount(w.rows)}</b>
                  <i>{w.week.slice(5)}</i>
                </span>
              ))}
            </div>
          </Card>

          <Card
            header="The queries the market is searching"
            description="Ordered by the market's impressions, not ours — the queries worth holding share on, whether or not we hold any today."
          >
            <AdsDataGrid<ShareQuery>
              rows={data.queries}
              rowId={(r) => r.query}
              noun="Query"
              firstColLabel="Search query"
              renderFirst={(r) => <span className="rpx-q">{r.query}</span>}
              firstSortValue={(r) => r.query}
              columns={columns}
              selectable={false}
              showTotal={false}
              searchable
              searchPlaceholder="Filter queries…"
              storageKey="rpx-share-queries"
              emptyLabel="No queries for this week."
            />
          </Card>
        </>
      )}

      <Caveats items={data.caveats} />
    </div>
  )
}

/** Bar width relative to the biggest share in the funnel, floored so a real zero still shows a track. */
function scaleBar(share: number | null, all: MarketShare['funnel']): number {
  if (share == null) return 0
  const max = all.reduce((m, s) => (s.share != null && s.share > m ? s.share : m), 0)
  return max > 0 ? Math.round((share / max) * 100) : 0
}

/**
 * The read, computed from the same four figures rather than written down.
 *
 * It only claims the inversion when the numbers actually show it — a sentence that is true of
 * this week and hardcoded would be a lie the week it stops being true.
 */
function FunnelRead({ data }: { data: MarketShare }) {
  const imp = data.funnel.find((s) => s.id === 'impressions')?.share ?? null
  const clk = data.funnel.find((s) => s.id === 'clicks')?.share ?? null
  const buy = data.funnel.find((s) => s.id === 'purchases')
  if (imp == null || clk == null) return null
  const punchesUp = clk > imp
  const lostAtPurchase = buy != null && buy.market > 0 && buy.ours === 0
  return (
    <p className="rpx-foot">
      {punchesUp
        ? <><b>We are more clickable than our visibility warrants.</b> {fmtShare(imp)} of impressions and {fmtShare(clk)} of clicks — {(clk / imp).toFixed(1)}× our impression weight.</>
        : <><b>Clicks track impressions.</b> {fmtShare(imp)} of impressions and {fmtShare(clk)} of clicks.</>}
      {lostAtPurchase && (
        <> Then none of the {fmtCount(buy!.market)} purchases Amazon counted on these queries were ours — a counted zero, not a rounded one.</>
      )}
    </p>
  )
}
