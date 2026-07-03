'use client'

/**
 * E3 — eBay Ads dashboard: spend / ad sales / eBay ACOS / clicks +
 * vs-previous deltas, daily trend, campaign counts, economics readiness.
 * Every figure is any-click-attributed and stamped with freshness.
 */
import { useMemo, useState } from 'react'
import { Euro, TrendingUp, Percent, MousePointerClick, Eye, Package } from 'lucide-react'
import { AdsPageHeader } from '../_shell/AdsPageHeader'
import { KpiStrip, type KpiTileSpec } from '@/app/_shared/grid-lens'
import { PerformanceGraph } from '@/design-system/components/PerformanceGraph'
import { Banner } from '@/design-system/components/Banner'
import { EmptyState } from '@/design-system/components/EmptyState'
import { Skeleton } from '@/design-system/primitives/Skeleton'
import { Select } from '@/design-system/primitives/Select'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import './ebay.css'
import {
  useEbayAdsFetch, EBAY_MARKETS, PRESETS, eurC, pctP, intlN,
  FreshnessLine, type SummaryPayload, type TrendPayload,
} from './_shared'

export function EbayDashboard() {
  const [market, setMarket] = useState('all')
  const [preset, setPreset] = useState('last30')
  const summary = useEbayAdsFetch<SummaryPayload>('/summary', market, preset)
  const trend = useEbayAdsFetch<TrendPayload>('/trend', market, preset)

  const s = summary.data
  const tiles: KpiTileSpec[] = useMemo(() => {
    if (!s) return []
    const d = s.current
    return [
      { icon: Euro, label: 'AD FEES', value: eurC(d.adFeesCents), detail: `vs prior ${eurC(s.prior.adFeesCents)}`, tone: 'rose', delta: { pct: s.deltas.adFeesPct, good: false } },
      { icon: TrendingUp, label: 'AD SALES (ANY-CLICK)', value: eurC(d.salesCents), detail: `${intlN(d.soldQty)} sold · vs prior ${eurC(s.prior.salesCents)}`, tone: 'emerald', delta: { pct: s.deltas.salesPct, good: true } },
      { icon: Percent, label: 'EBAY ACOS', value: pctP(d.acosPct), detail: 'ad fees ÷ attributed sales', tone: 'violet' },
      { icon: MousePointerClick, label: 'CLICKS', value: intlN(d.clicks), detail: `avg CPC ${d.avgCpcCents != null ? eurC(d.avgCpcCents) : '—'}`, tone: 'blue', delta: { pct: s.deltas.clicksPct, good: true } },
      { icon: Eye, label: 'IMPRESSIONS', value: intlN(d.impressions), detail: `CTR ${pctP(d.ctrPct, 2)}`, tone: 'slate', delta: { pct: s.deltas.impressionsPct, good: true } },
      { icon: Package, label: 'CAMPAIGNS', value: String(Object.values(s.campaignCounts).reduce((a, b) => a + b, 0)), detail: Object.entries(s.campaignCounts).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(' · '), tone: 'amber' },
    ]
  }, [s])

  const chartData = useMemo(
    () => (trend.data?.points ?? []).map((p) => ({ date: p.date.slice(5), fees: p.adFeesCents / 100, sales: p.salesCents / 100 })),
    [trend.data],
  )

  const missingCogs = s?.economicsStatus?.MISSING_COGS ?? 0
  const hasAnyData = (s?.current.impressions ?? 0) > 0 || (s?.current.adFeesCents ?? 0) > 0

  return (
    <div className="eb-page">
      <AdsPageHeader
        title="eBay Advertising"
        subtitle="Promoted Listings — General (cost-per-sale) + Priority (cost-per-click) across your eBay marketplaces."
        markets={EBAY_MARKETS.map((m) => m.id)}
        market={market}
        onMarketChange={setMarket}
      />

      <div className="eb-controls">
        <Select value={preset} onChange={(e) => setPreset(e.target.value)} aria-label="Date range">
          {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </Select>
        <FreshnessLine f={s?.freshness} />
      </div>

      {summary.error && (
        <Banner tone="danger" title="Couldn't load the eBay ads summary">
          {summary.error} — <button className="eb-linkbtn" onClick={summary.reload}>retry</button>
        </Banner>
      )}

      {summary.loading ? (
        <div className="eb-kpi-skeleton"><Skeleton height={92} /><Skeleton height={92} /><Skeleton height={92} /><Skeleton height={92} /><Skeleton height={92} /><Skeleton height={92} /></div>
      ) : s && (
        <>
          <KpiStrip tiles={tiles} className="eb-kpis" />

          {missingCogs > 0 && (
            <Banner tone="warning" title={`Break-even ad rates unavailable for ${missingCogs} listing${missingCogs === 1 ? '' : 's'}`}>
              Product costs are missing, so net margin after ads can't be computed yet. Add costs on the products
              (or wire the cost master) — until then those listings are <b>manual only</b> for any automation.
            </Banner>
          )}

          <section className="eb-panel">
            <header className="eb-panel-head">
              <h3>Ad fees vs attributed sales</h3>
              <span className="eb-panel-note">{s.window.since} → {s.window.until} · EUR · daily</span>
            </header>
            {trend.loading ? (
              <Skeleton height={240} />
            ) : chartData.length === 0 ? (
              <EmptyState title="No performance data in this window" description="Reports land daily (03:40 UTC scheduler + 3-minute poller). Widen the range or check /sync-logs if this persists." />
            ) : (
              <PerformanceGraph
                data={chartData}
                xKey="date"
                left={{ key: 'fees', label: 'Ad fees', color: '#f43f5e', axis: 'left', format: (v) => `€${v.toFixed(2)}` }}
                right={{ key: 'sales', label: 'Ad sales', color: '#10b981', axis: 'right', format: (v) => `€${v.toFixed(2)}` }}
                height={240}
              />
            )}
          </section>

          {!hasAnyData && !summary.loading && (
            <EmptyState
              title="No eBay ads activity in this window"
              description="Campaigns are synced hourly and performance reports daily. If you just connected, the first facts arrive after the next report cycle."
            />
          )}
        </>
      )}
    </div>
  )
}
