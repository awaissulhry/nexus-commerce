'use client'

import { useState, useCallback, useTransition } from 'react'
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
} from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────────────────

interface ReconStats {
  byStatus: Record<string, number>
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
  matchedProduct: { id: string; sku: string; name: string } | null
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

const MARKETPLACE_OPTIONS = ['IT', 'DE', 'FR', 'ES', 'UK']
const STATUS_OPTIONS = ['PENDING', 'CONFIRMED', 'CONFLICT', 'IGNORE', 'CREATE_NEW']

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

  const [channel] = useState(initialChannel)
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

  const refreshStats = useCallback(async () => {
    const res = await fetch(`${backend}/api/reconciliation/stats?channel=${channel}&marketplace=${marketplace}`, { cache: 'no-store' }).catch(() => null)
    if (res?.ok) setStats(await res.json().catch(() => null))
  }, [backend, channel, marketplace])

  const refreshItems = useCallback(async (p: number, status: string) => {
    const res = await fetch(
      `${backend}/api/reconciliation/items?channel=${channel}&marketplace=${marketplace}&status=${status}&page=${p}&pageSize=50`,
      { cache: 'no-store' }
    ).catch(() => null)
    if (res?.ok) setItemPage(await res.json().catch(() => null))
  }, [backend, channel, marketplace])

  const handleRun = () => {
    startTransition(async () => {
      setRunMsg('Running reconciliation — fetching Amazon catalog (may take 5-10 min)…')
      const res = await fetch(`${backend}/api/reconciliation/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, marketplace }),
      }).catch(() => null)
      if (res?.ok) {
        const data = await res.json()
        const s = data.summary
        setRunMsg(`Done — ${s.totalDiscovered} discovered, ${s.matched} matched, ${s.unmatched} unmatched, ${s.skipped} skipped (${Math.round(s.durationMs / 1000)}s)`)
      } else {
        const err = await res?.json().catch(() => null)
        setRunMsg(`Error: ${err?.error ?? 'Unknown failure'}`)
      }
      await Promise.all([refreshStats(), refreshItems(1, statusFilter)])
      setPage(1)
    })
  }

  const handleConfirm = async (id: string) => {
    setActionMsg(prev => ({ ...prev, [id]: 'Confirming…' }))
    const res = await fetch(`${backend}/api/reconciliation/items/${id}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviewedBy: 'operator' }),
    }).catch(() => null)
    const msg = res?.ok ? '✓ Confirmed' : 'Error'
    setActionMsg(prev => ({ ...prev, [id]: msg }))
    if (res?.ok) {
      await Promise.all([refreshStats(), refreshItems(page, statusFilter)])
    }
  }

  const handleSetStatus = async (id: string, status: string) => {
    setActionMsg(prev => ({ ...prev, [id]: 'Saving…' }))
    const res = await fetch(`${backend}/api/reconciliation/items/${id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, reviewedBy: 'operator' }),
    }).catch(() => null)
    const msg = res?.ok ? `✓ ${status}` : 'Error'
    setActionMsg(prev => ({ ...prev, [id]: msg }))
    if (res?.ok) {
      await Promise.all([refreshStats(), refreshItems(page, statusFilter)])
    }
  }

  const handleLink = async (id: string) => {
    if (!linkProductId.trim()) return
    setActionMsg(prev => ({ ...prev, [id]: 'Linking…' }))
    const res = await fetch(`${backend}/api/reconciliation/items/${id}/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: linkProductId.trim(), reviewedBy: 'operator' }),
    }).catch(() => null)
    const msg = res?.ok ? '✓ Linked' : 'Error'
    setActionMsg(prev => ({ ...prev, [id]: msg }))
    if (res?.ok) {
      setLinkTarget(null)
      setLinkProductId('')
      await Promise.all([refreshStats(), refreshItems(page, statusFilter)])
    }
  }

  const handlePageChange = (newPage: number) => {
    setPage(newPage)
    startTransition(() => { refreshItems(newPage, statusFilter) })
  }

  const handleStatusFilter = (s: string) => {
    setStatusFilter(s)
    setPage(1)
    startTransition(() => { refreshItems(1, s) })
  }

  const handleMarketplace = (m: string) => {
    setMarketplace(m)
    setPage(1)
    startTransition(async () => {
      const [sr, ir] = await Promise.all([
        fetch(`${backend}/api/reconciliation/stats?channel=${channel}&marketplace=${m}`, { cache: 'no-store' }).catch(() => null),
        fetch(`${backend}/api/reconciliation/items?channel=${channel}&marketplace=${m}&status=${statusFilter}&page=1&pageSize=50`, { cache: 'no-store' }).catch(() => null),
      ])
      if (sr?.ok) setStats(await sr.json().catch(() => null))
      if (ir?.ok) setItemPage(await ir.json().catch(() => null))
    })
  }

  const rows = itemPage?.rows ?? []
  const totalRows = itemPage?.total ?? 0
  const totalPages = itemPage?.totalPages ?? 1

  const pending = stats?.byStatus?.PENDING ?? 0
  const confirmed = stats?.byStatus?.CONFIRMED ?? 0
  const conflict = stats?.byStatus?.CONFLICT ?? 0
  const ignored = stats?.byStatus?.IGNORE ?? 0
  const total = stats?.total ?? 0

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Listing Reconciliation</h1>
            <p className="text-sm text-gray-500 mt-0.5">
              Match Amazon/eBay live listings to Nexus products before enabling write-back.
            </p>
          </div>
          <button
            onClick={handleRun}
            disabled={isPending}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isPending ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            Run reconciliation
          </button>
        </div>

        {runMsg && (
          <div className="mt-3 px-4 py-2 bg-blue-50 text-blue-800 text-sm rounded-lg">
            {runMsg}
          </div>
        )}
      </div>

      <div className="px-6 py-4 max-w-screen-xl mx-auto">
        {/* Marketplace selector */}
        <div className="flex gap-2 mb-5">
          {MARKETPLACE_OPTIONS.map(mp => (
            <button
              key={mp}
              onClick={() => handleMarketplace(mp)}
              className={`px-3 py-1.5 rounded-md text-sm font-medium border transition-colors ${marketplace === mp ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'}`}
            >
              {mp}
            </button>
          ))}
        </div>

        {/* Stats strip */}
        <div className="grid grid-cols-5 gap-3 mb-6">
          {[
            { label: 'Total discovered', value: total, color: 'text-gray-900' },
            { label: 'Pending review', value: pending, color: 'text-blue-700' },
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

        {/* Match method breakdown */}
        {stats?.matchMethods && Object.keys(stats.matchMethods).length > 0 && (
          <div className="flex gap-3 mb-5 flex-wrap">
            {Object.entries(stats.matchMethods).map(([method, count]) => (
              <span key={method} className="px-3 py-1 bg-white border rounded-full text-xs text-gray-600">
                {method}: <strong>{count}</strong>
              </span>
            ))}
          </div>
        )}

        {/* Status filter tabs */}
        <div className="flex gap-1 mb-4 border-b">
          {STATUS_OPTIONS.map(s => (
            <button
              key={s}
              onClick={() => handleStatusFilter(s)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px ${statusFilter === s ? 'border-blue-600 text-blue-700' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
            >
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
                ? 'No listings discovered yet. Click "Run reconciliation" to pull from Amazon.'
                : `No rows with status ${statusFilter}.`}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-600 w-48">Channel SKU / ASIN</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">Title</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600 w-32">Price / Qty</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600 w-48">Matched product</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600 w-32">Confidence</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600 w-28">Status</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600 w-56">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map(row => (
                  <tr key={row.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-mono text-xs text-gray-700">
                      <div className="truncate max-w-[11rem]" title={row.externalSku}>{row.externalSku}</div>
                      {row.externalListingId && (
                        <div className="text-gray-400 truncate max-w-[11rem]" title={row.externalListingId}>
                          {row.externalListingId}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      <div className="line-clamp-2 text-xs">{row.title ?? '—'}</div>
                    </td>
                    <td className="px-4 py-3 text-gray-700 text-xs">
                      {row.channelPrice != null ? `€${Number(row.channelPrice).toFixed(2)}` : '—'}
                      <div className="text-gray-400">qty {row.channelQuantity ?? '—'}</div>
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {row.matchedProduct ? (
                        <div>
                          <div className="font-medium text-gray-800 truncate max-w-[11rem]" title={row.matchedProduct.name}>
                            {row.matchedProduct.name}
                          </div>
                          <div className="text-gray-400 font-mono">{row.matchedProduct.sku}</div>
                        </div>
                      ) : (
                        <span className="text-gray-400 italic">No match</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {confidenceBadge(row.matchConfidence, row.matchMethod)}
                    </td>
                    <td className="px-4 py-3">
                      {statusBadge(row.reconciliationStatus)}
                    </td>
                    <td className="px-4 py-3">
                      {actionMsg[row.id] ? (
                        <span className="text-xs text-gray-600">{actionMsg[row.id]}</span>
                      ) : linkTarget === row.id ? (
                        <div className="flex gap-1.5 items-center">
                          <input
                            value={linkProductId}
                            onChange={e => setLinkProductId(e.target.value)}
                            placeholder="Product ID"
                            className="border rounded px-2 py-1 text-xs w-28 focus:outline-none focus:ring-1 focus:ring-blue-500"
                          />
                          <button onClick={() => handleLink(row.id)} className="text-xs text-blue-700 hover:underline">Save</button>
                          <button onClick={() => { setLinkTarget(null); setLinkProductId('') }} className="text-xs text-gray-400 hover:underline">Cancel</button>
                        </div>
                      ) : (
                        <div className="flex gap-1.5 flex-wrap">
                          {row.reconciliationStatus === 'PENDING' && row.matchedProductId && (
                            <button
                              onClick={() => handleConfirm(row.id)}
                              className="flex items-center gap-1 px-2 py-1 bg-green-600 text-white rounded text-xs hover:bg-green-700"
                            >
                              <CheckCircle2 className="w-3 h-3" /> Confirm
                            </button>
                          )}
                          <button
                            onClick={() => { setLinkTarget(row.id); setLinkProductId('') }}
                            className="flex items-center gap-1 px-2 py-1 bg-white border text-gray-600 rounded text-xs hover:bg-gray-50"
                          >
                            <Link2 className="w-3 h-3" /> Link
                          </button>
                          {row.reconciliationStatus !== 'IGNORE' && (
                            <button
                              onClick={() => handleSetStatus(row.id, 'IGNORE')}
                              className="flex items-center gap-1 px-2 py-1 bg-white border text-gray-500 rounded text-xs hover:bg-gray-50"
                            >
                              <XCircle className="w-3 h-3" /> Ignore
                            </button>
                          )}
                          {row.reconciliationStatus !== 'CONFLICT' && (
                            <button
                              onClick={() => handleSetStatus(row.id, 'CONFLICT')}
                              className="flex items-center gap-1 px-2 py-1 bg-white border text-amber-600 rounded text-xs hover:bg-amber-50"
                            >
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
              <span className="text-xs text-gray-500">
                {totalRows} rows · page {page} of {totalPages}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => handlePageChange(page - 1)}
                  disabled={page <= 1}
                  className="p-1.5 rounded border bg-white hover:bg-gray-50 disabled:opacity-40"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <button
                  onClick={() => handlePageChange(page + 1)}
                  disabled={page >= totalPages}
                  className="p-1.5 rounded border bg-white hover:bg-gray-50 disabled:opacity-40"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Zero-state instructions */}
        {total === 0 && !isPending && (
          <div className="mt-6 bg-blue-50 border border-blue-200 rounded-lg p-5 text-sm">
            <h3 className="font-medium text-blue-900 mb-2">How to proceed</h3>
            <ol className="list-decimal list-inside space-y-1 text-blue-800">
              <li>Click <strong>Run reconciliation</strong> above — this pulls your live Amazon IT catalog (~5 min for large catalogs).</li>
              <li>Review the matched rows. Green = high confidence SKU match. Amber = ASIN match. Red = unmatched.</li>
              <li>For each PENDING row: <strong>Confirm</strong> the match, <strong>Link</strong> to a different product, or <strong>Ignore</strong> listings Nexus shouldn't manage.</li>
              <li>Once all rows are reviewed, Nexus knows about every live listing. Only then will write-back (price/inventory sync) be enabled.</li>
            </ol>
          </div>
        )}
      </div>
    </div>
  )
}
