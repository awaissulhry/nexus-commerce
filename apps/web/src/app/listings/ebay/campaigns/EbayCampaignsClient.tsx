'use client'

// C.16 — eBay Promoted Listings campaign manager.
//
// CRUD UI on top of EbayCampaign (C.14 schema). Shows the operator's
// campaigns scoped to their connected eBay accounts, supports
// create / pause / resume / end / delete flows.
//
// G.4 — table replaced with SharedVirtualizedGrid so column-resize,
// keyboard nav, density, and all future GridLens features apply here
// automatically.

import { useState, useMemo, useEffect, useCallback } from 'react'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/components.css'
import { Plus, Play, Pause, Square, Trash2, AlertCircle } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { COUNTRY_NAMES } from '@/lib/country-names'
import { Card } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'
import { Modal, ModalBody, ModalFooter } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { Listbox } from '@/design-system/components/Listbox'
import { DateField } from '@/design-system/components/DateField'
import { useToast } from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { getBackendUrl } from '@/lib/backend-url'
import { usePolledList } from '@/lib/sync/use-polled-list'
import { DensityToggle, GridToolbar, VirtualizedGrid, GridFooter } from '@/app/_shared/grid-lens'
import type { GridLensColumn, GridLensRow } from '@/app/_shared/grid-lens'
import { type Density, DENSITY_CELL_CLASS } from '@/lib/products/theme'

// ── Constants ────────────────────────────────────────────────────────

const EBAY_MARKET_CODES = ['IT', 'DE', 'ES', 'FR', 'GB']

const EBAY_MARKETPLACES = [
  { id: 'EBAY_IT', label: 'Italy (EBAY_IT)' },
  { id: 'EBAY_DE', label: 'Germany (EBAY_DE)' },
  { id: 'EBAY_ES', label: 'Spain (EBAY_ES)' },
  { id: 'EBAY_FR', label: 'France (EBAY_FR)' },
  { id: 'EBAY_GB', label: 'United Kingdom (EBAY_GB)' },
]

const CAMPAIGN_COLUMNS: GridLensColumn[] = [
  { key: 'name',    label: 'Campaign', subLabel: 'Name · ID',   width: 300 },
  { key: 'market',  label: 'Market',   subLabel: 'Marketplace', width: 100 },
  { key: 'funding', label: 'Funding',  subLabel: 'CPM / CPC',   width: 160 },
  { key: 'status',  label: 'Status',   subLabel: 'State',       width: 110 },
  { key: 'spend',   label: 'Spend',    subLabel: '€ total',     width: 90  },
  { key: 'sales',   label: 'Sales',    subLabel: '€ total',     width: 90  },
  { key: 'actions', label: '',                                   width: 130 },
]

const CAMPAIGN_SORT_KEYS: Record<string, string> = {
  name: 'name', market: 'market', status: 'status', spend: 'spend', sales: 'sales',
}

const STORAGE_KEY = 'ebay-campaigns'
const _EMPTY_SET = new Set<string>()
const _EMPTY_MAP = {}
const _NOOP = () => {}

// ── Types ─────────────────────────────────────────────────────────────

interface EbayCampaign {
  id: string
  channelConnectionId: string
  marketplace: string
  externalCampaignId: string
  name: string
  fundingStrategy: 'STANDARD' | 'ADVANCED'
  bidPercentage: number | null
  dailyBudget: number | null
  budgetCurrency: string | null
  status: 'DRAFT' | 'RUNNING' | 'PAUSED' | 'ENDED'
  startDate: string
  endDate: string | null
  impressions: number
  clicks: number
  sales: number
  spend: number
  metricsAt: string | null
  createdAt: string
  updatedAt: string
}

type CampaignRow = EbayCampaign & GridLensRow

const STATUS_TONE: Record<string, string> = {
  DRAFT:   'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-default dark:border-slate-700',
  RUNNING: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900',
  PAUSED:  'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-900',
  ENDED:   'bg-slate-50 dark:bg-slate-800 text-tertiary dark:text-slate-500 border-default dark:border-slate-700',
}

// ── Component ─────────────────────────────────────────────────────────

export default function EbayCampaignsClient() {
  const [marketplaceFilter, setMarketplaceFilter] = useState<string>('')
  const [statusFilter, setStatusFilter]           = useState<string>('')
  const [createOpen, setCreateOpen]               = useState(false)
  const [selected, setSelected]                   = useState<Set<string>>(new Set())
  const [sortBy, setSortBy]                       = useState('name')
  const [density, setDensity]                     = useState<Density>(() => {
    try { return (localStorage.getItem(`${STORAGE_KEY}.density`) as Density) ?? 'comfortable' } catch { return 'comfortable' }
  })
  const { toast } = useToast()
  const askConfirm = useConfirm()

  useEffect(() => {
    const mp = marketplaceFilter.replace('EBAY_', '')
    const country = mp ? (COUNTRY_NAMES[mp] ?? mp) : null
    document.title = country ? `eBay Promoted Listings · ${country}` : 'eBay Promoted Listings · Campaigns'
  }, [marketplaceFilter])

  useEffect(() => {
    try { localStorage.setItem(`${STORAGE_KEY}.density`, density) } catch {}
  }, [density])

  const url = useMemo(() => {
    const qs = new URLSearchParams()
    if (marketplaceFilter) qs.set('marketplace', marketplaceFilter)
    if (statusFilter)      qs.set('status', statusFilter)
    return `/api/listings/ebay/campaigns?${qs.toString()}`
  }, [marketplaceFilter, statusFilter])

  const { data, loading, error, refetch } = usePolledList<{ campaigns: EbayCampaign[] }>({
    url,
    intervalMs: 30_000,
  })

  const campaigns = data?.campaigns ?? []

  // Client-side sort
  const rows = useMemo((): CampaignRow[] => {
    const base = campaigns.map(c => ({ ...c, isParent: false as const, childCount: 0, parentId: null }))
    const [key, dir] = sortBy.endsWith('-asc') ? [sortBy.slice(0, -4), 'asc'] : [sortBy, 'desc']
    return [...base].sort((a, b) => {
      let av: any, bv: any
      switch (key) {
        case 'name':   av = a.name;      bv = b.name;      break
        case 'market': av = a.marketplace; bv = b.marketplace; break
        case 'status': av = a.status;    bv = b.status;    break
        case 'spend':  av = a.spend;     bv = b.spend;     break
        case 'sales':  av = a.sales;     bv = b.sales;     break
        default: return 0
      }
      const cmp = typeof av === 'string' ? av.localeCompare(bv) : ((av ?? 0) - (bv ?? 0))
      return dir === 'asc' ? cmp : -cmp
    })
  }, [campaigns, sortBy])

  const allSelected = rows.length > 0 && rows.every(r => selected.has(r.id))
  const cellPad = DENSITY_CELL_CLASS[density] ?? DENSITY_CELL_CLASS.comfortable

  const toggleSelect = useCallback((id: string, _shiftKey: boolean) => {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }, [])

  const toggleSelectAll = useCallback(() => {
    setSelected(allSelected ? new Set() : new Set(rows.map(r => r.id)))
  }, [allSelected, rows])

  const onSort = useCallback((key: string) => {
    setSortBy(prev => {
      const base = key.replace(/-asc$/, '')
      if (prev === base) return `${base}-asc`
      if (prev === `${base}-asc`) return base
      return base
    })
  }, [])

  const transition = async (id: string, nextStatus: 'RUNNING' | 'PAUSED' | 'ENDED') => {
    try {
      const res = await fetch(`${getBackendUrl()}/api/listings/ebay/campaigns/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
      toast.success(`Campaign ${nextStatus.toLowerCase()}`)
      refetch()
    } catch (e: any) { toast.error(`Update failed: ${e?.message ?? String(e)}`) }
  }

  const remove = async (campaign: EbayCampaign) => {
    if (campaign.status !== 'DRAFT') {
      toast.error('Only DRAFT campaigns can be deleted. Use End to preserve metrics history.')
      return
    }
    const ok = await askConfirm({
      title: `Delete campaign "${campaign.name}"?`,
      description: 'This DRAFT campaign will be removed permanently. Active and ended campaigns must be ended via the End button instead.',
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!ok) return
    try {
      const res = await fetch(`${getBackendUrl()}/api/listings/ebay/campaigns/${campaign.id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
      toast.success('Campaign deleted')
      refetch()
    } catch (e: any) { toast.error(`Delete failed: ${e?.message ?? String(e)}`) }
  }

  const renderCell = useCallback((row: CampaignRow, colKey: string) => {
    switch (colKey) {
      case 'name':
        return (
          <div>
            <div className="font-medium text-slate-900 dark:text-slate-100 truncate">{row.name}</div>
            <div className="text-xs text-slate-500 dark:text-slate-400 font-mono truncate">
              {row.externalCampaignId.startsWith('local-') ? '(not yet pushed to eBay)' : row.externalCampaignId}
            </div>
          </div>
        )
      case 'market':
        return <span className="text-sm font-mono text-slate-600 dark:text-slate-400">{row.marketplace.replace('EBAY_', '')}</span>
      case 'funding':
        return row.fundingStrategy === 'STANDARD' ? (
          <span className="text-sm text-slate-700 dark:text-slate-300">
            CPM <span className="font-semibold tabular-nums">{row.bidPercentage?.toFixed(2)}%</span>
          </span>
        ) : (
          <span className="text-sm text-slate-700 dark:text-slate-300">
            CPC <span className="font-semibold tabular-nums">{row.dailyBudget?.toFixed(2)} {row.budgetCurrency}/day</span>
          </span>
        )
      case 'status':
        return (
          <span className={`inline-block text-xs font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded ${STATUS_TONE[row.status] ?? ''}`}>
            {row.status}
          </span>
        )
      case 'spend':
        return <span className="text-sm tabular-nums text-slate-700 dark:text-slate-300">{row.spend > 0 ? row.spend.toFixed(2) : '—'}</span>
      case 'sales':
        return <span className="text-sm tabular-nums text-slate-700 dark:text-slate-300">{row.sales > 0 ? row.sales.toFixed(2) : '—'}</span>
      case 'actions':
        return (
          <div className="flex items-center gap-1 justify-end">
            {(row.status === 'DRAFT' || row.status === 'PAUSED') && (
              <button onClick={() => transition(row.id, 'RUNNING')} title="Start / resume" aria-label={`Start campaign "${row.name}"`}
                className="h-7 w-7 inline-flex items-center justify-center text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 rounded focus:outline-none focus:ring-2 focus:ring-emerald-300">
                <Play size={12} />
              </button>
            )}
            {row.status === 'RUNNING' && (
              <button onClick={() => transition(row.id, 'PAUSED')} title="Pause" aria-label={`Pause campaign "${row.name}"`}
                className="h-7 w-7 inline-flex items-center justify-center text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/40 rounded focus:outline-none focus:ring-2 focus:ring-amber-300">
                <Pause size={12} />
              </button>
            )}
            {row.status !== 'ENDED' && (
              <button onClick={() => transition(row.id, 'ENDED')} title="End campaign" aria-label={`End campaign "${row.name}"`}
                className="h-7 w-7 inline-flex items-center justify-center text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 rounded focus:outline-none focus:ring-2 focus:ring-slate-300">
                <Square size={12} />
              </button>
            )}
            {row.status === 'DRAFT' && (
              <button onClick={() => remove(row)} title="Delete" aria-label={`Delete DRAFT campaign "${row.name}"`}
                className="h-7 w-7 inline-flex items-center justify-center text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded focus:outline-none focus:ring-2 focus:ring-rose-300">
                <Trash2 size={12} />
              </button>
            )}
          </div>
        )
      default:
        return null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="space-y-4">
      <PageHeader
        title={(() => {
          const mp = marketplaceFilter.replace('EBAY_', '')
          const country = mp ? (COUNTRY_NAMES[mp] ?? mp) : null
          return country ? `eBay Promoted Listings · ${country}` : 'eBay Promoted Listings'
        })()}
        description="Standard CPM (bid percentage) or Advanced CPC (daily budget). Manage campaigns and track performance across eBay marketplaces."
        breadcrumbs={[
          { label: 'Listings', href: '/listings' },
          { label: 'eBay', href: '/listings/ebay' },
          { label: 'Campaigns' },
        ]}
      />

      {/* Marketplace tab strip */}
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={() => setMarketplaceFilter('')}
          className={`px-3 py-1.5 rounded border text-sm font-medium transition-colors ${marketplaceFilter === '' ? 'bg-slate-900 text-white border-slate-900 dark:bg-slate-100 dark:text-slate-900' : 'bg-white text-slate-600 border-default hover:border-slate-400 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-700 dark:hover:border-slate-500'}`}
        >
          All markets
        </button>
        {EBAY_MARKET_CODES.map(mp => (
          <button
            key={mp}
            onClick={() => setMarketplaceFilter(`EBAY_${mp}`)}
            className={`px-3 py-1.5 rounded border text-sm font-medium transition-colors ${marketplaceFilter === `EBAY_${mp}` ? 'bg-slate-900 text-white border-slate-900 dark:bg-slate-100 dark:text-slate-900' : 'bg-white text-slate-600 border-default hover:border-slate-400 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-700 dark:hover:border-slate-500'}`}
          >
            {COUNTRY_NAMES[mp] ?? mp}
          </button>
        ))}
      </div>

      {/* Honest banner */}
      <Card>
        <div className="flex items-start gap-2 text-sm">
          <AlertCircle size={14} className="mt-0.5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
          <div className="text-slate-600 dark:text-slate-400">
            <span className="font-semibold text-slate-700 dark:text-slate-300">eBay push pending —</span>{' '}
            campaigns are stored in Nexus only for now. Create the matching campaign on
            eBay&apos;s Seller Hub side, then flip status to <code className="px-1 bg-slate-100 dark:bg-slate-800 rounded text-xs">RUNNING</code> here
            so metrics tracking lines up. Direct push to eBay&apos;s Marketing API
            lands behind <code className="px-1 bg-slate-100 dark:bg-slate-800 rounded text-xs">NEXUS_ENABLE_EBAY_PUBLISH</code> in a follow-up commit.
          </div>
        </div>
      </Card>

      {/* Canonical chrome toolbar */}
      <GridToolbar
        quickFilterSlot={
          <>
            <Listbox
              value={statusFilter}
              onChange={setStatusFilter}
              className="w-36"
              ariaLabel="Filter by status"
              options={[
                { value: '', label: 'All statuses' },
                { value: 'DRAFT', label: 'Draft' },
                { value: 'RUNNING', label: 'Running' },
                { value: 'PAUSED', label: 'Paused' },
                { value: 'ENDED', label: 'Ended' },
              ]}
            />
            <span className="text-sm text-slate-500 dark:text-slate-400">
              {rows.length} campaign{rows.length === 1 ? '' : 's'}
            </span>
          </>
        }
        density={<DensityToggle density={density} onChange={setDensity} />}
        trailingSlot={
          <button
            onClick={() => setCreateOpen(true)}
            className="h-8 px-3 text-base bg-blue-600 dark:bg-blue-700 text-white rounded hover:bg-blue-700 dark:hover:bg-blue-600 inline-flex items-center gap-1.5"
          >
            <Plus size={12} /> New campaign
          </button>
        }
      />

      {/* Grid */}
      {loading && !data ? (
        <Card><Skeleton variant="text" lines={4} /></Card>
      ) : error && !data ? (
        <Card><div className="text-rose-600 dark:text-rose-400 text-sm">Failed to load: {error}</div></Card>
      ) : rows.length === 0 ? (
        <Card>
          <div className="text-center py-8 text-sm text-slate-500 dark:text-slate-400">
            No campaigns yet.{' '}
            <button onClick={() => setCreateOpen(true)} className="text-blue-600 dark:text-blue-400 hover:underline">
              Create your first campaign
            </button>.
          </div>
        </Card>
      ) : (<>
        <VirtualizedGrid
          rows={rows}
          visible={CAMPAIGN_COLUMNS}
          density={density}
          cellPad={cellPad}
          selected={selected}
          toggleSelect={toggleSelect}
          toggleSelectAll={toggleSelectAll}
          allSelected={allSelected}
          sortBy={sortBy}
          onSort={onSort}
          sortKeys={CAMPAIGN_SORT_KEYS}
          expandedParents={_EMPTY_SET}
          childrenByParent={_EMPTY_MAP}
          loadingChildren={_EMPTY_SET}
          onToggleExpand={_NOOP}
          focusedRowId={null}
          searchTerm=""
          riskFlaggedSkus={_EMPTY_SET}
          storageKey={STORAGE_KEY}
          showExpandColumn={false}
          renderCell={renderCell}
        />
        <GridFooter count={rows.length} label="campaigns" />
      </>)
      }

      {createOpen && (
        <CreateCampaignModal
          onClose={() => setCreateOpen(false)}
          onCreated={() => { setCreateOpen(false); refetch() }}
        />
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// CreateCampaignModal — name + marketplace + funding strategy + start
// ────────────────────────────────────────────────────────────────────
function CreateCampaignModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { toast } = useToast()
  const [name, setName]                         = useState('')
  const [marketplace, setMarketplace]           = useState('EBAY_IT')
  const [fundingStrategy, setFundingStrategy]   = useState<'STANDARD' | 'ADVANCED'>('STANDARD')
  const [bidPercentage, setBidPercentage]       = useState('5.00')
  const [dailyBudget, setDailyBudget]           = useState('20.00')
  const [budgetCurrency, setBudgetCurrency]     = useState('EUR')
  const [startDate, setStartDate]               = useState(() => new Date().toISOString().slice(0, 10))
  const [endDate, setEndDate]                   = useState('')
  const [busy, setBusy]                         = useState(false)

  const submit = async () => {
    setBusy(true)
    try {
      const body: any = { name: name.trim(), marketplace, fundingStrategy, startDate, endDate: endDate || null }
      if (fundingStrategy === 'STANDARD') {
        body.bidPercentage = Number(bidPercentage)
      } else {
        body.dailyBudget = Number(dailyBudget)
        body.budgetCurrency = budgetCurrency
      }
      const res = await fetch(`${getBackendUrl()}/api/listings/ebay/campaigns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
      toast.success('Campaign created (DRAFT). Flip to RUNNING when you push it on eBay.')
      onCreated()
    } catch (e: any) {
      toast.error(`Create failed: ${e?.message ?? String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} title="New Promoted Listings campaign" size="md">
      <ModalBody>
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">Campaign name</label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder='e.g. "Spring 2026 — Italy boost"' autoFocus />
          </div>
          <div>
            <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">Marketplace</label>
            <Listbox value={marketplace} onChange={setMarketplace} ariaLabel="Marketplace" className="w-full"
              options={EBAY_MARKETPLACES.map(m => ({ value: m.id, label: m.label }))} />
          </div>
          <div>
            <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">Funding strategy</label>
            <div className="space-y-1.5 text-sm text-slate-700 dark:text-slate-300">
              <label className="flex items-start gap-2 cursor-pointer">
                <input type="radio" name="funding" value="STANDARD" checked={fundingStrategy === 'STANDARD'} onChange={() => setFundingStrategy('STANDARD')} className="mt-0.5" />
                <span><span className="font-medium">Standard (CPM)</span> — pay a percentage of the sale price when an item sells through the campaign.</span>
              </label>
              <label className="flex items-start gap-2 cursor-pointer">
                <input type="radio" name="funding" value="ADVANCED" checked={fundingStrategy === 'ADVANCED'} onChange={() => setFundingStrategy('ADVANCED')} className="mt-0.5" />
                <span><span className="font-medium">Advanced (CPC)</span> — pay per click with a daily budget cap.</span>
              </label>
            </div>
          </div>
          {fundingStrategy === 'STANDARD' ? (
            <div>
              <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">Bid percentage</label>
              <Input type="number" step="0.10" min="0.10" max="100" value={bidPercentage} onChange={e => setBidPercentage(e.target.value)} placeholder="e.g. 5.00" />
              <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">eBay charges this % of the final sale price for items sold via the campaign.</div>
            </div>
          ) : (
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <div>
                <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">Daily budget</label>
                <Input type="number" step="0.01" min="0.01" value={dailyBudget} onChange={e => setDailyBudget(e.target.value)} />
              </div>
              <div>
                <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">Currency</label>
                <Listbox value={budgetCurrency} onChange={setBudgetCurrency} ariaLabel="Currency" className="w-24"
                  options={[
                    { value: 'EUR', label: 'EUR' },
                    { value: 'GBP', label: 'GBP' },
                    { value: 'USD', label: 'USD' },
                  ]} />
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">Start date</label>
              <DateField value={startDate} onChange={setStartDate} ariaLabel="Start date" />
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">End date <span className="text-tertiary dark:text-slate-500 font-normal">(optional)</span></label>
              <DateField value={endDate} onChange={setEndDate} ariaLabel="End date (optional)" />
            </div>
          </div>
        </div>
      </ModalBody>
      <ModalFooter>
        <button onClick={onClose} disabled={busy}
          className="h-8 px-3 text-base text-slate-700 dark:text-slate-300 border border-default dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800">
          Cancel
        </button>
        <button onClick={submit} disabled={busy || !name.trim()}
          className="h-8 px-3 text-base bg-blue-600 dark:bg-blue-700 text-white rounded hover:bg-blue-700 dark:hover:bg-blue-600 inline-flex items-center gap-1.5 disabled:opacity-50">
          {busy ? 'Creating…' : 'Create campaign'}
        </button>
      </ModalFooter>
    </Modal>
  )
}
