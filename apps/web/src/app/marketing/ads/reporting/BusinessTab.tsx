'use client'

/**
 * RPX.4 — the Business tab: what advertising costs the whole company, not just the ad account.
 *
 * ACOS divides spend by the sales advertising claims credit for, so it cannot fall when the
 * business shrinks. TACoS divides by every euro the account took. The gap between the two is
 * the story, and it needs a feed the ad API does not have — `DailySalesAggregate`, which we
 * hold back to May 2024.
 *
 * 🔴 The service behind this had a live defect until RPX: it aggregated
 * `AmazonAdsDailyPerformance` without excluding the 659 rows Amazon Marketing Stream wrote to
 * the daily grain before AX2.3 stopped it. Measured on prod over the last 90 days, Italian ad
 * spend read €6,298.39 against a true €4,981.03 and ad sales €15,138.40 against €11,794.07.
 * Every ACOS, TACoS and ad-share on this tab moved when the guard went in.
 *
 * One market at a time, because a TACoS blended across four markets hides exactly the market
 * that moved.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '@/design-system/components/Card'
import { Pill } from '@/design-system/primitives/Pill'
import { MetricChart, type ChartMetric } from '../_shared/MetricChart'
import { fetchBusinessContext, type BusinessContext } from './business-api'
import { fmtCount, fmtMoney, fmtShare } from './strategy-api'
import { BlockedNote, Caveats, ProvenanceStrip, StatCard, TabState } from './StrategyBits'

/** Amazon's own names, so a reader is not left to expand SP/SB/SD themselves. */
const AD_PRODUCT_NAME: Record<string, string> = {
  SP: 'Sponsored Products',
  SB: 'Sponsored Brands',
  SD: 'Sponsored Display',
  ST: 'Sponsored TV',
}

const CHART_METRICS: ChartMetric[] = [
  { key: 'tacos', label: 'TACoS', unit: 'pct' },
  { key: 'adShare', label: 'Ad-attributed share of sales', unit: 'pct' },
  { key: 'adSpend', label: 'Ad spend', unit: 'eur' },
  { key: 'adSales', label: 'Ad-attributed sales', unit: 'eur' },
  { key: 'totalSales', label: 'Total sales', unit: 'eur' },
]

/** The window the tab opens on. Long enough for a trend, short enough to still be this quarter. */
const WINDOW_DAYS = 72

export function BusinessTab({ market }: { market: string }) {
  const [data, setData] = useState<BusinessContext | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const [plotted, setPlotted] = useState<string[]>(['tacos'])

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  const window = useMemo(() => {
    const to = new Date()
    const from = new Date(to.getTime() - WINDOW_DAYS * 86_400_000)
    return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) }
  }, [])

  useEffect(() => {
    const ac = new AbortController()
    setLoading(true)
    fetchBusinessContext({
      from: window.from,
      to: window.to,
      marketplaces: market === 'all' ? [] : [market],
    }, ac.signal)
      .then((d) => { setData(d); setError(null) })
      .catch((e: unknown) => { if ((e as Error).name !== 'AbortError') setError((e as Error).message) })
      .finally(() => { if (!ac.signal.aborted) setLoading(false) })
    return () => ac.abort()
  }, [market, window, nonce])

  /**
   * The partial week is drawn hollow by nulling nothing and marking the point instead — the
   * shared chart has no per-point style, so the honest option here is to keep the value and say
   * so beneath, rather than drop a real week or draw it as if it were complete.
   */
  const chartData = useMemo(() => (data?.series ?? []).map((w) => ({
    date: w.weekStart,
    tacos: w.tacos,
    adShare: w.adShare,
    adSpend: w.adSpend,
    adSales: w.adSales,
    totalSales: w.totalSales,
  })), [data])

  if (error || (loading && !data)) return <TabState loading={loading} error={error} onRetry={reload} />
  if (!data) return null

  const complete = data.series.filter((w) => !w.partial)
  const latest = complete[complete.length - 1] ?? null
  const prev = complete[complete.length - 2] ?? null
  const partials = data.series.filter((w) => w.partial)
  const t = data.totals

  const delta = (now: number | null, before: number | null): string | null => {
    if (now == null || before == null || before === 0) return null
    return `${now > before ? '↗' : '↘'} ${(Math.abs(now / before - 1) * 100).toFixed(1)}%`
  }

  return (
    <div className="rpx">
      <ProvenanceStrip
        source="Ads daily performance × account sales"
        grain="day, rolled to ISO weeks"
        held={`${data.window.from} → ${data.window.to}`}
        markets={[]}
        extra={(
          <>
            <span className="k">Complete through</span>
            <span className="v">{data.completeThrough ?? '—'}</span>
            <span className="sep" aria-hidden />
            <span className="k">Market</span>
            <span className="v">{data.marketplaces.length ? data.marketplaces.join(', ') : 'all'}</span>
          </>
        )}
      />

      <div className="rpx-stats">
        <StatCard
          label="Ad spend"
          value={fmtMoney(t.adSpend)}
          sub={latest ? <>Latest complete week {fmtMoney(latest.adSpend)} {delta(latest.adSpend, prev?.adSpend ?? null) ?? ''}</> : undefined}
        />
        <StatCard
          label="Ad-attributed sales"
          value={fmtMoney(t.adSales)}
          sub={<>ACOS {t.acos == null ? '—' : fmtShare(t.acos, 1)}</>}
        />
        <StatCard
          label="Total sales"
          value={fmtMoney(t.totalSales)}
          sub={<>Ad-attributed share {t.adShare == null ? '—' : fmtShare(t.adShare, 1)}</>}
        />
        <StatCard
          label="TACoS"
          value={t.tacos == null ? '—' : fmtShare(t.tacos, 1)}
          tone={t.tacos != null && t.tacos > 0.35 ? 'warn' : 'default'}
          sub={latest && latest.tacos != null
            ? <>Latest complete week {fmtShare(latest.tacos, 1)} {delta(latest.tacos, prev?.tacos ?? null) ?? ''}</>
            : <>Spend ÷ every euro the account took</>}
        />
      </div>

      <Card
        header="Total advertising cost of sale"
        description="Ad spend as a share of every euro the account took, not just the euros advertising claims. One point per ISO week."
        headerAction={partials.length ? <Pill tone="neutral">{partials.length === 1 ? 'Last week is partial' : `${partials.length} partial weeks`}</Pill> : undefined}
      >
        <MetricChart
          title=""
          subtitle={`By week · ${data.window.from} → ${data.window.to}`}
          data={chartData}
          metrics={CHART_METRICS}
          selected={plotted}
          onSelectedChange={setPlotted}
          emptyLabel="No weeks in this window."
          storageKey="rpx-biz-chart"
        />
        {partials.length > 0 && (
          <p className="rpx-foot">
            <b>{partials.map((w) => w.weekStart).join(', ')} {partials.length === 1 ? 'is' : 'are'} not complete.</b>{' '}
            Both feeds reach {data.completeThrough ?? 'an unknown date'}, so {partials.length === 1 ? 'that week holds' : 'those weeks hold'} fewer
            than seven days and {partials.length === 1 ? 'is' : 'are'} excluded from the comparison above.
          </p>
        )}
      </Card>

      <Card
        header="Week by week"
        description="The same four figures the headline is built from. Nothing here is a different definition of TACoS — it is the same expression over a narrower window."
      >
        <div className="rpx-weeks">
          <div className="hd">
            <span>Week</span><span className="n">Ad spend</span><span className="n">Ad sales</span>
            <span className="n">Total sales</span><span className="n">TACoS</span><span className="n">Ad share</span>
          </div>
          {[...data.series].reverse().map((w) => (
            <div key={w.weekStart} className={`row${w.partial ? ' is-partial' : ''}`}>
              <span>{w.weekStart}{w.partial && <span className="tag">partial</span>}</span>
              <span className="n">{fmtMoney(w.adSpend)}</span>
              <span className="n">{fmtMoney(w.adSales)}</span>
              <span className="n">{fmtMoney(w.totalSales)}</span>
              <span className="n b">{w.tacos == null ? '—' : fmtShare(w.tacos, 1)}</span>
              <span className="n">{w.adShare == null ? '—' : fmtShare(w.adShare, 1)}</span>
            </div>
          ))}
        </div>
      </Card>

      <Card
        header="Where the spend goes by ad type"
        description="Every campaign on the account, whether or not it ran in this window."
      >
        <div className="rpx-mix">
          {data.adMix.map((m) => {
            const top = data.adMix[0]?.spend ?? 0
            return (
              <div key={m.adProduct} className={`row${m.enabled === 0 ? ' is-idle' : ''}`}>
                <span className="n">{AD_PRODUCT_NAME[m.adProduct] ?? m.adProduct}</span>
                <span className="c">
                  {m.enabled === 0
                    ? <Pill tone="neutral">{m.campaigns} {m.campaigns === 1 ? 'campaign' : 'campaigns'}, all paused</Pill>
                    : <>{m.enabled} of {m.campaigns} running</>}
                </span>
                <span className="bar"><i style={{ width: `${top > 0 ? Math.round((m.spend / top) * 100) : 0}%` }} /></span>
                {/* A zero here is a real zero: the campaigns exist and did not run. */}
                <span className="s">{m.spend === 0 && m.enabled === 0 ? '—' : fmtMoney(m.spend)}</span>
              </div>
            )
          })}
        </div>
        {data.adMix.filter((m) => m.enabled > 0).length === 1 && (
          <BlockedNote title="This is also why cross-ad attribution is empty" tone="neutral">
            Every Amazon Marketing Cloud view compares ad types against each other, and one type is
            running. An instance granted tomorrow would draw a diagram of one circle — and none is
            provisioned for this account either, so AMC is blocked twice over.
          </BlockedNote>
        )}
      </Card>

      <div className="rpx-two">
        <Card header="Wasted spend" description={`Clicks that produced no attributed sales, judged only to ${data.wasted.maturedTo}.`}>
          <div className="rpx-waste">
            <div className="big">{fmtMoney(data.wasted.amount)}</div>
            <div className="sub">
              {fmtCount(data.wasted.terms)} search terms, {fmtShare(data.wasted.pctOfSpend, 1)} of the spend examined.
              A term must reach {data.wasted.minClicks} clicks before zero sales counts as waste rather than sampling.
            </div>
          </div>
          {data.wasted.top.length > 0 && (
            <div className="rpx-wastelist">
              {data.wasted.top.slice(0, 6).map((w) => (
                <div key={`${w.marketplace}-${w.query}`} className="r">
                  <span className="q">{w.query}</span>
                  <span className="m">{w.marketplace}</span>
                  <span className="c">{fmtCount(w.clicks)} clicks</span>
                  <span className="s">{fmtMoney(w.spend)}</span>
                </div>
              ))}
            </div>
          )}
          <BlockedNote title="Not a margin figure" tone="warn">
            This is spend that produced no attributed sales, not spend below break-even. A
            margin-based number needs cost of goods on every product, and the caveat below counts
            how far that has got — the figure is built from the count, never asserted.
          </BlockedNote>
        </Card>

        <Card header="By market" description="Each market on its own, because a blended TACoS hides the one that moved.">
          <div className="rpx-mktrows">
            <div className="hd"><span>Market</span><span className="n">Spend</span><span className="n">Ad sales</span><span className="n">Total sales</span><span className="n">ACOS</span><span className="n">TACoS</span></div>
            {data.byMarket.map((m) => (
              <div key={m.marketplace} className="row">
                <span>{m.marketplace}</span>
                <span className="n">{fmtMoney(m.adSpend)}</span>
                <span className="n">{fmtMoney(m.adSales)}</span>
                <span className="n">{fmtMoney(m.totalSales)}</span>
                <span className="n">{m.acos == null ? '—' : fmtShare(m.acos, 1)}</span>
                <span className="n b">{m.tacos == null ? '—' : fmtShare(m.tacos, 1)}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Caveats items={data.caveats} />
    </div>
  )
}
