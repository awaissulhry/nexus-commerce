'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import {
  Mail, MapPin, Package, Truck, Undo2, Star, RefreshCw,
  ExternalLink, Clock, CheckCircle2, XCircle, DollarSign,
  ShoppingCart, FileText, Activity, Receipt,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Skeleton } from '@/components/ui/Skeleton'
import { useToast } from '@/components/ui/Toast'
import { getBackendUrl } from '@/lib/backend-url'
import { deepLinkForOrder } from '../_lib/deep-links'

const CHANNEL_TONE: Record<string, string> = {
  AMAZON: 'bg-orange-50 text-orange-700 border-orange-200',
  EBAY: 'bg-blue-50 text-blue-700 border-blue-200',
  SHOPIFY: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  WOOCOMMERCE: 'bg-violet-50 text-violet-700 border-violet-200',
  ETSY: 'bg-rose-50 text-rose-700 border-rose-200',
  MANUAL: 'bg-slate-50 text-slate-700 border-slate-200',
}
const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'danger' | 'default' | 'info'> = {
  PENDING: 'warning', SHIPPED: 'info', DELIVERED: 'success', CANCELLED: 'default',
}
const TIMELINE_ICON: Record<string, any> = {
  placed: ShoppingCart, paid: DollarSign, shipped: Truck, delivered: CheckCircle2,
  cancelled: XCircle, 'shipment-shipped': Truck, 'shipment-delivered': CheckCircle2,
  'return-received': Undo2, 'return-refunded': DollarSign, 'return-restocked': Package,
  'review-sent': Star, 'review-scheduled': Clock,
}

type Tab = 'summary' | 'fulfillment' | 'activity' | 'fiscal'

export default function OrderDetailClient({ id }: { id: string }) {
  const { toast } = useToast()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const tabParam = (searchParams.get('tab') as Tab) || 'summary'
  const [order, setOrder] = useState<any>(null)
  const [timeline, setTimeline] = useState<any[]>([])
  const [financials, setFinancials] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [reviewBusy, setReviewBusy] = useState(false)

  const setTab = useCallback(
    (t: Tab) => {
      const next = new URLSearchParams(searchParams.toString())
      if (t === 'summary') next.delete('tab')
      else next.set('tab', t)
      router.replace(`${pathname}?${next.toString()}`, { scroll: false })
    },
    [router, pathname, searchParams],
  )

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [oRes, tRes, fRes] = await Promise.all([
        fetch(`${getBackendUrl()}/api/orders/${id}`, { cache: 'no-store' }),
        fetch(`${getBackendUrl()}/api/orders/${id}/timeline`, { cache: 'no-store' }),
        fetch(`${getBackendUrl()}/api/orders/${id}/financials`, { cache: 'no-store' }),
      ])
      if (oRes.ok) setOrder(await oRes.json())
      if (tRes.ok) setTimeline((await tRes.json()).events ?? [])
      if (fRes.ok) setFinancials(await fRes.json())
    } finally { setLoading(false) }
  }, [id])

  useEffect(() => { refresh() }, [refresh])

  const requestReviewNow = async () => {
    setReviewBusy(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/orders/${id}/request-review`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      const tone = data.status === 'SENT' || data.status === 'OK' ? 'success' : 'info'
      const msg = `Review request: ${data.status}${data.errorMessage ? ` — ${data.errorMessage}` : ''}`
      toast[tone === 'success' ? 'success' : 'info'](msg)
      refresh()
    } catch (e: any) {
      toast.error(e.message)
    } finally { setReviewBusy(false) }
  }

  if (loading && !order) {
    return (
      <div className="p-5 space-y-3">
        <Skeleton variant="card" />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <div className="lg:col-span-2 space-y-3">
            <Skeleton variant="card" />
            <Skeleton variant="card" />
          </div>
          <div className="space-y-3">
            <Skeleton variant="card" />
            <Skeleton variant="card" />
          </div>
        </div>
      </div>
    )
  }
  if (!order) return <div className="p-5"><Card><div className="text-md text-rose-600 py-8 text-center">Order not found.</div></Card></div>

  const addr = order.shippingAddress ?? {}
  const lastReview = order.reviewRequests?.[0]

  return (
    <div className="space-y-5">
      <PageHeader
        title={`Order ${order.channelOrderId}`}
        description={`${order.customerName} · ${order.customerEmail}`}
        breadcrumbs={[{ label: 'Orders', href: '/orders' }, { label: order.channelOrderId }]}
        actions={
          <div className="flex items-center gap-2">
            {(() => {
              const link = deepLinkForOrder({
                channel: order.channel,
                marketplace: order.marketplace,
                channelOrderId: order.channelOrderId,
              })
              if (!link) return null
              return (
                <a
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={link.label}
                  className="h-8 px-3 text-base border border-slate-200 rounded hover:bg-slate-50 inline-flex items-center gap-1.5"
                >
                  <ExternalLink size={12} /> {link.label}
                </a>
              )
            })()}
            <button
              onClick={requestReviewNow}
              disabled={reviewBusy || !order.deliveredAt}
              title={!order.deliveredAt ? 'Order must be delivered first' : 'Send Amazon review request now (4-30d window)'}
              className="h-8 px-3 text-base bg-amber-50 text-amber-700 border border-amber-200 rounded hover:bg-amber-100 disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              <Star size={12} className={reviewBusy ? 'animate-pulse' : ''} /> Request review
            </button>
            {/* FU.1 — Italian fiscal artifacts (IT marketplace only).
                B2B unlocks the FatturaPA + SDI dispatch options;
                everyone else gets a Pro Forma + packing slip. */}
            {order.marketplace === 'IT' && (
              <FiscalActions order={order} />
            )}
            <button onClick={refresh} className="h-8 px-3 text-base border border-slate-200 rounded hover:bg-slate-50 inline-flex items-center gap-1.5">
              <RefreshCw size={12} /> Refresh
            </button>
          </div>
        }
      />

      {/* AU.1 — tab nav. Summary is default; others gate their
          content blocks. URL-backed via ?tab= so deep-links work
          (e.g. /orders/123?tab=fulfillment from a notification). */}
      <div role="tablist" aria-label="Order detail sections" className="inline-flex items-center bg-slate-100 rounded-md p-0.5 flex-wrap gap-0.5">
        {([
          { key: 'summary', label: 'Summary', icon: FileText },
          { key: 'fulfillment', label: 'Fulfillment', icon: Truck },
          { key: 'activity', label: 'Activity', icon: Activity },
          ...(order.marketplace === 'IT'
            ? ([{ key: 'fiscal', label: 'Fiscal', icon: Receipt }] as const)
            : ([] as const)),
        ] as Array<{ key: Tab; label: string; icon: any }>).map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tabParam === t.key}
            onClick={() => setTab(t.key)}
            className={`h-7 px-3 text-base font-medium inline-flex items-center gap-1.5 rounded transition-colors ${
              tabParam === t.key
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <t.icon size={12} aria-hidden="true" />
            {t.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Main column */}
        <div className="lg:col-span-2 space-y-4">
          {/* Header card — always visible regardless of tab */}
          <Card>
            <div className="flex items-start gap-3 flex-wrap">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className={`inline-block text-xs font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded ${CHANNEL_TONE[order.channel]}`}>{order.channel}</span>
                  {order.marketplace && <span className="text-xs font-mono bg-slate-100 px-1.5 py-0.5 rounded text-slate-700">{order.marketplace}</span>}
                  <Badge variant={STATUS_VARIANT[order.status] ?? 'default'} size="sm">{order.status}</Badge>
                  {order.fulfillmentMethod && <Badge variant={order.fulfillmentMethod === 'FBA' ? 'warning' : 'info'} size="sm">{order.fulfillmentMethod}</Badge>}
                </div>
                <div className="text-sm text-slate-500">
                  Placed {order.purchaseDate ? new Date(order.purchaseDate).toLocaleString() : new Date(order.createdAt).toLocaleString()}
                </div>
              </div>
              <div className="ml-auto text-right">
                <div className="text-sm uppercase tracking-wider text-slate-500 font-semibold">Total</div>
                <div className="text-[24px] font-semibold tabular-nums text-slate-900">{order.currencyCode === 'EUR' || !order.currencyCode ? '€' : ''}{Number(order.totalPrice).toFixed(2)}{order.currencyCode && order.currencyCode !== 'EUR' ? ` ${order.currencyCode}` : ''}</div>
              </div>
            </div>
          </Card>

          {/* AU.1 — Items live on Summary tab */}
          {tabParam === 'summary' && (
          <Card title="Items" description={`${order.items.length} line${order.items.length === 1 ? '' : 's'}`}>
            <div className="divide-y divide-slate-100">
              {order.items.map((it: any) => (
                <div key={it.id} className="flex items-center gap-3 py-2 -mx-3 px-3 hover:bg-slate-50">
                  {it.product?.thumbnailUrl ? (
                    <img src={it.product.thumbnailUrl} alt="" className="w-10 h-10 rounded object-cover bg-slate-100" />
                  ) : (
                    <div className="w-10 h-10 rounded bg-slate-100 flex items-center justify-center text-slate-400">
                      <Package size={14} />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    {it.product ? (
                      <Link href={`/products/${it.productId}/edit`} className="text-md text-slate-900 hover:text-blue-600 truncate block">
                        {it.product.name}
                      </Link>
                    ) : (
                      <div className="text-md text-slate-700 truncate">{it.sku}</div>
                    )}
                    <div className="text-sm text-slate-500 font-mono">{it.sku}</div>
                  </div>
                  {/* FU.1 — per-line VAT override (IT marketplace only) */}
                  {order.marketplace === 'IT' && (
                    <select
                      value={it.itVatRatePct == null ? '' : String(it.itVatRatePct)}
                      onChange={async (e) => {
                        const raw = e.target.value
                        const rate = raw === '' ? null : Number(raw)
                        try {
                          const res = await fetch(
                            `${getBackendUrl()}/api/orders/${order.id}/items/${it.id}/vat`,
                            {
                              method: 'PATCH',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ rate }),
                            },
                          )
                          if (!res.ok) throw new Error(await res.text())
                          toast.success(`VAT updated to ${rate ?? 'default'}%`)
                          refresh()
                        } catch (err: any) {
                          toast.error(err.message)
                        }
                      }}
                      title="Italian VAT rate for this line"
                      className="h-7 px-1.5 text-sm border border-slate-200 rounded tabular-nums"
                    >
                      <option value="">— %</option>
                      <option value="22">22%</option>
                      <option value="10">10%</option>
                      <option value="4">4%</option>
                      <option value="0">0% (esente)</option>
                    </select>
                  )}
                  <div className="text-right">
                    <div className="text-md tabular-nums text-slate-700">×{it.quantity}</div>
                    <div className="text-sm tabular-nums text-slate-500">€{it.price.toFixed(2)}</div>
                  </div>
                  {it.productId && (
                    <Link href={`/listings?search=${encodeURIComponent(it.sku)}`} className="text-sm text-blue-600 hover:underline inline-flex items-center gap-1">
                      Listings <ExternalLink size={10} />
                    </Link>
                  )}
                </div>
              ))}
            </div>
          </Card>
          )}

          {/* AU.1 — Timeline lives on Activity tab */}
          {tabParam === 'activity' && (
          <Card title="Timeline" description="Lifecycle events for this order">
            {timeline.length === 0 ? (
              <div className="text-base text-slate-400 text-center py-4">No events yet</div>
            ) : (
              <ol className="relative border-l border-slate-200 ml-2 space-y-3">
                {timeline.map((ev, i) => {
                  const Icon = TIMELINE_ICON[ev.kind] ?? Clock
                  return (
                    <li key={i} className="ml-4">
                      <div className="absolute -left-[8px] mt-0.5 w-4 h-4 rounded-full bg-white border border-slate-300 inline-flex items-center justify-center">
                        <Icon size={9} className="text-slate-500" />
                      </div>
                      <div className="text-base font-medium text-slate-900">{ev.label}</div>
                      <div className="text-xs text-slate-500">{new Date(ev.at).toLocaleString()}</div>
                    </li>
                  )
                })}
              </ol>
            )}
          </Card>
          )}

          {/* AU.1 — Channel-specific cards on Activity tab */}
          {tabParam === 'activity' && order.channel === 'SHOPIFY' && order.shopifyMetadata && (
            <ShopifyDiscountsCard meta={order.shopifyMetadata} />
          )}
          {tabParam === 'activity' && order.channel === 'EBAY' && order.ebayMetadata && (
            <EbayMessagingCard meta={order.ebayMetadata} channelOrderId={order.channelOrderId} />
          )}

          {/* AU.1 — Amazon FBM ship-by impact lives on Fulfillment */}
          {tabParam === 'fulfillment' && order.channel === 'AMAZON' && order.fulfillmentMethod === 'FBM' && (
            <AmazonShipByImpactCard order={order} />
          )}

          {/* AU.1 — Shipments on Fulfillment tab */}
          {tabParam === 'fulfillment' && order.shipments && order.shipments.length > 0 && (
            <Card title="Shipments" description={`${order.shipments.length} shipment${order.shipments.length === 1 ? '' : 's'}`}>
              <div className="space-y-2">
                {order.shipments.map((s: any) => (
                  <div key={s.id} className="border border-slate-200 rounded p-3 hover:bg-slate-50">
                    <div className="flex items-center justify-between">
                      <Link href={`/fulfillment/outbound?id=${s.id}`} className="flex-1 block">
                        <div className="text-base font-semibold text-slate-900 inline-flex items-center gap-1.5">
                          <Truck size={12} /> {s.carrierCode}
                          {s.trackingNumber && <span className="font-mono text-blue-600">{s.trackingNumber}</span>}
                        </div>
                        <div className="text-xs text-slate-500 mt-0.5">
                          {s.warehouse?.code ?? '—'} · {s.items.length} items
                          {s.shippedAt && ` · shipped ${new Date(s.shippedAt).toLocaleDateString('en-GB')}`}
                          {s.deliveredAt && ` · delivered ${new Date(s.deliveredAt).toLocaleDateString('en-GB')}`}
                        </div>
                      </Link>
                      <div className="flex items-center gap-2 ml-2">
                        {/* FU.2 — link to existing per-shipment pack-slip
                            (O.37 in /fulfillment/outbound) so operators
                            can print from /orders/[id] without bouncing. */}
                        <a
                          href={`${getBackendUrl()}/api/fulfillment/shipments/${s.id}/pack-slip.html`}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          title="Pack slip (apre in nuova scheda)"
                          className="text-sm text-slate-500 hover:text-slate-900 inline-flex items-center gap-1"
                        >
                          <ExternalLink size={11} /> Pack slip
                        </a>
                        <Badge variant="info" size="sm">{s.status.replace(/_/g, ' ')}</Badge>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* AU.1 — Returns on Fulfillment tab */}
          {tabParam === 'fulfillment' && order.returns && order.returns.length > 0 && (
            <Card title="Returns" description={`${order.returns.length} return${order.returns.length === 1 ? '' : 's'}`}>
              <div className="space-y-2">
                {order.returns.map((r: any) => (
                  <Link key={r.id} href={`/fulfillment/returns?id=${r.id}`} className="block border border-slate-200 rounded p-3 hover:bg-slate-50">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-base font-semibold text-slate-900 inline-flex items-center gap-1.5">
                          <Undo2 size={12} /> {r.rmaNumber ?? '—'}
                        </div>
                        <div className="text-xs text-slate-500 mt-0.5">{r.reason ?? 'No reason given'}</div>
                      </div>
                      <Badge variant="warning" size="sm">{r.status.replace(/_/g, ' ')}</Badge>
                    </div>
                  </Link>
                ))}
              </div>
            </Card>
          )}

          {/* AU.1 — Financials on Fiscal tab (IT) or Summary (non-IT)
              When marketplace is IT, fiscal-related views live on
              the dedicated tab; otherwise financials sit at the
              bottom of Summary so non-IT operators don't have to
              click into a one-card tab. */}
          {(order.marketplace === 'IT' ? tabParam === 'fiscal' : tabParam === 'summary')
            && financials && financials.transactions.length > 0 && (
            <Card title="Financials" description="Gross / fees / net">
              <div className="grid grid-cols-3 gap-3 mb-3">
                <FinTile label="Gross" value={financials.rollup.gross} tone="default" />
                <FinTile label="Fees" value={financials.rollup.fees} tone="danger" />
                <FinTile label="Net" value={financials.rollup.net} tone="success" />
              </div>
              <div className="text-xs text-slate-500 uppercase tracking-wider font-semibold mb-1.5">Transactions</div>
              <div className="space-y-1">
                {financials.transactions.map((tx: any) => (
                  <div key={tx.id} className="flex items-center justify-between text-sm border-b border-slate-100 py-1">
                    <div>
                      <span className="font-mono text-slate-700">{tx.transactionType}</span>
                      <span className="text-slate-500 ml-2">{new Date(tx.transactionDate).toLocaleDateString('en-GB')}</span>
                    </div>
                    <div className="tabular-nums font-mono text-slate-900">€{Number(tx.amount).toFixed(2)}</div>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          <Card title="Customer">
            <div className="space-y-2">
              <div className="text-md font-semibold text-slate-900">{order.customerName}</div>
              <div className="text-sm text-slate-500 inline-flex items-center gap-1.5"><Mail size={11} /> {order.customerEmail}</div>
              {addr && (
                <div className="text-sm text-slate-600 mt-1.5 inline-flex items-start gap-1.5">
                  <MapPin size={11} className="mt-0.5 flex-shrink-0" />
                  <span>{[addr.street, addr.city, addr.postalCode, addr.state, addr.country].filter(Boolean).join(', ')}</span>
                </div>
              )}
              <Link href={`/orders?customerEmail=${encodeURIComponent(order.customerEmail)}`} className="block mt-2 text-sm text-blue-600 hover:underline">
                All orders from this customer →
              </Link>
            </div>
          </Card>

          {order.customerHistory && order.customerHistory.length > 0 && (
            <Card title="Order history" description={`${order.customerHistory.length} prior order${order.customerHistory.length === 1 ? '' : 's'}`}>
              <ul className="space-y-1">
                {order.customerHistory.slice(0, 8).map((h: any) => (
                  <li key={h.id}>
                    <Link href={`/orders/${h.id}`} className="flex items-center justify-between gap-2 px-2 py-1.5 -mx-2 rounded hover:bg-slate-50">
                      <div className="min-w-0">
                        <div className="text-sm font-mono text-slate-700 truncate">{h.channelOrderId}</div>
                        <div className="text-xs text-slate-500">
                          {h.purchaseDate ? new Date(h.purchaseDate).toLocaleDateString('en-GB') : new Date(h.createdAt).toLocaleDateString('en-GB')}
                        </div>
                      </div>
                      <div className="text-sm tabular-nums text-slate-900 flex-shrink-0">€{Number(h.totalPrice).toFixed(2)}</div>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card title="Review request" description="Amazon Solicitations">
            {!lastReview ? (
              <div className="text-base text-slate-500">No request yet.</div>
            ) : (
              <div className="space-y-1">
                <Badge variant="info" size="sm">{lastReview.status}</Badge>
                {lastReview.sentAt && <div className="text-xs text-slate-500">Sent {new Date(lastReview.sentAt).toLocaleString()}</div>}
                {lastReview.errorMessage && <div className="text-xs text-rose-600">{lastReview.errorMessage}</div>}
                {lastReview.suppressedReason && <div className="text-xs text-slate-500">{lastReview.suppressedReason}</div>}
              </div>
            )}
            <div className="mt-3 text-xs text-slate-500">
              {!order.deliveredAt
                ? 'Wait until order is delivered before requesting.'
                : 'Amazon allows one request per order, between 4–30 days post-delivery, with no custom message.'}
            </div>
          </Card>

          {order.tags && order.tags.length > 0 && (
            <Card title="Tags">
              <div className="flex items-center gap-1.5 flex-wrap">
                {order.tags.map((t: any) => (
                  <span key={t.id} className="inline-flex items-center px-1.5 py-0.5 text-xs rounded" style={{ background: t.color ? `${t.color}20` : '#f1f5f9', color: t.color ?? '#64748b' }}>
                    {t.name}
                  </span>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}

function FinTile({ label, value, tone }: { label: string; value: number; tone: 'default' | 'success' | 'danger' }) {
  const cls = { default: 'text-slate-900', success: 'text-emerald-600', danger: 'text-rose-600' }[tone]
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold">{label}</div>
      <div className={`text-2xl font-semibold tabular-nums ${cls}`}>€{value.toFixed(2)}</div>
    </div>
  )
}

// ── FU.1: Italian fiscal action group ─────────────────────────────────
// Renders only on IT-marketplace orders. Three actions:
//   • Print fattura — opens /api/orders/:id/invoice.html for browser
//     print (Italian PRO FORMA on non-B2B; full fattura on B2B with
//     lazy-assigned F.2 invoice number)
//   • Download FatturaPA XML — only on B2B; SDI-format .xml for
//     manual upload to operator's commercial provider
//   • Dispatch SDI — only on B2B; env-gated (NEXUS_ENABLE_SDI_
//     DISPATCH=true). Default: marks the FiscalInvoice
//     sdiStatus='PENDING' so the operator surface shows queued
//     state.
//
// Operators can find these where they think to look (order detail
// header) without us duplicating the existing /fulfillment/outbound
// pack-slip URL — that surface owns per-shipment pack-time printing.
function FiscalActions({ order }: { order: any }) {
  const isB2B = order.fiscalKind === 'B2B'

  const dispatchSdi = async () => {
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/orders/${order.id}/fattura-pa/dispatch`,
        { method: 'POST' },
      )
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? 'dispatch failed')
      // useToast is in the parent scope; bubble via custom event
      // since this is a pure-function component without prop drill.
      window.dispatchEvent(
        new CustomEvent('nexus:toast', {
          detail: { kind: data.status === 'PENDING' ? 'success' : 'info', text: data.message },
        }),
      )
    } catch (e: any) {
      window.dispatchEvent(
        new CustomEvent('nexus:toast', {
          detail: { kind: 'error', text: e.message },
        }),
      )
    }
  }

  return (
    <>
      <a
        href={`${getBackendUrl()}/api/orders/${order.id}/invoice.html`}
        target="_blank"
        rel="noopener noreferrer"
        title="Stampa fattura (apre in nuova scheda — usa Cmd+P per salvare in PDF)"
        className="h-8 px-3 text-base bg-blue-50 text-blue-700 border border-blue-200 rounded hover:bg-blue-100 inline-flex items-center gap-1.5"
      >
        <DollarSign size={12} /> Fattura
      </a>
      {isB2B && (
        <>
          <a
            href={`${getBackendUrl()}/api/orders/${order.id}/fattura-pa.xml`}
            title="Download FatturaPA XML for manual SDI upload"
            className="h-8 px-3 text-base border border-slate-200 rounded hover:bg-slate-50 inline-flex items-center gap-1.5"
            download
          >
            <ExternalLink size={12} /> XML SDI
          </a>
          <button
            onClick={dispatchSdi}
            title="Dispatch invoice to SDI (env-gated — set NEXUS_ENABLE_SDI_DISPATCH=true to flip from dryRun)"
            className="h-8 px-3 text-base bg-emerald-50 text-emerald-700 border border-emerald-200 rounded hover:bg-emerald-100 inline-flex items-center gap-1.5"
          >
            <CheckCircle2 size={12} /> Invia SDI
          </button>
        </>
      )}
    </>
  )
}

// ── O.16a: Amazon FBM ship-by impact (LSR/VTR per-order) ──────────────
// Per-order at-a-glance for the two metrics Amazon's Seller
// Performance dashboard tracks for FBM:
//   LSR (Late Shipment Rate)  — late = shippedAt > shipByDate
//   VTR (Valid Tracking Rate) — needs trackingNumber on a shipment
//
// Tier mapping mirrors the perOrderShipByTier server helper:
//   on-time  green   — shipped before shipByDate w/ tracking
//   at-risk  amber   — not shipped, < 24h to shipByDate
//   overdue  red     — past shipByDate, not shipped (LSR risk)
//   late     red     — shipped after shipByDate (counts toward LSR)
//   no-track red     — shipped on time but no tracking (VTR hit)
//
// Computed entirely client-side from the order data we already
// have — same logic as amazon-account-health.service.ts on the
// backend, kept inline here so the card renders without a fetch.
function AmazonShipByImpactCard({ order }: { order: any }) {
  const shipBy = order.shipByDate ? new Date(order.shipByDate) : null
  const shippedAt = order.shippedAt ? new Date(order.shippedAt) : null
  const hasTracking = (order.shipments ?? []).some(
    (s: any) => s.trackingNumber && String(s.trackingNumber).trim() !== '',
  )
  let tier: 'on-time' | 'at-risk' | 'overdue' | 'late' | 'no-track'
  let reason: string

  if (shippedAt) {
    const lateBy = shipBy ? shippedAt.getTime() - shipBy.getTime() : 0
    if (shipBy && lateBy > 0) {
      const hours = Math.round(lateBy / (60 * 60 * 1000))
      tier = 'late'
      reason = `Shipped ${hours}h past ship-by — counts toward LSR`
    } else if (!hasTracking) {
      tier = 'no-track'
      reason = 'Shipped without tracking — counts against VTR'
    } else {
      tier = 'on-time'
      reason = 'Shipped on time with tracking'
    }
  } else if (shipBy) {
    const msToShipBy = shipBy.getTime() - Date.now()
    if (msToShipBy < 0) {
      const hours = Math.round(-msToShipBy / (60 * 60 * 1000))
      tier = 'overdue'
      reason = `Past ship-by by ${hours}h — LSR risk`
    } else if (msToShipBy < 24 * 60 * 60 * 1000) {
      const hours = Math.round(msToShipBy / (60 * 60 * 1000))
      tier = 'at-risk'
      reason = `${hours}h until ship-by`
    } else {
      tier = 'on-time'
      reason = 'On track'
    }
  } else {
    return null
  }

  const tone = {
    'on-time': 'bg-emerald-50 text-emerald-700 border-emerald-200',
    'at-risk': 'bg-amber-50 text-amber-700 border-amber-200',
    overdue: 'bg-rose-50 text-rose-700 border-rose-200',
    late: 'bg-rose-50 text-rose-700 border-rose-200',
    'no-track': 'bg-rose-50 text-rose-700 border-rose-200',
  }[tier]

  return (
    <Card>
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-semibold uppercase tracking-wider text-slate-700 inline-flex items-center gap-1.5">
          <Clock size={12} /> Amazon ship-by impact
        </div>
        <span
          className={`inline-block text-xs font-semibold uppercase px-1.5 py-0.5 border rounded ${tone}`}
        >
          {tier.replace('-', ' ')}
        </span>
      </div>
      <div className="text-base text-slate-700">{reason}</div>
      <div className="mt-2 pt-2 border-t border-slate-100 text-xs text-slate-500 grid grid-cols-2 gap-x-4 gap-y-1">
        <div>
          ship-by:{' '}
          {shipBy ? shipBy.toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) : '—'}
        </div>
        <div>
          shipped:{' '}
          {shippedAt
            ? shippedAt.toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })
            : '—'}
        </div>
        <div>tracking: {hasTracking ? 'yes' : 'no'}</div>
        <div>
          fulfillment: <span className="font-mono">FBM</span>
        </div>
      </div>
    </Card>
  )
}

// ── O.17: eBay buyer messaging surface ─────────────────────────────────
// eBay's full Messaging API is gated behind a separate scope (and the
// modern Messaging API is still in beta as of 2026). Until that's
// wired, this card surfaces what we already have: `buyerCheckoutNotes`
// from the Fulfillment API order payload (cached on
// Order.ebayMetadata at ingest time). Plus a deep-link to the seller-
// hub messages tab so operators can read/reply in eBay directly.
//
// When the Messaging API does get wired (env-flag-gated commit), the
// card grows a thread list — the surface stays the same.
function EbayMessagingCard({
  meta,
  channelOrderId,
}: {
  meta: any
  channelOrderId: string
}) {
  const checkoutNotes: string | null =
    meta?.buyerCheckoutNotes ?? meta?.checkoutMessage ?? null
  const buyerUsername: string | null = meta?.buyer?.username ?? null

  // Always render the card on eBay orders so operators have a
  // reliable place to deep-link from, even if no message text was
  // supplied at checkout. Empty-state copy is honest about why.
  return (
    <Card>
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-semibold uppercase tracking-wider text-slate-700 inline-flex items-center gap-1.5">
          <Mail size={12} /> eBay messages
        </div>
        <a
          href={`https://www.ebay.com/mesh/msg/inbox?buyerUsername=${encodeURIComponent(buyerUsername ?? '')}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-blue-600 hover:underline inline-flex items-center gap-1"
        >
          Open inbox <ExternalLink size={11} />
        </a>
      </div>
      {checkoutNotes ? (
        <div className="text-base text-slate-800 whitespace-pre-wrap border-l-2 border-blue-300 pl-3 py-1">
          {checkoutNotes}
          <div className="text-xs text-slate-500 mt-1">
            — {buyerUsername ?? 'buyer'}, at checkout
          </div>
        </div>
      ) : (
        <div className="text-sm text-slate-500">
          No checkout note from{' '}
          <span className="font-mono">{buyerUsername ?? 'the buyer'}</span>.
          Live message threads land here once the Messaging API is wired
          (set <code className="font-mono">NEXUS_ENABLE_EBAY_MESSAGING=1</code>{' '}
          + grant the messaging OAuth scope on your eBay connection).
        </div>
      )}
      <div className="mt-2 pt-2 border-t border-slate-100 text-xs text-slate-500">
        Order {channelOrderId} ·{' '}
        {meta?.lastModifiedDate
          ? `updated ${new Date(meta.lastModifiedDate).toLocaleString()}`
          : 'no recent activity'}
      </div>
    </Card>
  )
}

// ── O.18: Shopify discount codes + gift-card display ───────────────────
// Read-only render of the discount info Shopify ships in the
// orders/create webhook payload (which we cache verbatim on
// Order.shopifyMetadata). No new fetch — everything we need is
// already on the row.
//
// Surfaces:
//   - discount_codes[]:    [{ code, amount, type }] applied at checkout
//   - total_discounts:     gross discount in shop currency
//   - gift_cards:          payment_details / payment_gateway_names
//                          mention of gift_card; not always granular
//   - applied_discounts:   automatic discounts (Buy X Get Y, etc.)
//
// Renders nothing when no discount/gift-card markers are present —
// most Shopify orders go through cleanly without promo, no need to
// show an empty card.
function ShopifyDiscountsCard({ meta }: { meta: any }) {
  const discountCodes: Array<{ code: string; amount: string; type: string }> =
    Array.isArray(meta?.discount_codes) ? meta.discount_codes : []
  const totalDiscounts = Number(meta?.total_discounts ?? 0)
  const giftCardAmount = Number(meta?.total_tip_received ?? 0) // Shopify sometimes folds gift-card credit here
  const gateways: string[] = Array.isArray(meta?.payment_gateway_names)
    ? meta.payment_gateway_names
    : []
  const usedGiftCard = gateways.some((g) => /gift_card|giftcard/i.test(g))
  const appliedDiscounts: Array<{ title?: string; description?: string; value?: string; value_type?: string }> =
    Array.isArray(meta?.discount_applications) ? meta.discount_applications : []

  // Nothing to show? bail.
  const hasContent =
    discountCodes.length > 0 ||
    totalDiscounts > 0 ||
    usedGiftCard ||
    appliedDiscounts.length > 0
  if (!hasContent) return null

  return (
    <Card>
      <div className="text-sm font-semibold uppercase tracking-wider text-slate-700 mb-2 inline-flex items-center gap-1.5">
        <DollarSign size={12} /> Shopify promotions
      </div>
      <div className="space-y-2 text-sm">
        {discountCodes.length > 0 && (
          <div>
            <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-1">
              Discount codes
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              {discountCodes.map((d, i) => (
                <span
                  key={`${d.code}-${i}`}
                  className="inline-flex items-center gap-1 px-2 py-0.5 text-sm font-mono rounded bg-emerald-50 text-emerald-700 border border-emerald-200"
                >
                  {d.code}
                  {d.amount && (
                    <span className="text-xs text-emerald-600">
                      −{d.type === 'percentage' ? `${d.amount}%` : `€${Number(d.amount).toFixed(2)}`}
                    </span>
                  )}
                </span>
              ))}
            </div>
          </div>
        )}
        {appliedDiscounts.length > 0 && (
          <div>
            <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-1">
              Automatic discounts
            </div>
            <ul className="space-y-1">
              {appliedDiscounts.map((a, i) => (
                <li key={i} className="text-slate-700">
                  {a.title || a.description || 'Automatic discount'}
                  {a.value && (
                    <span className="text-slate-500 ml-1">
                      ({a.value_type === 'percentage' ? `${a.value}%` : `€${Number(a.value).toFixed(2)}`})
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {totalDiscounts > 0 && (
          <div className="text-slate-700">
            Total discount:{' '}
            <span className="font-semibold tabular-nums">
              €{totalDiscounts.toFixed(2)}
            </span>
          </div>
        )}
        {usedGiftCard && (
          <div className="inline-flex items-center gap-1.5 text-slate-700">
            <span className="inline-flex items-center px-2 py-0.5 text-xs font-semibold uppercase rounded bg-amber-50 text-amber-700 border border-amber-200">
              Gift card used
            </span>
            {giftCardAmount > 0 && (
              <span className="tabular-nums">
                €{giftCardAmount.toFixed(2)}
              </span>
            )}
          </div>
        )}
      </div>
    </Card>
  )
}
