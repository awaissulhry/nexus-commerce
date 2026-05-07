'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  RotateCw,
  TrendingDown,
  TrendingUp,
} from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { useToast } from '@/components/ui/Toast'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

// Mirrors GET /api/dashboard/stock-drift response.

interface DriftRow {
  id: string
  channel: string
  marketplace: string | null
  productId: string
  sku: string | null
  productName: string | null
  masterQuantity: number | null
  quantity: number | null
  quantityDelta: number | null
  masterPrice: string | null
  price: string | null
  priceDelta: number | null
  followMasterQuantity: boolean
  followMasterPrice: boolean
  pricingRule: string | null
  lastSyncStatus: string | null
  lastSyncedAt: string | null
  updatedAt: string
}

interface DriftResponse {
  quantityDrift: { totalCount: number; rows: DriftRow[]; threshold: number }
  priceDrift: { totalCount: number; rows: DriftRow[]; threshold: number }
  generatedAt: string
}

function relativeTime(iso: string | null): string {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0) return 'just now'
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}

function DeltaCell({
  delta,
  unit,
}: {
  delta: number | null
  unit: 'units' | 'currency'
}) {
  if (delta == null) return <span className="text-slate-400">—</span>
  const sign = delta > 0 ? '+' : ''
  const direction = delta > 0 ? 'text-amber-700' : 'text-red-700'
  const Icon = delta > 0 ? TrendingUp : TrendingDown
  const formatted =
    unit === 'currency'
      ? `${sign}${delta.toFixed(2)}`
      : `${sign}${Math.round(delta)}`
  return (
    <span className={cn('inline-flex items-center gap-0.5 font-mono tabular-nums font-semibold', direction)}>
      <Icon className="w-3 h-3" />
      {formatted}
    </span>
  )
}

export default function StockDriftPanel() {
  const [data, setData] = useState<DriftResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'quantity' | 'price'>('quantity')
  const [resyncing, setResyncing] = useState<string | null>(null)
  const { toast } = useToast()

  const fetchData = useCallback(async () => {
    try {
      setLoading(true)
      const res = await fetch(`${getBackendUrl()}/api/dashboard/stock-drift`, {
        cache: 'no-store',
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const json = await res.json()
      setData(json)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
    const id = setInterval(fetchData, 60_000)
    return () => clearInterval(id)
  }, [fetchData])

  const handleResync = useCallback(
    async (row: DriftRow, kind: 'quantity' | 'price') => {
      setResyncing(row.id)
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/dashboard/stock-drift/${row.id}/resync`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind }),
          },
        )
        const body = await res.json().catch(() => ({}))
        if (!res.ok) {
          throw new Error(body.error ?? `HTTP ${res.status}`)
        }
        const sku = row.sku ?? row.id.slice(-8)
        if (kind === 'quantity') {
          toast.success(
            `Resynced ${sku}: quantity → ${body.newValue}; sync queued`,
          )
        } else {
          toast.success(
            `Resynced ${sku}: price → ${body.newValue}; sync queued`,
          )
        }
        await fetchData()
      } catch (err) {
        toast.error(
          `Resync failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      } finally {
        setResyncing(null)
      }
    },
    [fetchData, toast],
  )

  const allClean =
    data &&
    data.quantityDrift.totalCount === 0 &&
    data.priceDrift.totalCount === 0
  const activeRows =
    tab === 'quantity'
      ? data?.quantityDrift.rows ?? []
      : data?.priceDrift.rows ?? []
  const activeTotal =
    tab === 'quantity'
      ? data?.quantityDrift.totalCount ?? 0
      : data?.priceDrift.totalCount ?? 0

  return (
    <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
      <div className="px-4 py-3 flex items-center justify-between border-b border-slate-200">
        <div>
          <h3 className="text-lg font-semibold text-slate-900">
            Stock & Price Drift
          </h3>
          <p className="text-base text-slate-500 mt-0.5">
            ChannelListings where the cached master snapshot disagrees with
            the displayed value (cascade out of sync, sync queue stuck, or
            manual override applied without flipping followMaster off).
          </p>
        </div>
        <button
          type="button"
          onClick={fetchData}
          disabled={loading}
          className="text-sm text-slate-500 hover:text-slate-900 inline-flex items-center gap-1 disabled:opacity-50"
        >
          <RefreshCw className={cn('w-3 h-3', loading && 'animate-spin')} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="px-4 py-2 text-base text-red-700 bg-red-50 border-b border-red-200 inline-flex items-center gap-2">
          <AlertCircle className="w-3.5 h-3.5" />
          {error}
        </div>
      )}

      {/* Headline KPIs */}
      {data && (
        <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex items-center gap-4 flex-wrap">
          <button
            type="button"
            onClick={() => setTab('quantity')}
            className={cn(
              'inline-flex items-center gap-2 px-3 py-1.5 rounded border transition-colors',
              tab === 'quantity'
                ? 'bg-white border-slate-300 shadow-sm'
                : 'bg-transparent border-transparent hover:bg-white',
            )}
          >
            <span className="text-sm font-medium text-slate-600 uppercase tracking-wide">
              Quantity drift
            </span>
            <Badge
              variant={data.quantityDrift.totalCount > 0 ? 'warning' : 'success'}
              size="sm"
            >
              {data.quantityDrift.totalCount}
            </Badge>
          </button>
          <button
            type="button"
            onClick={() => setTab('price')}
            className={cn(
              'inline-flex items-center gap-2 px-3 py-1.5 rounded border transition-colors',
              tab === 'price'
                ? 'bg-white border-slate-300 shadow-sm'
                : 'bg-transparent border-transparent hover:bg-white',
            )}
          >
            <span className="text-sm font-medium text-slate-600 uppercase tracking-wide">
              Price drift (FIXED rule)
            </span>
            <Badge
              variant={data.priceDrift.totalCount > 0 ? 'warning' : 'success'}
              size="sm"
            >
              {data.priceDrift.totalCount}
            </Badge>
          </button>
        </div>
      )}

      {loading && !data && (
        <div className="p-4 space-y-2">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-9 bg-slate-50 rounded animate-pulse" />
          ))}
        </div>
      )}

      {data && allClean && !loading && (
        <div className="p-6 text-center">
          <CheckCircle2 className="w-8 h-8 text-green-600 mx-auto mb-2" />
          <div className="text-md font-medium text-slate-900">
            No drift detected
          </div>
          <div className="text-base text-slate-500 mt-1">
            Every follow-master ChannelListing matches its master snapshot.
          </div>
        </div>
      )}

      {data && !allClean && activeRows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-base">
            <thead className="bg-slate-50 text-sm text-slate-600 border-b border-slate-200">
              <tr>
                <th className="text-left font-medium px-3 py-2">Listing</th>
                <th className="text-left font-medium px-3 py-2 w-32">Channel</th>
                <th className="text-right font-medium px-3 py-2 w-28">Master</th>
                <th className="text-right font-medium px-3 py-2 w-28">Displayed</th>
                <th className="text-right font-medium px-3 py-2 w-24">Delta</th>
                <th className="text-left font-medium px-3 py-2 w-32">Last sync</th>
                <th className="text-right font-medium px-3 py-2 w-24"></th>
              </tr>
            </thead>
            <tbody>
              {activeRows.map((row) => {
                const isQty = tab === 'quantity'
                return (
                  <tr key={row.id} className="border-b border-slate-100 last:border-0 align-top">
                    <td className="px-3 py-2">
                      <div className="font-mono text-sm text-slate-900">
                        {row.sku ?? <span className="text-slate-400">—</span>}
                      </div>
                      {row.productName && (
                        <div className="text-sm text-slate-500 truncate max-w-md">
                          {row.productName}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="text-sm text-slate-700">
                        {row.channel}
                        {row.marketplace && (
                          <span className="text-slate-400"> · {row.marketplace}</span>
                        )}
                      </div>
                      {row.pricingRule && !isQty && (
                        <div className="text-xs text-slate-500 mt-0.5">
                          rule: {row.pricingRule}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-700">
                      {isQty
                        ? (row.masterQuantity ?? '—')
                        : row.masterPrice
                          ? Number(row.masterPrice).toFixed(2)
                          : '—'}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-900 font-medium">
                      {isQty
                        ? (row.quantity ?? '—')
                        : row.price
                          ? Number(row.price).toFixed(2)
                          : '—'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {isQty ? (
                        <DeltaCell delta={row.quantityDelta} unit="units" />
                      ) : (
                        <DeltaCell delta={row.priceDelta} unit="currency" />
                      )}
                    </td>
                    <td className="px-3 py-2 text-sm text-slate-500">
                      {relativeTime(row.lastSyncedAt)}
                      {row.lastSyncStatus && (
                        <div className="text-xs text-slate-400 mt-0.5">
                          {row.lastSyncStatus}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => handleResync(row, isQty ? 'quantity' : 'price')}
                        disabled={resyncing === row.id}
                        className="inline-flex items-center gap-1 px-2 py-1 text-sm font-medium text-blue-700 bg-white border border-blue-200 rounded hover:bg-blue-50 disabled:opacity-50"
                        title={`Set ${isQty ? 'quantity' : 'price'} = master and queue immediate sync`}
                      >
                        {resyncing === row.id ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <RotateCw className="w-3 h-3" />
                        )}
                        Resync
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {activeTotal > activeRows.length && (
            <div className="px-3 py-2 bg-amber-50 border-t border-amber-200 text-sm text-amber-800">
              Showing top {activeRows.length} of {activeTotal} drifting listings (sorted by largest delta).
            </div>
          )}
        </div>
      )}
    </div>
  )
}
