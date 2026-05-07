'use client'

// O.4 — Shipments tab content. Existing pre-O.4 OutboundWorkspace
// behavior preserved verbatim: pipeline view (DRAFT → READY → LABEL →
// SHIPPED → DELIVERED) + Sendcloud label print scaffold + bulk batch
// print + tracking pushback. The cornerstone "what should I ship?"
// view now lives in PendingShipmentsClient (the new default tab); this
// tab handles "what's mid-flight or done?".

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  Truck, Search, RefreshCw, Printer, ExternalLink, X, CheckCircle2,
  AlertTriangle, Send, Download,
} from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Input } from '@/components/ui/Input'
import { EmptyState } from '@/components/ui/EmptyState'
import { useToast } from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { getBackendUrl } from '@/lib/backend-url'

type Shipment = {
  id: string
  orderId: string | null
  warehouseId: string | null
  carrierCode: string
  status: string
  sendcloudParcelId: string | null
  trackingNumber: string | null
  trackingUrl: string | null
  labelUrl: string | null
  weightGrams: number | null
  costCents: number | null
  pickedAt: string | null
  packedAt: string | null
  labelPrintedAt: string | null
  shippedAt: string | null
  deliveredAt: string | null
  trackingPushedAt: string | null
  trackingPushError: string | null
  notes: string | null
  warehouse?: { code: string; name: string } | null
  items: Array<{ id: string; sku: string; quantity: number; productId: string | null }>
  createdAt: string
}

const STATUS_TONE: Record<string, 'default' | 'success' | 'warning' | 'danger' | 'info'> = {
  DRAFT: 'default',
  READY_TO_PICK: 'info',
  PICKED: 'info',
  PACKED: 'info',
  LABEL_PRINTED: 'warning',
  SHIPPED: 'success',
  IN_TRANSIT: 'success',
  DELIVERED: 'success',
  CANCELLED: 'default',
  RETURNED: 'danger',
}

const PIPELINE: Array<{ key: string; label: string }> = [
  { key: 'ALL', label: 'All' },
  { key: 'DRAFT', label: 'Draft' },
  { key: 'READY_TO_PICK', label: 'Ready' },
  { key: 'LABEL_PRINTED', label: 'Labeled' },
  { key: 'SHIPPED', label: 'Shipped' },
  { key: 'DELIVERED', label: 'Delivered' },
]

export default function ShipmentsClient() {
  const { toast } = useToast()
  const askConfirm = useConfirm()
  const router = useRouter()
  const params = useSearchParams()
  const openDrawer = (orderId: string) => {
    const next = new URLSearchParams(params.toString())
    next.set('drawer', orderId)
    router.replace(`?${next.toString()}`, { scroll: false })
  }
  const [statusFilter, setStatusFilter] = useState<string>('ALL')
  const [search, setSearch] = useState('')
  const [items, setItems] = useState<Shipment[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [carriers, setCarriers] = useState<Array<{ code: string; isActive: boolean }>>([])

  const fetchShipments = useCallback(async () => {
    setLoading(true)
    try {
      const qs = new URLSearchParams()
      if (statusFilter !== 'ALL') qs.set('status', statusFilter)
      if (search) qs.set('search', search)
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/shipments?${qs.toString()}`, { cache: 'no-store' })
      if (res.ok) {
        const data = await res.json()
        setItems(data.items ?? [])
      }
    } finally { setLoading(false) }
  }, [statusFilter, search])

  const fetchCarriers = useCallback(async () => {
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/carriers`, { cache: 'no-store' })
      if (res.ok) {
        const data = await res.json()
        setCarriers(data.items ?? [])
      }
    } catch {}
  }, [])

  useEffect(() => { fetchShipments(); fetchCarriers() }, [fetchShipments, fetchCarriers])

  const sendcloudConnected = carriers.find((c) => c.code === 'SENDCLOUD')?.isActive

  const counts = useMemo(() => {
    const c: Record<string, number> = { ALL: items.length }
    for (const it of items) c[it.status] = (c[it.status] ?? 0) + 1
    return c
  }, [items])

  const printLabel = async (id: string) => {
    if (!sendcloudConnected) {
      if (!(await askConfirm({ title: 'Sendcloud not connected', description: 'Open carrier settings to connect?', confirmLabel: 'Open settings', tone: 'info' }))) return
      window.location.href = '/fulfillment/carriers'
      return
    }
    const res = await fetch(`${getBackendUrl()}/api/fulfillment/shipments/${id}/print-label`, { method: 'POST' })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      toast.error(err.error ?? 'Label print failed')
      return
    }
    fetchShipments()
  }

  const markShipped = async (id: string) => {
    await fetch(`${getBackendUrl()}/api/fulfillment/shipments/${id}/mark-shipped`, { method: 'POST' })
    fetchShipments()
  }

  // O.15: parallel bulk runner. Concurrency capped so we don't
  // hammer Sendcloud (which has its own per-second rate limits) and
  // the API server's connection pool stays sane. Returns
  // { ok, fail } counters so callers can render a single toast.
  const runBulk = useCallback(
    async <T extends { id: string }>(
      items: T[],
      action: (it: T) => Promise<boolean>,
      concurrency = 5,
    ): Promise<{ ok: number; fail: number }> => {
      let ok = 0
      let fail = 0
      const queue = [...items]
      const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        while (queue.length > 0) {
          const next = queue.shift()
          if (!next) return
          try {
            const success = await action(next)
            if (success) ok++
            else fail++
          } catch {
            fail++
          }
        }
      })
      await Promise.all(workers)
      return { ok, fail }
    },
    [],
  )

  const reportBulk = (label: string, ok: number, total: number) => {
    if (ok === total) toast.success(`${label} ${ok} ${ok === 1 ? 'shipment' : 'shipments'}`)
    else if (ok === 0) toast.error(`${label} failed for all ${total} shipments`)
    else toast.warning(`${label} ${ok} of ${total} (${total - ok} failed)`)
  }

  const bulkPrint = async () => {
    if (selected.size === 0) { toast.error('Select shipments first'); return }
    const eligible = items.filter((s) => selected.has(s.id) && (s.status === 'DRAFT' || s.status === 'READY_TO_PICK' || s.status === 'PACKED'))
    if (eligible.length === 0) { toast.error('No selected shipments are ready for label print'); return }
    const { ok } = await runBulk(eligible, async (s) => {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/shipments/${s.id}/print-label`, { method: 'POST' })
      return res.ok
    })
    reportBulk('Printed', ok, eligible.length)
    setSelected(new Set())
    fetchShipments()
  }

  const bulkMarkShipped = async () => {
    if (selected.size === 0) { toast.error('Select shipments first'); return }
    const eligible = items.filter((s) => selected.has(s.id) && s.status === 'LABEL_PRINTED')
    if (eligible.length === 0) { toast.error('No selected shipments are in LABEL_PRINTED status'); return }
    const { ok } = await runBulk(eligible, async (s) => {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/shipments/${s.id}/mark-shipped`, { method: 'POST' })
      return res.ok
    })
    reportBulk('Marked shipped', ok, eligible.length)
    setSelected(new Set())
    fetchShipments()
  }

  const bulkExportCsv = () => {
    if (selected.size === 0) { toast.error('Select shipments first'); return }
    const rows = items.filter((s) => selected.has(s.id))
    if (rows.length === 0) return
    const header = ['shipment_id', 'order_id', 'status', 'carrier', 'tracking_number', 'tracking_url', 'cost_eur', 'shipped_at', 'delivered_at', 'sku_count', 'unit_count']
    const csv = [
      header.join(','),
      ...rows.map((s) =>
        [
          s.id,
          s.orderId ?? '',
          s.status,
          s.carrierCode,
          s.trackingNumber ?? '',
          s.trackingUrl ?? '',
          s.costCents != null ? (s.costCents / 100).toFixed(2) : '',
          s.shippedAt ?? '',
          s.deliveredAt ?? '',
          s.items.length,
          s.items.reduce((n, i) => n + i.quantity, 0),
        ].map((v) => {
          const str = String(v)
          // CSV-quote any field containing comma, quote, or newline.
          return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str
        }).join(','),
      ),
    ].join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `shipments-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
    toast.success(`Exported ${rows.length} ${rows.length === 1 ? 'shipment' : 'shipments'}`)
  }

  const toggleSelect = (id: string) => {
    const next = new Set(selected)
    next.has(id) ? next.delete(id) : next.add(id)
    setSelected(next)
  }

  return (
    <div className="space-y-3">
      {!sendcloudConnected && (
        <Card>
          <div className="flex items-center gap-3">
            <AlertTriangle size={18} className="text-amber-600 flex-shrink-0" />
            <div className="flex-1">
              <div className="text-md font-semibold text-slate-900">Sendcloud not connected</div>
              <div className="text-base text-slate-500">Label printing and tracking sync need a Sendcloud connection.</div>
            </div>
            <Link href="/fulfillment/carriers" className="h-8 px-3 text-base bg-blue-600 text-white rounded hover:bg-blue-700 inline-flex items-center">
              Connect Sendcloud →
            </Link>
          </div>
        </Card>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        {PIPELINE.map((p) => (
          <button
            key={p.key}
            onClick={() => setStatusFilter(p.key)}
            className={`h-7 px-3 text-base border rounded-full inline-flex items-center gap-1.5 transition-colors ${statusFilter === p.key ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-700 border-slate-200 hover:border-slate-300'}`}
          >
            {p.label}
            {counts[p.key] != null && (
              <span className={`tabular-nums ${statusFilter === p.key ? 'text-slate-300' : 'text-slate-400'}`}>{counts[p.key]}</span>
            )}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <Input
              placeholder="Tracking or parcel ID"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-7 w-56"
            />
          </div>
          <button onClick={fetchShipments} className="h-8 px-3 text-base border border-slate-200 rounded-md hover:bg-slate-50 inline-flex items-center gap-1.5">
            <RefreshCw size={12} /> Refresh
          </button>
        </div>
      </div>

      {selected.size > 0 && (
        <div className="sticky top-2 z-20">
          <Card>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-base font-semibold text-slate-700">{selected.size} selected</span>
              <div className="h-4 w-px bg-slate-200" />
              <button onClick={bulkPrint} className="h-7 px-3 text-base bg-blue-50 text-blue-700 border border-blue-200 rounded hover:bg-blue-100 inline-flex items-center gap-1.5">
                <Printer size={12} /> Print labels
              </button>
              <button onClick={bulkMarkShipped} className="h-7 px-3 text-base bg-emerald-50 text-emerald-700 border border-emerald-200 rounded hover:bg-emerald-100 inline-flex items-center gap-1.5">
                <Send size={12} /> Mark shipped
              </button>
              <button onClick={bulkExportCsv} className="h-7 px-3 text-base bg-slate-50 text-slate-700 border border-slate-200 rounded hover:bg-slate-100 inline-flex items-center gap-1.5">
                <Download size={12} /> Export CSV
              </button>
              <button onClick={() => setSelected(new Set())} className="ml-auto h-7 w-7 inline-flex items-center justify-center text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded">
                <X size={14} />
              </button>
            </div>
          </Card>
        </div>
      )}

      {loading && items.length === 0 ? (
        <Card><div className="text-md text-slate-500 py-8 text-center">Loading shipments…</div></Card>
      ) : items.length === 0 ? (
        <EmptyState
          icon={Truck}
          title="No shipments here"
          description="Shipments get created from the Pending tab, or via bulk-create from the orders page."
        />
      ) : (
        <Card noPadding>
          <div className="overflow-x-auto">
            <table className="w-full text-md">
              <thead className="border-b border-slate-200 bg-slate-50">
                <tr>
                  <th className="px-3 py-2 w-8">
                    <input
                      type="checkbox"
                      checked={items.length > 0 && items.every((i) => selected.has(i.id))}
                      onChange={() => {
                        if (items.every((i) => selected.has(i.id))) setSelected(new Set())
                        else setSelected(new Set(items.map((i) => i.id)))
                      }}
                    />
                  </th>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700">Order</th>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700">Status</th>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700">Items</th>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700">Carrier</th>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700">Tracking</th>
                  <th className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-slate-700">Cost</th>
                  <th className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-slate-700"></th>
                </tr>
              </thead>
              <tbody>
                {items.map((s) => (
                  <tr
                    key={s.id}
                    className={`border-b border-slate-100 hover:bg-slate-50 ${s.orderId ? 'cursor-pointer' : ''}`}
                    onClick={() => s.orderId && openDrawer(s.orderId)}
                  >
                    <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selected.has(s.id)}
                        onChange={() => toggleSelect(s.id)}
                      />
                    </td>
                    <td className="px-3 py-2">
                      {s.orderId ? (
                        <button
                          type="button"
                          className="text-base font-mono text-blue-600 hover:underline"
                          onClick={(e) => { e.stopPropagation(); openDrawer(s.orderId!) }}
                        >
                          {s.orderId.slice(0, 12)}…
                        </button>
                      ) : <span className="text-slate-400 text-base">—</span>}
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant={STATUS_TONE[s.status] ?? 'default'} size="sm">{s.status.replace(/_/g, ' ')}</Badge>
                    </td>
                    <td className="px-3 py-2 text-base text-slate-700">
                      <span className="tabular-nums">{s.items.reduce((n, i) => n + i.quantity, 0)}</span> units · {s.items.length} SKU{s.items.length === 1 ? '' : 's'}
                    </td>
                    <td className="px-3 py-2 text-base text-slate-700">{s.carrierCode}</td>
                    <td className="px-3 py-2">
                      {s.trackingNumber ? (
                        s.trackingUrl ? (
                          <a href={s.trackingUrl} target="_blank" rel="noreferrer" className="text-base font-mono text-blue-600 hover:underline inline-flex items-center gap-1">
                            {s.trackingNumber.slice(0, 16)}{s.trackingNumber.length > 16 ? '…' : ''}
                            <ExternalLink size={10} />
                          </a>
                        ) : (
                          <span className="text-base font-mono text-slate-700">{s.trackingNumber}</span>
                        )
                      ) : <span className="text-slate-400 text-base">—</span>}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-base text-slate-600">
                      {s.costCents != null ? `€${(s.costCents / 100).toFixed(2)}` : '—'}
                    </td>
                    <td className="px-3 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center gap-1 justify-end">
                        {(s.status === 'DRAFT' || s.status === 'READY_TO_PICK' || s.status === 'PACKED') && (
                          <button onClick={() => printLabel(s.id)} title="Print label" className="h-6 px-2 text-sm bg-blue-50 text-blue-700 border border-blue-200 rounded hover:bg-blue-100 inline-flex items-center gap-1">
                            <Printer size={11} /> Label
                          </button>
                        )}
                        {s.status === 'LABEL_PRINTED' && (
                          <button onClick={() => markShipped(s.id)} title="Mark shipped" className="h-6 px-2 text-sm bg-emerald-50 text-emerald-700 border border-emerald-200 rounded hover:bg-emerald-100 inline-flex items-center gap-1">
                            <CheckCircle2 size={11} /> Ship
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}
