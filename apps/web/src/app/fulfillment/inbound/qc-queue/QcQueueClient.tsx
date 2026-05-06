'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  ClipboardList,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Trash2,
  XCircle,
} from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { useToast } from '@/components/ui/Toast'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

interface QcItem {
  itemId: string
  sku: string
  productId: string | null
  productName: string | null
  quantityExpected: number
  quantityReceived: number
  qcStatus: 'FAIL' | 'HOLD' | string | null
  qcNotes: string | null
  photoUrls?: string[]
  shipment: {
    id: string
    type: string
    status: string
    reference: string | null
    expectedAt: string | null
  }
}

interface QcQueueResponse {
  count: number
  items: QcItem[]
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

export default function QcQueueClient() {
  const [data, setData] = useState<QcQueueResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actingId, setActingId] = useState<string | null>(null)
  const [photoFor, setPhotoFor] = useState<{ urls: string[]; sku: string } | null>(null)
  const [filter, setFilter] = useState<'all' | 'HOLD' | 'FAIL'>('all')
  const { toast } = useToast()

  const fetchData = useCallback(async () => {
    try {
      setLoading(true)
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/inbound/qc-queue`,
        { cache: 'no-store' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const json = await res.json()
      // The endpoint already exists and returns shape { count, items[] }.
      // We need photoUrls per item — fetch separately if not included.
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
  }, [fetchData])

  const filteredItems = useMemo(() => {
    if (!data) return []
    if (filter === 'all') return data.items
    return data.items.filter((it) => it.qcStatus === filter)
  }, [data, filter])

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: data?.count ?? 0, HOLD: 0, FAIL: 0 }
    if (data) {
      for (const it of data.items) {
        if (it.qcStatus === 'HOLD') c.HOLD++
        else if (it.qcStatus === 'FAIL') c.FAIL++
      }
    }
    return c
  }, [data])

  const handleRelease = useCallback(
    async (item: QcItem) => {
      setActingId(item.itemId)
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/fulfillment/inbound/${item.shipment.id}/items/${item.itemId}/release-hold`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          },
        )
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
        toast.success(`Released ${item.sku} to stock`)
        await fetchData()
      } catch (err) {
        toast.error(
          `Release failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      } finally {
        setActingId(null)
      }
    },
    [fetchData, toast],
  )

  const handleScrap = useCallback(
    async (item: QcItem) => {
      const reason = window.prompt(
        `Scrap ${item.sku} (${item.quantityExpected} units expected)?\nReason for write-off / supplier claim:`,
      )
      if (reason == null) return
      setActingId(item.itemId)
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/fulfillment/inbound/${item.shipment.id}/items/${item.itemId}/scrap`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: reason.trim() || null }),
          },
        )
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
        toast.success(`Scrapped ${item.sku}`)
        await fetchData()
      } catch (err) {
        toast.error(
          `Scrap failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      } finally {
        setActingId(null)
      }
    },
    [fetchData, toast],
  )

  return (
    <div className="space-y-3">
      {/* Filter chips */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1 flex-wrap">
          {(['all', 'HOLD', 'FAIL'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={cn(
                'px-3 py-1 text-[11px] font-medium rounded border transition-colors',
                filter === f
                  ? 'bg-slate-900 text-white border-slate-900'
                  : 'bg-white text-slate-700 border-slate-200 hover:border-slate-300',
              )}
            >
              {f === 'all' ? 'All' : f === 'HOLD' ? 'On Hold' : 'Failed'}
              {counts[f] > 0 && (
                <span className="ml-1 opacity-70">{counts[f]}</span>
              )}
            </button>
          ))}
        </div>
        <Button variant="secondary" size="sm" onClick={fetchData} disabled={loading}>
          <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="text-[12px] text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 inline-flex items-center gap-2">
          <AlertCircle className="w-3.5 h-3.5" />
          {error}
        </div>
      )}

      {loading && !data && (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-24 bg-white border border-slate-200 rounded-lg animate-pulse"
            />
          ))}
        </div>
      )}

      {data && filteredItems.length === 0 && !loading && (
        <EmptyState
          icon={CheckCircle2}
          title={filter === 'all' ? 'QC queue is clear' : `No ${filter === 'HOLD' ? 'held' : 'failed'} items`}
          description={
            filter === 'all'
              ? 'No items currently in HOLD or FAIL status. Items appear here when the receive flow flags them for supervisor review.'
              : 'Try a different filter.'
          }
        />
      )}

      {data && filteredItems.length > 0 && (
        <div className="space-y-2">
          {filteredItems.map((item) => {
            const isHold = item.qcStatus === 'HOLD'
            const isFail = item.qcStatus === 'FAIL'
            const photoCount = item.photoUrls?.length ?? 0
            return (
              <div
                key={item.itemId}
                className="bg-white border border-slate-200 rounded-lg p-4"
              >
                <div className="flex items-start gap-3">
                  <div className="flex-shrink-0 mt-0.5">
                    {isHold ? (
                      <ShieldAlert className="w-5 h-5 text-amber-600" />
                    ) : isFail ? (
                      <XCircle className="w-5 h-5 text-red-600" />
                    ) : (
                      <ClipboardList className="w-5 h-5 text-slate-400" />
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-[13px] font-medium text-slate-900">
                        {item.sku}
                      </span>
                      <Badge
                        variant={isHold ? 'warning' : isFail ? 'danger' : 'default'}
                        size="sm"
                      >
                        {item.qcStatus}
                      </Badge>
                      <span className="text-[12px] text-slate-700">
                        {item.quantityExpected} expected · {item.quantityReceived} received
                      </span>
                    </div>

                    {item.productName && (
                      <div className="text-[12px] text-slate-600 mt-0.5 truncate max-w-xl">
                        {item.productName}
                      </div>
                    )}

                    <div className="flex items-center gap-3 mt-1 text-[11px] text-slate-500 flex-wrap">
                      <span>
                        Shipment{' '}
                        <span className="font-mono">
                          {item.shipment.reference ?? item.shipment.id.slice(-8)}
                        </span>
                      </span>
                      <span>· {item.shipment.type}</span>
                      <span>· {item.shipment.status}</span>
                      {item.shipment.expectedAt && (
                        <span>· expected {relativeTime(item.shipment.expectedAt)}</span>
                      )}
                    </div>

                    {item.qcNotes && (
                      <div className="mt-2 px-3 py-2 bg-slate-50 border border-slate-200 rounded text-[11px] text-slate-700 whitespace-pre-wrap break-words">
                        {item.qcNotes}
                      </div>
                    )}

                    {photoCount > 0 && (
                      <button
                        type="button"
                        onClick={() =>
                          setPhotoFor({
                            urls: item.photoUrls ?? [],
                            sku: item.sku,
                          })
                        }
                        className="mt-2 inline-flex items-center gap-1 text-[11px] text-blue-700 hover:text-blue-900"
                      >
                        <ImageIcon className="w-3 h-3" />
                        {photoCount} {photoCount === 1 ? 'photo' : 'photos'}
                      </button>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <button
                      type="button"
                      onClick={() => handleRelease(item)}
                      disabled={actingId === item.itemId}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-[11px] font-medium text-white bg-green-600 border border-green-600 rounded hover:bg-green-700 disabled:opacity-50"
                      title="Pass QC and release into stock"
                    >
                      {actingId === item.itemId ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <CheckCircle2 className="w-3 h-3" />
                      )}
                      Pass
                    </button>
                    <button
                      type="button"
                      onClick={() => handleScrap(item)}
                      disabled={actingId === item.itemId}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-[11px] font-medium text-red-700 bg-white border border-red-200 rounded hover:bg-red-50 disabled:opacity-50"
                      title="Mark as scrapped (terminal — write-off / supplier claim)"
                    >
                      <Trash2 className="w-3 h-3" />
                      Scrap
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Photo lightbox */}
      {photoFor && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/80 flex items-center justify-center p-4"
          onClick={() => setPhotoFor(null)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="bg-white rounded-lg max-w-4xl w-full max-h-[90vh] overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-medium text-slate-900">
                {photoFor.sku} — {photoFor.urls.length}{' '}
                {photoFor.urls.length === 1 ? 'photo' : 'photos'}
              </h3>
              <button
                type="button"
                onClick={() => setPhotoFor(null)}
                className="text-slate-400 hover:text-slate-700"
                aria-label="Close"
              >
                <XCircle className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-3">
              {photoFor.urls.map((url, idx) => (
                <a
                  key={idx}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block bg-slate-100 rounded overflow-hidden hover:ring-2 hover:ring-blue-300"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={url}
                    alt={`${photoFor.sku} proof ${idx + 1}`}
                    className="w-full h-auto object-cover"
                  />
                </a>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
