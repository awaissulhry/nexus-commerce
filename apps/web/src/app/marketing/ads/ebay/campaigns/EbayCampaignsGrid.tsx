'use client'

/**
 * E3 — eBay campaign grid: strategy/status facets, window metrics per
 * campaign, rate/budget at a glance, STALE-ad counts, row → detail.
 */
import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Download, Upload } from 'lucide-react'
import { AdsPageHeader } from '../../_shell/AdsPageHeader'
import { Button } from '@/design-system/primitives/Button'
import { getBackendUrl } from '@/lib/backend-url'
import { ImportCsvModal } from '../_write-modals'
import { useWriteMode, SandboxBanner } from '../_shared'
import { DataGrid, type Column } from '@/design-system/components/DataGrid'
import { SegmentedControl } from '@/design-system/primitives/SegmentedControl'
import { Select } from '@/design-system/primitives/Select'
import { Banner } from '@/design-system/components/Banner'
import { EmptyState } from '@/design-system/components/EmptyState'
import { Skeleton } from '@/design-system/primitives/Skeleton'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import '../ebay.css'
import {
  useEbayAdsFetch, EBAY_MARKETS, PRESETS, eurC, pctP, intlN,
  FreshnessLine, StrategyChip, StatusChip, type CampaignRow,
} from '../_shared'

type CampaignsPayload = {
  window: { since: string; until: string }
  campaigns: CampaignRow[]
  freshness: { factsReportedAt: string | null; entitySyncAt: string | null; listingSeenAt: string | null }
}

const STRATEGY_TABS = [
  { value: 'all', label: 'All' },
  { value: 'COST_PER_SALE', label: 'General' },
  { value: 'COST_PER_CLICK', label: 'Priority' },
  { value: 'OFF_SITE', label: 'Offsite' },
]

export function EbayCampaignsGrid() {
  const router = useRouter()
  const [market, setMarket] = useState('all')
  const [preset, setPreset] = useState('last30')
  const [strategy, setStrategy] = useState('all')
  const [status, setStatus] = useState('all')
  const [importOpen, setImportOpen] = useState(false)
  const writeMode = useWriteMode()
  const { data, error, loading, reload } = useEbayAdsFetch<CampaignsPayload>('/campaigns', market, preset)

  const rows = useMemo(() => {
    let out = data?.campaigns ?? []
    if (strategy === 'OFF_SITE') out = out.filter((c) => c.channels.includes('OFF_SITE'))
    else if (strategy !== 'all') out = out.filter((c) => c.fundingModel === strategy && !c.channels.includes('OFF_SITE'))
    if (status !== 'all') out = out.filter((c) => c.status === status)
    return out
  }, [data, strategy, status])

  const columns: Column<CampaignRow>[] = useMemo(() => [
    {
      key: 'name', label: 'Campaign', sticky: true, width: 280, sortable: true, sortValue: (r) => r.name,
      render: (r) => (
        <div className="eb-cell-name">
          <span className="nm">{r.name}</span>
          <span className="sub">
            {r.externalCampaignId} · {r.marketplace}
            {r.isRulesBased && <span className="eb-chip eb-chip--rules" title="Rules-based: eBay auto-adds/removes matching listings daily">rules</span>}
            {r.nexusManaged && <span className="eb-chip eb-chip--nexus">Nexus</span>}
          </span>
        </div>
      ),
    },
    { key: 'strategy', label: 'Strategy', width: 130, render: (r) => <StrategyChip fundingModel={r.fundingModel} targetingType={r.targetingType} channels={r.channels} /> },
    { key: 'status', label: 'Status', width: 100, sortable: true, sortValue: (r) => r.status, render: (r) => <StatusChip status={r.status} /> },
    {
      key: 'rate', label: 'Rate / Budget', align: 'right', width: 130, render: (r) =>
        r.fundingModel === 'COST_PER_SALE'
          ? <span title={r.adRateStrategy === 'DYNAMIC' ? 'Dynamic — follows eBay suggested rate under your cap' : 'Fixed campaign default; ad-level rates override'}>{r.bidPercentage != null ? `${r.bidPercentage}%` : 'per-ad'}{r.adRateStrategy === 'DYNAMIC' ? ' · dyn' : ''}</span>
          : <span>{r.dailyBudgetCents != null ? `${eurC(r.dailyBudgetCents)}/day` : '—'}</span>,
    },
    { key: 'ads', label: 'Ads', align: 'right', width: 80, sortable: true, sortValue: (r) => r.ads.total, render: (r) => <span>{r.ads.total}{r.ads.stale > 0 && <span className="eb-chip eb-chip--stale" title="Ads pointing at listings that are no longer live">{r.ads.stale} stale</span>}</span> },
    { key: 'impressions', label: 'Impr.', align: 'right', width: 90, sortable: true, sortValue: (r) => r.metrics.impressions, render: (r) => intlN(r.metrics.impressions) },
    { key: 'clicks', label: 'Clicks', align: 'right', width: 80, sortable: true, sortValue: (r) => r.metrics.clicks, render: (r) => intlN(r.metrics.clicks) },
    { key: 'ctr', label: 'CTR', align: 'right', width: 80, render: (r) => pctP(r.metrics.ctrPct, 2) },
    { key: 'fees', label: 'Ad fees', align: 'right', width: 100, sortable: true, sortValue: (r) => r.metrics.adFeesCents, render: (r) => eurC(r.metrics.adFeesCents) },
    { key: 'sales', label: 'Ad sales', align: 'right', width: 110, sortable: true, sortValue: (r) => r.metrics.salesCents, render: (r) => eurC(r.metrics.salesCents) },
    { key: 'acos', label: 'eBay ACOS', align: 'right', width: 100, sortable: true, sortValue: (r) => r.metrics.acosPct ?? -1, render: (r) => pctP(r.metrics.acosPct) },
    { key: 'sold', label: 'Sold', align: 'right', width: 70, sortable: true, sortValue: (r) => r.metrics.soldQty, render: (r) => intlN(r.metrics.soldQty) },
    {
      key: 'open', label: '', stickyRight: true, width: 70,
      render: (r) => <button className="eb-linkbtn" onClick={() => router.push(`/marketing/ads/ebay/campaigns/${r.id}`)}>Open</button>,
    },
  ], [router])

  return (
    <div className="eb-page">
      <AdsPageHeader
        title="eBay Campaigns"
        subtitle="All Promoted Listings campaigns — Seller-Hub-created and Nexus-managed — with window performance."
        markets={EBAY_MARKETS.map((m) => m.id)}
        market={market}
        onMarketChange={setMarket}
      />

      <div className="eb-controls">
        <SegmentedControl options={STRATEGY_TABS} value={strategy} onChange={setStrategy} aria-label="Strategy filter" />
        <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status filter">
          <option value="all">All statuses</option>
          <option value="RUNNING">Running</option>
          <option value="PAUSED">Paused</option>
          <option value="ENDED">Ended</option>
        </Select>
        <Select value={preset} onChange={(e) => setPreset(e.target.value)} aria-label="Date range">
          {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </Select>
        <Button onClick={() => router.push('/marketing/ads/ebay/campaigns/new')}><Plus size={14} aria-hidden /> New campaign</Button>
        <Button variant="ghost" onClick={() => { window.location.href = `${getBackendUrl()}/api/ebay-ads/export.csv` }}><Download size={13} aria-hidden /> Export CSV</Button>
        <Button variant="ghost" onClick={() => setImportOpen(true)}><Upload size={13} aria-hidden /> Import CSV</Button>
        <FreshnessLine f={data?.freshness} />
      </div>
      <SandboxBanner mode={writeMode} />
      <ImportCsvModal open={importOpen} onClose={() => setImportOpen(false)} onDone={reload} />

      {error && (
        <Banner tone="danger" title="Couldn't load campaigns">{error} — <button className="eb-linkbtn" onClick={reload}>retry</button></Banner>
      )}

      {loading ? (
        <Skeleton height={420} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No campaigns match these filters"
          description={data?.campaigns.length ? 'Clear the strategy/status filters to see all synced campaigns.' : 'Campaigns sync hourly from eBay. Trigger ebay-ads-entity-sync in /sync-logs to pull now.'}
        />
      ) : (
        <DataGrid<CampaignRow>
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          initialSort={{ key: 'fees', dir: 'desc' }}
          maxHeight="calc(100vh - 320px)"
        />
      )}
    </div>
  )
}
