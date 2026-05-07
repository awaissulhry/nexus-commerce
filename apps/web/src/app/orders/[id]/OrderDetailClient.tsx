'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  Mail, MapPin, Package, Truck, Undo2, Star, RefreshCw,
  ExternalLink, Clock, CheckCircle2, XCircle, DollarSign,
  ShoppingCart,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { getBackendUrl } from '@/lib/backend-url'

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

export default function OrderDetailClient({ id }: { id: string }) {
  const [order, setOrder] = useState<any>(null)
  const [timeline, setTimeline] = useState<any[]>([])
  const [financials, setFinancials] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [reviewBusy, setReviewBusy] = useState(false)

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
      alert(`Review request: ${data.status}${data.errorMessage ? ` — ${data.errorMessage}` : ''}`)
      refresh()
    } catch (e: any) {
      alert(e.message)
    } finally { setReviewBusy(false) }
  }

  if (loading && !order) return <div className="p-5"><Card><div className="text-md text-slate-500 py-8 text-center">Loading order…</div></Card></div>
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
            <button
              onClick={requestReviewNow}
              disabled={reviewBusy || !order.deliveredAt}
              title={!order.deliveredAt ? 'Order must be delivered first' : 'Send Amazon review request now (4-30d window)'}
              className="h-8 px-3 text-base bg-amber-50 text-amber-700 border border-amber-200 rounded hover:bg-amber-100 disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              <Star size={12} className={reviewBusy ? 'animate-pulse' : ''} /> Request review
            </button>
            <button onClick={refresh} className="h-8 px-3 text-base border border-slate-200 rounded hover:bg-slate-50 inline-flex items-center gap-1.5">
              <RefreshCw size={12} /> Refresh
            </button>
          </div>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Main column */}
        <div className="lg:col-span-2 space-y-4">
          {/* Header card */}
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

          {/* Items */}
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

          {/* Timeline */}
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

          {/* Shipments */}
          {order.shipments && order.shipments.length > 0 && (
            <Card title="Shipments" description={`${order.shipments.length} shipment${order.shipments.length === 1 ? '' : 's'}`}>
              <div className="space-y-2">
                {order.shipments.map((s: any) => (
                  <Link key={s.id} href={`/fulfillment/outbound?id=${s.id}`} className="block border border-slate-200 rounded p-3 hover:bg-slate-50">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-base font-semibold text-slate-900 inline-flex items-center gap-1.5">
                          <Truck size={12} /> {s.carrierCode}
                          {s.trackingNumber && <span className="font-mono text-blue-600">{s.trackingNumber}</span>}
                        </div>
                        <div className="text-xs text-slate-500 mt-0.5">
                          {s.warehouse?.code ?? '—'} · {s.items.length} items
                          {s.shippedAt && ` · shipped ${new Date(s.shippedAt).toLocaleDateString('en-GB')}`}
                          {s.deliveredAt && ` · delivered ${new Date(s.deliveredAt).toLocaleDateString('en-GB')}`}
                        </div>
                      </div>
                      <Badge variant="info" size="sm">{s.status.replace(/_/g, ' ')}</Badge>
                    </div>
                  </Link>
                ))}
              </div>
            </Card>
          )}

          {/* Returns */}
          {order.returns && order.returns.length > 0 && (
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

          {/* Financials */}
          {financials && financials.transactions.length > 0 && (
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
