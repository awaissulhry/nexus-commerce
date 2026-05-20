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
  Truck, Search, Printer, ExternalLink, X, CheckCircle2,
  AlertTriangle, Send, Download, RotateCcw, Trash, Pause, Play,
  Copy, Keyboard, Trash2,
} from 'lucide-react'
import FreshnessIndicator from '@/components/filters/FreshnessIndicator'
import {
  AutoRefreshSelect,
  DensityToggle as SharedDensityToggle,
  GridToolbar,
  KeyboardShortcutsModal,
  type AutoRefreshInterval,
  type Density,
  type ShortcutGroup,
} from '@/app/_shared/grid-lens'
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

// F1.10 — IN_FLIGHT is a pseudo-status surfaced as a pipeline chip.
// API translates it to status IN (LABEL_PRINTED, IN_TRANSIT) so the
// operator gets a single "with the carrier" view instead of
// toggling between two narrow filters. The aggregated count is
// computed client-side (counts is a per-row aggregate, not a server
// fetch).
const PIPELINE: Array<{ key: string; tKey: string }> = [
  { key: 'ALL', tKey: 'outbound.shipments.pipeline.all' },
  { key: 'DRAFT', tKey: 'outbound.shipments.pipeline.draft' },
  { key: 'READY_TO_PICK', tKey: 'outbound.shipments.pipeline.ready' },
  { key: 'ON_HOLD', tKey: 'outbound.shipments.pipeline.onHold' },
  { key: 'LABEL_PRINTED', tKey: 'outbound.shipments.pipeline.labeled' },
  { key: 'IN_FLIGHT', tKey: 'outbound.shipments.pipeline.inFlight' },
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
  // O.63: honor ?search= so Cmd+K (and any other deep-link) can land
  // on the shipments tab pre-filtered. Initialized from the URL once;
  // subsequent edits flow through the input → state path.
  const [search, setSearch] = useState(() => params.get('search') ?? '')
  // RB.1 — recycle-bin scope via ?deleted=true. Backend defaults to
  // live-only; this flag flips the list + selection into bin mode.
  const showDeleted = params.get('deleted') === 'true'
  const [items, setItems] = useState<Shipment[]>([])
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [density, setDensity] = useState<Density>(() => {
    if (typeof window === 'undefined') return 'comfortable'
    const v = window.localStorage.getItem('outbound-shipments.density') as Density | null
    return v === 'compact' || v === 'comfortable' || v === 'spacious' ? v : 'comfortable'
  })
  useEffect(() => { try { window.localStorage.setItem('outbound-shipments.density', density) } catch {} }, [density])
  const [autoRefreshMin, setAutoRefreshMin] = useState<AutoRefreshInterval>(() => {
    if (typeof window === 'undefined') return 0
    const n = Number(window.localStorage.getItem('outbound-shipments.autoRefreshMin'))
    return (n === 5 || n === 15) ? n : 0
  })
  useEffect(() => { try { window.localStorage.setItem('outbound-shipments.autoRefreshMin', String(autoRefreshMin)) } catch {} }, [autoRefreshMin])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [carriers, setCarriers] = useState<Array<{ code: string; isActive: boolean }>>([])

  const fetchShipments = useCallback(async () => {
    setLoading(true)
    try {
      const qs = new URLSearchParams()
      if (statusFilter !== 'ALL') qs.set('status', statusFilter)
      if (search) qs.set('search', search)
      if (showDeleted) qs.set('deleted', 'true')
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/shipments?${qs.toString()}`, { cache: 'no-store' })
      if (res.ok) {
        const data = await res.json()
        setItems(data.items ?? [])
        setLastFetchedAt(Date.now())
      }
    } finally { setLoading(false) }
  }, [statusFilter, search, showDeleted])

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
    // F1.10 — derived IN_FLIGHT aggregate. Counts only reflect what's
    // currently loaded (matching the active filter); when statusFilter
    // is something else we still surface a meaningful aggregate
    // because the next click will refetch with the IN_FLIGHT filter.
    c.IN_FLIGHT = (c.LABEL_PRINTED ?? 0) + (c.IN_TRANSIT ?? 0)
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

  // O.40: bulk hold / release. Eligible-status filter mirrors the
  // server gate so a partial-success doesn't surprise the operator.
  const bulkHold = async () => {
    if (selected.size === 0) { toast.error(t('outbound.pending.toast.selectFirst')); return }
    const eligible = items.filter((s) => selected.has(s.id) && !['LABEL_PRINTED', 'SHIPPED', 'IN_TRANSIT', 'DELIVERED', 'ON_HOLD'].includes(s.status))
    if (eligible.length === 0) { toast.error(t('outbound.pending.toast.selectFirst')); return }
    const reason = window.prompt(t('outbound.shipments.hold.prompt')) ?? ''
    if (!reason.trim()) return
    const res = await fetch(`${getBackendUrl()}/api/fulfillment/shipments/bulk-hold`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shipmentIds: eligible.map((s) => s.id), reason: reason.trim() }),
    })
    if (!res.ok) { toast.error(t('common.error')); return }
    const out = await res.json()
    if (out.held === eligible.length) toast.success(t('outbound.shipments.bulk.toast.heldAll', { n: out.held }))
    else toast.warning(t('outbound.shipments.bulk.toast.heldPartial', { ok: out.held, total: eligible.length }))
    for (const s of eligible) emitInvalidation({ type: 'shipment.updated', id: s.id })
    setSelected(new Set())
    fetchShipments()
  }

  const bulkRelease = async () => {
    if (selected.size === 0) { toast.error(t('outbound.pending.toast.selectFirst')); return }
    const eligible = items.filter((s) => selected.has(s.id) && s.status === 'ON_HOLD')
    if (eligible.length === 0) { toast.error(t('outbound.pending.toast.selectFirst')); return }
    const res = await fetch(`${getBackendUrl()}/api/fulfillment/shipments/bulk-release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shipmentIds: eligible.map((s) => s.id) }),
    })
    if (!res.ok) { toast.error(t('common.error')); return }
    const out = await res.json()
    if (out.released === eligible.length) toast.success(t('outbound.shipments.bulk.toast.releasedAll', { n: out.released }))
    else toast.warning(t('outbound.shipments.bulk.toast.releasedPartial', { ok: out.released, total: eligible.length }))
    for (const s of eligible) emitInvalidation({ type: 'shipment.updated', id: s.id })
    setSelected(new Set())
    fetchShipments()
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

  // F1.9 — server-side batch instead of N round-trips. Single audit
  // batch via writeMany on the API side; client just reports the
  // {shipped, skipped} pair. Mixed-status selections degrade
  // gracefully (skipped count surfaces in the toast).
  const bulkMarkShipped = async () => {
    if (selected.size === 0) { toast.error(t('outbound.pending.toast.selectFirst')); return }
    const eligible = items.filter((s) => selected.has(s.id) && s.status === 'LABEL_PRINTED')
    if (eligible.length === 0) { toast.error(t('outbound.pending.toast.selectFirst')); return }
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/shipments/bulk-mark-shipped`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shipmentIds: eligible.map((s) => s.id) }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data?.error ?? t('common.error'))
        return
      }
      reportBulk('shipped', data.shipped ?? 0, eligible.length)
      if ((data.shipped ?? 0) > 0) {
        emitInvalidation({ type: 'order.shipped', meta: { count: data.shipped } })
      }
      setSelected(new Set())
      fetchShipments()
    } catch (e: any) {
      toast.error(e?.message ?? t('common.error'))
    }
  }

  // F1.9 — bulk void-label. Carrier API is per-parcel so the server
  // serialises the calls; the client gets a {voided, failed, skipped,
  // results[]} payload. Cap is 50 (mirrors backend) — chunking
  // beyond that would block the worker too long.
  const bulkVoidLabel = async () => {
    if (selected.size === 0) { toast.error(t('outbound.pending.toast.selectFirst')); return }
    const eligible = items.filter((s) => selected.has(s.id) && s.status === 'LABEL_PRINTED')
    if (eligible.length === 0) { toast.error(t('outbound.pending.toast.selectFirst')); return }
    if (eligible.length > 50) {
      toast.error(t('outbound.shipments.toast.bulkVoidCap', { cap: 50 }))
      return
    }
    if (!(await askConfirm({
      title: t('outbound.shipments.bulkVoid.title', { n: eligible.length }),
      description: t('outbound.shipments.bulkVoid.description'),
      confirmLabel: t('outbound.shipments.bulkVoid.confirm'),
      tone: 'warning',
    }))) return
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/shipments/bulk-void-label`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shipmentIds: eligible.map((s) => s.id) }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data?.error ?? t('common.error'))
        return
      }
      const voided = data.voided ?? 0
      const failed = data.failed ?? 0
      if (failed === 0) {
        toast.success(t('outbound.shipments.toast.bulkVoidAll', { n: voided }))
      } else if (voided === 0) {
        toast.error(t('outbound.shipments.toast.bulkVoidNone', { n: failed }))
      } else {
        toast.warning(t('outbound.shipments.toast.bulkVoidPartial', { ok: voided, failed }))
      }
      if (voided > 0) {
        emitInvalidation({ type: 'shipment.updated', meta: { count: voided } })
      }
      setSelected(new Set())
      fetchShipments()
    } catch (e: any) {
      toast.error(e?.message ?? t('common.error'))
    }
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

  // RB.1 — recycle-bin handlers. Soft-delete from live scope, restore
  // + hard-delete from bin scope. The hard-delete confirm modal warns
  // when any selected shipment has a printed label (the carrier-side
  // label/charge isn't reversed by a database delete).
  const [confirmHardDelete, setConfirmHardDelete] = useState(false)
  const [recycleBusy, setRecycleBusy] = useState(false)

  const softDeleteSelected = async () => {
    if (selected.size === 0) { toast.error(t('outbound.pending.toast.selectFirst')); return }
    setRecycleBusy(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/shipments/bulk-soft-delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: Array.from(selected) }),
      })
      const out = await res.json().catch(() => ({}))
      if (!res.ok) { toast.error(out.error ?? t('common.error')); return }
      toast.success(t('outbound.bulk.movedToBin', { n: out.changed ?? selected.size }))
      emitInvalidation({ type: 'shipment.deleted', meta: { count: out.changed } })
      setSelected(new Set())
      fetchShipments()
    } finally { setRecycleBusy(false) }
  }

  const restoreSelected = async () => {
    if (selected.size === 0) { toast.error(t('outbound.pending.toast.selectFirst')); return }
    setRecycleBusy(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/shipments/bulk-restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: Array.from(selected) }),
      })
      const out = await res.json().catch(() => ({}))
      if (!res.ok) { toast.error(out.error ?? t('common.error')); return }
      toast.success(t('outbound.bulk.restored', { n: out.changed ?? selected.size }))
      emitInvalidation({ type: 'shipment.updated', meta: { count: out.changed } })
      setSelected(new Set())
      fetchShipments()
    } finally { setRecycleBusy(false) }
  }

  const hardDeleteSelected = async () => {
    if (selected.size === 0) { setConfirmHardDelete(false); return }
    setRecycleBusy(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/shipments/bulk-hard-delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: Array.from(selected) }),
      })
      const out = await res.json().catch(() => ({}))
      if (!res.ok) { toast.error(out.error ?? t('common.error')); return }
      toast.success(t('outbound.bulk.permanentlyDeleted', { n: out.purged ?? selected.size }))
      emitInvalidation({ type: 'shipment.deleted', meta: { count: out.purged } })
      setConfirmHardDelete(false)
      setSelected(new Set())
      fetchShipments()
    } finally { setRecycleBusy(false) }
  }

  // Selected rows that had a label printed — surface as a warning in
  // the hard-delete confirm modal so the operator knows the carrier
  // side isn't reversed by a local delete.
  const printedLabelSelected = useMemo(
    () => items.filter((s) => selected.has(s.id) && s.labelPrintedAt != null),
    [items, selected],
  )

  return (
    <div className="space-y-3">
      {!sendcloudConnected && (
        <Card>
          <div className="flex items-center gap-3">
            <AlertTriangle size={18} className="text-amber-600 dark:text-amber-400 flex-shrink-0" />
            <div className="flex-1">
              <div className="text-md font-semibold text-slate-900 dark:text-slate-100">{t('outbound.shipments.sendcloudNotConnected.title')}</div>
              <div className="text-base text-slate-500 dark:text-slate-400">{t('outbound.shipments.sendcloudNotConnected.description')}</div>
            </div>
            <Link href="/fulfillment/carriers" className="h-8 px-3 text-base bg-blue-600 dark:bg-blue-700 text-white rounded hover:bg-blue-700 dark:hover:bg-blue-600 inline-flex items-center">
              {t('outbound.shipments.sendcloudNotConnected.cta')}
            </Link>
          </div>
        </Card>
      )}

      <GridToolbar
        searchSlot={
          <div className="relative">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500" />
            <Input
              placeholder={t('outbound.shipments.searchPlaceholder')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-7 w-56"
            />
          </div>
        }
        quickFilterSlot={
          <>
            {PIPELINE.map((p) => (
              <button
                key={p.key}
                onClick={() => setStatusFilter(p.key)}
                className={`h-7 px-3 text-base border rounded-full inline-flex items-center gap-1.5 transition-colors ${statusFilter === p.key ? 'bg-slate-900 text-white border-slate-900 dark:bg-slate-100 dark:text-slate-900 dark:border-slate-100' : 'bg-white text-slate-700 border-slate-200 hover:border-slate-300 dark:bg-slate-900 dark:text-slate-300 dark:border-slate-700 dark:hover:border-slate-600'}`}
              >
                {t(p.tKey)}
                {counts[p.key] != null && (
                  <span className={`tabular-nums ${statusFilter === p.key ? 'text-slate-300 dark:text-slate-600' : 'text-slate-400 dark:text-slate-500'}`}>{counts[p.key]}</span>
                )}
              </button>
            ))}
          </>
        }
        density={<SharedDensityToggle density={density} onChange={setDensity} />}
        autoRefresh={
          <AutoRefreshSelect
            value={autoRefreshMin}
            onChange={setAutoRefreshMin}
            onTick={fetchShipments}
          />
        }
        freshness={
          <FreshnessIndicator
            lastFetchedAt={lastFetchedAt}
            onRefresh={fetchShipments}
            loading={loading}
          />
        }
        shortcuts={
          <button
            type="button"
            onClick={() => setShortcutsOpen(true)}
            className="h-7 w-7 inline-flex items-center justify-center border border-slate-200 dark:border-slate-700 rounded-md hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400"
            title="Keyboard shortcuts (?)"
            aria-label="Keyboard shortcuts"
          >
            <Keyboard size={12} />
          </button>
        }
        trailingSlot={
          /* RB.1 — recycle-bin toggle. Mirrors the /orders pattern
             (rose tone when active, sr-only label otherwise). Resets
             page selection so the bin scope starts clean. */
          <button
            type="button"
            onClick={() => {
              const next = new URLSearchParams(params.toString())
              if (showDeleted) next.delete('deleted')
              else next.set('deleted', 'true')
              router.replace(`?${next.toString()}`, { scroll: false })
              setSelected(new Set())
            }}
            title={showDeleted ? t('outbound.recycleBin.exit') : t('outbound.recycleBin.enter')}
            className={`h-8 px-3 text-base border rounded-md inline-flex items-center gap-1.5 transition-colors ${
              showDeleted
                ? 'bg-rose-50 text-rose-700 border-rose-200 hover:bg-rose-100 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800 dark:hover:bg-rose-900/40'
                : 'border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800'
            }`}
          >
            <Trash2 size={12} />
            {showDeleted ? t('outbound.recycleBin.label') : <span className="sr-only">{t('outbound.recycleBin.enter')}</span>}
          </button>
        }
      />

      {selected.size > 0 && (
        <div className="sticky top-2 z-20">
          <Card>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-base font-semibold text-slate-700 dark:text-slate-300">{t('outbound.pending.selectedCount', { n: selected.size })}</span>
              <div className="h-4 w-px bg-slate-200 dark:bg-slate-700" />
              {showDeleted ? (
                /* RB.1 — bin scope: only restore + permanently delete.
                   All print/ship/void/hold actions are hidden because
                   they don't make sense against soft-deleted rows. */
                <>
                  <button
                    onClick={restoreSelected}
                    disabled={recycleBusy}
                    className="h-7 px-3 text-base bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-900 rounded hover:bg-emerald-100 dark:hover:bg-emerald-900/60 disabled:opacity-50 inline-flex items-center gap-1.5"
                  >
                    <RotateCcw size={12} /> {t('outbound.bulk.restore')}
                  </button>
                  <button
                    onClick={() => setConfirmHardDelete(true)}
                    disabled={recycleBusy}
                    className="h-7 px-3 text-base bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-900 rounded hover:bg-rose-100 dark:hover:bg-rose-900/60 disabled:opacity-50 inline-flex items-center gap-1.5"
                  >
                    <Trash2 size={12} /> {t('outbound.bulk.permanentlyDelete')}
                  </button>
                </>
              ) : (
                <>
                  <button onClick={bulkPrint} className="h-7 px-3 text-base bg-blue-50 text-blue-700 border border-blue-200 rounded hover:bg-blue-100 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-900 dark:hover:bg-blue-900/60 inline-flex items-center gap-1.5">
                    <Printer size={12} /> {t('outbound.shipments.bulk.printLabels')}
                  </button>
                  <button onClick={bulkMarkShipped} className="h-7 px-3 text-base bg-emerald-50 text-emerald-700 border border-emerald-200 rounded hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900 dark:hover:bg-emerald-900/60 inline-flex items-center gap-1.5">
                    <Send size={12} /> {t('outbound.shipments.bulk.markShipped')}
                  </button>
                  {/* F1.9 — bulk void-label. Destructive (cancels carrier
                      parcel + resets the shipment to PACKED), so confirm
                      modal lives in bulkVoidLabel(). */}
                  <button onClick={bulkVoidLabel} className="h-7 px-3 text-base bg-rose-50 text-rose-700 border border-rose-200 rounded hover:bg-rose-100 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-900 dark:hover:bg-rose-900/60 inline-flex items-center gap-1.5">
                    <X size={12} /> {t('outbound.shipments.bulk.voidLabel')}
                  </button>
                  <button onClick={bulkHold} className="h-7 px-3 text-base bg-amber-50 text-amber-700 border border-amber-200 rounded hover:bg-amber-100 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900 dark:hover:bg-amber-900/60 inline-flex items-center gap-1.5">
                    <Pause size={12} /> {t('outbound.shipments.bulk.hold')}
                  </button>
                  <button onClick={bulkRelease} className="h-7 px-3 text-base bg-emerald-50 text-emerald-700 border border-emerald-200 rounded hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900 dark:hover:bg-emerald-900/60 inline-flex items-center gap-1.5">
                    <Play size={12} /> {t('outbound.shipments.bulk.release')}
                  </button>
                  <button onClick={bulkExportCsv} className="h-7 px-3 text-base bg-slate-50 text-slate-700 border border-slate-200 rounded hover:bg-slate-100 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700 dark:hover:bg-slate-700 inline-flex items-center gap-1.5">
                    <Download size={12} /> {t('outbound.shipments.bulk.exportCsv')}
                  </button>
                  <button
                    onClick={softDeleteSelected}
                    disabled={recycleBusy}
                    className="h-7 px-3 text-base bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-900 rounded hover:bg-rose-100 dark:hover:bg-rose-900/60 disabled:opacity-50 inline-flex items-center gap-1.5"
                  >
                    <Trash2 size={12} /> {t('outbound.bulk.delete')}
                  </button>
                </>
              )}
              <button onClick={() => setSelected(new Set())} className="ml-auto h-7 w-7 inline-flex items-center justify-center text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 rounded">
                <X size={14} />
              </button>
            </div>
          </Card>
        </div>
      )}

      {loading && items.length === 0 ? (
        <Card><div className="text-md text-slate-500 dark:text-slate-400 py-8 text-center">{t('common.loading')}</div></Card>
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
              <thead className="border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800">
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
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">{t('outbound.shipments.col.order')}</th>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">{t('outbound.shipments.col.status')}</th>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">{t('outbound.shipments.col.items')}</th>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">{t('outbound.shipments.col.carrier')}</th>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">{t('outbound.shipments.col.tracking')}</th>
                  <th className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">{t('outbound.shipments.col.cost')}</th>
                  <th className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300"></th>
                </tr>
              </thead>
              <tbody>
                {items.map((s) => (
                  <tr
                    key={s.id}
                    className={`border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60 ${s.orderId ? 'cursor-pointer' : ''}`}
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
                          className="text-base font-mono text-blue-600 dark:text-blue-400 hover:underline"
                          onClick={(e) => { e.stopPropagation(); openDrawer(s.orderId!) }}
                        >
                          {s.orderId.slice(0, 12)}…
                        </button>
                      ) : <span className="text-slate-400 dark:text-slate-500 text-base">—</span>}
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant={STATUS_TONE[s.status] ?? 'default'} size="sm">{s.status.replace(/_/g, ' ')}</Badge>
                    </td>
                    <td className="px-3 py-2 text-base text-slate-700 dark:text-slate-300">
                      <span className="tabular-nums">{s.items.reduce((n, i) => n + i.quantity, 0)}</span> units · {s.items.length} SKU{s.items.length === 1 ? '' : 's'}
                    </td>
                    <td className="px-3 py-2 text-base text-slate-700 dark:text-slate-300">{s.carrierCode}</td>
                    <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                      {s.trackingNumber ? (
                        <span className="inline-flex items-center gap-1 group/track">
                          {s.trackingUrl ? (
                            <a href={s.trackingUrl} target="_blank" rel="noreferrer" className="text-base font-mono text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-1">
                              {s.trackingNumber.slice(0, 16)}{s.trackingNumber.length > 16 ? '…' : ''}
                              <ExternalLink size={10} />
                            </a>
                          ) : (
                            <span className="text-base font-mono text-slate-700 dark:text-slate-300">{s.trackingNumber}</span>
                          )}
                          {/* O.65: copy tracking — operator pastes into
                              customer-support emails without re-typing.
                              Hover-revealed so it doesn't add noise to
                              the row when you're scanning visually. */}
                          <button
                            onClick={async () => {
                              try {
                                await navigator.clipboard.writeText(s.trackingNumber!)
                                toast.success(t('outbound.shipments.copy.toast'))
                              } catch {
                                toast.error(t('common.error'))
                              }
                            }}
                            title={t('outbound.shipments.copy.title')}
                            className="opacity-0 group-hover/track:opacity-100 h-5 w-5 inline-flex items-center justify-center text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 rounded transition-opacity"
                          >
                            <Copy size={10} />
                          </button>
                        </span>
                      ) : <span className="text-slate-400 dark:text-slate-500 text-base">—</span>}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-base text-slate-600 dark:text-slate-400">
                      {s.costCents != null ? `€${(s.costCents / 100).toFixed(2)}` : '—'}
                    </td>
                    <td className="px-3 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center gap-1 justify-end">
                        {(s.status === 'DRAFT' || s.status === 'READY_TO_PICK' || s.status === 'PACKED') && (
                          <>
                            <button
                              onClick={() => hold(s.id)}
                              title={t('outbound.shipments.action.hold')}
                              className="h-6 w-6 inline-flex items-center justify-center text-slate-500 dark:text-slate-400 hover:text-amber-700 dark:hover:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/40 rounded"
                            >
                              <Pause size={11} />
                            </button>
                            <button onClick={() => printLabel(s.id)} title={t('outbound.shipments.action.label')} className="h-6 px-2 text-sm bg-blue-50 text-blue-700 border border-blue-200 rounded hover:bg-blue-100 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-900 dark:hover:bg-blue-900/60 inline-flex items-center gap-1">
                              <Printer size={11} /> {t('outbound.shipments.action.label')}
                            </button>
                          </>
                        )}
                        {s.status === 'ON_HOLD' && (
                          <button
                            onClick={() => release(s.id)}
                            title={s.heldReason ?? t('outbound.shipments.action.release')}
                            className="h-6 px-2 text-sm bg-amber-50 text-amber-700 border border-amber-200 rounded hover:bg-amber-100 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900 dark:hover:bg-amber-900/60 inline-flex items-center gap-1"
                          >
                            <Play size={11} /> {t('outbound.shipments.action.release')}
                          </button>
                        )}
                        {s.status === 'LABEL_PRINTED' && (
                          <>
                            <button
                              onClick={() => reprintLabel(s.id)}
                              title={t('outbound.shipments.action.reprint')}
                              className="h-6 w-6 inline-flex items-center justify-center text-slate-500 dark:text-slate-400 hover:text-blue-700 dark:hover:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/40 rounded"
                            >
                              <RotateCcw size={11} />
                            </button>
                            <button
                              onClick={() => voidLabel(s.id)}
                              title={t('outbound.shipments.action.void')}
                              className="h-6 w-6 inline-flex items-center justify-center text-slate-500 dark:text-slate-400 hover:text-rose-700 dark:hover:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded"
                            >
                              <Trash size={11} />
                            </button>
                            <button onClick={() => markShipped(s.id)} title={t('outbound.shipments.action.ship')} className="h-6 px-2 text-sm bg-emerald-50 text-emerald-700 border border-emerald-200 rounded hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900 dark:hover:bg-emerald-900/60 inline-flex items-center gap-1">
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

      {shortcutsOpen && (
        <KeyboardShortcutsModal
          groups={SHIPMENTS_SHORTCUTS}
          onClose={() => setShortcutsOpen(false)}
        />
      )}

      {/* RB.1 — hard-delete confirm. Surfaces a label-print warning
          when any selected shipment has labelPrintedAt set: voiding
          the carrier label is a carrier operation, not a database
          delete, so the operator needs to know the carrier-side
          parcel + charge survives this action. */}
      {confirmHardDelete && (
        <div
          className="fixed inset-0 z-[1000] bg-slate-900/40 flex items-center justify-center p-4"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setConfirmHardDelete(false) }}
        >
          <div
            className="w-full max-w-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl p-5"
            role="dialog"
            aria-label={t('outbound.bulk.confirmHardDelete.title')}
          >
            <div className="flex items-start gap-3">
              <div className="h-9 w-9 shrink-0 rounded-full bg-rose-50 dark:bg-rose-950/40 flex items-center justify-center">
                <AlertTriangle size={18} className="text-rose-600 dark:text-rose-400" />
              </div>
              <div className="flex-1">
                <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                  {t('outbound.bulk.confirmHardDelete.title')}
                </h2>
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                  {t('outbound.bulk.confirmHardDelete.body', { n: selected.size })}
                </p>
                {printedLabelSelected.length > 0 && (
                  <div className="mt-3 rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-3 py-2">
                    <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                      {t('outbound.bulk.confirmHardDelete.labelWarningTitle', { n: printedLabelSelected.length })}
                    </p>
                    <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">
                      {t('outbound.bulk.confirmHardDelete.labelWarningBody')}
                    </p>
                    <ul className="mt-1.5 text-xs text-amber-800 dark:text-amber-300 space-y-0.5">
                      {printedLabelSelected.slice(0, 5).map((s) => (
                        <li key={s.id}>
                          <span className="font-mono">{s.carrierCode}</span>
                          {s.trackingNumber ? <> · {s.trackingNumber}</> : null}
                        </li>
                      ))}
                      {printedLabelSelected.length > 5 && (
                        <li className="italic">… +{printedLabelSelected.length - 5} more</li>
                      )}
                    </ul>
                  </div>
                )}
              </div>
            </div>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmHardDelete(false)}
                disabled={recycleBusy}
                className="h-8 px-3 text-sm border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={hardDeleteSelected}
                disabled={recycleBusy}
                className="h-8 px-3 text-sm bg-rose-600 text-white border border-rose-600 rounded hover:bg-rose-700 disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                <Trash2 size={12} /> {t('outbound.bulk.confirmHardDelete.confirm', { n: selected.size })}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const SHIPMENTS_SHORTCUTS: ShortcutGroup[] = [
  {
    title: 'Navigation',
    rows: [
      { keys: ['/'], label: 'Focus search' },
      { keys: ['r'], label: 'Refresh data' },
      { keys: ['Esc'], label: 'Clear selection' },
    ],
  },
  {
    title: 'Help',
    rows: [{ keys: ['?'], label: 'Toggle this overlay' }],
  },
]
