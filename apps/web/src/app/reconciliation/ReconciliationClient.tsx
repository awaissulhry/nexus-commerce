'use client'

import { useState, useCallback, useTransition, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { getBackendUrl } from '@/lib/backend-url'
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Link2,
  RefreshCw,
  Play,
  ChevronLeft,
  ChevronRight,
  Zap,
  Download,
  ExternalLink,
} from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────────────────

interface ReconStats {
  byStatus: Record<string, number>
  byMarket?: Record<string, Record<string, number>>
  matchMethods: Record<string, number>
  total: number
}

interface ReconRow {
  id: string
  channel: string
  marketplace: string
  externalSku: string
  externalListingId: string | null
  parentAsin: string | null
  title: string | null
  channelPrice: number | null
  channelQuantity: number | null
  channelStatus: string | null
  matchedProductId: string | null
  matchedVariationId: string | null
  matchMethod: string | null
  matchConfidence: number | null
  reconciliationStatus: string
  conflictNotes: string | null
  reviewedBy: string | null
  reviewedAt: string | null
  importedAt: string | null
  runId: string
  createdAt: string
  matchedProduct: { id: string; sku: string; name: string; variationTheme?: string } | null
  matchedVariation: { id: string; sku: string; variationAttributes: Record<string, string> | null } | null
  isVariationChild: boolean
}

interface ReconPage {
  rows: ReconRow[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

interface Props {
  channel: string
  marketplace: string
  initialStats: ReconStats | null
  initialItems: ReconPage | null
}

// ── Helpers ───────────────────────────────────────────────────────────────

const CHANNEL_OPTIONS = ['AMAZON', 'EBAY']
const MARKETPLACE_OPTIONS = ['ALL', 'IT', 'DE', 'FR', 'ES', 'UK']
const STATUS_OPTIONS = ['PENDING', 'CONFIRMED', 'CONFLICT', 'IGNORE', 'CREATE_NEW']

const MARKET_COLORS: Record<string, string> = {
  IT: 'bg-green-100 text-green-700',
  DE: 'bg-blue-100 text-blue-700',
  FR: 'bg-purple-100 text-purple-700',
  ES: 'bg-orange-100 text-orange-700',
  UK: 'bg-gray-100 text-gray-600',
}

function marketBadge(mp: string) {
  return (
    <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${MARKET_COLORS[mp] ?? 'bg-gray-100 text-gray-600'}`}>
      {mp}
    </span>
  )
}

function confidenceBadge(confidence: number | null, method: string | null) {
  if (!method || method === 'UNMATCHED') {
    return <span className="px-2 py-0.5 rounded text-xs bg-red-100 text-red-700 font-medium">Unmatched</span>
  }
  const pct = Math.round((confidence ?? 0) * 100)
  const color =
    pct >= 95 ? 'bg-green-100 text-green-700' :
    pct >= 80 ? 'bg-amber-100 text-amber-700' :
    'bg-orange-100 text-orange-700'
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${color}`}>
      {method} {pct}%
    </span>
  )
}

function statusBadge(status: string) {
  const map: Record<string, string> = {
    PENDING: 'bg-blue-50 text-blue-700',
    CONFIRMED: 'bg-green-50 text-green-700',
    CONFLICT: 'bg-red-50 text-red-700',
    IGNORE: 'bg-gray-100 text-gray-500',
    CREATE_NEW: 'bg-purple-50 text-purple-700',
  }
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${map[status] ?? 'bg-gray-100 text-gray-600'}`}>
      {status}
    </span>
  )
}

// ── Main component ────────────────────────────────────────────────────────

export default function ReconciliationClient({
  channel: initialChannel,
  marketplace: initialMarketplace,
  initialStats,
  initialItems,
}: Props) {
  const backend = getBackendUrl()
  const [channel, setChannel] = useState(initialChannel)
  const [marketplace, setMarketplace] = useState(initialMarketplace)
  const [statusFilter, setStatusFilter] = useState('PENDING')
  const [stats, setStats] = useState<ReconStats | null>(initialStats)
  const [itemPage, setItemPage] = useState<ReconPage | null>(initialItems)
  const [page, setPage] = useState(1)
  const [runMsg, setRunMsg] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const [actionMsg, setActionMsg] = useState<Record<string, string>>({})
  const [linkTarget, setLinkTarget] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'reconciliation' | 'pull' | 'propagate'>('reconciliation')
  const router = useRouter()
  const [linkProductId, setLinkProductId] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkMsg, setBulkMsg] = useState<string | null>(null)

  const refreshStats = useCallback(async (ch: string, mp: string) => {
    const url = `${backend}/api/reconciliation/stats?channel=${ch}&marketplace=${mp}`
    const res = await fetch(url, { cache: 'no-store' }).catch(() => null)
    if (res?.ok) setStats(await res.json().catch(() => null))
  }, [backend])

  const refreshItems = useCallback(async (p: number, status: string, ch: string, mp: string) => {
    const res = await fetch(
      `${backend}/api/reconciliation/items?channel=${ch}&marketplace=${mp}&status=${status}&page=${p}&pageSize=100`,
      { cache: 'no-store' }
    ).catch(() => null)
    if (res?.ok) {
      setItemPage(await res.json().catch(() => null))
      setSelected(new Set())
    }
  }, [backend])

  const refresh = useCallback((p = page, s = statusFilter, ch = channel, mp = marketplace) => {
    startTransition(async () => {
      await Promise.all([refreshStats(ch, mp), refreshItems(p, s, ch, mp)])
    })
  }, [page, statusFilter, channel, marketplace, refreshStats, refreshItems]) // eslint-disable-line

  // ── Run reconciliation ────────────────────────────────────────────────

  const handleRun = (allMarkets: boolean) => {
    startTransition(async () => {
      const mp = allMarkets ? 'ALL' : marketplace
      const label = allMarkets ? 'all markets (IT/DE/FR/ES/UK)' : `Amazon ${marketplace}`
      setRunMsg(`Running reconciliation for ${label}… (each market takes ~5 min — please wait)`)
      const res = await fetch(`${backend}/api/reconciliation/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, marketplace: mp }),
      }).catch(() => null)
      if (res?.ok) {
        const data = await res.json()
        if (data.allMarkets) {
          const perMarket = (data.markets ?? []).map((m: any) =>
            `${m.marketplace}: ${m.totalDiscovered}${m.fetchMethod === 'listings-api' ? ' (API)' : m.fetchMethod === 'empty' ? ' (none)' : ''}${m.enriched ? ` ✓${m.enriched}` : ''}`
          ).join(' · ')
          const errors = data.errors ?? []
          const errStr = errors.length > 0 ? ` ⚠ ${errors.map((e: any) => `${e.marketplace}: ${e.error.slice(0, 60)}`).join('; ')}` : ''
          setRunMsg(`Done ✓ — ${data.totalDiscovered} discovered · ${data.totalMatched} matched · ${Math.round(data.durationMs / 60000)}min | ${perMarket}${errStr}`)
        } else {
          const s = data.summary
          const method = s.fetchMethod === 'listings-api' ? ' (via Listings API)' : s.fetchMethod === 'empty' ? ' (no listings found)' : ''
          setRunMsg(`Done ✓ — ${s.totalDiscovered} discovered · ${s.matched} matched · ${s.unmatched} unmatched${method}`)
        }
      } else {
        const err = await res?.json().catch(() => null)
        setRunMsg(`Error: ${err?.error ?? 'Unknown failure'}`)
      }
      refresh(1, statusFilter, channel, marketplace)
      setPage(1)
    })
  }

  // ── Bulk actions ─────────────────────────────────────────────────────

  const handleBulkConfirm = async () => {
    const ids = [...selected]
    setBulkMsg(`Confirming ${ids.length} rows…`)
    const res = await fetch(`${backend}/api/reconciliation/bulk/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, reviewedBy: 'operator' }),
    }).catch(() => null)
    if (res?.ok) {
      const d = await res.json()
      setBulkMsg(`✓ Confirmed ${d.succeeded}${d.failed > 0 ? ` · ${d.failed} failed` : ''}`)
    } else setBulkMsg('Confirm failed')
    refresh(page, statusFilter, channel, marketplace)
  }

  const handleBulkIgnore = async () => {
    const ids = [...selected]
    setBulkMsg(`Ignoring ${ids.length} rows…`)
    const res = await fetch(`${backend}/api/reconciliation/bulk/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, status: 'IGNORE', reviewedBy: 'operator' }),
    }).catch(() => null)
    if (res?.ok) {
      const d = await res.json()
      setBulkMsg(`✓ Ignored ${d.succeeded}`)
    } else setBulkMsg('Ignore failed')
    refresh(page, statusFilter, channel, marketplace)
  }

  const handleConfirmAllHigh = async () => {
    setBulkMsg('Confirming all high-confidence (≥95%) rows…')
    const res = await fetch(`${backend}/api/reconciliation/bulk/confirm-all-high`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, marketplace: marketplace === 'ALL' ? undefined : marketplace, reviewedBy: 'operator' }),
    }).catch(() => null)
    if (res?.ok) {
      const d = await res.json()
      setBulkMsg(`✓ Confirmed ${d.succeeded} high-confidence rows${d.failed > 0 ? ` · ${d.failed} failed` : ''}`)
    } else setBulkMsg('Confirm-all failed')
    refresh(1, statusFilter, channel, marketplace)
    setPage(1)
  }

  // ── Single-row actions ────────────────────────────────────────────────

  const handleConfirm = async (id: string) => {
    setActionMsg(prev => ({ ...prev, [id]: 'Confirming…' }))
    const res = await fetch(`${backend}/api/reconciliation/items/${id}/confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviewedBy: 'operator' }),
    }).catch(() => null)
    setActionMsg(prev => ({ ...prev, [id]: res?.ok ? '✓ Confirmed' : 'Error' }))
    if (res?.ok) refresh(page, statusFilter, channel, marketplace)
  }

  const handleSetStatus = async (id: string, status: string) => {
    setActionMsg(prev => ({ ...prev, [id]: 'Saving…' }))
    const res = await fetch(`${backend}/api/reconciliation/items/${id}/status`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, reviewedBy: 'operator' }),
    }).catch(() => null)
    setActionMsg(prev => ({ ...prev, [id]: res?.ok ? `✓ ${status}` : 'Error' }))
    if (res?.ok) refresh(page, statusFilter, channel, marketplace)
  }

  const handleLink = async (id: string) => {
    if (!linkProductId.trim()) return
    setActionMsg(prev => ({ ...prev, [id]: 'Linking…' }))
    const res = await fetch(`${backend}/api/reconciliation/items/${id}/link`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: linkProductId.trim(), reviewedBy: 'operator' }),
    }).catch(() => null)
    setActionMsg(prev => ({ ...prev, [id]: res?.ok ? '✓ Linked' : 'Error' }))
    if (res?.ok) { setLinkTarget(null); setLinkProductId(''); refresh(page, statusFilter, channel, marketplace) }
  }

  const handleChannelChange = (ch: string) => {
    setChannel(ch); setPage(1); setSelected(new Set())
    refresh(1, statusFilter, ch, marketplace)
  }
  const handleMarketplace = (mp: string) => {
    setMarketplace(mp); setPage(1); setSelected(new Set())
    refresh(1, statusFilter, channel, mp)
  }
  const handleStatusFilter = (s: string) => {
    setStatusFilter(s); setPage(1); setSelected(new Set())
    refresh(1, s, channel, marketplace)
  }
  const handlePageChange = (p: number) => {
    setPage(p); setSelected(new Set())
    refresh(p, statusFilter, channel, marketplace)
  }

  const rows = itemPage?.rows ?? []
  const totalRows = itemPage?.total ?? 0
  const totalPages = itemPage?.totalPages ?? 1

  const pending = stats?.byStatus?.PENDING ?? 0
  const confirmed = stats?.byStatus?.CONFIRMED ?? 0
  const conflict = stats?.byStatus?.CONFLICT ?? 0
  const ignored = stats?.byStatus?.IGNORE ?? 0
  const total = stats?.total ?? 0

  const highConfPending = rows.filter(r => r.reconciliationStatus === 'PENDING' && (r.matchConfidence ?? 0) >= 0.95 && r.matchedProductId && r.externalListingId).length
  const allSelected = selected.size === rows.length && rows.length > 0

  const TABS = [
    { id: 'reconciliation' as const, label: 'Reconciliation' },
    { id: 'pull' as const, label: 'Pull from Amazon' },
    { id: 'propagate' as const, label: 'Propagate to markets' },
  ]

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b px-6 pt-4">
        <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Listing Reconciliation</h1>
            <p className="text-sm text-gray-500 mt-0.5">
              Match, pull, and propagate Amazon listing data across all markets.
            </p>
          </div>
        </div>
        {/* Tab nav */}
        <div className="flex gap-0">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-5 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${
                activeTab === tab.id
                  ? 'border-blue-600 text-blue-700'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="px-6 py-4 max-w-screen-xl mx-auto">

      {/* ── Reconciliation tab ── */}
      {activeTab === 'reconciliation' && (<>
        {/* Run buttons */}
        <div className="flex gap-2 mb-5">
          <button
            onClick={() => handleRun(false)}
            disabled={isPending || marketplace === 'ALL'}
            className="flex items-center gap-2 px-3 py-2 border bg-white text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50 disabled:opacity-40"
          >
            {isPending ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            Run {marketplace !== 'ALL' ? marketplace : '…'}
          </button>
          <button
            onClick={() => handleRun(true)}
            disabled={isPending}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            {isPending ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
            Run ALL markets
          </button>
        </div>
        {runMsg && (
          <div className={`mb-4 px-4 py-2 rounded-lg text-sm ${runMsg.startsWith('Done') ? 'bg-green-50 text-green-800' : runMsg.startsWith('Error') ? 'bg-red-50 text-red-800' : 'bg-blue-50 text-blue-800'}`}>
            {runMsg}
          </div>
        )}

        {/* Channel + Marketplace selector */}
        <div className="flex gap-4 mb-5 flex-wrap">
          <div className="flex gap-1">
            {CHANNEL_OPTIONS.map(ch => (
              <button key={ch} onClick={() => handleChannelChange(ch)}
                className={`px-3 py-1.5 rounded border text-sm font-medium transition-colors ${channel === ch ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'}`}>
                {ch}
              </button>
            ))}
          </div>
          <div className="flex gap-1">
            {MARKETPLACE_OPTIONS.map(mp => (
              <button key={mp} onClick={() => handleMarketplace(mp)}
                className={`px-3 py-1.5 rounded border text-sm font-medium transition-colors ${marketplace === mp ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'}`}>
                {mp}
              </button>
            ))}
          </div>
        </div>

        {/* Stats strip — per-market breakdown when ALL */}
        <div className="grid grid-cols-5 gap-3 mb-5">
          {[
            { label: 'Total', value: total, color: 'text-gray-900' },
            { label: 'Pending', value: pending, color: 'text-blue-700' },
            { label: 'Confirmed', value: confirmed, color: 'text-green-700' },
            { label: 'Conflict', value: conflict, color: 'text-red-700' },
            { label: 'Ignored', value: ignored, color: 'text-gray-500' },
          ].map(({ label, value, color }) => (
            <div key={label} className="bg-white border rounded-lg px-4 py-3">
              <div className={`text-2xl font-semibold ${color}`}>{value ?? '—'}</div>
              <div className="text-xs text-gray-500 mt-0.5">{label}</div>
            </div>
          ))}
        </div>

        {/* Per-market breakdown (only when ALL is selected) */}
        {marketplace === 'ALL' && stats?.byMarket && Object.keys(stats.byMarket).length > 0 && (
          <div className="grid grid-cols-5 gap-2 mb-5">
            {Object.entries(stats.byMarket).map(([mp, statusCounts]) => (
              <div key={mp} className="bg-white border rounded-lg px-3 py-2 text-xs">
                <div className="flex items-center gap-1.5 mb-1.5">{marketBadge(mp)}</div>
                {Object.entries(statusCounts).map(([s, n]) => (
                  <div key={s} className="flex justify-between text-gray-600">
                    <span>{s}</span><span className="font-medium">{n}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}

        {/* Bulk action bar — appears when rows are selected or in PENDING view */}
        {statusFilter === 'PENDING' && pending > 0 && (
          <div className="bg-white border rounded-lg px-4 py-3 mb-4 flex items-center gap-3 flex-wrap">
            <span className="text-sm text-gray-600 font-medium">Bulk actions:</span>

            {highConfPending > 0 && (
              <button onClick={handleConfirmAllHigh}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 text-white rounded text-sm font-medium hover:bg-green-700">
                <CheckCircle2 className="w-4 h-4" />
                Confirm all high-confidence ({highConfPending} this page)
              </button>
            )}

            {selected.size > 0 && (
              <>
                <button onClick={handleBulkConfirm}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 text-white rounded text-sm font-medium hover:bg-green-700">
                  <CheckCircle2 className="w-4 h-4" /> Confirm {selected.size}
                </button>
                <button onClick={handleBulkIgnore}
                  className="flex items-center gap-1.5 px-3 py-1.5 border text-gray-600 rounded text-sm hover:bg-gray-50">
                  <XCircle className="w-4 h-4" /> Ignore {selected.size}
                </button>
                <button onClick={() => setSelected(new Set())}
                  className="text-sm text-gray-400 hover:text-gray-600">
                  Clear
                </button>
              </>
            )}

            {bulkMsg && (
              <span className={`text-sm px-3 py-1 rounded ${bulkMsg.startsWith('✓') ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
                {bulkMsg}
              </span>
            )}
          </div>
        )}

        {/* Status filter tabs */}
        <div className="flex gap-1 mb-4 border-b">
          {STATUS_OPTIONS.map(s => (
            <button key={s} onClick={() => handleStatusFilter(s)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px ${statusFilter === s ? 'border-blue-600 text-blue-700' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
              {s}
              {s === 'PENDING' && pending > 0 && (
                <span className="ml-1.5 px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded-full text-xs">{pending}</span>
              )}
            </button>
          ))}
        </div>

        {/* Items table */}
        <div className="bg-white border rounded-lg overflow-hidden">
          {rows.length === 0 ? (
            <div className="py-16 text-center text-gray-400">
              {total === 0
                ? 'No listings discovered yet. Click "Run ALL markets" to pull from Amazon.'
                : `No rows with status ${statusFilter}.`}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="px-3 py-3 w-10">
                    <input type="checkbox" className="rounded"
                      checked={allSelected}
                      onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map(r => r.id)))} />
                  </th>
                  <th className="px-3 py-3 text-left font-medium text-gray-600 w-12">Mkt</th>
                  <th className="px-3 py-3 text-left font-medium text-gray-600 w-44">Channel SKU / ASIN</th>
                  <th className="px-3 py-3 text-left font-medium text-gray-600">Title</th>
                  <th className="px-3 py-3 text-left font-medium text-gray-600 w-28">Price / Qty</th>
                  <th className="px-3 py-3 text-left font-medium text-gray-600 w-48">Matched product</th>
                  <th className="px-3 py-3 text-left font-medium text-gray-600 w-32">Confidence</th>
                  <th className="px-3 py-3 text-left font-medium text-gray-600 w-28">Status</th>
                  <th className="px-3 py-3 text-left font-medium text-gray-600 w-48">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map(row => (
                  <tr key={row.id} className={`hover:bg-gray-50 ${selected.has(row.id) ? 'bg-blue-50' : ''}`}>
                    <td className="px-3 py-2.5">
                      <input type="checkbox" className="rounded"
                        checked={selected.has(row.id)}
                        onChange={e => {
                          const next = new Set(selected)
                          if (e.target.checked) next.add(row.id); else next.delete(row.id)
                          setSelected(next)
                        }} />
                    </td>
                    <td className="px-3 py-2.5">{marketBadge(row.marketplace)}</td>
                    <td className="px-3 py-2.5 font-mono text-xs text-gray-700">
                      <div className="truncate max-w-[10rem]" title={row.externalSku}>{row.externalSku}</div>
                      {row.externalListingId && (
                        <div className="text-gray-400 truncate max-w-[10rem]" title={row.externalListingId}>
                          {row.externalListingId}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-gray-700">
                      <div className="line-clamp-2 text-xs">{row.title ?? '—'}</div>
                    </td>
                    <td className="px-3 py-2.5 text-gray-700 text-xs">
                      {row.channelPrice != null ? `€${Number(row.channelPrice).toFixed(2)}` : '—'}
                      <div className="text-gray-400">qty {row.channelQuantity ?? '—'}</div>
                    </td>
                    <td className="px-3 py-2.5 text-xs">
                      {row.matchedProduct ? (
                        <div>
                          <div className="font-medium text-gray-800 truncate max-w-[11rem]" title={row.matchedProduct.name}>
                            {row.matchedProduct.name}
                          </div>
                          {row.matchedVariation && row.matchedVariation.variationAttributes ? (
                            <div className="text-blue-600 font-mono text-xs">
                              {Object.entries(row.matchedVariation.variationAttributes as Record<string,string>)
                                .map(([k, v]) => `${k}: ${v}`).join(' · ')}
                            </div>
                          ) : (
                            <div className="text-gray-400 font-mono">{row.matchedProduct.sku}</div>
                          )}
                          {row.isVariationChild && row.parentAsin && (
                            <div className="text-gray-300 font-mono text-xs">Parent: {row.parentAsin}</div>
                          )}
                        </div>
                      ) : (
                        <span className="text-gray-400 italic">No match</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      {confidenceBadge(row.matchConfidence, row.matchMethod)}
                    </td>
                    <td className="px-3 py-2.5">
                      {statusBadge(row.reconciliationStatus)}
                    </td>
                    <td className="px-3 py-2.5">
                      {actionMsg[row.id] ? (
                        <span className="text-xs text-gray-600">{actionMsg[row.id]}</span>
                      ) : linkTarget === row.id ? (
                        <div className="flex gap-1.5 items-center">
                          <input value={linkProductId} onChange={e => setLinkProductId(e.target.value)}
                            placeholder="Product ID"
                            className="border rounded px-2 py-1 text-xs w-28 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                          <button onClick={() => handleLink(row.id)} className="text-xs text-blue-700 hover:underline">Save</button>
                          <button onClick={() => { setLinkTarget(null); setLinkProductId('') }} className="text-xs text-gray-400 hover:underline">✕</button>
                        </div>
                      ) : (
                        <div className="flex gap-1 flex-wrap">
                          {row.reconciliationStatus === 'PENDING' && row.matchedProductId && row.externalListingId && (
                            <button onClick={() => handleConfirm(row.id)}
                              className="flex items-center gap-1 px-2 py-1 bg-green-600 text-white rounded text-xs hover:bg-green-700">
                              <CheckCircle2 className="w-3 h-3" /> Confirm
                            </button>
                          )}
                          <button onClick={() => { setLinkTarget(row.id); setLinkProductId('') }}
                            className="flex items-center gap-1 px-2 py-1 bg-white border text-gray-600 rounded text-xs hover:bg-gray-50">
                            <Link2 className="w-3 h-3" /> Link
                          </button>
                          {row.reconciliationStatus !== 'IGNORE' && (
                            <button onClick={() => handleSetStatus(row.id, 'IGNORE')}
                              className="flex items-center gap-1 px-2 py-1 bg-white border text-gray-500 rounded text-xs hover:bg-gray-50">
                              <XCircle className="w-3 h-3" /> Ignore
                            </button>
                          )}
                          {row.reconciliationStatus !== 'CONFLICT' && (
                            <button onClick={() => handleSetStatus(row.id, 'CONFLICT')}
                              className="flex items-center gap-1 px-2 py-1 bg-white border text-amber-600 rounded text-xs hover:bg-amber-50">
                              <AlertTriangle className="w-3 h-3" /> Flag
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="px-4 py-3 border-t flex items-center justify-between bg-gray-50">
              <span className="text-xs text-gray-500">{totalRows} rows · page {page} of {totalPages}</span>
              <div className="flex gap-2">
                <button onClick={() => handlePageChange(page - 1)} disabled={page <= 1}
                  className="p-1.5 rounded border bg-white hover:bg-gray-50 disabled:opacity-40">
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <button onClick={() => handlePageChange(page + 1)} disabled={page >= totalPages}
                  className="p-1.5 rounded border bg-white hover:bg-gray-50 disabled:opacity-40">
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Instructions */}
        {total === 0 && !isPending && (
          <div className="mt-6 bg-blue-50 border border-blue-200 rounded-lg p-5 text-sm">
            <h3 className="font-medium text-blue-900 mb-2">How to reconcile all markets in one go</h3>
            <ol className="list-decimal list-inside space-y-1 text-blue-800">
              <li>Click <strong>Run ALL markets</strong> — fetches live listings from Amazon IT/DE/FR/ES/UK (~5 min each = ~25 min total).</li>
              <li>Switch to <strong>ALL</strong> marketplace view to see everything at once.</li>
              <li>Click <strong>Confirm all high-confidence</strong> — approves every SKU-exact match in one click.</li>
              <li>Review remaining rows (amber = ASIN match, red = unmatched) individually — Link or Ignore as needed.</li>
            </ol>
          </div>
        )}

      </>)}

      {/* ── Pull from Amazon tab ── */}
      {activeTab === 'pull' && <PullTab backend={backend} router={router} />}

      {/* ── Propagate tab ── */}
      {activeTab === 'propagate' && <PropagateTab backend={backend} router={router} />}

      </div>
    </div>
  )
}

// ── Shared helpers ─────────────────────────────────────────────────────────

const ALL_MARKETS = ['IT', 'DE', 'FR', 'ES', 'UK']

function useProductTypes(backend: string) {
  const [types, setTypes] = useState<string[]>([])
  useEffect(() => {
    fetch(`${backend}/api/reconciliation/product-types`)
      .then((r) => r.ok ? r.json() : { types: [] })
      .then((d) => setTypes(d.types ?? []))
      .catch(() => {})
  }, [backend])
  return types
}

function ProductTypeSelect({ value, onChange, types }: { value: string; onChange: (v: string) => void; types: string[] }) {
  return types.length > 0 ? (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="px-2.5 py-1.5 text-sm border border-gray-300 rounded bg-white text-gray-800 focus:outline-none focus:ring-1 focus:ring-blue-500 w-40"
    >
      <option value="">Select type…</option>
      {types.map((t) => <option key={t} value={t}>{t}</option>)}
    </select>
  ) : (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value.toUpperCase())}
      placeholder="e.g. OUTERWEAR"
      className="px-2.5 py-1.5 text-sm border border-gray-300 rounded bg-white text-gray-800 focus:outline-none focus:ring-1 focus:ring-blue-500 w-40"
    />
  )
}

function ProgressBar({ pct }: { pct: number }) {
  return (
    <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
      <div className="h-full bg-blue-500 rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
    </div>
  )
}

// ── Pull from Amazon tab ───────────────────────────────────────────────────

interface SinglePullJob {
  jobId: string; marketplace: string; productType: string
  status: 'running' | 'done' | 'failed'
  progress: number; total: number; pulled: number; skipped: number; failed: number
  errors: Array<{ sku: string; error: string }>; rows: any[]; fatalError?: string
}

interface AllMarketsPullJob {
  jobId: string; productType: string; markets: string[]; currentMarket: string | null
  status: 'running' | 'done' | 'failed'
  perMarket: Record<string, SinglePullJob | null>; fatalError?: string
}

function PullTab({ backend, router }: { backend: string; router: ReturnType<typeof useRouter> }) {
  const productTypes = useProductTypes(backend)
  const [mode, setMode] = useState<'single' | 'all'>('all')
  const [market, setMarket] = useState('IT')
  const [productType, setProductType] = useState('')
  const [singleJob, setSingleJob] = useState<SinglePullJob | null>(null)
  const [allJob, setAllJob] = useState<AllMarketsPullJob | null>(null)
  const [starting, setStarting] = useState(false)
  const [errMsg, setErrMsg] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Poll single job
  useEffect(() => {
    if (!singleJob || singleJob.status !== 'running') {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
      return
    }
    pollRef.current = setInterval(async () => {
      const res = await fetch(`${backend}/api/reconciliation/flat-file-pull/status/${singleJob.jobId}`).catch(() => null)
      if (res?.ok) setSingleJob(await res.json())
    }, 3000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [singleJob?.jobId, singleJob?.status, backend]) // eslint-disable-line

  // Poll all-markets job
  useEffect(() => {
    if (!allJob || allJob.status !== 'running') {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
      return
    }
    pollRef.current = setInterval(async () => {
      const res = await fetch(`${backend}/api/reconciliation/flat-file-pull/status-all/${allJob.jobId}`).catch(() => null)
      if (res?.ok) setAllJob(await res.json())
    }, 3000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [allJob?.jobId, allJob?.status, backend]) // eslint-disable-line

  async function handleStart() {
    if (!productType.trim()) { setErrMsg('Select a product type'); return }
    setErrMsg(null); setStarting(true); setSingleJob(null); setAllJob(null)
    try {
      if (mode === 'all') {
        const res = await fetch(`${backend}/api/reconciliation/flat-file-pull/start-all`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ productType: productType.trim().toUpperCase(), markets: ALL_MARKETS }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? 'Start failed')
        const s = await fetch(`${backend}/api/reconciliation/flat-file-pull/status-all/${data.jobId}`).catch(() => null)
        setAllJob(s?.ok ? await s.json() : { ...data, status: 'running', perMarket: {}, markets: ALL_MARKETS, currentMarket: null })
      } else {
        const res = await fetch(`${backend}/api/reconciliation/flat-file-pull/start`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ marketplace: market, productType: productType.trim().toUpperCase() }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? 'Start failed')
        const s = await fetch(`${backend}/api/reconciliation/flat-file-pull/status/${data.jobId}`).catch(() => null)
        setSingleJob(s?.ok ? await s.json() : { ...data, status: 'running', progress: 0, total: 0, pulled: 0, skipped: 0, failed: 0, errors: [], rows: [] })
      }
    } catch (e: any) {
      setErrMsg(e?.message ?? 'Failed to start')
    } finally {
      setStarting(false)
    }
  }

  function openFlatFile(mp: string, pt: string, rows: any[]) {
    try { localStorage.setItem(`ff-rows-${mp.toUpperCase()}-${pt.toUpperCase()}`, JSON.stringify(rows)) } catch {}
    router.push(`/products/amazon-flat-file?marketplace=${mp}&productType=${pt}`)
  }

  const isRunning = (singleJob?.status === 'running') || (allJob?.status === 'running')

  return (
    <div className="space-y-6">
      <div className="bg-white border rounded-xl p-6">
        <div className="flex items-center gap-2 mb-5">
          <Download className="w-4 h-4 text-blue-600" />
          <h2 className="text-base font-semibold text-gray-900">Pull from Amazon</h2>
          <span className="text-sm text-gray-400">Fetches all listing attributes per SKU and pre-fills the flat file editor</span>
        </div>

        {/* Mode toggle */}
        <div className="flex gap-2 mb-5">
          {[{ id: 'all', label: 'All markets (IT/DE/FR/ES/UK)' }, { id: 'single', label: 'Single market' }].map((m) => (
            <button key={m.id} type="button" onClick={() => setMode(m.id as 'all' | 'single')}
              className={`px-3 py-1.5 text-sm rounded border transition-colors ${mode === m.id ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'}`}>
              {m.label}
            </button>
          ))}
        </div>

        <div className="flex items-end gap-3 flex-wrap">
          {mode === 'single' && (
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Marketplace</label>
              <div className="flex gap-1">
                {ALL_MARKETS.map((mp) => (
                  <button key={mp} type="button" onClick={() => setMarket(mp)}
                    className={`px-2.5 py-1.5 text-sm rounded border transition-colors font-medium ${market === mp ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'}`}>
                    {mp}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Product Type</label>
            <ProductTypeSelect value={productType} onChange={setProductType} types={productTypes} />
          </div>

          <button type="button" onClick={handleStart} disabled={starting || isRunning}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white text-sm font-medium rounded-lg transition-colors">
            {starting || isRunning ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            {isRunning ? 'Pulling…' : 'Pull from Amazon'}
          </button>
        </div>

        {errMsg && <p className="mt-3 text-sm text-red-600">{errMsg}</p>}

        {/* Single job progress */}
        {singleJob && (
          <div className="mt-5 space-y-3">
            {singleJob.status === 'running' && (
              <>
                <div className="flex justify-between text-sm text-gray-500">
                  <span>Pulling {singleJob.marketplace} · {singleJob.progress} / {singleJob.total || '?'} SKUs</span>
                  <span>{singleJob.total > 0 ? Math.round(singleJob.progress / singleJob.total * 100) : 0}%</span>
                </div>
                <ProgressBar pct={singleJob.total > 0 ? singleJob.progress / singleJob.total * 100 : 0} />
              </>
            )}
            {singleJob.status === 'done' && (
              <div className="flex items-center gap-4 text-sm flex-wrap">
                <span className="flex items-center gap-1 text-green-700"><CheckCircle2 className="w-4 h-4" />{singleJob.pulled} pulled</span>
                {singleJob.skipped > 0 && <span className="text-gray-400">{singleJob.skipped} not on {singleJob.marketplace}</span>}
                {singleJob.failed > 0 && <span className="text-amber-600">{singleJob.failed} failed</span>}
                {singleJob.rows.length > 0 && (
                  <button type="button" onClick={() => openFlatFile(singleJob.marketplace, singleJob.productType, singleJob.rows)}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white text-sm rounded-lg">
                    <ExternalLink className="w-4 h-4" />Open {singleJob.marketplace} flat file →
                  </button>
                )}
              </div>
            )}
            {singleJob.status === 'failed' && <p className="text-sm text-red-600">⚠ {singleJob.fatalError ?? 'Job failed'}</p>}
          </div>
        )}

        {/* All-markets job progress */}
        {allJob && (
          <div className="mt-5 space-y-3">
            {allJob.status === 'running' && allJob.currentMarket && (
              <p className="text-sm text-gray-500 flex items-center gap-2">
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                Currently pulling {allJob.currentMarket}…
              </p>
            )}
            <div className="space-y-2">
              {ALL_MARKETS.map((mp) => {
                const mJob = allJob.perMarket[mp]
                if (!mJob) return (
                  <div key={mp} className="flex items-center gap-3 text-sm text-gray-400">
                    <span className="w-8 font-medium">{mp}</span>
                    <span>{allJob.currentMarket === mp ? 'Starting…' : 'Waiting…'}</span>
                  </div>
                )
                const pct = mJob.total > 0 ? Math.round(mJob.progress / mJob.total * 100) : 0
                return (
                  <div key={mp} className="space-y-1">
                    <div className="flex items-center gap-3 text-sm">
                      <span className="w-8 font-medium text-gray-700">{mp}</span>
                      {mJob.status === 'running' && <span className="text-gray-500">{mJob.progress} / {mJob.total} · {pct}%</span>}
                      {mJob.status === 'done' && <>
                        <span className="text-green-700 flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5" />{mJob.pulled} pulled</span>
                        {mJob.skipped > 0 && <span className="text-gray-400">{mJob.skipped} skipped</span>}
                        {mJob.failed > 0 && <span className="text-amber-600">{mJob.failed} failed</span>}
                        {mJob.rows.length > 0 && (
                          <button type="button" onClick={() => openFlatFile(mp, allJob.productType, mJob.rows)}
                            className="flex items-center gap-1 px-2 py-0.5 bg-green-600 hover:bg-green-700 text-white text-xs rounded">
                            <ExternalLink className="w-3 h-3" />Open →
                          </button>
                        )}
                      </>}
                      {mJob.status === 'failed' && <span className="text-red-600">{mJob.fatalError ?? 'Failed'}</span>}
                    </div>
                    {mJob.status === 'running' && <ProgressBar pct={pct} />}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        <p className="mt-5 text-xs text-gray-400">
          Rate-limited automatically by the SP client. ~2–5 min per market for a ~280-SKU catalog.
        </p>
      </div>
    </div>
  )
}

// ── Propagate to markets tab ───────────────────────────────────────────────

interface PropagateMarketState {
  status: 'pending' | 'running' | 'done' | 'failed'
  phase: string; translated: number; total: number; errors: string[]; rows: any[]
}
interface PropagateJob {
  jobId: string; sourceMarket: string; targetMarkets: string[]; productType: string
  options: { translateText: boolean; translateEnums: boolean }
  status: 'running' | 'done' | 'failed'
  markets: Record<string, PropagateMarketState>
  fatalError?: string
}

function PropagateTab({ backend, router }: { backend: string; router: ReturnType<typeof useRouter> }) {
  const productTypes = useProductTypes(backend)
  const [sourceMarket, setSourceMarket] = useState('IT')
  const [targetMarkets, setTargetMarkets] = useState<Set<string>>(new Set(['DE', 'FR', 'ES', 'UK']))
  const [productType, setProductType] = useState('')
  const [translateText, setTranslateText] = useState(true)
  const [translateEnums, setTranslateEnums] = useState(true)
  const [job, setJob] = useState<PropagateJob | null>(null)
  const [starting, setStarting] = useState(false)
  const [errMsg, setErrMsg] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (!job || job.status !== 'running') {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
      return
    }
    pollRef.current = setInterval(async () => {
      const res = await fetch(`${backend}/api/reconciliation/propagate/status/${job.jobId}`).catch(() => null)
      if (res?.ok) setJob(await res.json())
    }, 3000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [job?.jobId, job?.status, backend]) // eslint-disable-line

  function toggleTarget(mp: string) {
    setTargetMarkets((prev) => {
      const next = new Set(prev)
      if (next.has(mp)) next.delete(mp); else next.add(mp)
      return next
    })
  }

  async function handleStart() {
    if (!productType.trim()) { setErrMsg('Select a product type'); return }
    if (!targetMarkets.size) { setErrMsg('Select at least one target market'); return }
    setErrMsg(null); setStarting(true); setJob(null)
    try {
      const res = await fetch(`${backend}/api/reconciliation/propagate/start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceMarket,
          targetMarkets: [...targetMarkets],
          productType: productType.trim().toUpperCase(),
          translateText,
          translateEnums,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Start failed')
      const s = await fetch(`${backend}/api/reconciliation/propagate/status/${data.jobId}`).catch(() => null)
      setJob(s?.ok ? await s.json() : { ...data, status: 'running', markets: {} })
    } catch (e: any) {
      setErrMsg(e?.message ?? 'Failed to start')
    } finally {
      setStarting(false)
    }
  }

  function openFlatFile(mp: string, rows: any[]) {
    try { localStorage.setItem(`ff-rows-${mp.toUpperCase()}-${productType.toUpperCase()}`, JSON.stringify(rows)) } catch {}
    router.push(`/products/amazon-flat-file?marketplace=${mp}&productType=${productType}`)
  }

  const PHASE_LABEL: Record<string, string> = {
    copy: 'Copying fields…', text: 'Translating text…',
    enums: 'Translating enum values…', sync: 'Syncing to platform…', idle: '',
  }

  const isRunning = job?.status === 'running'

  return (
    <div className="space-y-6">
      <div className="bg-white border rounded-xl p-6">
        <div className="flex items-center gap-2 mb-5">
          <RefreshCw className="w-4 h-4 text-purple-600" />
          <h2 className="text-base font-semibold text-gray-900">Propagate to markets</h2>
          <span className="text-sm text-gray-400">Copy data from a pulled market to others with AI translation</span>
        </div>

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 mb-5">
          {/* Source market */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-2">Source market (already pulled)</label>
            <div className="flex gap-1 flex-wrap">
              {ALL_MARKETS.map((mp) => (
                <button key={mp} type="button" onClick={() => setSourceMarket(mp)}
                  className={`px-2.5 py-1.5 text-sm rounded border font-medium transition-colors ${sourceMarket === mp ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'}`}>
                  {mp}
                </button>
              ))}
            </div>
          </div>

          {/* Target markets */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-2">Target markets</label>
            <div className="flex gap-1 flex-wrap">
              {ALL_MARKETS.filter((mp) => mp !== sourceMarket).map((mp) => (
                <button key={mp} type="button" onClick={() => toggleTarget(mp)}
                  className={`px-2.5 py-1.5 text-sm rounded border font-medium transition-colors ${targetMarkets.has(mp) ? 'bg-purple-600 text-white border-purple-600' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'}`}>
                  {mp}
                </button>
              ))}
            </div>
          </div>

          {/* Product type */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-2">Product Type</label>
            <ProductTypeSelect value={productType} onChange={setProductType} types={productTypes} />
          </div>
        </div>

        {/* Translation options */}
        <div className="flex gap-6 mb-5">
          <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
            <input type="checkbox" checked={translateText} onChange={(e) => setTranslateText(e.target.checked)}
              className="rounded border-gray-300 text-purple-600 focus:ring-purple-500" />
            Translate text fields (AI)
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
            <input type="checkbox" checked={translateEnums} onChange={(e) => setTranslateEnums(e.target.checked)}
              className="rounded border-gray-300 text-purple-600 focus:ring-purple-500" />
            Translate enum values (AI)
          </label>
        </div>

        <button type="button" onClick={handleStart} disabled={starting || isRunning}
          className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-purple-400 text-white text-sm font-medium rounded-lg transition-colors">
          {starting || isRunning ? <RefreshCw className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          {isRunning ? 'Propagating…' : 'Propagate'}
        </button>

        {errMsg && <p className="mt-3 text-sm text-red-600">{errMsg}</p>}

        {/* Job progress */}
        {job && (
          <div className="mt-5 space-y-2">
            {job.status === 'failed' && !Object.keys(job.markets).length && (
              <p className="text-sm text-red-600">⚠ {job.fatalError ?? 'Job failed'}</p>
            )}
            {Object.entries(job.markets).map(([mp, state]) => (
              <div key={mp} className="space-y-1">
                <div className="flex items-center gap-3 text-sm">
                  <span className="w-8 font-medium text-gray-700">{mp}</span>
                  {state.status === 'pending' && <span className="text-gray-400">Waiting…</span>}
                  {state.status === 'running' && (
                    <span className="text-gray-500 flex items-center gap-1.5">
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      {PHASE_LABEL[state.phase] ?? 'Processing…'}
                    </span>
                  )}
                  {state.status === 'done' && <>
                    <span className="text-green-700 flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5" />{state.translated} rows done</span>
                    {state.rows.length > 0 && (
                      <button type="button" onClick={() => openFlatFile(mp, state.rows)}
                        className="flex items-center gap-1 px-2 py-0.5 bg-green-600 hover:bg-green-700 text-white text-xs rounded">
                        <ExternalLink className="w-3 h-3" />Open →
                      </button>
                    )}
                  </>}
                  {state.status === 'failed' && <span className="text-red-600">{state.errors[0] ?? 'Failed'}</span>}
                </div>
              </div>
            ))}
          </div>
        )}

        <p className="mt-5 text-xs text-gray-400">
          Requires the source market to have been pulled from Amazon first. Text + enum translation uses AI — one call per target market.
        </p>
      </div>
    </div>
  )
}
