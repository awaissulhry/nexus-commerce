'use client'

/**
 * ER3.1 — eBay Ad Manager polish (SPEC-er3-ad-manager, all 10 deltas):
 * one Export button (grid built-in) · Automation column (rules count +
 * Protected + posture) · "Limited by budget" derived status · DateRangePicker
 * (D1) · Filter Library (filterPresetsKey) · row menu gains Clone/Budget +
 * consequence-stating End (last window.confirm gone) · self-explanatory
 * Rate/Budget column (money(), C7) · ACOS/ROAS naming (D2) · OOS-hidden ads
 * in the Ads tooltip · live Data Sync header button.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { ExternalLink, ChevronDown, Plus, Upload, Cog } from 'lucide-react'
import { AdsPageHeader } from '../../_shell/AdsPageHeader'
import { DateRangePicker } from '../../_shell/DateRangePicker'
import { AdsDataGrid, type GridColumn, type GridFilter } from '../../campaigns/_grid/AdsDataGrid'
import { int, pct, money, latestReportLabel, METRIC_TIPS } from '../../campaigns/_grid/format'
import { getBackendUrl } from '@/lib/backend-url'
import '../ebay.css'
import {
  useEbayAdsFetch, postEbayAds, EBAY_MARKETS, mapMetrics,
  useWriteMode, SandboxBanner, type CampaignRow,
} from '../_lib'
import { ebayStatusPill } from '../_lib/status'
import { StatusPill } from '../../_shared/StatusPill'
import { ImportCsvModal } from '../_modals/ImportCsvModal'
import { CloneModal } from './[id]/modals/CloneModal'
import { EndCampaignModal } from './[id]/modals/EndCampaignModal'
import { GridBudgetModal } from './GridBudgetModal'

type CampaignsPayload = {
  window: { since: string; until: string }
  campaigns: CampaignRow[]
  freshness: { factsReportedAt: string | null; entitySyncAt: string | null; listingSeenAt: string | null }
}

const strategyBadge = (c: CampaignRow) => (c.channels.includes('OFF_SITE') ? 'OFF' : c.fundingModel === 'COST_PER_CLICK' ? 'PRI' : 'GEN')
const strategyLabel = (c: CampaignRow) => (c.channels.includes('OFF_SITE') ? 'Offsite' : c.fundingModel === 'COST_PER_CLICK' ? (c.targetingType === 'SMART' ? 'Priority · Smart' : 'Priority') : 'General')

const defaultRange = () => { const e = new Date(); e.setHours(0, 0, 0, 0); const s = new Date(e); s.setDate(s.getDate() - 29); return { start: s, end: e } }

function StatusCell({ c, onAction, onMenu }: {
  c: CampaignRow
  onAction: (id: string, action: 'pause' | 'resume') => void
  onMenu: (c: CampaignRow, item: 'clone' | 'budget' | 'end') => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  const sp = ebayStatusPill(c.status)
  return (
    // eb-statusrel/eb-statusfix: keep the menu OUT of normal flow (absolute)
    // so an open dropdown never grows the row height.
    <span className="h10-statuscell eb-statusrel" ref={ref}>
      <StatusPill label={sp.label} cls={sp.cls} />
      {c.limitedByBudget && (
        <StatusPill label="Limited by budget" cls="warn" title="Spent ≥90% of the daily budget yesterday — eBay caps delivery when budget runs out; consider raising it (heuristic from yesterday's fees)." />
      )}
      {c.status !== 'ENDED' && (
        <button type="button" className="ch" aria-label="Campaign actions" onClick={(e) => { e.stopPropagation(); setOpen((o) => !o) }}>
          <ChevronDown size={13} />
        </button>
      )}
      {open && (
        <span className="h10-statusmenu eb-statusfix" onClick={(e) => e.stopPropagation()}>
          {(c.status === 'PAUSED' || c.status === 'DRAFT') && <button type="button" onClick={() => { setOpen(false); onAction(c.id, 'resume') }}>{c.status === 'DRAFT' ? 'Activate' : 'Enable'}</button>}
          {c.status === 'RUNNING' && <button type="button" onClick={() => { setOpen(false); onAction(c.id, 'pause') }}>Pause</button>}
          {c.fundingModel === 'COST_PER_CLICK' && <button type="button" onClick={() => { setOpen(false); onMenu(c, 'budget') }}>Budget…</button>}
          <button type="button" onClick={() => { setOpen(false); onMenu(c, 'clone') }}>Clone…</button>
          <button type="button" className="danger" onClick={() => { setOpen(false); onMenu(c, 'end') }}>End…</button>
        </span>
      )}
    </span>
  )
}

export function EbayCampaignsGrid() {
  const router = useRouter()
  // ER3.3 — dashboard deep link (?status=LIMITED) seeds the grid filter
  const statusParam = useSearchParams().get('status')
  const [market, setMarket] = useState('all')
  const [dateRange, setDateRange] = useState(defaultRange)
  const [importOpen, setImportOpen] = useState(false)
  const [modal, setModal] = useState<{ kind: 'clone' | 'budget' | 'end'; c: CampaignRow } | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const writeMode = useWriteMode()
  const { data, error, loading, reload } = useEbayAdsFetch<CampaignsPayload>('/campaigns', market, dateRange)
  const rows = data?.campaigns ?? []
  const say = useCallback((m: string) => { setToast(m); setTimeout(() => setToast(null), 5000) }, [])

  const onAction = useCallback(async (id: string, action: 'pause' | 'resume') => {
    try {
      const out = await postEbayAds<{ status: string; mode: string }>(`/campaigns/${id}/action`, { action })
      say(`${action} ✓ → ${out.status} (${out.mode})`)
      reload()
    } catch (e) { say((e as Error).message) }
  }, [reload, say])

  const dataSync = useCallback(async () => {
    setSyncing(true)
    try {
      const out = await postEbayAds<{ report: { campaigns?: number; ads?: number } }>('/sync', {})
      say(`entities synced · ${out.report.campaigns ?? '?'} campaign(s), ${out.report.ads ?? '?'} ad(s)`)
      reload()
    } catch (e) { say(`sync failed: ${(e as Error).message}`) } finally { setSyncing(false) }
  }, [reload, say])

  const um = (c: CampaignRow) => mapMetrics(c.metrics)
  const totSpend = rows.reduce((a, c) => a + um(c).spendCents, 0)
  const totSales = rows.reduce((a, c) => a + um(c).salesCents, 0)
  const columns: GridColumn<CampaignRow>[] = useMemo(() => [
    { key: 'status', label: 'Status', metric: false, sortValue: (c) => (c.limitedByBudget ? 'LIMITED' : c.status), render: (c) => <StatusCell c={c} onAction={onAction} onMenu={(cc, kind) => setModal({ kind, c: cc })} /> },
    {
      key: 'rate', label: 'Rate / Budget', metric: false, sortable: false,
      tip: 'General campaigns: a % rate — "per-ad" means each ad carries its own (open the Ads tab); "· dyn" follows eBay\'s daily suggestion under a cap. Priority/Offsite: the daily budget.',
      render: (c) => c.fundingModel === 'COST_PER_SALE'
        ? <span title={c.adRateStrategy === 'DYNAMIC' ? "DYNAMIC — follows eBay's suggested rate under your cap (Floor Watch alerts above it)" : c.bidPercentage != null ? 'Fixed campaign-level rate' : 'Rates live per ad — open the campaign\'s Ads tab'}>{c.bidPercentage != null ? `${c.bidPercentage}%` : 'per-ad'}{c.adRateStrategy === 'DYNAMIC' ? ' · dyn' : ''}</span>
        : <span title="Daily budget (eBay may spend up to 2× in a day; monthly cap = 30.4× daily)">{c.dailyBudgetCents != null ? `${money(c.dailyBudgetCents, c.budgetCurrency)}/day` : '—'}</span>,
    },
    {
      key: 'ads', label: 'Ads', metric: false, sortValue: (c) => c.ads.total,
      render: (c) => (
        <span title={(c.ads.hidden ?? 0) > 0 ? `${c.ads.hidden} hidden — out of stock (eBay resurfaces them on restock)` : undefined}>
          {c.ads.total}
          {c.ads.stale > 0 && <span className="h10-pill warn" style={{ marginLeft: 6 }} title="Ads pointing at listings no longer live">{c.ads.stale} stale</span>}
          {(c.ads.hidden ?? 0) > 0 && <span className="h10-pill arch" style={{ marginLeft: 6 }} title="Auto-hidden by eBay — out of stock; a state, not an error">{c.ads.hidden} hidden</span>}
        </span>
      ),
    },
    {
      key: 'auto', label: 'Automation', metric: false, sortValue: (c) => c.automation?.rules ?? 0,
      tip: 'Rules that apply to this campaign + its automation policy. Click through to the campaign\'s Automation tab.',
      render: (c) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <button type="button" className="h10-am-link" style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }} title={`${c.automation?.rules ?? 0} rule(s) apply — open Automation tab`}
            onClick={(e) => { e.stopPropagation(); router.push(`/marketing/ads/ebay/campaigns/${c.id}?tab=automation`) }}>
            <Cog size={12} /> {c.automation?.rules ?? 0}
          </button>
          {c.automation?.protected && <StatusPill label="Protected" cls="warn" title="Excluded from ALL automation" />}
          {c.automation && c.automation.posture !== 'INHERIT' && !c.automation.protected && <StatusPill label={c.automation.posture.toLowerCase()} cls="arch" title="Per-campaign posture override" />}
        </span>
      ),
    },
    { key: 'impressions', label: 'Impressions', tip: METRIC_TIPS.impressions, render: (c) => int(um(c).impressions), sortValue: (c) => um(c).impressions, filterValue: (c) => um(c).impressions, total: int(rows.reduce((a, c) => a + um(c).impressions, 0)) },
    { key: 'clicks', label: 'Clicks', tip: METRIC_TIPS.clicks, render: (c) => int(um(c).clicks), sortValue: (c) => um(c).clicks, filterValue: (c) => um(c).clicks, total: int(rows.reduce((a, c) => a + um(c).clicks, 0)) },
    { key: 'ctr', label: 'CTR', tip: METRIC_TIPS.ctr, render: (c) => (um(c).ctr != null ? pct(um(c).ctr! / 100) : '—'), sortValue: (c) => um(c).ctr ?? -1 },
    { key: 'spend', label: 'Ad Fees', tip: 'Attributed eBay ad fees (any-click) in the selected window.', render: (c) => money(um(c).spendCents, c.budgetCurrency), sortValue: (c) => um(c).spendCents, filterValue: (c) => um(c).spendCents / 100, total: money(totSpend) },
    { key: 'sales', label: 'Ad Sales', tip: 'Any-click attributed sales: any buyer purchase within 30 days of any click on the ad.', render: (c) => money(um(c).salesCents, c.budgetCurrency), sortValue: (c) => um(c).salesCents, filterValue: (c) => um(c).salesCents / 100, total: money(totSales) },
    {
      key: 'acos', label: 'ACOS', tip: 'Ad fees ÷ any-click attributed sales. Post-any-click this trends high by construction — judge vs break-even.',
      render: (c) => (um(c).acos != null ? pct(um(c).acos! / 100) : '—'), sortValue: (c) => um(c).acos ?? -1, filterValue: (c) => um(c).acos ?? 0,
      total: totSales > 0 ? pct(totSpend / totSales) : '—',
    },
    {
      key: 'roas', label: 'ROAS', tip: 'Attributed sales ÷ ad fees.',
      render: (c) => (um(c).roas != null ? um(c).roas!.toFixed(2) : '—'), sortValue: (c) => um(c).roas ?? -1,
      total: totSpend > 0 ? (totSales / totSpend).toFixed(2) : '—',
    },
    { key: 'sold', label: 'Sold', render: (c) => int(um(c).sold), sortValue: (c) => um(c).sold, total: int(rows.reduce((a, c) => a + um(c).sold, 0)) },
  ], [rows, onAction, router, totSpend, totSales])

  const filters: GridFilter[] = useMemo(() => [
    { key: 'strategy', label: 'Strategy', kind: 'select', options: [{ value: 'GEN', label: 'General' }, { value: 'PRI', label: 'Priority' }, { value: 'OFF', label: 'Offsite' }], placeholder: 'All strategies', value: (c) => strategyBadge(c as CampaignRow) },
    {
      key: 'status', label: 'Status', kind: 'select',
      options: [{ value: 'RUNNING', label: 'Enabled' }, { value: 'LIMITED', label: 'Limited by budget' }, { value: 'PAUSED', label: 'Paused' }, { value: 'ENDED', label: 'Ended' }, { value: 'DRAFT', label: 'Draft' }],
      placeholder: 'All statuses',
      value: (c) => ((c as CampaignRow).limitedByBudget ? 'LIMITED' : (c as CampaignRow).status),
    },
    { key: 'spend', label: 'Ad Fees', kind: 'range', unit: '€' },
    { key: 'sales', label: 'Ad Sales', kind: 'range', unit: '€' },
    { key: 'clicks', label: 'Clicks', kind: 'range' },
    { key: 'impressions', label: 'Impressions', kind: 'range' },
  ], [])

  return (
    <div className="h10-am">
      <AdsPageHeader
        channel="ebay"
        title="eBay Ad Manager"
        subtitle="Promoted Listings — General (cost-per-sale) and Priority (cost-per-click), Seller-Hub-created and Nexus-managed."
        markets={EBAY_MARKETS.map((x) => x.id)}
        market={market}
        onMarketChange={setMarket}
        showLearn={false} showDateRange={false}
        onDataSync={() => void dataSync()} syncing={syncing}
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
            {c.nexusManaged && <span className="mk" title="Created and managed by Nexus — full audit trail on the Activity tab">nexus</span>}
            <a className="h10-open" href={`/marketing/ads/ebay/campaigns/${c.id}`} onClick={(e) => e.stopPropagation()}><ExternalLink size={11} /> Open</a>
          </div>
        )}
        firstSortValue={(c) => c.name.toLowerCase()}
        columns={columns}
        filters={filters}
        filtersDefaultOpen={false}
        filterPresetsKey="er3-ebay-campaigns"
        initialFilters={statusParam ? { status: [statusParam] } : undefined}
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
        toolbarLeft={<DateRangePicker value={dateRange} onChange={(start, end) => setDateRange({ start, end })} />}
        toolbarRight={
          <>
            <button type="button" className="h10-am-btn" onClick={() => setImportOpen(true)}><Upload size={13} /> Import CSV</button>
            <button type="button" className="h10-am-btn primary" onClick={() => router.push('/marketing/ads/ebay/campaigns/new')}><Plus size={13} /> Campaign</button>
          </>
        }
      />

      <ImportCsvModal open={importOpen} onClose={() => setImportOpen(false)} onDone={reload} />
      {modal?.kind === 'clone' && <CloneModal open onClose={() => setModal(null)} campaignId={modal.c.id} sourceName={modal.c.name} onDone={(id) => router.push(`/marketing/ads/ebay/campaigns/${id}`)} />}
      {modal?.kind === 'end' && <EndCampaignModal open onClose={() => setModal(null)} campaignId={modal.c.id} campaignName={modal.c.name} onDone={() => { say('campaign ended'); reload() }} />}
      {modal?.kind === 'budget' && <GridBudgetModal open onClose={() => setModal(null)} campaignId={modal.c.id} campaignName={modal.c.name} currentCents={modal.c.dailyBudgetCents} usedToday={modal.c.budgetUpdatesToday ?? 0} currency={modal.c.budgetCurrency} onDone={() => { say('budget saved'); reload() }} />}
      {toast && <div className="h10-am-toast" role="status">{toast}</div>}
    </div>
  )
}
