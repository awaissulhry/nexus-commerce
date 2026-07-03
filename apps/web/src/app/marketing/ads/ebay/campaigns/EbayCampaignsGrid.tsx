'use client'

/**
 * E6.1 — eBay Ad Manager, visually 1:1 with the Amazon Ad Manager idiom:
 * AdsDataGrid engine (shared, imported — Amazon files untouched), .nmw name
 * cell with hover-reveal .h10-open, h10-pill statuses with the pause/enable
 * chevron menu, pinned totals, Customize/Export toolbar, keyboard nav.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ExternalLink, ChevronDown, Plus, Download, Upload } from 'lucide-react'
import { AdsPageHeader } from '../../_shell/AdsPageHeader'
import { AdsDataGrid, type GridColumn, type GridFilter } from '../../campaigns/_grid/AdsDataGrid'
import { eur, int, pct, latestReportLabel, METRIC_TIPS } from '../../campaigns/_grid/format'
import { getBackendUrl } from '@/lib/backend-url'
import '../ebay.css'
import {
  useEbayAdsFetch, postEbayAds, EBAY_MARKETS, PRESETS,
  useWriteMode, SandboxBanner, EBAY_STATUS_PILL, type CampaignRow,
} from '../_lib'
import { ImportCsvModal } from '../_modals/ImportCsvModal'

type CampaignsPayload = {
  window: { since: string; until: string }
  campaigns: CampaignRow[]
  freshness: { factsReportedAt: string | null; entitySyncAt: string | null; listingSeenAt: string | null }
}

const strategyBadge = (c: CampaignRow) => (c.channels.includes('OFF_SITE') ? 'OFF' : c.fundingModel === 'COST_PER_CLICK' ? 'PRI' : 'GEN')
const strategyLabel = (c: CampaignRow) => (c.channels.includes('OFF_SITE') ? 'Offsite' : c.fundingModel === 'COST_PER_CLICK' ? (c.targetingType === 'SMART' ? 'Priority · Smart' : 'Priority') : 'General')

function StatusCell({ c, onAction }: { c: CampaignRow; onAction: (id: string, action: 'pause' | 'resume' | 'end') => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  const sp = EBAY_STATUS_PILL[c.status] ?? { label: c.status, cls: '' }
  const can = (a: string) => (a === 'pause' ? c.status === 'RUNNING' : a === 'resume' ? c.status === 'PAUSED' || c.status === 'DRAFT' : c.status !== 'ENDED')
  return (
    // eb-statusrel/eb-statusfix: keep the menu OUT of normal flow (absolute)
    // so an open dropdown never grows the row height. Scoped classes — never
    // restyles the Amazon pages.
    <span className="h10-statuscell eb-statusrel" ref={ref}>
      <span className={`h10-pill ${sp.cls}`}>{sp.label}</span>
      {c.status !== 'ENDED' && (
        <button type="button" className="ch" aria-label="Change status" onClick={(e) => { e.stopPropagation(); setOpen((o) => !o) }}>
          <ChevronDown size={13} />
        </button>
      )}
      {open && (
        <span className="h10-statusmenu eb-statusfix" onClick={(e) => e.stopPropagation()}>
          {can('resume') && <button type="button" onClick={() => { setOpen(false); onAction(c.id, 'resume') }}>{c.status === 'DRAFT' ? 'Activate' : 'Enable'}</button>}
          {can('pause') && <button type="button" onClick={() => { setOpen(false); onAction(c.id, 'pause') }}>Pause</button>}
          {can('end') && <button type="button" onClick={() => { setOpen(false); onAction(c.id, 'end') }}>End</button>}
        </span>
      )}
    </span>
  )
}

export function EbayCampaignsGrid() {
  const router = useRouter()
  const [market, setMarket] = useState('all')
  const [preset, setPreset] = useState('last30')
  const [importOpen, setImportOpen] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const writeMode = useWriteMode()
  const { data, error, loading, reload } = useEbayAdsFetch<CampaignsPayload>('/campaigns', market, preset)
  const rows = data?.campaigns ?? []

  const onAction = useCallback(async (id: string, action: 'pause' | 'resume' | 'end') => {
    if (action === 'end' && !window.confirm('End this campaign? Ended campaigns cannot be resumed (clone instead).')) return
    try {
      const out = await postEbayAds<{ status: string; mode: string }>(`/campaigns/${id}/action`, { action })
      setToast(`${action} ✓ → ${out.status} (${out.mode})`)
      reload()
    } catch (e) { setToast((e as Error).message) }
  }, [reload])

  const m = (c: CampaignRow) => c.metrics
  const columns: GridColumn<CampaignRow>[] = useMemo(() => [
    { key: 'status', label: 'Status', metric: false, sortValue: (c) => c.status, render: (c) => <StatusCell c={c} onAction={onAction} /> },
    {
      key: 'rate', label: 'Rate / Budget', metric: false, sortable: false,
      render: (c) => c.fundingModel === 'COST_PER_SALE'
        ? <span title={c.adRateStrategy === 'DYNAMIC' ? 'Dynamic — follows eBay suggested rate under your cap' : 'Fixed campaign default; ad-level rates override'}>{c.bidPercentage != null ? `${c.bidPercentage}%` : 'per-ad'}{c.adRateStrategy === 'DYNAMIC' ? ' · dyn' : ''}</span>
        : <span>{c.dailyBudgetCents != null ? `${eur(c.dailyBudgetCents / 100)}/day` : '—'}</span>,
    },
    {
      key: 'ads', label: 'Ads', metric: false, sortValue: (c) => c.ads.total,
      render: (c) => <span>{c.ads.total}{c.ads.stale > 0 && <span className="h10-pill warn" style={{ marginLeft: 6 }} title="Ads pointing at listings no longer live">{c.ads.stale} stale</span>}</span>,
    },
    { key: 'impressions', label: 'Impressions', tip: METRIC_TIPS.impressions, render: (c) => int(m(c).impressions), sortValue: (c) => m(c).impressions, filterValue: (c) => m(c).impressions, total: int(rows.reduce((a, c) => a + m(c).impressions, 0)) },
    { key: 'clicks', label: 'Clicks', tip: METRIC_TIPS.clicks, render: (c) => int(m(c).clicks), sortValue: (c) => m(c).clicks, filterValue: (c) => m(c).clicks, total: int(rows.reduce((a, c) => a + m(c).clicks, 0)) },
    { key: 'ctr', label: 'CTR', tip: METRIC_TIPS.ctr, render: (c) => (m(c).ctrPct != null ? pct(m(c).ctrPct! / 100) : '—'), sortValue: (c) => m(c).ctrPct ?? -1 },
    { key: 'spend', label: 'Ad Fees', tip: 'Attributed eBay ad fees (any-click) in the selected window.', render: (c) => eur(m(c).adFeesCents / 100), sortValue: (c) => m(c).adFeesCents, filterValue: (c) => m(c).adFeesCents / 100, total: eur(rows.reduce((a, c) => a + m(c).adFeesCents, 0) / 100) },
    { key: 'sales', label: 'Ad Sales', tip: 'Any-click attributed sales: any buyer purchase within 30 days of any click on the ad.', render: (c) => eur(m(c).salesCents / 100), sortValue: (c) => m(c).salesCents, filterValue: (c) => m(c).salesCents / 100, total: eur(rows.reduce((a, c) => a + m(c).salesCents, 0) / 100) },
    {
      key: 'acos', label: 'eBay ACOS', tip: 'Ad fees ÷ any-click attributed sales.',
      render: (c) => (m(c).acosPct != null ? pct(m(c).acosPct! / 100) : '—'), sortValue: (c) => m(c).acosPct ?? -1, filterValue: (c) => m(c).acosPct ?? 0,
      total: (() => { const f = rows.reduce((a, c) => a + m(c).adFeesCents, 0); const s = rows.reduce((a, c) => a + m(c).salesCents, 0); return s > 0 ? pct(f / s) : '—' })(),
    },
    { key: 'sold', label: 'Sold', render: (c) => int(m(c).soldQty), sortValue: (c) => m(c).soldQty, total: int(rows.reduce((a, c) => a + m(c).soldQty, 0)) },
  ], [rows, onAction])

  const filters: GridFilter[] = useMemo(() => [
    { key: 'strategy', label: 'Strategy', kind: 'select', options: [{ value: 'GEN', label: 'General' }, { value: 'PRI', label: 'Priority' }, { value: 'OFF', label: 'Offsite' }], placeholder: 'All strategies', value: (c) => strategyBadge(c as CampaignRow) },
    { key: 'status', label: 'Status', kind: 'select', options: [{ value: 'RUNNING', label: 'Enabled' }, { value: 'PAUSED', label: 'Paused' }, { value: 'ENDED', label: 'Ended' }, { value: 'DRAFT', label: 'Draft' }], placeholder: 'All statuses', value: (c) => (c as CampaignRow).status },
    { key: 'spend', label: 'Ad Fees', kind: 'range', unit: '€' },
    { key: 'sales', label: 'Ad Sales', kind: 'range', unit: '€' },
    { key: 'clicks', label: 'Clicks', kind: 'range' },
    { key: 'impressions', label: 'Impressions', kind: 'range' },
  ], [])

  return (
    <div className="h10-am">
      <AdsPageHeader
        title="eBay Ad Manager"
        subtitle="Promoted Listings — General (cost-per-sale) and Priority (cost-per-click), Seller-Hub-created and Nexus-managed."
        markets={EBAY_MARKETS.map((x) => x.id)}
        market={market}
        onMarketChange={setMarket}
        showLearn={false} showDataSync={false} showDateRange={false}
      />
      <SandboxBanner mode={writeMode} />
      {error && <div className="h10-am-latest" role="alert"><b>Load failed:</b> {error} · <button className="h10-am-link" onClick={reload}>Retry</button></div>}

      <AdsDataGrid<CampaignRow>
        rows={rows}
        loading={loading}
        rowId={(c) => c.id}
        noun="Campaign"
        firstColLabel="Campaign"
        renderFirst={(c) => (
          <div className="nmw">
            <span className="pb" data-p={strategyBadge(c)} title={strategyLabel(c)}>{strategyBadge(c)}</span>
            <span className="t" title={c.name} onClick={() => router.push(`/marketing/ads/ebay/campaigns/${c.id}`)}>{c.name}</span>
            <span className="mk">{c.marketplace.replace('EBAY_', '')}</span>
            {c.isRulesBased && <span className="mk" title="Rules-based: eBay auto-adds/removes matching listings daily">rules</span>}
            {c.nexusManaged && <span className="mk" title="Created by Nexus">nexus</span>}
            <a className="h10-open" href={`/marketing/ads/ebay/campaigns/${c.id}`} onClick={(e) => e.stopPropagation()}><ExternalLink size={11} /> Open</a>
          </div>
        )}
        firstSortValue={(c) => c.name.toLowerCase()}
        columns={columns}
        filters={filters}
        filtersDefaultOpen={false}
        searchable
        searchPlaceholder="Search campaigns…"
        searchValue={(c) => `${c.name} ${c.externalCampaignId}`}
        showTotal
        defaultSort={{ key: 'spend', dir: 'desc' }}
        storageKey="h10-ebay-campaigns-cols"
        exportable
        onExport={() => { window.location.href = `${getBackendUrl()}/api/ebay-ads/export.csv` }}
        reportLabel={latestReportLabel([data?.freshness.factsReportedAt ?? null])}
        onRowClick={(c) => router.push(`/marketing/ads/ebay/campaigns/${c.id}`)}
        keyboardNav
        toolbarLeft={
          <select className="h10-am-btn" value={preset} onChange={(e) => setPreset(e.target.value)} aria-label="Date range" style={{ paddingRight: 8 }}>
            {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        }
        toolbarRight={
          <>
            <button type="button" className="h10-am-btn" onClick={() => setImportOpen(true)}><Upload size={13} /> Import CSV</button>
            <button type="button" className="h10-am-btn" onClick={() => { window.location.href = `${getBackendUrl()}/api/ebay-ads/export.csv` }}><Download size={13} /> Export Data</button>
            <button type="button" className="h10-am-btn primary" onClick={() => router.push('/marketing/ads/ebay/campaigns/new')}><Plus size={13} /> Campaign</button>
          </>
        }
      />

      <ImportCsvModal open={importOpen} onClose={() => setImportOpen(false)} onDone={reload} />
      {toast && <div className="h10-am-toast" role="status" onAnimationEnd={() => setToast(null)}>{toast}</div>}
    </div>
  )
}
