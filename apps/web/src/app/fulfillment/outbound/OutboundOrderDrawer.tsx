'use client'

// O.5 — Per-order drawer for the outbound surface. Mounted from
// OutboundWorkspace; opens via ?drawer=<orderId> URL state so direct
// links + back/forward work. Esc closes; clicking the dim overlay
// closes; pattern mirrors ProductDrawer.
//
// Renders order detail focused on outbound needs: customer + address,
// ship-by urgency banner, lifecycle timeline (purchase → ship by →
// delivery promise), line items with images, shipments-so-far list,
// and the create-shipment CTA when there's no active shipment.

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import {
  X, Package, ExternalLink, Truck, Crown, AlertTriangle, Clock,
  MapPin, User, CreditCard, Plus, Printer, CheckCircle2, Undo2,
  TrendingDown, Globe, Copy, FileText,
} from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Skeleton } from '@/components/ui/Skeleton'
import { useToast } from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { useTranslations } from '@/lib/i18n/use-translations'
import { emitInvalidation, useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import { getBackendUrl } from '@/lib/backend-url'

type DrawerOrder = {
  id: string
  channel: string
  marketplace: string | null
  channelOrderId: string
  status: string
  customerName: string
  customerEmail: string
  shippingAddress: any
  purchaseDate: string | null
  paidAt: string | null
  shippedAt: string | null
  deliveredAt: string | null
  cancelledAt: string | null
  shipByDate: string | null
  earliestShipDate: string | null
  latestDeliveryDate: string | null
  fulfillmentLatency: number | null
  isPrime: boolean | null
  fulfillmentMethod: string | null
  totalPrice: number
  currencyCode: string | null
  amazonMetadata: any
  ebayMetadata: any
  shopifyMetadata: any
  // FU.2 — Italian fiscal snapshot (F.1). Drives the fiscal-actions
  // group in this drawer when marketplace === 'IT'.
  fiscalKind: string | null
  woocommerceMetadata: any
  createdAt: string
  items: Array<{
    id: string
    sku: string
    productId: string | null
    quantity: number
    price: number
    product: { id: string; sku: string; name: string; imageUrl: string | null } | null
  }>
  shipments: Array<{
    id: string
    status: string
    carrierCode: string
    trackingNumber: string | null
    trackingUrl: string | null
    labelUrl: string | null
    costCents: number | null
    currencyCode: string | null
    weightGrams: number | null
    pickedAt: string | null
    packedAt: string | null
    labelPrintedAt: string | null
    shippedAt: string | null
    deliveredAt: string | null
    // O.83: hold-state metadata so the drawer can surface why a
    // shipment is on hold + offer one-click release.
    heldAt: string | null
    heldReason: string | null
    items: Array<{ id: string; sku: string; quantity: number }>
    warehouse?: { code: string; name: string } | null
    createdAt: string
    trackingEvents: Array<{
      id: string
      occurredAt: string
      code: string
      description: string
      location: string | null
      source: string
    }>
    activity: Array<{
      id: string
      action: string
      before: any
      after: any
      metadata: any
      userId: string | null
      createdAt: string
    }>
  }>
  // O.60: lean returns summary so the drawer can deep-link to existing
  // RMAs instead of letting the operator open a duplicate.
  returns?: Array<{
    id: string
    rmaNumber: string | null
    status: string
    refundStatus: string
    refundCents: number | null
    currencyCode: string
    channel: string
    isFbaReturn: boolean
    createdAt: string
  }>
}

// O.51 / O.54: human-readable label per audit action. Resolved
// against the i18n catalog so Italian operators see translated
// labels; falls through to the raw verb when no key is mapped.
// Map keys → i18n keys to keep both catalogs co-located.
const ACTION_TKEY: Record<string, string> = {
  'print-label': 'outbound.activity.action.printLabel',
  'void-label': 'outbound.activity.action.voidLabel',
  'void-label-failed': 'outbound.activity.action.voidLabelFailed',
  'mark-shipped': 'outbound.activity.action.markShipped',
  'hold': 'outbound.activity.action.hold',
  'release': 'outbound.activity.action.release',
  'auto-cancel-from-order': 'outbound.activity.action.autoCancel',
  'manual-cancel': 'outbound.activity.action.manualCancel',
}

const TRACKING_TONE: Record<string, string> = {
  ANNOUNCED: 'text-slate-500 bg-slate-100',
  PICKED_UP: 'text-blue-700 bg-blue-100',
  IN_TRANSIT: 'text-blue-700 bg-blue-100',
  OUT_FOR_DELIVERY: 'text-amber-700 bg-amber-100',
  DELIVERED: 'text-emerald-700 bg-emerald-100',
  DELIVERY_ATTEMPTED: 'text-amber-700 bg-amber-100',
  EXCEPTION: 'text-rose-700 bg-rose-100',
  RETURNED_TO_SENDER: 'text-rose-700 bg-rose-100',
  CANCELLED: 'text-slate-500 bg-slate-100',
  INFO: 'text-slate-500 bg-slate-100',
}

const CHANNEL_LABEL: Record<string, string> = {
  AMAZON: 'Amazon',
  EBAY: 'eBay',
  SHOPIFY: 'Shopify',
  WOOCOMMERCE: 'Woo',
  ETSY: 'Etsy',
  MANUAL: 'Manual',
}

const SHIPMENT_TONE: Record<string, 'default' | 'success' | 'warning' | 'danger' | 'info'> = {
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

function formatMoney(v: number, currency: string | null): string {
  const c = currency || 'EUR'
  try {
    return new Intl.NumberFormat('it-IT', { style: 'currency', currency: c }).format(v)
  } catch {
    return `${v.toFixed(2)} ${c}`
  }
}

function urgencyOf(d: string | null): { tint: string; tKey: string } | null {
  if (!d) return null
  const t = new Date(d).getTime()
  const now = Date.now()
  const diffH = (t - now) / 3_600_000
  if (diffH < 0) return { tint: 'bg-rose-50 text-rose-700 border-rose-200', tKey: 'outbound.drawer.urgency.overdue' }
  if (diffH < 24) return { tint: 'bg-amber-50 text-amber-700 border-amber-200', tKey: 'outbound.drawer.urgency.today' }
  if (diffH < 48) return { tint: 'bg-yellow-50 text-yellow-700 border-yellow-200', tKey: 'outbound.drawer.urgency.tomorrow' }
  return null
}

interface Props {
  orderId: string | null
  onClose: () => void
}

export default function OutboundOrderDrawer({ orderId, onClose }: Props) {
  const { toast } = useToast()
  const askConfirm = useConfirm()
  const { t } = useTranslations()
  const [data, setData] = useState<DrawerOrder | null>(null)
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)

  // O.28: rate-compare panel state. Lazily fetched per shipment when
  // operator clicks Compare. Cleared when drawer closes.
  type Rate = {
    source: 'SENDCLOUD' | 'AMAZON_BUY_SHIPPING'
    carrier: string
    serviceName: string
    serviceCode: string
    priceEur: number
  }
  const [ratesShipmentId, setRatesShipmentId] = useState<string | null>(null)
  const [rates, setRates] = useState<Rate[] | null>(null)
  const [ratesLoading, setRatesLoading] = useState(false)

  // O.64: customs preflight surface. The endpoint exists from the
  // Wave-2 work but no surface ever consumed it — so an Italian
  // merchant shipping internationally would only learn an HS code
  // was missing when Sendcloud rejected the print-label call. We
  // fetch the preflight for each active shipment on drawer open and
  // render a panel above the activity feed; errors there are an
  // explicit "fix this before printing" signal.
  type CustomsPreflight = {
    shipmentId: string
    destinationCountry: string | null
    isInternational: boolean
    isIntraEU: boolean
    currency: string
    totalValue: number
    lines: Array<{
      sku: string
      productSku: string | null
      productId: string | null
      quantity: number
      unitPrice: number
      totalValue: number
      hsCode: string | null
      originCountry: string | null
    }>
    issues: Array<{
      sku: string
      severity: 'error' | 'warning'
      code: string
      message: string
    }>
    // O.71: weight check (always present, regardless of international).
    weightCheck: {
      expectedGrams: number | null
      declaredGrams: number | null
      missingWeightMaster: boolean
      variancePct: number | null
      severity: 'ok' | 'warning' | 'error' | 'pending'
    }
    ready: boolean
  }
  const [customsByShipment, setCustomsByShipment] = useState<
    Record<string, CustomsPreflight>
  >({})

  const compareRates = async (shipmentId: string) => {
    setRatesShipmentId(shipmentId)
    setRates(null)
    setRatesLoading(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/shipments/${shipmentId}/rates`,
        { cache: 'no-store' },
      )
      if (res.ok) {
        const out = await res.json()
        setRates(out.rates ?? [])
      } else {
        toast.error(t('common.error'))
      }
    } catch {
      toast.error(t('common.error'))
    } finally {
      setRatesLoading(false)
    }
  }

  // O.48: operator-initiated cancellation. Confirm-gated; cascades
  // void/restock via the backend. Surfaces a follow-up toast about
  // channel pushback so operator knows to also cancel on the
  // marketplace.
  const cancelOrder = async () => {
    if (!orderId) return
    if (!(await askConfirm({
      title: t('outbound.drawer.cancel.title'),
      description: t('outbound.drawer.cancel.description'),
      confirmLabel: t('outbound.drawer.cancel.confirm'),
      tone: 'danger',
    }))) return
    try {
      const res = await fetch(`${getBackendUrl()}/api/orders/${orderId}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const out = await res.json()
      if (!res.ok) {
        toast.error(out.error ?? t('common.error'))
        return
      }
      toast.success(t('outbound.drawer.cancel.toast'))
      if (out.channelPushbackPending) {
        toast.warning(
          t('outbound.drawer.cancel.channelReminder', {
            channel: out.channel,
            orderId: out.channelOrderId ?? '',
          }),
        )
      }
      emitInvalidation({ type: 'shipment.deleted', meta: { orderId } })
      fetchDetail()
    } catch {
      toast.error(t('common.error'))
    }
  }

  const applyRate = async (rate: Rate) => {
    if (!ratesShipmentId) return
    const carrierCode =
      rate.source === 'AMAZON_BUY_SHIPPING' ? 'AMAZON_BUY_SHIPPING' : rate.carrier
    const res = await fetch(
      `${getBackendUrl()}/api/fulfillment/shipments/${ratesShipmentId}/service`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          carrierCode,
          serviceCode: rate.serviceCode,
          serviceName: rate.serviceName,
        }),
      },
    )
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      toast.error(err.error ?? t('common.error'))
      return
    }
    toast.success(t('rates.toast.applied', { service: rate.serviceName }))
    setRatesShipmentId(null)
    setRates(null)
    emitInvalidation({ type: 'shipment.updated', id: ratesShipmentId })
    fetchDetail()
  }

  const fetchDetail = useCallback(async () => {
    if (!orderId) return
    setLoading(true)
    setData(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/outbound/orders/${orderId}`,
        { cache: 'no-store' },
      )
      if (res.ok) setData(await res.json())
      else toast.error(t('common.error'))
    } catch {
      toast.error(t('common.error'))
    } finally {
      setLoading(false)
    }
  }, [orderId, toast])

  useEffect(() => { fetchDetail() }, [fetchDetail])

  // O.64: customs preflight per active shipment. Runs after the
  // drawer payload lands; one fetch per shipment in flight (capped
  // at the number of shipments per order — typically 1, occasionally
  // 2-3 with split packages). Cleared when the drawer's order
  // changes; the in-place merge keeps results during re-fetches so
  // the panel doesn't flash empty.
  useEffect(() => {
    if (!data) return
    const targets = data.shipments.filter(
      (s) => s.status !== 'CANCELLED' && s.status !== 'DELIVERED',
    )
    if (targets.length === 0) return
    let cancelled = false
    void Promise.all(
      targets.map(async (s) => {
        try {
          const res = await fetch(
            `${getBackendUrl()}/api/fulfillment/shipments/${s.id}/customs-preflight`,
            { cache: 'no-store' },
          )
          if (!res.ok) return null
          return (await res.json()) as CustomsPreflight
        } catch {
          return null
        }
      }),
    ).then((results) => {
      if (cancelled) return
      const next: Record<string, CustomsPreflight> = {}
      for (const r of results) {
        if (r && r.shipmentId) next[r.shipmentId] = r
      }
      setCustomsByShipment(next)
    })
    return () => {
      cancelled = true
    }
  }, [data])

  // O.26: re-fetch the open drawer when a sibling tab transitions
  // this order's outbound state. Filters by id when the event has
  // one to avoid full re-fetches for unrelated shipments.
  useInvalidationChannel(
    ['shipment.created', 'shipment.updated', 'order.shipped'],
    () => {
      // event.id may be a shipment id, not order id — easier to
      // just refetch unconditionally since the drawer is open at
      // most once.
      if (orderId) fetchDetail()
    },
  )

  // Esc closes. O.85: 'P' fires the primary print-label action when
  // the active shipment is in PACKED state — same idempotent endpoint
  // the in-drawer button hits, just keyboard-driven for power users.
  // Skipped when the operator is typing in an input/textarea so we
  // don't hijack the 'p' key from text editing.
  // Uses a ref for `data` so the listener doesn't re-bind on every
  // refetch — handler always reads the current shipment list.
  const dataRef = useRef<DrawerOrder | null>(null)
  useEffect(() => { dataRef.current = data }, [data])
  useEffect(() => {
    if (!orderId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key === 'p' || e.key === 'P') {
        const target = e.target as HTMLElement | null
        if (target) {
          const tag = target.tagName
          if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
          if (target.isContentEditable) return
        }
        if (e.metaKey || e.ctrlKey || e.altKey) return // don't shadow Cmd+P
        const ship = dataRef.current?.shipments.find((s) => s.status !== 'CANCELLED')
        if (!ship || ship.status !== 'PACKED') return
        e.preventDefault()
        void (async () => {
          const res = await fetch(
            `${getBackendUrl()}/api/fulfillment/shipments/${ship.id}/print-label`,
            { method: 'POST' },
          )
          const out = await res.json().catch(() => ({}))
          if (!res.ok) {
            toast.error(out.error ?? t('common.error'))
            return
          }
          const url = out.labelUrl ?? out.shipment?.labelUrl
          if (url) window.open(url, '_blank', 'noopener,noreferrer')
          toast.success(t('outbound.drawer.printLabel.toast'))
          emitInvalidation({ type: 'shipment.updated', meta: { shipmentId: ship.id } })
          fetchDetail()
        })()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [orderId, onClose, fetchDetail, toast, t])

  const createShipment = async () => {
    if (!orderId) return
    setCreating(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/shipments/bulk-create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderIds: [orderId] }),
      })
      const out = await res.json()
      if (!res.ok || (out.created ?? 0) === 0) {
        toast.error(out?.errors?.[0]?.reason ?? out.error ?? t('common.error'))
        return
      }
      toast.success(t('outbound.pending.toast.createdAll', { n: 1 }))
      emitInvalidation({ type: 'shipment.created', meta: { orderId } })
      fetchDetail()
    } catch {
      toast.error(t('common.error'))
    } finally {
      setCreating(false)
    }
  }

  if (!orderId) return null

  const activeShipments =
    data?.shipments.filter((s) => s.status !== 'CANCELLED') ?? []
  const hasActiveShipment = activeShipments.length > 0
  const urgency = urgencyOf(data?.shipByDate ?? null)
  const ship = data?.shippingAddress
  const channelMetadata =
    data?.channel === 'AMAZON' ? data.amazonMetadata
    : data?.channel === 'EBAY' ? data.ebayMetadata
    : data?.channel === 'SHOPIFY' ? data.shopifyMetadata
    : data?.channel === 'WOOCOMMERCE' ? data.woocommerceMetadata
    : null

  return (
    <div
      className="fixed inset-0 z-40 bg-slate-900/30 flex justify-end animate-fade-in"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t('outbound.drawer.lifecycle')}
    >
      <div
        className="w-full max-w-[640px] bg-white shadow-2xl border-l border-slate-200 flex flex-col h-full animate-slide-from-right"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ───────────────────────────────────────────── */}
        <div className="flex items-start gap-3 px-5 py-4 border-b border-slate-200">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-lg font-semibold text-slate-900 truncate">
                {data?.customerName || (loading ? t('common.loading') : t('outbound.pending.col.order'))}
              </h2>
              {data && (
                <Badge variant="info" size="sm">
                  {CHANNEL_LABEL[data.channel] ?? data.channel}
                  {data.marketplace ? ` · ${data.marketplace}` : ''}
                </Badge>
              )}
              {data?.isPrime && (
                <span
                  title="Amazon Prime SFP"
                  className="inline-flex items-center gap-0.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5"
                >
                  <Crown size={10} /> Prime
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 text-sm text-slate-500 font-mono mt-0.5">
              {/* O.87: click-to-copy on channel order id. Operators
                  paste this constantly into Amazon Seller Central /
                  eBay support / Shopify admin. Uses the existing
                  copy-tracking-toast pattern from O.65. */}
              {data?.channelOrderId ? (
                <button
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(data.channelOrderId)
                      toast.success(t('outbound.drawer.copyChannelOrderId.toast'))
                    } catch {
                      toast.error(t('common.error'))
                    }
                  }}
                  title={t('outbound.drawer.copyChannelOrderId.title')}
                  className="hover:text-slate-700 hover:underline"
                >
                  {data.channelOrderId}
                </button>
              ) : (
                <span>—</span>
              )}
              {data?.fulfillmentMethod && (
                <span className="text-slate-400">{data.fulfillmentMethod}</span>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="h-8 w-8 inline-flex items-center justify-center text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded"
            aria-label={t('common.close')}
          >
            <X size={16} />
          </button>
        </div>

        {/* ── Body ─────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {loading && !data ? (
            <div className="space-y-4" aria-busy="true" aria-label={t('common.loading')}>
              {/* Header-shape skeleton: customer + badges + order id */}
              <Card>
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Skeleton variant="block" width={140} height={20} />
                    <Skeleton variant="pill" width={80} />
                  </div>
                  <Skeleton variant="text" width="60%" />
                </div>
              </Card>
              {/* Address + lifecycle blocks */}
              <Card><Skeleton lines={3} /></Card>
              <Card><Skeleton lines={4} /></Card>
              {/* Items list skeleton — 3 thumbnail rows */}
              <Card>
                <div className="space-y-2">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="flex items-center gap-3">
                      <Skeleton variant="thumbnail" width={40} />
                      <div className="flex-1">
                        <Skeleton variant="text" width="70%" />
                      </div>
                      <Skeleton variant="block" width={40} height={14} />
                    </div>
                  ))}
                </div>
              </Card>
            </div>
          ) : data ? (
            <>
              {/* O.47: status step indicator. Shows where in the
                  pipeline the highest-status shipment is. Past steps
                  filled emerald, current step blue, future steps
                  slate. Cancelled/Returned states render as a single
                  badge instead since they're terminal-and-bad. */}
              {(() => {
                const ship = activeShipments[0]
                if (!ship) return null
                const TERMINAL_BAD = ['CANCELLED', 'RETURNED']
                if (TERMINAL_BAD.includes(ship.status)) {
                  return (
                    <div className="flex items-center justify-center py-2">
                      <Badge variant="danger" size="sm">{ship.status.replace(/_/g, ' ')}</Badge>
                    </div>
                  )
                }
                if (ship.status === 'ON_HOLD') {
                  return (
                    <div className="flex items-start gap-2 py-2 bg-amber-50 border border-amber-200 rounded px-3">
                      <Badge variant="warning" size="sm">ON HOLD</Badge>
                      <div className="flex-1 text-sm">
                        {/* O.83: surface heldReason inline so the
                            operator doesn't have to dig the audit
                            log to learn why something is blocked. */}
                        {ship.heldReason ? (
                          <div className="text-amber-900">{ship.heldReason}</div>
                        ) : (
                          <div className="text-amber-700">{t('outbound.drawer.held.noReason')}</div>
                        )}
                        {ship.heldAt && (
                          <div className="text-xs text-amber-700 tabular-nums">
                            {t('outbound.drawer.held.since', {
                              date: new Date(ship.heldAt).toLocaleString('it-IT', {
                                month: 'short',
                                day: 'numeric',
                                hour: '2-digit',
                                minute: '2-digit',
                              }),
                            })}
                          </div>
                        )}
                      </div>
                      <button
                        onClick={async () => {
                          const res = await fetch(
                            `${getBackendUrl()}/api/fulfillment/shipments/${ship.id}/release`,
                            { method: 'POST' },
                          )
                          if (!res.ok) {
                            const out = await res.json().catch(() => ({}))
                            toast.error(out.error ?? t('common.error'))
                            return
                          }
                          toast.success(t('outbound.drawer.held.released'))
                          emitInvalidation({ type: 'shipment.updated', meta: { shipmentId: ship.id } })
                          fetchDetail()
                        }}
                        className="h-7 px-3 text-sm bg-emerald-600 text-white rounded hover:bg-emerald-700 inline-flex items-center gap-1"
                      >
                        {t('outbound.drawer.held.release')}
                      </button>
                    </div>
                  )
                }
                const STEPS: Array<{ key: string; label: string }> = [
                  { key: 'DRAFT', label: 'Created' },
                  { key: 'PACKED', label: 'Packed' },
                  { key: 'LABEL_PRINTED', label: 'Labeled' },
                  { key: 'SHIPPED', label: 'Shipped' },
                  { key: 'DELIVERED', label: 'Delivered' },
                ]
                const STATUS_RANK: Record<string, number> = {
                  DRAFT: 0, READY_TO_PICK: 0, PICKED: 0,
                  PACKED: 1, LABEL_PRINTED: 2,
                  SHIPPED: 3, IN_TRANSIT: 3, DELIVERED: 4,
                }
                const currentIdx = STATUS_RANK[ship.status] ?? 0
                return (
                  <div className="flex items-center gap-1 px-1">
                    {STEPS.map((step, idx) => {
                      const isPast = idx < currentIdx
                      const isCurrent = idx === currentIdx
                      const isLast = idx === STEPS.length - 1
                      return (
                        <div key={step.key} className="flex items-center flex-1 last:flex-none">
                          <div className="flex flex-col items-center gap-1 flex-1 last:flex-none">
                            <div
                              className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold transition-colors ${
                                isPast
                                  ? 'bg-emerald-500 text-white'
                                  : isCurrent
                                  ? 'bg-blue-600 text-white ring-4 ring-blue-100'
                                  : 'bg-slate-100 text-slate-400 border border-slate-300'
                              }`}
                            >
                              {isPast ? '✓' : idx + 1}
                            </div>
                            <span
                              className={`text-[10px] uppercase tracking-wider whitespace-nowrap ${
                                isCurrent ? 'text-blue-700 font-semibold' : isPast ? 'text-slate-700' : 'text-slate-400'
                              }`}
                            >
                              {step.label}
                            </span>
                          </div>
                          {!isLast && (
                            <div
                              className={`flex-1 h-0.5 mx-1 -mt-4 ${
                                isPast ? 'bg-emerald-500' : 'bg-slate-200'
                              }`}
                            />
                          )}
                        </div>
                      )
                    })}
                  </div>
                )
              })()}

              {/* Urgency banner */}
              {urgency && (
                <div className={`flex items-center gap-2 px-3 py-2 rounded border ${urgency.tint}`}>
                  <AlertTriangle size={14} />
                  <span className="text-md font-semibold">
                    {t('outbound.drawer.shipBy')} {t(urgency.tKey).toLowerCase()}
                  </span>
                  <span className="text-md ml-auto">
                    {data.shipByDate ? new Date(data.shipByDate).toLocaleString('it-IT') : ''}
                  </span>
                </div>
              )}

              {/* Customer + address */}
              <Card>
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-700 uppercase tracking-wider">
                    <User size={12} /> {t('outbound.drawer.customer')}
                  </div>
                  <div className="text-md text-slate-900">{data.customerName || '—'}</div>
                  <div className="text-base text-slate-600">{data.customerEmail || '—'}</div>
                  {ship && (() => {
                    // O.68: copy-address affordance. Operators paste
                    // shipping addresses into manual carrier portals,
                    // customer-support emails, and printer dialogs;
                    // copy-paste from a multi-line div is brittle
                    // (extra whitespace, missed lines). One-click copy
                    // gives them a clean newline-joined block.
                    const addressLines = [
                      data.customerName,
                      ship.AddressLine1 ?? ship.addressLine1 ?? ship.street,
                      ship.AddressLine2 ?? ship.addressLine2,
                      [ship.PostalCode ?? ship.postalCode, ship.City ?? ship.city].filter(Boolean).join(' '),
                      [ship.StateOrRegion ?? ship.stateOrProvince ?? ship.state, ship.CountryCode ?? ship.countryCode ?? ship.country].filter(Boolean).join(' · '),
                    ].filter(Boolean) as string[]
                    return (
                      <div className="pt-2 border-t border-slate-100">
                        <div className="flex items-center gap-2 text-sm font-semibold text-slate-700 uppercase tracking-wider mb-1.5">
                          <MapPin size={12} /> {t('outbound.drawer.shipTo')}
                          <button
                            onClick={async () => {
                              try {
                                await navigator.clipboard.writeText(addressLines.join('\n'))
                                toast.success(t('outbound.drawer.copyAddress.toast'))
                              } catch {
                                toast.error(t('common.error'))
                              }
                            }}
                            title={t('outbound.drawer.copyAddress.title')}
                            className="ml-auto h-5 w-5 inline-flex items-center justify-center text-slate-400 hover:text-slate-700 rounded normal-case"
                          >
                            <Copy size={11} />
                          </button>
                        </div>
                        <div className="text-base text-slate-700 whitespace-pre-line">
                          {addressLines.slice(1).join('\n')}
                        </div>
                      </div>
                    )
                  })()}
                </div>
              </Card>

              {/* Lifecycle timeline */}
              <Card>
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-700 uppercase tracking-wider">
                    <Clock size={12} /> {t('outbound.drawer.lifecycle')}
                  </div>
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-base">
                    <Row label={t('outbound.drawer.lifecycle.purchased')} value={data.purchaseDate} />
                    {data.paidAt && <Row label={t('outbound.drawer.lifecycle.paid')} value={data.paidAt} />}
                    <Row label={t('outbound.drawer.lifecycle.shipBy')} value={data.shipByDate} highlight={!!urgency} />
                    {data.earliestShipDate && (
                      <Row label={t('outbound.drawer.lifecycle.earliestShip')} value={data.earliestShipDate} />
                    )}
                    {data.latestDeliveryDate && (
                      <Row label={t('outbound.drawer.lifecycle.promisedBy')} value={data.latestDeliveryDate} />
                    )}
                    {data.shippedAt && <Row label={t('outbound.drawer.lifecycle.shipped')} value={data.shippedAt} />}
                    {data.deliveredAt && <Row label={t('outbound.drawer.lifecycle.delivered')} value={data.deliveredAt} />}
                    {data.cancelledAt && <Row label={t('outbound.drawer.lifecycle.cancelled')} value={data.cancelledAt} />}
                  </dl>
                </div>
              </Card>

              {/* FU.2 — Italian fiscal artifacts (mirror of /orders
                  /[id]'s FiscalActions). Renders only on IT-marketplace
                  orders so the outbound operator can print fattura
                  + dispatch SDI without bouncing to /orders. The
                  per-shipment pack-slip link further below stays
                  unchanged — that surface owns pack-time printing. */}
              {data.marketplace === 'IT' && (
                <Card>
                  <div className="space-y-2">
                    <div className="text-sm font-semibold text-slate-700 uppercase tracking-wider">
                      Documenti fiscali
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <a
                        href={`${getBackendUrl()}/api/orders/${data.id}/invoice.html`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="h-7 px-3 text-sm bg-blue-50 text-blue-700 border border-blue-200 rounded hover:bg-blue-100 inline-flex items-center gap-1.5"
                      >
                        <ExternalLink size={11} /> Fattura
                      </a>
                      {data.fiscalKind === 'B2B' && (
                        <>
                          <a
                            href={`${getBackendUrl()}/api/orders/${data.id}/fattura-pa.xml`}
                            className="h-7 px-3 text-sm border border-slate-200 rounded hover:bg-slate-50 inline-flex items-center gap-1.5"
                            download
                          >
                            <ExternalLink size={11} /> XML SDI
                          </a>
                          <button
                            onClick={async () => {
                              try {
                                const res = await fetch(
                                  `${getBackendUrl()}/api/orders/${data.id}/fattura-pa/dispatch`,
                                  { method: 'POST' },
                                )
                                const d = await res.json()
                                if (!res.ok) throw new Error(d?.error ?? 'dispatch failed')
                                toast.success(d.message ?? 'SDI dispatched')
                              } catch (e: any) {
                                toast.error(e.message)
                              }
                            }}
                            className="h-7 px-3 text-sm bg-emerald-50 text-emerald-700 border border-emerald-200 rounded hover:bg-emerald-100 inline-flex items-center gap-1.5"
                          >
                            Invia SDI
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </Card>
              )}

              {/* Line items */}
              <Card>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-sm font-semibold text-slate-700 uppercase tracking-wider">
                      <Package size={12} /> {t('outbound.drawer.items', { n: data.items.length })}
                    </div>
                    <div className="text-md font-semibold text-slate-900 tabular-nums">
                      {formatMoney(data.totalPrice, data.currencyCode)}
                    </div>
                  </div>
                  <div className="divide-y divide-slate-100">
                    {data.items.map((it) => (
                      <div key={it.id} className="flex items-center gap-3 py-2">
                        <div className="flex-shrink-0 w-10 h-10 rounded bg-slate-100 flex items-center justify-center overflow-hidden">
                          {it.product?.imageUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={it.product.imageUrl} alt="" className="w-full h-full object-cover" />
                          ) : (
                            <Package className="w-4 h-4 text-slate-400" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-base text-slate-900 truncate">
                            {it.product?.name ?? it.sku}
                          </div>
                          <div className="text-sm text-slate-500 font-mono">{it.sku}</div>
                        </div>
                        <div className="text-base text-slate-700 tabular-nums">
                          ×{it.quantity}
                        </div>
                        <div className="text-base text-slate-700 tabular-nums w-20 text-right">
                          {formatMoney(it.price * it.quantity, data.currencyCode)}
                        </div>
                        {it.productId && (
                          <Link
                            href={`/products/${it.productId}`}
                            className="text-slate-400 hover:text-blue-600"
                            title="Open product"
                          >
                            <ExternalLink size={12} />
                          </Link>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </Card>

              {/* Shipments */}
              <Card>
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-700 uppercase tracking-wider">
                    <Truck size={12} /> {t('outbound.drawer.shipments', { n: data.shipments.length })}
                  </div>
                  {data.shipments.length === 0 ? (
                    <div className="text-base text-slate-500 py-2">
                      {t('outbound.drawer.noShipmentYet')}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {data.shipments.map((s) => (
                        <div
                          key={s.id}
                          className="flex items-center gap-2 px-3 py-2 border border-slate-100 rounded"
                        >
                          <Badge variant={SHIPMENT_TONE[s.status] ?? 'default'} size="sm">
                            {s.status.replace(/_/g, ' ')}
                          </Badge>
                          <div className="flex-1 min-w-0">
                            <div className="text-base text-slate-700">
                              {s.carrierCode}
                              {s.warehouse && (
                                <span className="text-sm text-slate-500"> · {s.warehouse.code}</span>
                              )}
                            </div>
                            {/* O.28: rate-compare button — only for shipments
                                that haven't printed a label yet. */}
                            {!['LABEL_PRINTED', 'SHIPPED', 'IN_TRANSIT', 'DELIVERED'].includes(s.status) && (
                              <button
                                onClick={() => compareRates(s.id)}
                                className="text-xs text-blue-600 hover:underline inline-flex items-center gap-1 mt-0.5"
                              >
                                <TrendingDown size={9} /> {t('rates.compare')}
                              </button>
                            )}
                            {s.trackingNumber && (
                              s.trackingUrl ? (
                                <a
                                  href={s.trackingUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-sm font-mono text-blue-600 hover:underline inline-flex items-center gap-1"
                                >
                                  {s.trackingNumber}
                                  <ExternalLink size={9} />
                                </a>
                              ) : (
                                <span className="text-sm font-mono text-slate-600">{s.trackingNumber}</span>
                              )
                            )}
                          </div>
                          {s.costCents != null && (
                            <span className="text-sm tabular-nums text-slate-600">
                              €{(s.costCents / 100).toFixed(2)}
                            </span>
                          )}
                          {/* O.80: pack slip — operator's "what goes in
                              the box" reference. Useful before pack
                              (to print and walk the warehouse) AND
                              post-ship (to print a record copy). */}
                          <a
                            href={`${getBackendUrl()}/api/fulfillment/shipments/${s.id}/pack-slip.html`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-slate-400 hover:text-blue-600"
                            title={t('outbound.drawer.printPackSlip')}
                          >
                            <FileText size={12} />
                          </a>
                          {s.labelUrl && (
                            <a
                              href={s.labelUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="text-slate-400 hover:text-blue-600"
                              title={t('outbound.drawer.printLabel.button')}
                            >
                              <Printer size={12} />
                            </a>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </Card>

              {/* O.28: Rate-compare panel (modal-like, inline) */}
              {ratesShipmentId && (
                <Card>
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-2 text-sm font-semibold text-slate-700 uppercase tracking-wider">
                        <TrendingDown size={12} /> {t('rates.title')}
                      </div>
                      <button
                        onClick={() => { setRatesShipmentId(null); setRates(null) }}
                        className="ml-auto h-6 w-6 inline-flex items-center justify-center text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded"
                        aria-label={t('common.close')}
                      >
                        <X size={12} />
                      </button>
                    </div>
                    {ratesLoading ? (
                      <div className="text-md text-slate-500 py-4 text-center">{t('common.loading')}</div>
                    ) : !rates || rates.length === 0 ? (
                      <div className="text-md text-slate-500 py-4 text-center">
                        {t('rates.empty')}
                      </div>
                    ) : (
                      <div className="space-y-1.5">
                        {rates.map((r, idx) => (
                          <button
                            key={`${r.source}-${r.serviceCode}`}
                            onClick={() => applyRate(r)}
                            className={`w-full flex items-center gap-3 px-3 py-2 border rounded hover:bg-slate-50 text-left transition-colors ${
                              idx === 0 ? 'border-emerald-200 bg-emerald-50/50' : 'border-slate-200'
                            }`}
                          >
                            {idx === 0 && (
                              <Badge variant="success" size="sm">{t('rates.cheapest')}</Badge>
                            )}
                            <div className="flex-1 min-w-0">
                              <div className="text-md text-slate-900 truncate">{r.serviceName}</div>
                              <div className="text-xs text-slate-500">
                                {r.carrier} · {r.source === 'AMAZON_BUY_SHIPPING' ? 'Amazon Buy Shipping' : 'Sendcloud'}
                              </div>
                            </div>
                            <div className="tabular-nums text-md font-semibold text-slate-900">
                              €{r.priceEur.toFixed(2)}
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </Card>
              )}

              {/* O.64 + O.71: shipment preflight panel — surfaces when
                  any active shipment is heading abroad (customs check)
                  OR when a weight-check flag fires (warning/error).
                  Skips rendering for boring intra-EU shipments where
                  every check passes. */}
              {Object.values(customsByShipment).some(
                (c) =>
                  c.isInternational ||
                  c.weightCheck.severity === 'warning' ||
                  c.weightCheck.severity === 'error',
              ) && (
                <Card>
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-sm font-semibold text-slate-700 uppercase tracking-wider">
                      <Globe size={12} /> {t('outbound.drawer.customs.title')}
                    </div>
                    {Object.values(customsByShipment)
                      .filter(
                        (c) =>
                          c.isInternational ||
                          c.weightCheck.severity === 'warning' ||
                          c.weightCheck.severity === 'error',
                      )
                      .map((c) => {
                        const errors = c.issues.filter((i) => i.severity === 'error')
                        const warnings = c.issues.filter((i) => i.severity === 'warning')
                        return (
                          <div key={c.shipmentId} className="space-y-2 border border-slate-200 rounded p-2">
                            <div className="flex items-center gap-2 text-xs">
                              <span className="text-slate-500">{t('outbound.drawer.customs.destination')}</span>
                              <span className="font-mono font-medium text-slate-900">{c.destinationCountry ?? '—'}</span>
                              <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                                c.ready
                                  ? 'bg-emerald-50 text-emerald-700'
                                  : 'bg-rose-50 text-rose-700'
                              }`}>
                                {c.ready
                                  ? t('outbound.drawer.customs.ready')
                                  : t('outbound.drawer.customs.blocked')}
                              </span>
                              <span className="ml-auto text-xs text-slate-500 tabular-nums">
                                {c.currency} {c.totalValue.toFixed(2)}
                              </span>
                            </div>
                            {/* F1.8 — printable CN22 (small) / CN23 (large)
                                customs declaration. Backend picks the
                                right form based on weight + value. Opens
                                in a new tab and auto-prints. */}
                            {c.isInternational && (
                              <div className="flex items-center gap-2 pt-1 border-t border-slate-100">
                                <a
                                  href={`${getBackendUrl()}/api/fulfillment/shipments/${c.shipmentId}/customs-declaration.html`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-xs px-2 py-1 border border-slate-300 rounded hover:bg-slate-50 inline-flex items-center gap-1.5"
                                  title={t('outbound.drawer.customs.printCnHint')}
                                >
                                  <Globe size={11} />
                                  {t('outbound.drawer.customs.printCn')}
                                </a>
                                <a
                                  href={`${getBackendUrl()}/api/fulfillment/shipments/${c.shipmentId}/customs-declaration.html?category=RETURNED_GOODS`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-xs px-2 py-1 border border-slate-300 rounded hover:bg-slate-50 inline-flex items-center gap-1.5"
                                >
                                  {t('outbound.drawer.customs.printCnReturn')}
                                </a>
                              </div>
                            )}
                            {errors.length > 0 && (
                              <ul className="space-y-1 text-xs">
                                {errors.map((iss, idx) => (
                                  <li key={`e-${idx}`} className="flex items-start gap-1.5 text-rose-700">
                                    <AlertTriangle size={11} className="mt-0.5 flex-shrink-0" />
                                    <span>{iss.message}</span>
                                  </li>
                                ))}
                              </ul>
                            )}
                            {/* O.71: weight check inline. Renders as a
                                small row when a comparison is possible
                                (declared + master both present); other
                                states (pending pack, missing master)
                                show muted hints so the operator knows
                                why no green badge is showing yet. */}
                            {(() => {
                              const w = c.weightCheck
                              if (w.severity === 'pending') {
                                if (w.declaredGrams == null) {
                                  return (
                                    <div className="text-xs text-slate-500">
                                      {t('outbound.drawer.weight.pendingPack')}
                                    </div>
                                  )
                                }
                                if (w.missingWeightMaster) {
                                  return (
                                    <div className="text-xs text-amber-700">
                                      {t('outbound.drawer.weight.masterMissing')}
                                    </div>
                                  )
                                }
                              }
                              const tone =
                                w.severity === 'error'
                                  ? 'text-rose-700'
                                  : w.severity === 'warning'
                                  ? 'text-amber-700'
                                  : 'text-emerald-700'
                              const tKey =
                                w.severity === 'error'
                                  ? 'outbound.drawer.weight.error'
                                  : w.severity === 'warning'
                                  ? 'outbound.drawer.weight.warning'
                                  : 'outbound.drawer.weight.ok'
                              return (
                                <div className={`text-xs flex items-center gap-2 ${tone}`}>
                                  <span>
                                    {t(tKey, {
                                      declared: ((w.declaredGrams ?? 0) / 1000).toFixed(2),
                                      expected: ((w.expectedGrams ?? 0) / 1000).toFixed(2),
                                      pct: w.variancePct ?? 0,
                                    })}
                                  </span>
                                </div>
                              )
                            })()}
                            {warnings.length > 0 && (
                              <ul className="space-y-1 text-xs">
                                {warnings.map((iss, idx) => (
                                  <li key={`w-${idx}`} className="flex items-start gap-1.5 text-amber-700">
                                    <AlertTriangle size={11} className="mt-0.5 flex-shrink-0" />
                                    <span>{iss.message}</span>
                                  </li>
                                ))}
                              </ul>
                            )}
                            {c.isInternational && c.lines.length > 0 && (
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="text-slate-500 border-b border-slate-100">
                                    <th className="text-left font-normal py-1">{t('outbound.drawer.customs.col.sku')}</th>
                                    <th className="text-right font-normal py-1">{t('outbound.drawer.customs.col.qty')}</th>
                                    <th className="text-left font-normal py-1 px-2">{t('outbound.drawer.customs.col.hs')}</th>
                                    <th className="text-left font-normal py-1">{t('outbound.drawer.customs.col.origin')}</th>
                                    <th className="text-right font-normal py-1">{t('outbound.drawer.customs.col.value')}</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {c.lines.map((l, idx) => {
                                    const missing = !l.hsCode || !l.originCountry
                                    return (
                                      <tr key={`${l.sku}-${idx}`} className="border-b border-slate-50 last:border-0">
                                        <td className="py-1 font-mono text-slate-700">
                                          {/* O.66: deep-link to product edit
                                              when master data is missing —
                                              one click to fix the gap. */}
                                          {missing && l.productId ? (
                                            <Link
                                              href={`/products/${l.productId}/edit`}
                                              className="hover:underline text-blue-600 inline-flex items-center gap-0.5"
                                              title={t('outbound.drawer.customs.fixProduct')}
                                            >
                                              {l.sku} <ExternalLink size={9} />
                                            </Link>
                                          ) : l.sku}
                                        </td>
                                        <td className="py-1 text-right tabular-nums text-slate-700">{l.quantity}</td>
                                        <td className={`py-1 px-2 font-mono ${l.hsCode ? 'text-slate-700' : 'text-rose-600'}`}>
                                          {l.hsCode ?? '—'}
                                        </td>
                                        <td className={`py-1 ${l.originCountry ? 'text-slate-700' : 'text-amber-600'}`}>
                                          {l.originCountry ?? '—'}
                                        </td>
                                        <td className="py-1 text-right tabular-nums text-slate-700">
                                          {l.totalValue.toFixed(2)}
                                        </td>
                                      </tr>
                                    )
                                  })}
                                </tbody>
                              </table>
                            )}
                          </div>
                        )
                      })}
                  </div>
                </Card>
              )}

              {/* O.49: per-shipment activity log — collated across
                  all shipments, most-recent first. Pulls from the
                  AuditLog rows the lifecycle endpoints write (print/
                  void/hold/release/ship/auto-cancel). */}
              {data.shipments.some((s) => s.activity.length > 0) && (
                <Card>
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-sm font-semibold text-slate-700 uppercase tracking-wider">
                      <Clock size={12} /> {t('outbound.drawer.activity')}
                    </div>
                    <div className="space-y-1.5">
                      {data.shipments
                        .flatMap((s) =>
                          s.activity.map((a) => ({ ...a, shipmentId: s.id, carrier: s.carrierCode })),
                        )
                        .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
                        .slice(0, 20)
                        .map((a) => {
                          const reason = (a.metadata as any)?.reason
                          const dryRun = (a.metadata as any)?.dryRun
                          const beforeStatus = (a.before as any)?.status
                          const afterStatus = (a.after as any)?.status
                          const tone =
                            a.action.includes('void') || a.action.includes('cancel')
                              ? 'text-rose-700 bg-rose-50'
                              : a.action.includes('hold')
                              ? 'text-amber-700 bg-amber-50'
                              : a.action.includes('release') || a.action.includes('shipped') || a.action.includes('print')
                              ? 'text-emerald-700 bg-emerald-50'
                              : 'text-slate-700 bg-slate-100'
                          const tKey = ACTION_TKEY[a.action]
                          const label = tKey ? t(tKey) : a.action
                          return (
                            <div key={a.id} className="flex items-start gap-3 text-sm">
                              <div className="text-slate-500 tabular-nums w-32 flex-shrink-0">
                                {new Date(a.createdAt).toLocaleString('it-IT', {
                                  month: 'short',
                                  day: 'numeric',
                                  hour: '2-digit',
                                  minute: '2-digit',
                                })}
                              </div>
                              {/* O.54: click-through to /audit-log
                                  filtered to this shipment. Operator
                                  finds the full forensic detail
                                  (before/after JSON, metadata) one
                                  click away from the drawer. */}
                              <Link
                                href={`/audit-log?entityType=Shipment&entityId=${a.shipmentId}`}
                                className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium hover:underline ${tone}`}
                                title={t('outbound.activity.openAuditLog')}
                              >
                                {label}
                              </Link>
                              <div className="flex-1 min-w-0 text-slate-600 space-y-0.5">
                                <div>
                                  {a.userId ? `by ${a.userId}` : t('outbound.activity.bySystem')}
                                  {reason ? ` · ${reason}` : ''}
                                  {dryRun ? ' · dryRun' : ''}
                                </div>
                                {/* O.51: state-change diff. Only render
                                    when both sides are status-typed +
                                    actually different. Operator-readable
                                    visual: BEFORE → AFTER with arrow. */}
                                {beforeStatus && afterStatus && beforeStatus !== afterStatus && (
                                  <div className="text-xs text-slate-500 font-mono">
                                    {beforeStatus.replace(/_/g, ' ')} → {afterStatus.replace(/_/g, ' ')}
                                  </div>
                                )}
                              </div>
                            </div>
                          )
                        })}
                    </div>
                    {/* O.74: link to the full audit log for this
                        order. The activity feed shows the most-recent
                        20; the full audit log includes everything
                        plus before/after JSON for forensic review. */}
                    {(() => {
                      const shipmentIds = data.shipments.map((s) => s.id)
                      if (shipmentIds.length === 0) return null
                      // /audit-log accepts entityType + a comma-separated
                      // entityIds for multi-shipment orders.
                      const href = `/audit-log?entityType=Shipment&entityIds=${shipmentIds.join(',')}`
                      return (
                        <Link
                          href={href}
                          className="text-xs text-blue-600 hover:underline inline-flex items-center gap-1"
                        >
                          {t('outbound.drawer.activityViewAll')}
                          <ExternalLink size={9} />
                        </Link>
                      )
                    })()}
                  </div>
                </Card>
              )}

              {/* O.20: Tracking timeline — collated across all shipments,
                   most-recent first. Empty when no carrier scans yet. */}
              {data.shipments.some((s) => s.trackingEvents.length > 0) && (
                <Card>
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-sm font-semibold text-slate-700 uppercase tracking-wider">
                      <Clock size={12} /> {t('outbound.drawer.timeline')}
                    </div>
                    <div className="space-y-1.5">
                      {data.shipments
                        .flatMap((s) =>
                          s.trackingEvents.map((e) => ({ ...e, shipmentId: s.id, carrier: s.carrierCode })),
                        )
                        .sort((a, b) => +new Date(b.occurredAt) - +new Date(a.occurredAt))
                        .slice(0, 30)
                        .map((e) => (
                          <div key={e.id} className="flex items-start gap-3 text-sm">
                            <div className="text-slate-500 tabular-nums w-32 flex-shrink-0">
                              {new Date(e.occurredAt).toLocaleString('it-IT', {
                                month: 'short',
                                day: 'numeric',
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </div>
                            <span
                              className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${
                                TRACKING_TONE[e.code] ?? 'text-slate-500 bg-slate-100'
                              }`}
                            >
                              {e.code.replace(/_/g, ' ')}
                            </span>
                            <div className="flex-1 min-w-0">
                              <div className="text-slate-700">{e.description}</div>
                              {e.location && <div className="text-xs text-slate-500">{e.location}</div>}
                            </div>
                          </div>
                        ))}
                    </div>
                  </div>
                </Card>
              )}

              {/* Channel metadata (collapsed by default — operator-debug surface) */}
              {channelMetadata && (
                <details className="group">
                  <summary className="cursor-pointer text-sm font-semibold text-slate-500 uppercase tracking-wider hover:text-slate-700">
                    <CreditCard size={12} className="inline mr-1" />
                    {t('outbound.drawer.channelMeta')}
                  </summary>
                  <pre className="mt-2 p-3 bg-slate-50 border border-slate-200 rounded text-xs text-slate-700 overflow-x-auto max-h-64 overflow-y-auto">
                    {JSON.stringify(channelMetadata, null, 2)}
                  </pre>
                </details>
              )}
            </>
          ) : null}
        </div>

        {/* ── Footer ───────────────────────────────────────────── */}
        {data && (
          <div className="flex items-center gap-2 px-5 py-3 border-t border-slate-200 bg-slate-50">
            {!hasActiveShipment ? (
              <button
                onClick={createShipment}
                disabled={creating}
                className="h-11 md:h-8 px-4 md:px-3 text-base bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                <Plus size={12} /> {t('outbound.drawer.createShipment')}
              </button>
            ) : (() => {
              // O.13 + O.77: surface the next-step CTA based on shipment
              // state. Pre-PACKED shipments → "Pack & ready" → /pack
              // page. PACKED → in-drawer Print label button (was
              // "go to shipments tab" — that round-trip is now gone).
              // LABEL_PRINTED+ → tracking is in flight.
              const ship = activeShipments[0]
              if (!ship) return null
              if (['DRAFT', 'READY_TO_PICK', 'PICKED'].includes(ship.status)) {
                return (
                  <Link
                    href={`/fulfillment/outbound/pack/${ship.id}`}
                    className="h-8 px-3 text-base bg-blue-600 text-white rounded hover:bg-blue-700 inline-flex items-center gap-1.5"
                  >
                    <Plus size={12} /> {t('outbound.drawer.packAndReady')}
                  </Link>
                )
              }
              if (ship.status === 'PACKED') {
                return (
                  <button
                    onClick={async () => {
                      const res = await fetch(
                        `${getBackendUrl()}/api/fulfillment/shipments/${ship.id}/print-label`,
                        { method: 'POST' },
                      )
                      const out = await res.json().catch(() => ({}))
                      if (!res.ok) {
                        toast.error(out.error ?? t('common.error'))
                        return
                      }
                      const url = out.labelUrl ?? out.shipment?.labelUrl
                      if (url) window.open(url, '_blank', 'noopener,noreferrer')
                      toast.success(t('outbound.drawer.printLabel.toast'))
                      emitInvalidation({ type: 'shipment.updated', meta: { shipmentId: ship.id } })
                      fetchDetail()
                    }}
                    className="h-8 px-3 text-base bg-blue-600 text-white rounded hover:bg-blue-700 inline-flex items-center gap-1.5"
                  >
                    <Printer size={12} /> {t('outbound.drawer.printLabel.button')}
                  </button>
                )
              }
              return (
                <span className="inline-flex items-center gap-1.5 h-8 px-3 text-base text-emerald-700 bg-emerald-50 border border-emerald-200 rounded">
                  <CheckCircle2 size={12} />
                  {t('outbound.drawer.shipmentInFlight')}
                </span>
              )
            })()}
            {/* O.21 + O.60: returns links. When an RMA already exists
                we deep-link to it so the operator doesn't open a
                duplicate; we still expose a "+ new" button so multi-
                package orders can spawn additional RMAs. */}
            {(() => {
              const returns = data.returns ?? []
              const openCount = returns.filter(
                (r) => r.status !== 'COMPLETED' && r.status !== 'CANCELLED',
              ).length
              return (
                <>
                  {returns.length > 0 && (
                    <Link
                      href={`/fulfillment/returns?orderId=${data.id}`}
                      className="h-8 px-3 text-base text-amber-700 bg-amber-50 border border-amber-200 rounded hover:bg-amber-100 inline-flex items-center gap-1.5"
                      title={t('outbound.drawer.viewReturnsTooltip', {
                        n: returns.length,
                      })}
                    >
                      <Undo2 size={11} />
                      {openCount > 0
                        ? t('outbound.drawer.viewReturnsOpen', {
                            n: returns.length,
                            open: openCount,
                          })
                        : t('outbound.drawer.viewReturns', { n: returns.length })}
                    </Link>
                  )}
                  {hasActiveShipment && (
                    <Link
                      href={`/fulfillment/returns?new=1&orderId=${data.id}`}
                      className="h-8 px-3 text-base text-slate-700 border border-slate-200 rounded hover:bg-white inline-flex items-center gap-1.5"
                    >
                      <Undo2 size={11} />
                      {returns.length > 0
                        ? t('outbound.drawer.generateAnotherReturn')
                        : t('outbound.drawer.generateReturn')}
                    </Link>
                  )}
                </>
              )
            })()}
            {/* O.48: cancel order — only when not already terminal. */}
            {data.status !== 'CANCELLED' && data.status !== 'DELIVERED' && (
              <button
                onClick={cancelOrder}
                className="h-8 px-3 text-base text-rose-700 border border-rose-200 rounded hover:bg-rose-50 inline-flex items-center gap-1.5"
                title={t('outbound.drawer.cancel.confirm')}
              >
                <X size={11} /> {t('outbound.drawer.cancel.button')}
              </button>
            )}
            <Link
              href={`/orders/${data.id}`}
              className="ml-auto h-8 px-3 text-base text-slate-700 border border-slate-200 rounded hover:bg-white inline-flex items-center gap-1.5"
            >
              {t('outbound.drawer.openFullOrder')}
              <ExternalLink size={11} />
            </Link>
          </div>
        )}
      </div>
    </div>
  )
}

function Row({ label, value, highlight = false }: { label: string; value: string | null; highlight?: boolean }) {
  return (
    <>
      <dt className="text-slate-500">{label}</dt>
      <dd className={`tabular-nums ${highlight ? 'text-rose-700 font-semibold' : 'text-slate-700'}`}>
        {value ? new Date(value).toLocaleString('it-IT') : '—'}
      </dd>
    </>
  )
}
