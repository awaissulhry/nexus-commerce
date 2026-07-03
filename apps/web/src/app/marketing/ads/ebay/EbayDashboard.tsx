'use client'

/**
 * E6.1 — eBay dashboard on the Amazon dashboard idiom (.dash structure +
 * dashboard.css imported from the Amazon page — file untouched): KPI strip
 * with ▲▼ deltas, dual-axis trend card, alerts + status row2 cards.
 */
import { useEffect, useMemo, useState } from 'react'
import { AdsPageHeader } from '../_shell/AdsPageHeader'
import { PerformanceGraph } from '@/design-system/components/PerformanceGraph'
import { getBackendUrl } from '@/lib/backend-url'
import '../dashboard/dashboard.css'
import './ebay.css'
import {
  useEbayAdsFetch, EBAY_MARKETS, PRESETS, eurC, pctP, intlN,
  useWriteMode, type SummaryPayload, type TrendPayload,
} from './_lib'
import { Select } from '@/design-system/primitives/Select'

interface Anomaly { type: string; severity: string; message: string }

function Delta({ pct, goodUp }: { pct: number | null; goodUp: boolean }) {
  if (pct == null) return null
  const up = pct >= 0
  const good = up === goodUp
  return <span className={`dd ${good ? 'up' : 'down'}`}>{up ? '▲' : '▼'} {Math.abs(pct).toFixed(0)}%</span>
}

export function EbayDashboard() {
  const [market, setMarket] = useState('all')
  const [preset, setPreset] = useState('last30')
  const summary = useEbayAdsFetch<SummaryPayload>('/summary', market, preset)
  const trend = useEbayAdsFetch<TrendPayload>('/trend', market, preset)
  const writeMode = useWriteMode()
  const [anomalies, setAnomalies] = useState<Anomaly[]>([])
  useEffect(() => {
    fetch(`${getBackendUrl()}/api/ebay-ads/automation/anomalies`, { credentials: 'include' })
      .then((r) => r.json()).then((j) => setAnomalies(j.anomalies ?? [])).catch(() => {})
  }, [])

  const s = summary.data
  const chartData = useMemo(
    () => (trend.data?.points ?? []).map((p) => ({ date: p.date.slice(5), fees: p.adFeesCents / 100, sales: p.salesCents / 100 })),
    [trend.data],
  )
  const missingCogs = s?.economicsStatus?.MISSING_COGS ?? 0
  const campaignsTotal = s ? Object.values(s.campaignCounts).reduce((a, b) => a + b, 0) : 0

  return (
    <div className="dash">
      <AdsPageHeader
        title="eBay Advertising"
        subtitle="Promoted Listings — General (cost-per-sale) + Priority (cost-per-click). All sales figures are any-click attributed."
        markets={EBAY_MARKETS.map((m) => m.id)}
        market={market}
        onMarketChange={setMarket}
        showLearn={false} showDataSync={false} showDateRange={false}
      />

      {writeMode === 'sandbox' && (
        <div className="dash-banner" role="status">
          <b>Sandbox mode</b> — writes validate, mirror and audit locally; nothing reaches eBay until <code>NEXUS_MARKETING_WRITES_EBAY=1</code>.
        </div>
      )}
      {missingCogs > 0 && (
        <div className="dash-banner" role="status">
          <b>{missingCogs} listing{missingCogs === 1 ? '' : 's'} without product cost</b> — break-even rates and net margin stay hidden until costs land (product costPrice or WAC); those listings are manual-only for automation.
        </div>
      )}

      <div className="dash-kpis">
        <div className="dash-kpi"><div className="dash-kpi-k">CAMPAIGNS</div><div className="dash-kpi-v">{intlN(campaignsTotal)}</div></div>
        <div className="dash-kpi"><div className="dash-kpi-k">AD FEES</div><div className="dash-kpi-v">{s ? eurC(s.current.adFeesCents) : '—'}<Delta pct={s?.deltas.adFeesPct ?? null} goodUp={false} /></div></div>
        <div className="dash-kpi"><div className="dash-kpi-k">AD SALES</div><div className="dash-kpi-v">{s ? eurC(s.current.salesCents) : '—'}<Delta pct={s?.deltas.salesPct ?? null} goodUp /></div></div>
        <div className="dash-kpi"><div className="dash-kpi-k">EBAY ACOS</div><div className="dash-kpi-v">{s ? pctP(s.current.acosPct) : '—'}</div></div>
        <div className="dash-kpi"><div className="dash-kpi-k">CLICKS</div><div className="dash-kpi-v">{s ? intlN(s.current.clicks) : '—'}<Delta pct={s?.deltas.clicksPct ?? null} goodUp /></div></div>
        <div className="dash-kpi"><div className="dash-kpi-k">IMPRESSIONS</div><div className="dash-kpi-v">{s ? intlN(s.current.impressions) : '—'}<Delta pct={s?.deltas.impressionsPct ?? null} goodUp /></div></div>
        <div className="dash-kpi"><div className="dash-kpi-k">SOLD</div><div className="dash-kpi-v">{s ? intlN(s.current.soldQty) : '—'}</div></div>
      </div>

      <div className="dash-card">
        <div className="dash-card-h">
          <span>Ad fees vs attributed sales</span>
          <Select value={preset} onChange={(e) => setPreset(e.target.value)} aria-label="Date range">
            {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </Select>
        </div>
        <div className="dash-chart">
          {chartData.length === 0 ? (
            <div className="dash-empty">{trend.loading ? 'Loading…' : 'No performance data in this window — reports land daily.'}</div>
          ) : (
            <PerformanceGraph
              data={chartData}
              xKey="date"
              left={{ key: 'fees', label: 'Ad fees', color: '#e5484d', axis: 'left', format: (v) => `€${v.toFixed(2)}` }}
              right={{ key: 'sales', label: 'Ad sales', color: '#1f6fde', axis: 'right', format: (v) => `€${v.toFixed(2)}` }}
              height={240}
            />
          )}
        </div>
      </div>

      <div className="dash-row2">
        <div className="dash-card">
          <div className="dash-card-h"><span>Alerts</span></div>
          {anomalies.length === 0 ? (
            <div className="dash-empty">No anomalies — fee spikes, CTR collapses and external campaign changes appear here.</div>
          ) : (
            <div className="dash-alerts">
              {anomalies.map((a, i) => (
                <div key={i} className="dash-alert">
                  <span className={`dash-sev--${a.severity === 'CRITICAL' ? 'high' : 'medium'}`} />
                  <span className={`dash-atype--${a.type}`}>{a.type.replace(/_/g, ' ')}</span>
                  <span className="dash-amsg">{a.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="dash-card">
          <div className="dash-card-h"><span>Status</span></div>
          <div className="eb-headstats" style={{ padding: '4px 2px' }}>
            {s && Object.entries(s.campaignCounts).map(([k, v]) => (
              <div key={k}><span className="k">{k}</span><span className="v">{v}</span></div>
            ))}
            {s?.coverage && (
              <div title="Live listings promoted in ≥1 active General campaign — the coverage guard proposes enrollment for the rest">
                <span className="k">Ad coverage</span>
                <span className="v" style={{ color: (s.coverage.pct ?? 0) >= 90 ? '#12855f' : '#b87503' }}>{s.coverage.pct != null ? `${s.coverage.pct}%` : '—'} <span style={{ fontSize: 11, fontWeight: 500, color: '#8a93a1' }}>({s.coverage.promoted}/{s.coverage.liveListings})</span></span>
              </div>
            )}
            <div><span className="k">Attribution</span><span className="v" style={{ fontSize: 13 }}>any-click (30d)</span></div>
            <div><span className="k">Facts as of</span><span className="v" style={{ fontSize: 13 }}>{s?.freshness.factsReportedAt ? new Date(s.freshness.factsReportedAt).toLocaleString('en-GB') : '—'}</span></div>
            <div><span className="k">Entities as of</span><span className="v" style={{ fontSize: 13 }}>{s?.freshness.entitySyncAt ? new Date(s.freshness.entitySyncAt).toLocaleString('en-GB') : '—'}</span></div>
          </div>
        </div>
      </div>
    </div>
  )
}
