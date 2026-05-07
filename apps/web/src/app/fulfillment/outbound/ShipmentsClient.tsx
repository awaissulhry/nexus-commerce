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
  AlertTriangle, Send, Download, RotateCcw, Trash, Pause, Play,
} from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Input } from '@/components/ui/Input'
import { EmptyState } from '@/components/ui/EmptyState'
import { useToast } from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { useTranslations } from '@/lib/i18n/use-translations'
import { emitInvalidation, useInvalidationChannel } from '@/lib/sync/invalidation-channel'
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
  heldAt: string | null
  heldReason: string | null
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
  ON_HOLD: 'warning',
}

const PIPELINE: Array<{ key: string; tKey: string }> = [
  { key: 'ALL', tKey: 'outbound.shipments.pipeline.all' },
  { key: 'DRAFT', tKey: 'outbound.shipments.pipeline.draft' },
  { key: 'READY_TO_PICK', tKey: 'outbound.shipments.pipeline.ready' },
  { key: 'ON_HOLD', tKey: 'outbound.shipments.pipeline.onHold' },
  { key: 'LABEL_PRINTED', tKey: 'outbound.shipments.pipeline.labeled' },
  { key: 'SHIPPED', tKey: 'outbound.shipments.pipeline.shipped' },
  { key: 'DELIVERED', tKey: 'outbound.shipments.pipeline.delivered' },
]

export default function ShipmentsClient() {
  const { toast } = useToast()
  const askConfirm = useConfirm()
  const { t } = useTranslations()
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

  // O.26: refresh when sibling surfaces transition outbound state.
  useInvalidationChannel(
    ['shipment.created', 'shipment.updated', 'shipment.deleted', 'order.shipped'],
    () => { fetchShipments() },
  )

  const sendcloudConnected = carriers.find((c) => c.code === 'SENDCLOUD')?.isActive

  const counts = useMemo(() => {
    const c: Record<string, number> = { ALL: items.length }
    for (const it of items) c[it.status] = (c[it.status] ?? 0) + 1
    return c
  }, [items])

  const printLabel = async (id: string) => {
    if (!sendcloudConnected) {
      if (!(await askConfirm({
        title: t('outbound.shipments.sendcloudNotConnected.title'),
        description: t('outbound.shipments.sendcloudNotConnected.description'),
        confirmLabel: t('outbound.shipments.sendcloudNotConnected.cta'),
        tone: 'info',
      }))) return
      window.location.href = '/fulfillment/carriers'
      return
    }
    const res = await fetch(`${getBackendUrl()}/api/fulfillment/shipments/${id}/print-label`, { method: 'POST' })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      toast.error(err.error ?? t('common.error'))
      return
    }
    emitInvalidation({ type: 'shipment.updated', id })
    fetchShipments()
  }

  const markShipped = async (id: string) => {
    await fetch(`${getBackendUrl()}/api/fulfillment/shipments/${id}/mark-shipped`, { method: 'POST' })
    emitInvalidation({ type: 'order.shipped', id })
    fetchShipments()
  }

  // O.34: re-print opens the stored label PDF in a new tab. Single
  // round-trip to /reprint-label so the URL is fresh + the endpoint
  // can apply auth/expiry recovery in a future commit.
  const reprintLabel = async (id: string) => {
    const res = await fetch(`${getBackendUrl()}/api/fulfillment/shipments/${id}/reprint-label`, { method: 'POST' })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      toast.error(err.error ?? t('common.error'))
      return
    }
    const { labelUrl } = await res.json()
    if (labelUrl) window.open(labelUrl, '_blank')
  }

  // O.36: hold + release.
  const hold = async (id: string) => {
    const reason = window.prompt(t('outbound.shipments.hold.prompt')) ?? ''
    if (!reason.trim()) return
    const res = await fetch(`${getBackendUrl()}/api/fulfillment/shipments/${id}/hold`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: reason.trim() }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      toast.error(err.error ?? t('common.error'))
      return
    }
    toast.success(t('outbound.shipments.hold.toast'))
    emitInvalidation({ type: 'shipment.updated', id })
    fetchShipments()
  }

  const release = async (id: string) => {
    const res = await fetch(`${getBackendUrl()}/api/fulfillment/shipments/${id}/release`, { method: 'POST' })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      toast.error(err.error ?? t('common.error'))
      return
    }
    toast.success(t('outbound.shipments.release.toast'))
    emitInvalidation({ type: 'shipment.updated', id })
    fetchShipments()
  }

  // O.34: void label — destructive, ask before proceeding. Resets
  // shipment to PACKED so operator can re-rate / re-print.
  const voidLabel = async (id: string) => {
    if (!(await askConfirm({
      title: t('outbound.shipments.void.title'),
      description: t('outbound.shipments.void.description'),
      confirmLabel: t('outbound.shipments.void.confirm'),
      tone: 'danger',
    }))) return
    const res = await fetch(`${getBackendUrl()}/api/fulfillment/shipments/${id}/void-label`, { method: 'POST' })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      toast.error(err.error ?? t('common.error'))
      return
    }
    toast.success(t('outbound.shipments.void.toast'))
    emitInvalidation({ type: 'shipment.updated', id })
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

  const reportBulk = (toastKey: 'printed' | 'shipped' | 'exported', ok: number, total: number) => {
    const labelWord = ok === 1 ? t('outbound.shipments.col.items').toLowerCase() : t('outbound.shipments.col.items').toLowerCase()
    if (ok === total) {
      const successKey =
        toastKey === 'printed' ? 'outbound.shipments.toast.printedAll'
        : toastKey === 'shipped' ? 'outbound.shipments.toast.markedAll'
        : 'outbound.shipments.toast.exportedAll'
      toast.success(t(successKey, { n: ok, label: labelWord }))
    } else if (ok === 0) {
      if (toastKey === 'printed') toast.error(t('outbound.shipments.toast.printedNone', { n: total }))
      else toast.error(t('common.error'))
    } else {
      if (toastKey === 'printed') toast.warning(t('outbound.shipments.toast.printedPartial', { ok, total }))
      else toast.warning(t('outbound.shipments.toast.printedPartial', { ok, total }))
    }
  }

  const bulkPrint = async () => {
    if (selected.size === 0) { toast.error(t('outbound.pending.toast.selectFirst')); return }
    const eligible = items.filter((s) => selected.has(s.id) && (s.status === 'DRAFT' || s.status === 'READY_TO_PICK' || s.status === 'PACKED'))
    if (eligible.length === 0) { toast.error(t('outbound.pending.toast.selectFirst')); return }
    const { ok } = await runBulk(eligible, async (s) => {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/shipments/${s.id}/print-label`, { method: 'POST' })
      return res.ok
    })
    reportBulk('printed', ok, eligible.length)
    if (ok > 0) emitInvalidation({ type: 'shipment.updated', meta: { count: ok } })
    setSelected(new Set())
    fetchShipments()
  }

  const bulkMarkShipped = async () => {
    if (selected.size === 0) { toast.error(t('outbound.pending.toast.selectFirst')); return }
    const eligible = items.filter((s) => selected.has(s.id) && s.status === 'LABEL_PRINTED')
    if (eligible.length === 0) { toast.error(t('outbound.pending.toast.selectFirst')); return }
    const { ok } = await runBulk(eligible, async (s) => {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/shipments/${s.id}/mark-shipped`, { method: 'POST' })
      return res.ok
    })
    reportBulk('shipped', ok, eligible.length)
    if (ok > 0) emitInvalidation({ type: 'order.shipped', meta: { count: ok } })
    setSelected(new Set())
    fetchShipments()
  }

  const bulkExportCsv = () => {
    if (selected.size === 0) { toast.error(t('outbound.pending.toast.selectFirst')); return }
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
    toast.success(t('outbound.shipments.toast.exportedAll', { n: rows.length, label: '' }))
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
              <div className="text-md font-semibold text-slate-900">{t('outbound.shipments.sendcloudNotConnected.title')}</div>
              <div className="text-base text-slate-500">{t('outbound.shipments.sendcloudNotConnected.description')}</div>
            </div>
            <Link href="/fulfillment/carriers" className="h-8 px-3 text-base bg-blue-600 text-white rounded hover:bg-blue-700 inline-flex items-center">
              {t('outbound.shipments.sendcloudNotConnected.cta')}
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
            {t(p.tKey)}
            {counts[p.key] != null && (
              <span className={`tabular-nums ${statusFilter === p.key ? 'text-slate-300' : 'text-slate-400'}`}>{counts[p.key]}</span>
            )}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <Input
              placeholder={t('outbound.shipments.searchPlaceholder')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-7 w-56"
            />
          </div>
          <button onClick={fetchShipments} className="h-8 px-3 text-base border border-slate-200 rounded-md hover:bg-slate-50 inline-flex items-center gap-1.5">
            <RefreshCw size={12} /> {t('common.refresh')}
          </button>
        </div>
      </div>

      {selected.size > 0 && (
        <div className="sticky top-2 z-20">
          <Card>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-base font-semibold text-slate-700">{t('outbound.pending.selectedCount', { n: selected.size })}</span>
              <div className="h-4 w-px bg-slate-200" />
              <button onClick={bulkPrint} className="h-7 px-3 text-base bg-blue-50 text-blue-700 border border-blue-200 rounded hover:bg-blue-100 inline-flex items-center gap-1.5">
                <Printer size={12} /> {t('outbound.shipments.bulk.printLabels')}
              </button>
              <button onClick={bulkMarkShipped} className="h-7 px-3 text-base bg-emerald-50 text-emerald-700 border border-emerald-200 rounded hover:bg-emerald-100 inline-flex items-center gap-1.5">
                <Send size={12} /> {t('outbound.shipments.bulk.markShipped')}
              </button>
              <button onClick={bulkExportCsv} className="h-7 px-3 text-base bg-slate-50 text-slate-700 border border-slate-200 rounded hover:bg-slate-100 inline-flex items-center gap-1.5">
                <Download size={12} /> {t('outbound.shipments.bulk.exportCsv')}
              </button>
              <button onClick={() => setSelected(new Set())} className="ml-auto h-7 w-7 inline-flex items-center justify-center text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded">
                <X size={14} />
              </button>
            </div>
          </Card>
        </div>
      )}

      {loading && items.length === 0 ? (
        <Card><div className="text-md text-slate-500 py-8 text-center">{t('common.loading')}</div></Card>
      ) : items.length === 0 ? (
        <EmptyState
          icon={Truck}
          title={t('outbound.shipments.empty.title')}
          description={t('outbound.shipments.empty.description')}
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
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700">{t('outbound.shipments.col.order')}</th>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700">{t('outbound.shipments.col.status')}</th>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700">{t('outbound.shipments.col.items')}</th>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700">{t('outbound.shipments.col.carrier')}</th>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700">{t('outbound.shipments.col.tracking')}</th>
                  <th className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-slate-700">{t('outbound.shipments.col.cost')}</th>
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
                          <>
                            <button
                              onClick={() => hold(s.id)}
                              title={t('outbound.shipments.action.hold')}
                              className="h-6 w-6 inline-flex items-center justify-center text-slate-500 hover:text-amber-700 hover:bg-amber-50 rounded"
                            >
                              <Pause size={11} />
                            </button>
                            <button onClick={() => printLabel(s.id)} title={t('outbound.shipments.action.label')} className="h-6 px-2 text-sm bg-blue-50 text-blue-700 border border-blue-200 rounded hover:bg-blue-100 inline-flex items-center gap-1">
                              <Printer size={11} /> {t('outbound.shipments.action.label')}
                            </button>
                          </>
                        )}
                        {s.status === 'ON_HOLD' && (
                          <button
                            onClick={() => release(s.id)}
                            title={s.heldReason ?? t('outbound.shipments.action.release')}
                            className="h-6 px-2 text-sm bg-amber-50 text-amber-700 border border-amber-200 rounded hover:bg-amber-100 inline-flex items-center gap-1"
                          >
                            <Play size={11} /> {t('outbound.shipments.action.release')}
                          </button>
                        )}
                        {s.status === 'LABEL_PRINTED' && (
                          <>
                            <button
                              onClick={() => reprintLabel(s.id)}
                              title={t('outbound.shipments.action.reprint')}
                              className="h-6 w-6 inline-flex items-center justify-center text-slate-500 hover:text-blue-700 hover:bg-blue-50 rounded"
                            >
                              <RotateCcw size={11} />
                            </button>
                            <button
                              onClick={() => voidLabel(s.id)}
                              title={t('outbound.shipments.action.void')}
                              className="h-6 w-6 inline-flex items-center justify-center text-slate-500 hover:text-rose-700 hover:bg-rose-50 rounded"
                            >
                              <Trash size={11} />
                            </button>
                            <button onClick={() => markShipped(s.id)} title={t('outbound.shipments.action.ship')} className="h-6 px-2 text-sm bg-emerald-50 text-emerald-700 border border-emerald-200 rounded hover:bg-emerald-100 inline-flex items-center gap-1">
                              <CheckCircle2 size={11} /> {t('outbound.shipments.action.ship')}
                            </button>
                          </>
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
