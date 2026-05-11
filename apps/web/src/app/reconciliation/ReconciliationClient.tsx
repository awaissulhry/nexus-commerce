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

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b px-6 py-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Listing Reconciliation</h1>
            <p className="text-sm text-gray-500 mt-0.5">
              Match Amazon/eBay live listings to Nexus products before enabling write-back.
            </p>
          </div>
          <div className="flex gap-2">
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
        </div>

        {runMsg && (
          <div className={`mt-3 px-4 py-2 rounded-lg text-sm ${runMsg.startsWith('Done') ? 'bg-green-50 text-green-800' : runMsg.startsWith('Error') ? 'bg-red-50 text-red-800' : 'bg-blue-50 text-blue-800'}`}>
            {runMsg}
          </div>
        )}
      </div>

      <div className="px-6 py-4 max-w-screen-xl mx-auto">
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

        {/* Flat File Sync */}
        <FlatFileSyncPanel />
      </div>
    </div>
  )
}

// ── Flat File Sync Panel ───────────────────────────────────────────────────

interface PullJob {
  jobId: string
  marketplace: string
  productType: string
  status: 'running' | 'done' | 'failed'
  progress: number
  total: number
  pulled: number
  skipped: number
  failed: number
  errors: Array<{ sku: string; error: string }>
  rows: any[]
  startedAt: string
  doneAt?: string
  fatalError?: string
}

const MARKETS = ['IT', 'DE', 'FR', 'ES', 'UK']

function FlatFileSyncPanel() {
  const backend = getBackendUrl()
  const router = useRouter()

  const [market, setMarket] = useState('IT')
  const [productType, setProductType] = useState('')
  const [job, setJob] = useState<PullJob | null>(null)
  const [starting, setStarting] = useState(false)
  const [errMsg, setErrMsg] = useState<string | null>(null)
  const [showErrors, setShowErrors] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Poll while job is running
  useEffect(() => {
    if (!job || job.status !== 'running') {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
      return
    }
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`${backend}/api/reconciliation/flat-file-pull/status/${job.jobId}`)
        if (res.ok) {
          const updated: PullJob = await res.json()
          setJob(updated)
        }
      } catch { /* ignore */ }
    }, 3000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [job?.jobId, job?.status, backend]) // eslint-disable-line

  async function handleStart() {
    if (!productType.trim()) { setErrMsg('Enter a product type (e.g. OUTERWEAR)'); return }
    setErrMsg(null)
    setStarting(true)
    setJob(null)
    setShowErrors(false)
    try {
      const res = await fetch(`${backend}/api/reconciliation/flat-file-pull/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marketplace: market, productType: productType.trim().toUpperCase() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Start failed')
      // Fetch initial status immediately
      const statusRes = await fetch(`${backend}/api/reconciliation/flat-file-pull/status/${data.jobId}`)
      setJob(statusRes.ok ? await statusRes.json() : { ...data, status: 'running', progress: 0, total: 0, pulled: 0, skipped: 0, failed: 0, errors: [], rows: [] })
    } catch (e: any) {
      setErrMsg(e?.message ?? 'Failed to start job')
    } finally {
      setStarting(false)
    }
  }

  function openFlatFile() {
    if (!job?.rows?.length) return
    try {
      const key = `ff-rows-${job.marketplace.toUpperCase()}-${job.productType.toUpperCase()}`
      localStorage.setItem(key, JSON.stringify(job.rows))
    } catch { /* storage full — navigate anyway */ }
    router.push(`/products/amazon-flat-file?marketplace=${job.marketplace}&productType=${job.productType}`)
  }

  const pct = job && job.total > 0 ? Math.round((job.progress / job.total) * 100) : 0
  const isDone = job?.status === 'done'
  const isFailed = job?.status === 'failed'
  const isRunning = job?.status === 'running'

  return (
    <div className="mt-8 border border-violet-200 dark:border-violet-800 rounded-xl bg-violet-50 dark:bg-violet-950/20 p-5">
      <div className="flex items-center gap-2 mb-4">
        <Download className="w-4 h-4 text-violet-600 dark:text-violet-400" />
        <h3 className="text-sm font-semibold text-violet-900 dark:text-violet-200">Pull from Amazon → Flat File</h3>
        <span className="text-xs text-violet-500 dark:text-violet-400">Fetches all attributes for every SKU and pre-fills the flat file editor</span>
      </div>

      <div className="flex items-end gap-3 flex-wrap">
        {/* Market */}
        <div>
          <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Marketplace</label>
          <div className="flex gap-1">
            {MARKETS.map((mp) => (
              <button key={mp} type="button"
                onClick={() => setMarket(mp)}
                className={`px-2.5 py-1 rounded text-xs font-medium border transition-colors ${
                  market === mp
                    ? 'bg-violet-600 text-white border-violet-600'
                    : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:border-violet-400'
                }`}>
                {mp}
              </button>
            ))}
          </div>
        </div>

        {/* Product type */}
        <div>
          <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Product Type</label>
          <input
            type="text"
            value={productType}
            onChange={(e) => setProductType(e.target.value.toUpperCase())}
            placeholder="e.g. OUTERWEAR"
            className="px-2.5 py-1 text-xs border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-violet-500 w-36"
            onKeyDown={(e) => e.key === 'Enter' && handleStart()}
          />
        </div>

        {/* Start button */}
        <button
          type="button"
          onClick={handleStart}
          disabled={starting || isRunning}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-violet-600 hover:bg-violet-700 disabled:bg-violet-400 text-white text-xs font-medium rounded transition-colors">
          {starting || isRunning
            ? <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            : <Download className="w-3.5 h-3.5" />}
          {isRunning ? 'Pulling…' : 'Pull from Amazon'}
        </button>

        {/* Open flat file button */}
        {isDone && job.rows.length > 0 && (
          <button
            type="button"
            onClick={openFlatFile}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium rounded transition-colors">
            <ExternalLink className="w-3.5 h-3.5" />
            Open flat file →
          </button>
        )}
      </div>

      {errMsg && (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400">{errMsg}</p>
      )}

      {/* Progress */}
      {job && (
        <div className="mt-4 space-y-2">
          {isRunning && (
            <>
              <div className="flex justify-between text-xs text-slate-500 dark:text-slate-400">
                <span>Pulling SKUs… {job.progress} / {job.total || '?'}</span>
                <span>{pct}%</span>
              </div>
              <div className="h-1.5 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                <div
                  className="h-full bg-violet-500 rounded-full transition-all duration-500"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </>
          )}

          {isDone && (
            <div className="flex items-center gap-4 text-xs">
              <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="w-3.5 h-3.5" />
                {job.pulled} pulled
              </span>
              {job.skipped > 0 && (
                <span className="text-slate-400">{job.skipped} not on Amazon {market}</span>
              )}
              {job.failed > 0 && (
                <button
                  type="button"
                  onClick={() => setShowErrors((v) => !v)}
                  className="flex items-center gap-1 text-amber-600 dark:text-amber-400 hover:underline">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  {job.failed} failed {showErrors ? '▲' : '▼'}
                </button>
              )}
              <span className="text-slate-400">
                {job.rows.length} rows ready for flat file
              </span>
            </div>
          )}

          {isFailed && (
            <p className="text-xs text-red-600 dark:text-red-400">
              ⚠ Job failed: {job.fatalError ?? 'Unknown error'}
            </p>
          )}

          {showErrors && job.errors.length > 0 && (
            <div className="mt-2 max-h-32 overflow-y-auto rounded border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/20 p-2 space-y-1">
              {job.errors.map((e, i) => (
                <div key={i} className="text-[11px] flex gap-2">
                  <span className="font-mono text-amber-700 dark:text-amber-300 flex-shrink-0">{e.sku}</span>
                  <span className="text-amber-600 dark:text-amber-400">{e.error}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <p className="mt-3 text-[11px] text-slate-400 dark:text-slate-500">
        Calls Amazon's Listings Items API per SKU — rate-limited automatically. Large catalogs may take 2–5 minutes.
        Existing platform data is updated; the flat file editor opens pre-populated when done.
      </p>
    </div>
  )
}
