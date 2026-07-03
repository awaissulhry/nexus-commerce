'use client'

/**
 * ER3.3 — dashboard shell (C1: file-per-card in _dash/): header with the real
 * DateRangePicker (D1/X3) driving KPIs + trend together, banners, KPI strip,
 * trend card with metric views, then Recommendations · Pacing · Alerts ·
 * Status. Amazon's dashboard.css is consumed, never edited (eb-dash-* styles
 * live in ebay.css).
 */
import { useEffect, useState } from 'react'
import { AdsPageHeader } from '../_shell/AdsPageHeader'
import '../dashboard/dashboard.css'
import './ebay.css'
import {
  useEbayAdsFetch, getEbayAds, EBAY_MARKETS, useWriteMode,
  type SummaryPayload, type TrendPayload, type DashboardPayload, type AnomalyRow,
} from './_lib'
import { KpiStrip } from './_dash/KpiStrip'
import { TrendCard } from './_dash/TrendCard'
import { RecommendationsCard } from './_dash/RecommendationsCard'
import { PacingCard } from './_dash/PacingCard'
import { AlertsCard } from './_dash/AlertsCard'
import { StatusCard } from './_dash/StatusCard'

// matches AdsPageHeader's built-in DateRangePicker default (last 7 days)
const headerDefaultRange = () => { const e = new Date(); e.setHours(0, 0, 0, 0); const s = new Date(e); s.setDate(s.getDate() - 6); return { start: s, end: e } }

export function EbayDashboard() {
  const [market, setMarket] = useState('all')
  const [range, setRange] = useState(headerDefaultRange)
  const summary = useEbayAdsFetch<SummaryPayload>('/summary', market, range)
  const trend = useEbayAdsFetch<TrendPayload>('/trend', market, range)
  const writeMode = useWriteMode()
  const [dash, setDash] = useState<DashboardPayload | null>(null)
  const [anomalies, setAnomalies] = useState<AnomalyRow[]>([])
  useEffect(() => {
    getEbayAds<DashboardPayload>('/dashboard').then(setDash).catch(() => {})
    getEbayAds<{ anomalies: AnomalyRow[] }>('/automation/anomalies').then((j) => setAnomalies(j.anomalies ?? [])).catch(() => {})
  }, [])

  const s = summary.data
  const missingCogs = s?.economicsStatus?.MISSING_COGS ?? 0
  const campaignsTotal = s ? Object.values(s.campaignCounts).reduce((a, b) => a + b, 0) : 0

  return (
    <div className="dash">
      <AdsPageHeader
        channel="ebay"
        title="eBay Advertising"
        subtitle="Promoted Listings — General (cost-per-sale) + Priority (cost-per-click). All sales figures are any-click attributed."
        markets={EBAY_MARKETS.map((m) => m.id)}
        market={market}
        onMarketChange={setMarket}
        showLearn={false} showDataSync={false}
        showDateRange onDateRange={(start, end) => setRange({ start, end })}
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

      <KpiStrip s={s} trend={trend.data} campaignsTotal={campaignsTotal} />
      <TrendCard trend={trend.data} loading={trend.loading} />

      <div className="dash-row2">
        <RecommendationsCard recs={dash?.recommendations ?? null} />
        <PacingCard pacing={dash?.pacing ?? null} />
      </div>
      <div className="dash-row2">
        <AlertsCard anomalies={anomalies} />
        <StatusCard s={s} />
      </div>
    </div>
  )
}
