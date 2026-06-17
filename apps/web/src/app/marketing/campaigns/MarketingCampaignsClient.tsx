'use client'

/**
 * UM-series (P3) — Unified Marketing OS · Campaign roster client.
 *
 * Dense cross-channel roster (Salesforce/Airtable density per the house
 * style). Reuses grid-lens KpiStrip + LensTabs; channel is the lens
 * dimension. Filters + sort re-fetch from /api/marketing/os/campaigns;
 * useMarketingEvents live-refreshes on backfill / sync / rebalance /
 * rule events. Read-only in P3 — inline actions land in P5.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  Megaphone,
  Wallet,
  TrendingUp,
  Activity,
  Search,
  RefreshCw,
  Radio,
  Play,
  Pause,
  Check,
  Plus,
  Rocket,
  X,
  Target,
} from 'lucide-react'
import { KpiStrip, SharedLensTabs, type KpiTileSpec, type LensTab } from '@/app/_shared/grid-lens'
import { getBackendUrl } from '@/lib/backend-url'
import { useMarketingEvents } from '@/lib/sync/use-marketing-events'

export interface RosterCampaign {
  id: string
  name: string
  channel: string
  surface: string
  objective: string
  status: string
  marketplaces: string[]
  primaryMarketplace: string | null
  budgetScope: string
  budgetCents: number | null
  budgetKind: string | null
  currency: string
  spendCents: number
  salesCents: number
  acos: number | null
  roas: number | null
  deliveryStatus: string | null
  deliveryReasons: string[]
  startDate: string
  endDate: string | null
  lastSyncedAt: string | null
  adProduct: string | null
  linkCount: number
  targetCount: number
  markets: string[]
}

export interface RosterSummary {
  total: number
  byChannel: Record<string, number>
  byStatus: Record<string, number>
  spendCents: number
  salesCents: number
}

type LensKey = 'ALL' | 'AMAZON' | 'EBAY' | 'SHOPIFY' | 'EXTERNAL' | 'INTERNAL' | 'PROMOTIONS'
type SortKey = 'spendCents' | 'salesCents' | 'acos' | 'roas' | 'name' | 'status'

const LENS_TABS: ReadonlyArray<LensTab<LensKey>> = [
  { key: 'ALL', label: 'All channels' },
  { key: 'AMAZON', label: 'Amazon' },
  { key: 'EBAY', label: 'eBay' },
  { key: 'SHOPIFY', label: 'Shopify' },
  { key: 'EXTERNAL', label: 'External' },
  { key: 'INTERNAL', label: 'Content & outreach' },
  { key: 'PROMOTIONS', label: 'Promotions' },
]

// External lens maps to the off-platform ad networks.
const EXTERNAL_CHANNELS = new Set(['GOOGLE', 'META', 'TIKTOK'])
// Promotions lens is a cross-channel SURFACE filter (deals/discounts/markdowns).
const PROMOTION_SURFACES = new Set(['DISCOUNT', 'MARKDOWN', 'DEAL'])
// Pseudo-lenses are surface/derived filters, not a single channel — they
// don't map to the server-side channel param.
const PSEUDO_LENSES = new Set<LensKey>(['ALL', 'EXTERNAL', 'PROMOTIONS'])

const CHANNEL_CHIP: Record<string, string> = {
  AMAZON: 'bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300',
  EBAY: 'bg-blue-100 text-blue-800 dark:bg-blue-950/50 dark:text-blue-300',
  SHOPIFY: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300',
  GOOGLE: 'bg-sky-100 text-sky-800 dark:bg-sky-950/50 dark:text-sky-300',
  META: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-950/50 dark:text-indigo-300',
  TIKTOK: 'bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-950/50 dark:text-fuchsia-300',
  INTERNAL: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
}

const STATUS_CHIP: Record<string, string> = {
  ACTIVE: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300',
  PAUSED: 'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300',
  DRAFT: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  SCHEDULED: 'bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300',
  ENDED: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
  SUSPENDED: 'bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300',
  FAILED: 'bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300',
}

function eur(cents: number | null | undefined, currency = 'EUR'): string {
  if (cents == null) return '—'
  return new Intl.NumberFormat('en-IE', { style: 'currency', currency }).format(cents / 100)
}
function pct(v: number | null | undefined): string {
  if (v == null) return '—'
  return `${(v * 100).toFixed(1)}%`
}

export function MarketingCampaignsClient({
  initialCampaigns,
  initialSummary,
  initialCapped,
}: {
  initialCampaigns: RosterCampaign[]
  initialSummary: RosterSummary
  initialCapped: boolean
}) {
  const [campaigns, setCampaigns] = useState(initialCampaigns)
  const [summary, setSummary] = useState(initialSummary)
  const [capped, setCapped] = useState(initialCapped)
  const [lens, setLens] = useState<LensKey>('ALL')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('spendCents')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [loading, setLoading] = useState(false)
  const [live, setLive] = useState(false)
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [editBudget, setEditBudget] = useState<{ id: string; value: string } | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [createForm, setCreateForm] = useState({ name: '', channel: 'INTERNAL', surface: 'CONTENT_PUSH', marketplaces: 'IT', contentType: 'LISTING_COPY', targetRefs: '', segmentId: '', budgetEur: '' })

  // Sandbox-gated mutation: optimistic local update from the server's
  // echoed campaign; Amazon stays sandbox (no live write) until P8.
  const mutate = useCallback(async (id: string, body: Record<string, unknown>) => {
    setBusy((b) => ({ ...b, [id]: true }))
    try {
      const res = await fetch(`${getBackendUrl()}/api/marketing/os/campaigns/${id}/mutate`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        const r = await res.json()
        setCampaigns((cs) => cs.map((c) => (c.id === id ? { ...c, status: r.campaign?.status ?? c.status, budgetCents: r.campaign?.budgetCents ?? c.budgetCents } : c)))
      }
    } catch {
      // ignore; next refetch reconciles
    } finally {
      setBusy((b) => ({ ...b, [id]: false }))
    }
  }, [])

  const refetch = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (!PSEUDO_LENSES.has(lens)) params.set('channel', lens)
      if (statusFilter) params.set('status', statusFilter)
      if (search.trim()) params.set('q', search.trim())
      const [r, s] = await Promise.all([
        fetch(`${getBackendUrl()}/api/marketing/os/campaigns?${params}`, { cache: 'no-store' }).then((x) => x.json()),
        fetch(`${getBackendUrl()}/api/marketing/os/summary`, { cache: 'no-store' }).then((x) => x.json()),
      ])
      setCampaigns(r.items ?? [])
      setCapped(!!r.capped)
      setSummary(s)
    } catch {
      // keep last good state
    } finally {
      setLoading(false)
    }
  }, [lens, statusFilter, search])

  // Re-fetch when server-side filters (lens/status) change. Search is
  // debounced separately below.
  useEffect(() => {
    void refetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lens, statusFilter])

  // Debounced search.
  useEffect(() => {
    const t = setTimeout(() => void refetch(), 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  // Live refresh on marketing events.
  useMarketingEvents(
    useCallback(() => {
      setLive(true)
      void refetch()
      const t = setTimeout(() => setLive(false), 1500)
      return () => clearTimeout(t)
    }, [refetch]),
  )

  const createCampaign = async () => {
    const f = createForm
    const body: Record<string, unknown> = {
      name: f.name, channel: f.channel, surface: f.surface,
      marketplaces: f.marketplaces.split(',').map((s) => s.trim()).filter(Boolean),
      status: 'DRAFT',
    }
    if (f.surface === 'CONTENT_PUSH') { body.contentType = f.contentType; body.targetRefs = f.targetRefs.split(',').map((s) => s.trim()).filter(Boolean) }
    if (f.surface === 'EMAIL_OUTREACH' || f.surface === 'REVIEW_OUTREACH') body.segmentId = f.segmentId || null
    if (f.budgetEur) { body.budgetCents = Math.round(parseFloat(f.budgetEur) * 100); body.budgetKind = 'DAILY' }
    await fetch(`${getBackendUrl()}/api/marketing/os/campaigns`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    setShowCreate(false)
    setCreateForm({ name: '', channel: 'INTERNAL', surface: 'CONTENT_PUSH', marketplaces: 'IT', contentType: 'LISTING_COPY', targetRefs: '', segmentId: '', budgetEur: '' })
    void refetch()
  }
  const launch = useCallback(async (id: string) => {
    setBusy((b) => ({ ...b, [id]: true }))
    try { await fetch(`${getBackendUrl()}/api/marketing/os/campaigns/${id}/launch`, { method: 'POST' }) } finally { setBusy((b) => ({ ...b, [id]: false })); void refetch() }
  }, [refetch])

  // Client-side lens filter for the EXTERNAL pseudo-channel + sort.
  const rows = useMemo(() => {
    let r = campaigns
    if (lens === 'EXTERNAL') r = r.filter((c) => EXTERNAL_CHANNELS.has(c.channel))
    if (lens === 'PROMOTIONS') r = r.filter((c) => PROMOTION_SURFACES.has(c.surface))
    const dir = sortDir === 'asc' ? 1 : -1
    return [...r].sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      if (typeof av === 'string' && typeof bv === 'string') return av.localeCompare(bv) * dir
      return ((av as number) - (bv as number)) * dir
    })
  }, [campaigns, lens, sortKey, sortDir])

  const tiles: KpiTileSpec[] = [
    { icon: Megaphone, label: 'Campaigns', value: String(summary.total), tone: 'blue',
      detail: Object.entries(summary.byChannel).map(([k, v]) => `${k} ${v}`).join(' · ') || undefined },
    { icon: Activity, label: 'Active', value: String(summary.byStatus.ACTIVE ?? 0), tone: 'emerald',
      detail: `${summary.byStatus.PAUSED ?? 0} paused · ${summary.byStatus.DRAFT ?? 0} draft` },
    { icon: Wallet, label: 'Spend', value: eur(summary.spendCents), tone: 'amber', detail: 'across all channels' },
    { icon: TrendingUp, label: 'Attributed sales', value: eur(summary.salesCents), tone: 'violet',
      detail: summary.spendCents > 0 ? `ROAS ${(summary.salesCents / summary.spendCents).toFixed(2)} · channel-reported` : 'channel-reported' },
  ]

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(k); setSortDir(k === 'name' || k === 'status' ? 'asc' : 'desc') }
  }
  const arrow = (k: SortKey) => (sortKey === k ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '')

  return (
    <div className="p-4 sm:p-6 max-w-[1600px] mx-auto">
      <header className="mb-4">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Campaigns</h1>
          {live && (
            <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
              <Radio size={12} className="animate-pulse" /> live
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <Link href="/marketing/advertising" className="inline-flex items-center gap-1 px-2.5 py-1.5 text-sm rounded-md border border-default dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800" title="Amazon Trading Desk — search terms, reports, aged stock, true profit, feeds">
              <Target size={14} /> Trading Desk
            </Link>
            <Link href="/pricing/promotions" className="inline-flex items-center gap-1 px-2.5 py-1.5 text-sm rounded-md border border-default dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800" title="Promotion scheduler (deals, markdowns, discounts)">
              <Megaphone size={14} /> Promotion scheduler
            </Link>
            <button onClick={() => setShowCreate(true)} className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700">
              <Plus size={14} /> New campaign
            </button>
          </div>
        </div>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Unified cross-channel campaigns across all markets. Pause/resume + budget edits run through the guarded mutation path (Amazon in sandbox until cutover — no live write fires).
        </p>
      </header>

      <KpiStrip tiles={tiles} className="mb-4" />

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <SharedLensTabs tabs={LENS_TABS} current={lens} onChange={setLens} />
        <div className="relative">
          <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-tertiary" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search campaigns…"
            className="pl-7 pr-2 py-1.5 text-sm rounded-md border border-default dark:border-slate-700 bg-white dark:bg-slate-900 w-56"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="py-1.5 px-2 text-sm rounded-md border border-default dark:border-slate-700 bg-white dark:bg-slate-900"
        >
          <option value="">All statuses</option>
          {['ACTIVE', 'PAUSED', 'DRAFT', 'SCHEDULED', 'ENDED', 'SUSPENDED', 'FAILED'].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <button
          onClick={() => void refetch()}
          className="inline-flex items-center gap-1 py-1.5 px-2 text-sm rounded-md border border-default dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
        <span className="text-xs text-tertiary ml-auto">{rows.length} shown{capped ? ' (capped at 500)' : ''}</span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-default dark:border-slate-800">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-900/60 text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wide">
            <tr>
              <th className="text-left font-medium px-3 py-2 cursor-pointer" onClick={() => toggleSort('name')}>Campaign{arrow('name')}</th>
              <th className="text-left font-medium px-3 py-2">Channel</th>
              <th className="text-left font-medium px-3 py-2">Markets</th>
              <th className="text-left font-medium px-3 py-2 cursor-pointer" onClick={() => toggleSort('status')}>Status{arrow('status')}</th>
              <th className="text-right font-medium px-3 py-2">Budget</th>
              <th className="text-right font-medium px-3 py-2 cursor-pointer" onClick={() => toggleSort('spendCents')}>Spend{arrow('spendCents')}</th>
              <th className="text-right font-medium px-3 py-2 cursor-pointer" onClick={() => toggleSort('salesCents')}>Sales{arrow('salesCents')}</th>
              <th className="text-right font-medium px-3 py-2 cursor-pointer" onClick={() => toggleSort('acos')}>ACOS{arrow('acos')}</th>
              <th className="text-right font-medium px-3 py-2 cursor-pointer" onClick={() => toggleSort('roas')}>ROAS{arrow('roas')}</th>
              <th className="text-left font-medium px-3 py-2">Delivery</th>
              <th className="text-center font-medium px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {rows.length === 0 && (
              <tr>
                <td colSpan={11} className="px-3 py-10 text-center text-tertiary">
                  No campaigns yet. Amazon campaigns appear once the shadow backfill has run; other channels populate as their adapters ship.
                </td>
              </tr>
            )}
            {rows.map((c) => (
              <tr key={c.id} className="hover:bg-slate-50 dark:hover:bg-slate-900/40">
                <td className="px-3 py-2">
                  <Link href={`/marketing/campaigns/${c.id}`} className="font-medium text-slate-800 dark:text-slate-100 truncate max-w-[280px] block hover:text-blue-600 hover:underline">{c.name}</Link>
                  <div className="text-xs text-tertiary">{c.surface}{c.adProduct ? ` · ${c.adProduct}` : ''}{c.targetCount ? ` · ${c.targetCount} targets` : ''}</div>
                </td>
                <td className="px-3 py-2">
                  <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${CHANNEL_CHIP[c.channel] ?? CHANNEL_CHIP.INTERNAL}`}>{c.channel}</span>
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {(c.markets.length ? c.markets : c.marketplaces).slice(0, 4).map((m) => (
                      <span key={m} className="px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-xs text-slate-600 dark:text-slate-300">{m}</span>
                    ))}
                    {c.budgetScope === 'MULTI_MARKET' && <span className="text-xs text-violet-500">multi</span>}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${STATUS_CHIP[c.status] ?? STATUS_CHIP.DRAFT}`}>{c.status}</span>
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">
                  {editBudget?.id === c.id ? (
                    <span className="inline-flex items-center gap-1">
                      <input
                        autoFocus type="number" step="0.01" value={editBudget.value}
                        onChange={(e) => setEditBudget({ id: c.id, value: e.target.value })}
                        onKeyDown={(e) => { if (e.key === 'Escape') setEditBudget(null); if (e.key === 'Enter') { void mutate(c.id, { budgetCents: Math.round(parseFloat(editBudget.value || '0') * 100) }); setEditBudget(null) } }}
                        className="w-20 px-1 py-0.5 text-right text-xs rounded border border-blue-400 bg-white dark:bg-slate-900"
                      />
                      <button onClick={() => { void mutate(c.id, { budgetCents: Math.round(parseFloat(editBudget.value || '0') * 100) }); setEditBudget(null) }} className="text-blue-600"><Check size={13} /></button>
                    </span>
                  ) : (
                    <button onClick={() => setEditBudget({ id: c.id, value: c.budgetCents != null ? (c.budgetCents / 100).toFixed(2) : '0' })} className="hover:underline decoration-dotted" title="Edit budget (sandbox)">
                      {eur(c.budgetCents, c.currency)}{c.budgetKind === 'DAILY' ? '/d' : ''}
                    </button>
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-700 dark:text-slate-200">{eur(c.spendCents, c.currency)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-700 dark:text-slate-200">{eur(c.salesCents, c.currency)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{pct(c.acos)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{c.roas != null ? c.roas.toFixed(2) : '—'}</td>
                <td className="px-3 py-2 text-xs text-slate-500">
                  {c.deliveryStatus ?? '—'}
                  {c.deliveryReasons?.length ? <span className="text-rose-400"> · {c.deliveryReasons[0]}</span> : null}
                </td>
                <td className="px-3 py-2 text-center">
                  {(c.status === 'ACTIVE' || c.status === 'PAUSED') && (
                    <button
                      disabled={busy[c.id]}
                      onClick={() => void mutate(c.id, { status: c.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' })}
                      title={c.status === 'ACTIVE' ? 'Pause (sandbox)' : 'Resume (sandbox)'}
                      className="inline-flex items-center justify-center w-7 h-7 rounded hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40"
                    >
                      {c.status === 'ACTIVE' ? <Pause size={14} className="text-amber-600" /> : <Play size={14} className="text-emerald-600" />}
                    </button>
                  )}
                  {c.channel === 'INTERNAL' && (
                    <button
                      disabled={busy[c.id]}
                      onClick={() => void launch(c.id)}
                      title="Launch content / outreach (sandbox)"
                      className="inline-flex items-center justify-center w-7 h-7 rounded hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40"
                    >
                      <Rocket size={14} className="text-violet-600" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setShowCreate(false)}>
          <div className="bg-white dark:bg-slate-900 rounded-lg shadow-xl w-full max-w-md p-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-semibold text-slate-900 dark:text-slate-100">New campaign</h2>
              <button onClick={() => setShowCreate(false)}><X size={16} /></button>
            </div>
            <div className="space-y-3">
              <input autoFocus placeholder="Campaign name" value={createForm.name} onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })} className="w-full px-2 py-1.5 text-sm rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-950" />
              <div className="flex gap-2">
                <label className="flex-1 text-xs text-slate-500">Channel
                  <select value={createForm.channel} onChange={(e) => setCreateForm({ ...createForm, channel: e.target.value })} className="w-full mt-0.5 px-2 py-1.5 text-sm rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-950">
                    {['INTERNAL', 'AMAZON', 'EBAY', 'SHOPIFY', 'GOOGLE', 'META', 'TIKTOK'].map((c) => <option key={c}>{c}</option>)}
                  </select>
                </label>
                <label className="flex-1 text-xs text-slate-500">Surface
                  <select value={createForm.surface} onChange={(e) => setCreateForm({ ...createForm, surface: e.target.value })} className="w-full mt-0.5 px-2 py-1.5 text-sm rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-950">
                    {['CONTENT_PUSH', 'EMAIL_OUTREACH', 'REVIEW_OUTREACH', 'SP', 'SB', 'SD', 'PROMOTED_LISTINGS', 'DISCOUNT', 'MARKDOWN', 'DEAL', 'SHOPPING_FEED'].map((s) => <option key={s}>{s}</option>)}
                  </select>
                </label>
              </div>
              <input placeholder="Markets (comma-sep, e.g. IT,DE)" value={createForm.marketplaces} onChange={(e) => setCreateForm({ ...createForm, marketplaces: e.target.value })} className="w-full px-2 py-1.5 text-sm rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-950" />
              {createForm.surface === 'CONTENT_PUSH' && (
                <div className="flex gap-2">
                  <select value={createForm.contentType} onChange={(e) => setCreateForm({ ...createForm, contentType: e.target.value })} className="px-2 py-1.5 text-sm rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-950">{['LISTING_COPY', 'APLUS', 'BRAND_STORY'].map((t) => <option key={t}>{t}</option>)}</select>
                  <input placeholder="Target ASINs/SKUs (comma-sep)" value={createForm.targetRefs} onChange={(e) => setCreateForm({ ...createForm, targetRefs: e.target.value })} className="flex-1 px-2 py-1.5 text-sm rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-950" />
                </div>
              )}
              {(createForm.surface === 'EMAIL_OUTREACH' || createForm.surface === 'REVIEW_OUTREACH') && (
                <input placeholder="CustomerSegment id (optional)" value={createForm.segmentId} onChange={(e) => setCreateForm({ ...createForm, segmentId: e.target.value })} className="w-full px-2 py-1.5 text-sm rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-950" />
              )}
              {['SP', 'SB', 'SD', 'PROMOTED_LISTINGS', 'SHOPPING_FEED'].includes(createForm.surface) && (
                <input placeholder="Daily budget € (optional)" value={createForm.budgetEur} onChange={(e) => setCreateForm({ ...createForm, budgetEur: e.target.value })} className="w-full px-2 py-1.5 text-sm rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-950" />
              )}
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setShowCreate(false)} className="px-3 py-1.5 text-sm rounded border border-default dark:border-slate-700">Cancel</button>
              <button onClick={createCampaign} disabled={!createForm.name} className="px-3 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">Create draft</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
